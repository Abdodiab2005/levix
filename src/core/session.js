// The WhatsApp session, owned by the backend.
//
// WHY THIS FILE EXISTS
// --------------------
// The bot used to create a Baileys socket as an unavoidable part of starting
// the process, and the reconnect logic lived inside the `connection.update`
// handler of whichever socket happened to be alive. Two problems came out of
// that:
//
//   * `levix` could not boot without dialling WhatsApp. A fresh install with no
//     pairing spent its whole life regenerating QR codes nobody was looking at.
//   * "who decides to reconnect" was answered by an event handler on a socket
//     that had already been replaced, so a slow close could resurrect a dead
//     connection on top of a live one.
//
// So the lifecycle is a small state machine here, in the backend, and it is the
// only thing allowed to create or destroy a socket. The panel *displays* this
// state and asks it to change; a browser opening, closing or refreshing has no
// effect on it whatsoever. Headless has no browser and simply calls start()
// itself.
//
// THE STATES
// ----------
//   idle              nothing is running. Panel mode boots here.
//   starting          a socket is being created right now.
//   waiting_for_qr    unpaired: a QR is out and we are waiting for a phone.
//   linking           the QR was scanned; WhatsApp wants the socket restarted.
//   connected         open.
//   reconnecting      a recoverable close; a retry is scheduled.
//   disconnected      closed and not retrying. Startable again by hand.
//   retry_exhausted   the retry schedule ran out. Levix keeps running.
//   logged_out        WhatsApp dropped the pairing; credentials were cleared.
//   error             starting the socket threw.
//
// THE RECONNECT POLICY
// --------------------
// Staged linear backoff — NOT exponential: 5s, 10s, 15s, 20s, 25s, then stop.
// The counter resets to zero on every successful `open`. Exactly one retry
// timer can exist at a time, and every socket carries a generation number: an
// event from a socket that is no longer the current one is dropped on the
// floor, which is what stops a late close from scheduling a reconnect on top
// of a live connection.
//
// A pairing attempt (unpaired install, QR on screen) that closes before it ever
// opened is NOT retried. The QR is deleted and the session goes back to idle.
// Regenerating one forever is how the old code burned a socket a minute on
// installs nobody was pairing.

import { createRequire } from "module";
import { DisconnectReason } from "@whiskeysockets/baileys";

import { createWhatsAppSocket } from "./socket.js";
import { setupEventListeners } from "./events.js";
import { handleConnectionOpen, classifyDisconnect } from "./connection.js";
import { RETRY_SCHEDULE_MS } from "../config/constants.js";
import { clearAuthState, deleteQrCode, saveQrCode } from "../utils/storage.esm.js";
import {
  createProxyAgents,
  describeProxyFailure,
  proxyFingerprint,
  readProxyConfig,
  redactProxy,
} from "./proxy.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");

// Baileys' `end()` awaits `ws.close()`, which waits for the socket's own
// 'close' event with no timeout of its own. A half-dead TCP connection can
// therefore hang it forever — and this is on the SIGTERM path, so "forever"
// would mean systemd eventually SIGKILLing a bot mid-write.
const SOCKET_CLOSE_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => setTimeout(resolve, ms).unref?.()),
  ]);
}

export const SESSION_STATES = Object.freeze({
  IDLE: "idle",
  STARTING: "starting",
  WAITING_FOR_QR: "waiting_for_qr",
  LINKING: "linking",
  CONNECTED: "connected",
  RECONNECTING: "reconnecting",
  DISCONNECTED: "disconnected",
  RETRY_EXHAUSTED: "retry_exhausted",
  LOGGED_OUT: "logged_out",
  ERROR: "error",
});

const S = SESSION_STATES;

/** States in which a socket already exists or is on its way. */
const BUSY_STATES = new Set([
  S.STARTING,
  S.WAITING_FOR_QR,
  S.LINKING,
  S.CONNECTED,
  S.RECONNECTING,
]);

/** What the dashboard's status pill has always been told. Kept stable. */
function legacyStatus(state, hasQr) {
  if (state === S.CONNECTED) return "Connected";
  if (state === S.WAITING_FOR_QR) return hasQr ? "QR Code Received" : "Connecting";
  if (state === S.STARTING) return "Connecting";
  if (state === S.LINKING) return "Linking";
  if (state === S.RECONNECTING) return "Reconnecting";
  return "Disconnected";
}

/**
 * The one WhatsApp session.
 *
 * Everything is injectable so the state machine can be tested without a network
 * or a phone; the defaults wire the real Baileys socket.
 */
export class WhatsAppSession {
  #state = S.IDLE;
  #since = Date.now();
  #socket = null;
  #clearAll = null;

  // Bumped for every socket. Events carrying an older number are ignored, which
  // is how a replaced socket stops being able to affect anything.
  #generation = 0;

  #attempt = 0;
  #retryTimer = null;
  #nextRetryAt = null;

  // A start() already in flight. Concurrent callers await it instead of
  // creating a second socket.
  #starting = null;

  // True while this attempt is an unpaired pairing attempt that has not yet
  // been scanned. Its closes are terminal by design.
  #pairing = false;

  #shuttingDown = false;

  // The proxy the live socket was actually built with, and how it reads. The
  // fingerprint contains the password, so it stays here — only the boolean
  // "would a reconnect change anything" reaches a browser.
  #proxyFingerprint = null;
  #proxyLabel = null;
  #proxyConfig = null;

  #qr = null;
  #reason = null;
  #detail = null;
  #lastDisconnect = null;

  constructor({
    createSocket = createWhatsAppSocket,
    attachListeners = setupEventListeners,
    onOpen = handleConnectionOpen,
    // The wipe of last resort. A socket hands us its own clearAll(), but a
    // session that is disconnected — 403, 405, retries exhausted, or simply
    // restarted — has no socket to ask, and that is exactly when an operator
    // wants to unlink and pair a different account.
    clearCredentials = clearAuthState,
    initializeScheduledJobs = null,
    stopScheduledJobs = null,
    // Read at socket-creation time, never cached at import: the operator can
    // change the proxy from the panel and the next connection must use it.
    // Injectable so a test can drive the whole state machine without a proxy.
    loadProxy = readProxyConfig,
    buildProxyAgents = createProxyAgents,
    emit = () => {},
    retryDelaysMs = RETRY_SCHEDULE_MS,
    log = logger,
  } = {}) {
    this.createSocket = createSocket;
    this.attachListeners = attachListeners;
    this.onOpen = onOpen;
    this.initializeScheduledJobs = initializeScheduledJobs;
    this.stopScheduledJobs = stopScheduledJobs;
    this.loadProxy = loadProxy;
    this.buildProxyAgents = buildProxyAgents;
    this.emitEvent = emit;
    this.clearCredentials = clearCredentials;
    this.retryDelaysMs = retryDelaysMs;
    this.log = log;
  }

  // -------------------------------------------------------------------------
  // what the outside world can see
  // -------------------------------------------------------------------------

  /** The live socket, or null. Callers must not cache it across a reconnect. */
  get socket() {
    return this.#socket;
  }

  get state() {
    return this.#state;
  }

  /**
   * The QR waiting to be scanned, or null.
   *
   * Deliberately not part of getState(): that snapshot is broadcast to every
   * open panel on every transition, and there is no reason to put a pairing
   * code through it more than once. A dashboard that loads while a code is
   * already up asks for it here instead.
   */
  get qr() {
    return this.#qr;
  }

  /** Everything the dashboard needs to render the Connection screen. */
  getState() {
    const terminal =
      this.#state === S.LOGGED_OUT ||
      this.#state === S.RETRY_EXHAUSTED ||
      this.#state === S.ERROR;

    return {
      state: this.#state,
      status: legacyStatus(this.#state, !!this.#qr),
      since: this.#since,
      attempt: this.#attempt,
      maxAttempts: this.retryDelaysMs.length,
      nextRetryAt: this.#nextRetryAt,
      canStart: !BUSY_STATES.has(this.#state) && !this.#shuttingDown,
      canStop: BUSY_STATES.has(this.#state),
      // Not "is it connected": a pairing that WhatsApp has refused (403, 405)
      // leaves dead credentials behind, and unlinking is the only way out of
      // it. The one state with nothing to unlink is the one that just did.
      canUnlink: this.#state !== S.LOGGED_OUT && !this.#shuttingDown,
      // Redacted — never the password. Null when the socket is direct.
      proxy: this.#proxyLabel,
      // True when the saved proxy settings differ from what the live socket was
      // built with, i.e. a reconnect would actually change something. Only the
      // answer crosses the wire, never the fingerprint it was computed from.
      proxyChanged: this.#proxyIsStale(),
      connected: this.#state === S.CONNECTED,
      terminal,
      hasQr: !!this.#qr,
      reason: this.#reason,
      detail: this.#detail,
      lastDisconnect: this.#lastDisconnect,
      user: this.#socket?.user
        ? { id: this.#socket.user.id || null, name: this.#socket.user.name || null }
        : null,
    };
  }

  // -------------------------------------------------------------------------
  // commands
  // -------------------------------------------------------------------------

  /**
   * Bring the session up. Idempotent: if a socket exists or is being made, this
   * returns the state it is already in and creates nothing.
   */
  async start({ reason = "manual" } = {}) {
    if (this.#shuttingDown) return this.getState();

    if (this.#starting) {
      await this.#starting.catch(() => {});
      return this.getState();
    }
    if (BUSY_STATES.has(this.#state)) return this.getState();

    // A manual start clears whatever the last failure left behind.
    this.#cancelRetry();
    this.#attempt = 0;

    this.#starting = this.#open({ reason });
    try {
      await this.#starting;
    } finally {
      this.#starting = null;
    }
    return this.getState();
  }

  /**
   * Take the session down on purpose. No retry follows, because the generation
   * is bumped before the socket is told to end — its close event is already
   * stale by the time it fires.
   */
  async stop({ reason = "manual", state = S.IDLE, detail = null } = {}) {
    this.#cancelRetry();
    this.#attempt = 0;

    // Wait for an in-flight start, or we would tear down a socket that has not
    // been assigned yet and then have it appear behind us.
    if (this.#starting) await this.#starting.catch(() => {});

    // Again after the await: a close that landed while we were waiting is
    // entitled to schedule a retry, and it would outlive this stop.
    this.#cancelRetry();
    this.#attempt = 0;

    await this.#destroySocket();
    this.#clearQr();
    this.#pairing = false;
    this.#transition(state, { reason, detail });
    return this.getState();
  }

  /**
   * Unlink the WhatsApp account: ask WhatsApp to drop the companion device,
   * then clear the credentials whether or not that call got through.
   */
  async logout() {
    // A start that is still creating its socket has to finish first: otherwise
    // #open() assigns a live socket after this method has already declared the
    // session logged out, and the account is unlinked with a connection still
    // running.
    this.#cancelRetry();
    if (this.#starting) await this.#starting.catch(() => {});

    const sock = this.#socket;
    const clearAll = this.#clearAll;

    // Stale from here on: whatever the socket emits while logging out is not
    // allowed to schedule anything.
    this.#generation += 1;
    this.#cancelRetry();
    this.#attempt = 0;

    if (sock) {
      try {
        await withTimeout(sock.logout(), SOCKET_CLOSE_TIMEOUT_MS);
      } catch (error) {
        this.log.warn({ err: error }, "[Session] logout call failed, clearing credentials anyway");
      }
      // Before the wipe, not after. The auth state's clearAll() empties the
      // table but leaves `state.creds` populated in memory, so one more
      // creds.update from a socket still finishing its teardown would write
      // the dead credentials straight back in.
      this.#detach(sock);
      try {
        await withTimeout(sock.end?.(undefined), SOCKET_CLOSE_TIMEOUT_MS);
      } catch {}
    }

    // clearAll() belongs to the socket that was alive; when there wasn't one,
    // the store-level wipe does the same job.
    try {
      await (clearAll ? clearAll() : this.clearCredentials?.());
    } catch (error) {
      this.log.error({ err: error }, "[Session] failed to clear credentials");
    }

    this.#socket = null;
    this.#clearAll = null;
    this.#pairing = false;
    this.#clearQr();
    this.#transition(S.LOGGED_OUT, {
      reason: "unlinked",
      detail: "The WhatsApp account was unlinked. Start a session to pair a new one.",
    });
    return this.getState();
  }

  /**
   * Take the session down and bring it straight back up.
   *
   * This is what "Reconnect to apply" runs. It is composed from the two
   * lifecycle methods that already exist rather than being a second path to a
   * socket: stop() cancels the retry and ends the current connection, start()
   * re-reads the settings — including the proxy — and opens a new one. Nothing
   * outside this class ever creates a socket.
   */
  async reconnect({ reason = "reconnect" } = {}) {
    if (this.#shuttingDown) return this.getState();
    await this.stop({ reason, state: S.IDLE });
    return this.start({ reason });
  }

  /** Process shutdown: cancel everything and never reconnect again. */
  async shutdown() {
    this.#shuttingDown = true;
    this.#cancelRetry();
    if (this.#starting) await this.#starting.catch(() => {});
    this.#cancelRetry();
    await this.#destroySocket();
    // A code left in the database would be served by GET /qr on the next boot,
    // long after the socket that issued it died.
    this.#clearQr();
    this.#transition(S.IDLE, { reason: "shutdown" });
  }

  // -------------------------------------------------------------------------
  // the socket
  // -------------------------------------------------------------------------

  async #open({ reason }) {
    // Whatever code was on offer belonged to the previous attempt.
    this.#clearQr();
    this.#transition(S.STARTING, { reason });

    // Anything that invalidates this attempt — stop, logout, shutdown — bumps
    // the generation. Creating a socket is asynchronous, so the attempt has to
    // recheck that it is still the current one when it comes back.
    const startedAt = this.#generation;

    // Read per attempt, so changing the proxy and pressing Reconnect is all it
    // takes. A configuration that does not validate fails the attempt with the
    // operator's own mistake rather than dialling out wrongly.
    let proxyConfig;
    let proxy = null;
    try {
      proxyConfig = this.loadProxy();
      proxy = this.buildProxyAgents(proxyConfig);
    } catch (error) {
      this.log.error(
        { err: error?.message },
        "[Session] the proxy configuration is not usable"
      );
      this.#proxyFingerprint = null;
      this.#proxyLabel = null;
      this.#transition(S.ERROR, {
        reason: "proxy_invalid",
        // normalizeProxyConfig() only ever throws messages about the shape of
        // the settings, never about their values, so this is safe to show.
        detail: error?.message || "The proxy configuration is not usable",
      });
      return;
    }

    this.#proxyFingerprint = proxyFingerprint(proxyConfig);
    this.#proxyLabel = redactProxy(proxyConfig);
    this.#proxyConfig = proxyConfig;

    let created;
    try {
      created = await this.createSocket({ proxy });
    } catch (error) {
      this.log.error({ err: error }, "[Session] failed to create the WhatsApp socket");
      this.#transition(S.ERROR, {
        reason: "socket_failed",
        detail:
          describeProxyFailure(error, proxyConfig) ||
          error?.message ||
          "Could not create the WhatsApp socket",
      });
      return;
    }

    if (this.#shuttingDown || this.#generation !== startedAt) {
      // Overtaken. Throw the socket away rather than adopt it, or we would end
      // up with a live connection nobody asked for and no state pointing at it.
      this.log.warn("[Session] discarding a socket whose start was overtaken");
      this.#detach(created.sock);
      try {
        await withTimeout(created.sock?.end?.(undefined), SOCKET_CLOSE_TIMEOUT_MS);
      } catch {}
      return;
    }

    const { sock, saveCreds, clearAll, isPaired } = created;

    const generation = (this.#generation += 1);
    this.#socket = sock;
    this.#clearAll = clearAll;
    // An install with no pairing yet is on a pairing attempt: its closes are
    // terminal until a phone has actually scanned the code.
    this.#pairing = !isPaired;

    this.attachListeners(sock, {
      saveCreds,
      onConnectionUpdate: (update) => this.#onConnectionUpdate(generation, update),
      onHandshakeRejected: (response) =>
        this.#onHandshakeRejected(generation, sock, response),
    });

    this.#transition(this.#pairing ? S.WAITING_FOR_QR : S.STARTING, {
      reason,
      detail: this.#pairing ? "Waiting for a QR code" : "Connecting to WhatsApp",
    });

    this.log.info("[Session] WhatsApp socket created");
  }

  /**
   * The server answered the WebSocket handshake with an HTTP status.
   *
   * In practice this is the proxy: 407 for bad credentials, 403 for a proxy
   * that will not tunnel to WhatsApp. Nothing else in Baileys reacts to it, so
   * without this the attempt hangs in `starting` forever.
   *
   * The response is turned into a normal close on the socket itself, so the
   * ordinary state machine decides what happens next — this does not classify
   * anything or schedule anything of its own.
   */
  #onHandshakeRejected(generation, sock, response) {
    if (generation !== this.#generation) return;

    const status = response?.statusCode ?? 0;
    const viaProxy = !!this.#proxyConfig?.enabled;
    const detail =
      viaProxy && (status === 407 || status === 401)
        ? `The proxy at ${this.#proxyLabel} rejected the username or password (HTTP ${status}).`
        : viaProxy
        ? `The proxy at ${this.#proxyLabel} refused to connect to WhatsApp (HTTP ${status}).`
        : `WhatsApp refused the connection (HTTP ${status}).`;

    this.log.error(`[Session] handshake rejected with HTTP ${status} — ${detail}`);

    // Baileys' end() is idempotent and emits the close through the normal
    // path, so the retry policy and the terminal classification stay exactly
    // where they already live.
    const error = new Error(detail);
    error.output = { statusCode: status || 500, payload: { error: detail } };
    Promise.resolve(sock?.end?.(error)).catch(() => {});
  }

  /** Cut every wire back from a socket we are done with. */
  #detach(sock) {
    for (const event of ["connection.update", "creds.update"]) {
      try {
        sock?.ev?.removeAllListeners?.(event);
      } catch {}
    }
  }

  /** End the current socket without letting its close event mean anything. */
  async #destroySocket() {
    const sock = this.#socket;
    if (!sock) return;

    this.#generation += 1;
    this.#socket = null;
    this.#clearAll = null;

    this.#detach(sock);
    this.#stopJobs();
    this.#proxyFingerprint = null;
    this.#proxyLabel = null;
    this.#proxyConfig = null;
    try {
      await withTimeout(sock.end?.(undefined), SOCKET_CLOSE_TIMEOUT_MS);
    } catch (error) {
      this.log.debug({ err: error?.message }, "[Session] socket end threw");
    }
  }

  /**
   * Would reconnecting pick up a different proxy than the one in use?
   *
   * False whenever nothing is connected — there is no socket to be stale, and
   * the next Start reads the settings fresh anyway.
   */
  #proxyIsStale() {
    if (this.#proxyFingerprint === null) return false;
    try {
      return proxyFingerprint(this.loadProxy()) !== this.#proxyFingerprint;
    } catch {
      // Settings that no longer validate (half-edited host, say) are not a
      // reason to nag; the next Start will report the real error.
      return false;
    }
  }

  /** Scheduled jobs live exactly as long as the socket they send through. */
  #stopJobs() {
    try {
      this.stopScheduledJobs?.();
    } catch (error) {
      this.log.warn({ err: error }, "[Session] stopping the scheduled jobs failed");
    }
  }

  // -------------------------------------------------------------------------
  // events from Baileys
  // -------------------------------------------------------------------------

  async #onConnectionUpdate(generation, update) {
    // A socket we have already replaced. Nothing it says can matter.
    if (generation !== this.#generation) return;

    const { connection, lastDisconnect, qr, isNewLogin } = update || {};

    if (qr) this.#onQr(qr);

    // The phone scanned the code. Pairing succeeded even though the connection
    // is about to be torn down and restarted — this is WhatsApp's own login
    // handshake, not a failed attempt.
    if (isNewLogin) {
      this.#pairing = false;
      this.#clearQr();
      this.#transition(S.LINKING, {
        reason: "paired",
        detail: "Paired. Finishing the handshake…",
      });
    }

    if (connection === "open") await this.#onOpen();
    else if (connection === "close") await this.#onClose(lastDisconnect);
  }

  #onQr(qr) {
    this.#qr = qr;
    try {
      saveQrCode(qr);
    } catch (error) {
      this.log.warn({ err: error }, "[Session] failed to store the QR code");
    }
    this.#transition(S.WAITING_FOR_QR, {
      reason: "qr",
      detail: "Scan the code from WhatsApp → Linked devices.",
    });
    this.emitEvent("qr", qr);
  }

  async #onOpen() {
    this.#attempt = 0;
    this.#nextRetryAt = null;
    this.#pairing = false;
    this.#clearQr();
    this.#lastDisconnect = null;
    this.#transition(S.CONNECTED, { reason: "open", detail: null });

    try {
      await this.onOpen(this.#socket, this.initializeScheduledJobs);
    } catch (error) {
      this.log.error({ err: error }, "[Session] post-connect setup failed");
    }
  }

  async #onClose(lastDisconnect) {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reasonText =
      lastDisconnect?.error?.output?.payload?.error ||
      lastDisconnect?.error?.message ||
      "Unknown";

    this.#lastDisconnect = { statusCode: statusCode ?? null, reason: reasonText, at: Date.now() };
    const closedSocket = this.#socket;
    this.#socket = null;
    // This socket is finished. Bump past it here rather than waiting for
    // #destroySocket(), which no-ops once #socket is null — otherwise a manual
    // stop from `reconnecting` would leave the dead socket's generation current
    // and anything it emitted afterwards would still be believed.
    this.#generation += 1;
    this.#detach(closedSocket);
    // The scheduled jobs were armed with that socket. Leaving them running
    // means a daily message firing into a closed connection, failing, and
    // being lost with nothing to show for it. The next open re-arms them.
    this.#stopJobs();

    // classifyDisconnect stays the only thing that decides terminal vs
    // recoverable. A proxy only ever enriches the sentence next to it.
    const verdict = classifyDisconnect(statusCode);
    const proxyNote = describeProxyFailure(lastDisconnect?.error, this.#proxyConfig);
    if (proxyNote && !verdict.terminal) {
      verdict.detail = verdict.detail ? `${proxyNote} ${verdict.detail}` : proxyNote;
    }

    this.log.warn(
      `[Session] Connection closed (${statusCode ?? "no status"}: ${reasonText}) — ${verdict.label}` +
        (this.#proxyLabel ? ` via ${this.#proxyLabel}` : "")
    );

    if (this.#shuttingDown) return;

    if (verdict.loggedOut) return this.#handleLoggedOut(verdict, closedSocket);
    if (verdict.terminal) {
      this.#clearQr();
      this.#pairing = false;
      return this.#transition(S.DISCONNECTED, {
        reason: verdict.reason,
        detail: verdict.detail,
      });
    }

    // A pairing attempt that closed before anyone scanned. Do not hand out
    // another code nobody asked for; drop the stale one and wait for a person.
    if (this.#pairing && !verdict.restartRequired) {
      this.#pairing = false;
      this.#clearQr();
      return this.#transition(S.DISCONNECTED, {
        reason: "pairing_cancelled",
        detail: "The pairing attempt ended before the code was scanned. Start a session to try again.",
      });
    }

    this.#scheduleRetry(verdict);
  }

  async #handleLoggedOut(verdict, closedSocket) {
    this.log.error("[Session] WhatsApp logged this device out. Clearing the stored credentials.");

    // Baileys destroys its emitter inside end() before this close is reported,
    // so there is normally nothing left to hear from. Being explicit costs
    // nothing and closes the one window where a late creds.update could write
    // the dead credentials back over the wipe below.
    this.#detach(closedSocket);

    const clearAll = this.#clearAll;
    this.#clearAll = null;
    if (clearAll) {
      try {
        await clearAll();
        this.log.info("[Session] Credentials cleared");
      } catch (error) {
        this.log.error({ err: error }, "[Session] failed to clear credentials");
      }
    }

    this.#pairing = false;
    this.#clearQr();
    this.#cancelRetry();
    this.#attempt = 0;
    this.#transition(S.LOGGED_OUT, { reason: verdict.reason, detail: verdict.detail });
  }

  // -------------------------------------------------------------------------
  // retries
  // -------------------------------------------------------------------------

  #scheduleRetry(verdict) {
    // Never two timers. A close that arrives while one is pending replaces it
    // rather than adding to it.
    this.#cancelRetry();

    if (this.#attempt >= this.retryDelaysMs.length) {
      this.log.error(
        `[Session] ${this.retryDelaysMs.length} reconnect attempts failed. Levix stays up; start the session again from the panel.`
      );
      this.#clearQr();
      return this.#transition(S.RETRY_EXHAUSTED, {
        reason: "retry_exhausted",
        detail: `Gave up after ${this.retryDelaysMs.length} attempts. Start the session to try again.`,
      });
    }

    const delayMs = this.retryDelaysMs[this.#attempt];
    this.#attempt += 1;
    this.#nextRetryAt = Date.now() + delayMs;

    this.log.warn(
      `[Session] Reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${this.#attempt}/${this.retryDelaysMs.length})`
    );

    this.#transition(S.RECONNECTING, {
      reason: verdict.reason,
      // The close's own explanation first: a 515 straight after a scan is
      // WhatsApp asking for a fresh connection, not a failed attempt, and
      // "attempt 1 of 5" on its own reads like something went wrong.
      // No countdown in here: this string is baked once, at schedule time, and
      // would go on claiming "in 5s" for the whole wait. The panel renders the
      // remaining seconds from nextRetryAt, which actually ticks.
      detail:
        `${verdict.detail ? `${verdict.detail} ` : ""}` +
        `Reconnecting (attempt ${this.#attempt} of ${this.retryDelaysMs.length}).`,
    });

    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#nextRetryAt = null;
      if (this.#shuttingDown) return;
      if (this.#starting) return;

      this.#starting = this.#open({ reason: "reconnect" })
        .catch((error) => this.log.error({ err: error }, "[Session] reconnect failed"))
        .finally(() => {
          this.#starting = null;
        });
    }, delayMs);

    // Deliberately NOT unref'd. Once the WhatsApp socket is gone, a headless
    // Levix has nothing else holding the event loop open — verified: the
    // database is synchronous and the log transport does not hold a ref — so an
    // unref'd timer would let the process exit during the wait instead of
    // reconnecting. Shutdown cancels this timer explicitly, so keeping it
    // ref'd cannot delay a SIGTERM.
  }

  #cancelRetry() {
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#nextRetryAt = null;
  }

  // -------------------------------------------------------------------------
  // bookkeeping
  // -------------------------------------------------------------------------

  /**
   * Drop the pairing code, in memory and on disk.
   *
   * The row is deleted unconditionally rather than only when this process is
   * holding a code: a QR written by a previous process is unscannable, and
   * guarding on the in-memory copy left it in the database forever, where
   * GET /qr would happily serve it to somebody.
   */
  #clearQr() {
    const had = this.#qr !== null;
    this.#qr = null;
    try {
      deleteQrCode();
    } catch (error) {
      this.log.debug({ err: error?.message }, "[Session] failed to delete the stored QR");
    }
    if (had) this.emitEvent("qr_cleared", {});
  }

  #transition(state, { reason = null, detail = null } = {}) {
    const changed = state !== this.#state;
    this.#state = state;
    this.#reason = reason;
    this.#detail = detail;
    if (changed) this.#since = Date.now();

    const snapshot = this.getState();
    // `session` carries everything; `status_update` is the shape the dashboard
    // and the headless printer have always listened for.
    this.emitEvent("session", snapshot);
    this.emitEvent("status_update", { status: snapshot.status, state: snapshot.state });
  }
}

/** The numbers Baileys hands back, for anything that needs to name them. */
export { DisconnectReason };

export default WhatsAppSession;
