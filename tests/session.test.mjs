// The WhatsApp session state machine (src/core/session.js).
//
// No network, no phone, no Baileys: the socket factory, the listener wiring and
// the post-connect work are all injected, so what is under test here is the
// lifecycle itself — how many sockets get made, when a retry is scheduled and
// for how long, and which closes are terminal.
//
// That is the whole point of pulling the state machine out of the connection
// handler: the rules can be stated as facts instead of hoped for.

import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  require as harnessRequire,
  ok,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-session");

const { WhatsAppSession, SESSION_STATES, parseStartOptions, normalizePairingPhone } = await import(
  "../src/core/session.js"
);
const { accountEpoch } = await import("../src/utils/storage.esm.js");
const { RETRY_SCHEDULE_MS, MAX_RETRIES } = await import("../src/config/constants.js");
const { classifyDisconnect, CONNECTION_FAILURE_405 } = await import("../src/core/connection.js");
const { DisconnectReason } = await import("@whiskeysockets/baileys");

const S = SESSION_STATES;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A Boom-shaped close, the way Baileys reports one. */
const closedWith = (statusCode, message = "test") => ({
  error: { message, output: { statusCode, payload: { error: message } } },
  date: new Date(),
});

const silent = { info() {}, warn() {}, error() {}, debug() {}, trace() {} };

/**
 * A session wired to fake sockets.
 *
 * `harness.sockets` is every socket ever created, in order — the count is what
 * proves "start is idempotent" and "a stale close cannot make a second one".
 * `harness.push(update)` delivers a connection.update to the CURRENT socket, so
 * a test can also aim one at an old socket on purpose.
 */
function makeHarness({ paired = false, retryDelaysMs, clearAll, isLinked, realClear = false } = {}) {
  const sockets = [];
  const events = [];

  const createSocket = async (opts = {}) => {
    const sock = {
      index: sockets.length,
      user: null,
      ended: 0,
      loggedOut: 0,
      fenced: 0,
      ev: new EventEmitter(),
      async end() {
        this.ended += 1;
      },
      async logout() {
        this.loggedOut += 1;
      },
      async requestPairingCode(phone) {
        this.pairingPhone = phone;
        return "ABCD1234";
      },
      pairingCodeOption: Boolean(opts.pairingCode),
      updates: null,
    };
    sockets.push(sock);
    return {
      sock,
      saveCreds: async () => {},
      clearAll,
      fence: () => {
        sock.fenced += 1;
      },
      isPaired: paired,
    };
  };

  const attachListeners = (sock, { onConnectionUpdate }) => {
    sock.updates = onConnectionUpdate;
  };

  const session = new WhatsAppSession({
    createSocket,
    attachListeners,
    onOpen: async () => {},
    emit: (event, payload) => events.push({ event, payload }),
    retryDelaysMs,
    checkConsent: () => ({ ok: true }),
    log: silent,
    pairingCodeDelayMs: 0,
    isLinked: isLinked ?? (() => paired),
    clearDirectory: realClear ? undefined : () => {
      events.push({ event: "directory_cleared", payload: null });
    },
  });

  return {
    session,
    sockets,
    events,
    latest: () => sockets[sockets.length - 1],
    push: (update, socket = sockets[sockets.length - 1]) => socket.updates(update),
  };
}

// ---------------------------------------------------------------------------

section("the retry schedule is 5/10/15/20/25 seconds, staged and linear");

equal(
  "the exact ladder",
  JSON.stringify([...RETRY_SCHEDULE_MS]),
  JSON.stringify([5000, 10000, 15000, 20000, 25000]),
);
equal("five attempts", MAX_RETRIES, 5);
ok("the schedule is frozen", Object.isFrozen(RETRY_SCHEDULE_MS));
{
  const steps = RETRY_SCHEDULE_MS.map((ms, i) => (i ? ms - RETRY_SCHEDULE_MS[i - 1] : ms));
  ok(
    "every step is the same 5s — linear, not exponential",
    steps.every((s) => s === 5000),
  );
}

section("a session does nothing until it is asked to");

{
  const h = makeHarness();
  equal("it starts idle", h.session.state, S.IDLE);
  equal("no socket was created", h.sockets.length, 0);
  ok("and it says it can be started", h.session.getState().canStart);
}

section("Start creates exactly one socket, however many times it is pressed");

{
  const h = makeHarness();
  await h.session.start();
  equal("one socket", h.sockets.length, 1);

  await h.session.start();
  await h.session.start();
  equal("pressing it again creates nothing", h.sockets.length, 1);

  // Five callers racing, none of them awaited before the next one starts.
  const h2 = makeHarness();
  await Promise.all(Array.from({ length: 5 }, () => h2.session.start()));
  equal("five concurrent starts still make one socket", h2.sockets.length, 1);

  // …and once it is open.
  h2.latest().user = { id: "1@s.whatsapp.net" };
  await h2.push({ connection: "open" });
  equal("it is connected", h2.session.state, S.CONNECTED);
  await h2.session.start();
  equal("starting a connected session is a no-op", h2.sockets.length, 1);
  ok("and it reports it cannot be started", !h2.session.getState().canStart);
}

section("a command that overtakes a start in flight wins cleanly");

{
  // A socket that takes a while to build — the window in which stop/logout can
  // land between "start was asked for" and "the socket exists".
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  const h = makeHarness({ paired: true });
  const realCreate = h.session.createSocket;
  h.session.createSocket = async (...args) => {
    await gate;
    return realCreate(...args);
  };

  const starting = h.session.start();
  const stopping = h.session.stop();
  release();
  await Promise.all([starting, stopping]);

  equal("the session really is stopped", h.session.state, S.IDLE);
  equal("no socket was left adopted", h.session.socket, null);
  equal("the one that was built got ended", h.sockets[0].ended, 1);
  await sleep(60);
  equal("and nothing reconnected behind the stop", h.sockets.length, 1);
}

{
  // The same window, but the operator unlinks instead of stopping. The
  // in-flight create adopts its socket; logout() and clearAll() each run once.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });

  let cleared = 0;
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      cleared += 1;
    },
  });
  const realCreate = h.session.createSocket;
  h.session.createSocket = async (...args) => {
    await gate;
    return realCreate(...args);
  };

  const starting = h.session.start();
  const unlinking = h.session.logout();
  release();
  await Promise.all([starting, unlinking]);

  equal("the account is unlinked", h.session.state, S.LOGGED_OUT);
  equal("no live socket survived the unlink", h.session.socket, null);
  equal("the adopted socket logged out once", h.sockets[0].loggedOut, 1);
  equal("the credentials were cleared once", cleared, 1);
  await sleep(60);
  equal("and nothing came back", h.sockets.length, 1);
}

section("pairing: a QR that nobody scans is not replaced by another one");

{
  const h = makeHarness({ paired: false });
  await h.session.start();
  await h.push({ qr: "QR-ONE" });

  equal("the state says a code is waiting", h.session.state, S.WAITING_FOR_QR);
  equal("the code is readable for a dashboard that loads late", h.session.qr, "QR-ONE");
  ok(
    "the QR went out to whoever is listening",
    h.events.some((e) => e.event === "qr"),
  );

  // The connection drops before a phone ever scanned it.
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.timedOut) });

  equal("the pairing attempt ends", h.session.state, S.DISCONNECTED);
  equal("no second socket was created", h.sockets.length, 1);
  equal("the stale code is gone", h.session.qr, null);
  ok(
    "the panel is told the code is gone",
    h.events.some((e) => e.event === "qr_cleared"),
  );
  ok("and it can be started by hand again", h.session.getState().canStart);

  await sleep(60);
  equal("still no reconnect after waiting", h.sockets.length, 1);

  await h.session.start();
  equal("a manual start begins a fresh attempt", h.sockets.length, 2);
  await h.session.stop();
}

section("pairing: a scan is not a failed attempt");

{
  const h = makeHarness({ paired: false, retryDelaysMs: [30, 60] });
  await h.session.start();
  await h.push({ qr: "QR-TWO" });

  // WhatsApp's own login handshake: the phone scans, then the server asks for
  // the connection to be made again.
  await h.push({ isNewLogin: true });
  equal("the session is linking", h.session.state, S.LINKING);
  equal("the code is cleared once it has been used", h.session.qr, null);

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.restartRequired),
  });
  equal("a restart-required close is retried, not abandoned", h.session.state, S.RECONNECTING);

  await sleep(120);
  equal("the retry actually made a second socket", h.sockets.length, 2);
  await h.session.stop();
}

section("an authenticated session reconnects on its own");

{
  const h = makeHarness({ paired: true });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("connected", h.session.state, S.CONNECTED);
  equal("the retry counter is clear", h.session.getState().attempt, 0);

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionClosed),
  });

  const state = h.session.getState();
  equal("it is reconnecting", state.state, S.RECONNECTING);
  equal("this is attempt one", state.attempt, 1);

  const wait = state.nextRetryAt - Date.now();
  ok(`attempt 1 waits ~5s (got ${Math.round(wait)}ms)`, wait > 4500 && wait <= 5000);

  // The retry is the backend's, not a browser's. Nothing in this file has ever
  // constructed a socket.io server, an Express app or a browser client — the
  // whole ladder above ran with no listener but a recording array.
  ok(
    "the retry was scheduled with nothing listening but a plain array",
    Array.isArray(h.events) && h.session.getState().nextRetryAt !== null,
  );

  await h.session.stop();
  equal("stopping cancels the pending retry", h.session.getState().nextRetryAt, null);
  await sleep(80);
  equal("and no socket appeared", h.sockets.length, 1);
}

section("…in order, and only one at a time, until it gives up");

{
  // The same ladder, shrunk so the test does not take 75 seconds. The real
  // numbers are asserted at the top of this file.
  const delays = [20, 40, 60, 80, 100];
  const h = makeHarness({ paired: true, retryDelaysMs: delays });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  const observed = [];
  for (let attempt = 1; attempt <= delays.length; attempt += 1) {
    await h.push({
      connection: "close",
      lastDisconnect: closedWith(DisconnectReason.connectionLost),
    });
    const state = h.session.getState();
    equal(`attempt ${attempt} is counted`, state.attempt, attempt);
    observed.push(Math.round(state.nextRetryAt - Date.now()));
    // Exactly one retry is pending at any moment.
    equal(`only one socket is alive at attempt ${attempt}`, h.sockets.length, attempt);
    await sleep(delays[attempt - 1] + 40);
    equal(`the retry produced socket ${attempt + 1}`, h.sockets.length, attempt + 1);
  }

  ok(
    `the delays climb in order (${observed.join(", ")})`,
    observed.every((ms, i) => i === 0 || ms > observed[i - 1]),
  );

  // One more close, with the schedule used up.
  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  equal("it gives up", h.session.state, S.RETRY_EXHAUSTED);
  ok("but says it can be started again", h.session.getState().canStart);
  await sleep(160);
  equal("and really stopped trying", h.sockets.length, delays.length + 1);

  // Retry exhaustion must never take Levix down with it. Two ways of saying so:
  // this process is still here to run the line, and there is no exit in the
  // module that would have ended it.
  {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const source = readFileSync(
      fileURLToPath(new URL("../src/core/session.js", import.meta.url)),
      "utf8",
    );
    ok("the session never exits the process", !/process\.exit/.test(source));
  }
}

section("a reconnect re-binds the scheduled jobs, and only once each");

{
  // Two halves of one guarantee.
  //
  // (1) the session hands initializeScheduledJobs to EVERY open, including a
  //     reconnect, because the jobs have to be bound to the new socket; and
  // (2) the scheduler stops the previous cron task for the same id before it
  //     schedules it again. Without (2), a weekly message goes out twice after
  //     the first reconnect and three times after the second.

  const { scheduleNewJob } = harnessRequire("./scheduler.cjs");
  const { saveSchedule } = await import("../src/utils/storage.esm.js");

  const job = {
    id: "reconnect-dupe-check",
    type: "recurring",
    targetJid: "1@s.whatsapp.net",
    message: "hello",
    cronString: "0 0 * * *",
    status: "active",
    creatorJid: "1@s.whatsapp.net",
  };
  saveSchedule(job);

  // The same module object the scheduler resolved, so patching it is visible
  // there. `import cron from "node-cron"` is a DIFFERENT object under CJS
  // interop and patching that one silently does nothing.
  const cron = harnessRequire("node-cron");
  const realSchedule = cron.schedule;
  let created = 0;
  let stopped = 0;
  // Every task made here is kept so it can be stopped again: a live cron task
  // holds a ref'd timer, and one left running keeps this process alive forever.
  const madeHere = [];

  cron.schedule = (...args) => {
    created += 1;
    const task = realSchedule.apply(cron, args);
    const realStop = task.stop.bind(task);
    madeHere.push(realStop);
    task.stop = (...stopArgs) => {
      stopped += 1;
      return realStop(...stopArgs);
    };
    return task;
  };

  try {
    const sock = { async sendMessage() {} };

    scheduleNewJob(sock, job);
    equal("the job is scheduled once", created, 1);
    equal("nothing has been stopped yet", stopped, 0);

    // Exactly what a reconnect does to an already-scheduled job.
    scheduleNewJob(sock, job);
    equal("scheduling it again makes a new task", created, 2);
    equal("…after stopping the old one", stopped, 1);
    equal("so one task is live, not two", created - stopped, 1);

    scheduleNewJob(sock, job);
    equal("and still one after a third", created - stopped, 1);
  } finally {
    cron.schedule = realSchedule;
    for (const stop of madeHere) {
      try {
        stop();
      } catch {}
    }
  }

  // The session side: every open re-binds, against the socket that is live now.
  const bound = [];
  const h = makeHarness({ paired: true, retryDelaysMs: [20, 40] });
  h.session.initializeScheduledJobs = (sock) => bound.push(sock);
  // The default onOpen is a stub in this harness, so wire the one part of the
  // real handler under test here: it is handed the scheduler and the socket.
  h.session.onOpen = async (sock, initializeScheduledJobs) => {
    if (initializeScheduledJobs) initializeScheduledJobs(sock);
  };

  await h.session.start();
  const firstSocket = h.latest();
  firstSocket.user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("the first open binds the jobs", bound.length, 1);

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  await sleep(60);
  const secondSocket = h.latest();
  secondSocket.user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  equal("so does the reconnect", bound.length, 2);
  ok("…and against the NEW socket", bound[1] === secondSocket && bound[1] !== firstSocket);

  await h.session.stop();
}

section("a successful open clears the counter");

{
  const h = makeHarness({ paired: true, retryDelaysMs: [20, 40, 60, 80, 100] });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  equal("one attempt used", h.session.getState().attempt, 1);
  await sleep(60);

  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("connected again", h.session.state, S.CONNECTED);
  equal("the counter is back to zero", h.session.getState().attempt, 0);

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  equal("so the next failure is attempt one again", h.session.getState().attempt, 1);
  await h.session.stop();
}

section("a replaced socket cannot reach back");

{
  const h = makeHarness({ paired: true, retryDelaysMs: [20, 40] });
  await h.session.start();
  const first = h.sockets[0];
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  await sleep(60);
  equal("a second socket exists", h.sockets.length, 2);
  h.sockets[1].user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("and it is the live one", h.session.state, S.CONNECTED);

  // The old socket finally gets round to reporting its own death.
  await h.push(
    { connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) },
    first,
  );
  equal("the stale close changed nothing", h.session.state, S.CONNECTED);
  await sleep(80);
  equal("and scheduled nothing", h.sockets.length, 2);

  // Same for a QR from a socket nobody is using any more.
  await h.push({ qr: "STALE-QR" }, first);
  equal("a stale QR is ignored too", h.session.qr, null);
  await h.session.stop();
}

section("terminal closes: logged out");

{
  let cleared = 0;
  const h = makeHarness({
    paired: true,
    retryDelaysMs: [20, 40],
    clearAll: async () => {
      cleared += 1;
    },
  });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  await h.push({ qr: "SHOULD-NOT-SURVIVE" });

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.loggedOut) });

  equal("the state is logged out", h.session.state, S.LOGGED_OUT);
  equal("the credentials were cleared", cleared, 1);
  equal("the QR state is clean", h.session.qr, null);
  ok("it is startable by hand", h.session.getState().canStart);

  await sleep(120);
  equal("nothing reconnected", h.sockets.length, 1);

  await h.session.start();
  equal("a manual start pairs again", h.sockets.length, 2);
  await h.session.stop();
}

section("terminal closes: 405");

{
  let cleared = 0;
  const h = makeHarness({
    paired: true,
    retryDelaysMs: [20, 40],
    clearAll: async () => {
      cleared += 1;
    },
  });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  await h.push({
    connection: "close",
    lastDisconnect: closedWith(CONNECTION_FAILURE_405, "Connection Failure"),
  });

  equal("it stops rather than hammering WhatsApp", h.session.state, S.DISCONNECTED);
  equal("the pairing was left alone", cleared, 0);
  ok("the reason is reported", h.session.getState().reason === "connection_failure");

  await sleep(120);
  equal("no automatic reconnect", h.sockets.length, 1);
  ok("and it can still be started by hand", h.session.getState().canStart);
}

section("classifying a close");

{
  const loggedOut = classifyDisconnect(DisconnectReason.loggedOut);
  ok("loggedOut is terminal", loggedOut.terminal && loggedOut.loggedOut);
  equal("…and comes from the Baileys enum, not a magic number", DisconnectReason.loggedOut, 401);

  const failure = classifyDisconnect(CONNECTION_FAILURE_405);
  equal("405 is a named constant", CONNECTION_FAILURE_405, 405);
  ok("405 is terminal", failure.terminal);
  ok("…but never a credential wipe", !failure.loggedOut);

  ok("403 is terminal", classifyDisconnect(DisconnectReason.forbidden).terminal);
  ok("…and is not treated as a logout", !classifyDisconnect(DisconnectReason.forbidden).loggedOut);

  ok("515 is recoverable", !classifyDisconnect(DisconnectReason.restartRequired).terminal);
  ok(
    "…and marked as the pairing handshake",
    classifyDisconnect(DisconnectReason.restartRequired).restartRequired,
  );

  for (const code of [
    DisconnectReason.connectionClosed,
    DisconnectReason.connectionLost,
    DisconnectReason.badSession,
    DisconnectReason.unavailableService,
    undefined,
  ]) {
    ok(`${code ?? "no status"} is retried`, !classifyDisconnect(code).terminal);
  }
}

section("unlinking from the panel");

{
  let cleared = 0;
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      cleared += 1;
    },
  });
  await h.session.start();
  const sock = h.latest();
  sock.user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });

  await h.session.logout();
  equal("WhatsApp was asked to drop the device", sock.loggedOut, 1);
  equal("the credentials went with it", cleared, 1);
  equal("the state is logged out", h.session.state, S.LOGGED_OUT);
  equal("there is no live socket left", h.session.socket, null);

  await sleep(80);
  equal("and nothing reconnected", h.sockets.length, 1);
}

section("unlink keeps staged account data pending");

{
  const { dataPath } = harnessRequire("./src/config/paths.cjs");
  const pending = dataPath("restore", "pending");
  mkdirSync(pending, { recursive: true });
  writeFileSync(join(pending, "pending.json"), "pending marker");
  const h = makeHarness({ paired: true, clearAll: async () => {}, realClear: true });
  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  await h.session.logout();
  ok("unlink leaves pending directory", existsSync(join(pending, "pending.json")));
}

section("unlinking works when there is no socket to unlink through");

{
  // 403 and 405 are terminal without clearing anything, so the dead pairing sits
  // in the database with no connection to unlink through. If unlink needed a
  // live socket the install would be stuck there.
  let socketClear = 0;
  let storeClear = 0;
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      socketClear += 1;
    },
  });
  h.session.clearCredentials = async () => {
    storeClear += 1;
  };

  await h.session.start();
  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  await h.push({ connection: "close", lastDisconnect: closedWith(CONNECTION_FAILURE_405) });

  equal("the session is stuck on a refusal", h.session.state, S.DISCONNECTED);
  equal("with no socket", h.session.socket, null);
  ok("but it still offers to unlink", h.session.getState().canUnlink);

  await h.session.logout();
  equal("the credentials were cleared anyway", socketClear + storeClear, 1);
  equal("and the session says so", h.session.state, S.LOGGED_OUT);
  ok("there is nothing left to unlink", !h.session.getState().canUnlink);
}

{
  // The harder case: nothing is holding the socket's own clearAll any more —
  // the session was stopped, or this is a fresh process that has never
  // connected. Only the store-level wipe can reach the credentials now.
  let storeClear = 0;
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      throw new Error("this socket is long gone");
    },
  });
  h.session.clearCredentials = async () => {
    storeClear += 1;
  };

  await h.session.start();
  await h.session.stop();
  equal("stopped, with no socket and no clearAll", h.session.socket, null);
  ok("unlink is still on offer", h.session.getState().canUnlink);

  await h.session.logout();
  equal("the store-level wipe ran", storeClear, 1);
  equal("and the session is unlinked", h.session.state, S.LOGGED_OUT);
}

section("a pairing code never outlives the attempt that issued it");

{
  const { getQrCode } = await import("../src/utils/storage.esm.js");

  const h = makeHarness({ paired: false });
  await h.session.start();
  await h.push({ qr: "QR-PERSISTED" });
  equal("the code is on disk for GET /qr", getQrCode(), "QR-PERSISTED");

  // Ctrl+C, or systemd restarting the unit. The row must not survive: the next
  // process would serve a code nobody can scan.
  await h.session.shutdown();
  equal("shutdown took the code with it", getQrCode(), null);
}

{
  const { getQrCode, saveQrCode } = await import("../src/utils/storage.esm.js");

  // A code left behind by an older process, before this session ever ran.
  saveQrCode("QR-FROM-A-DEAD-PROCESS");
  const h = makeHarness({ paired: false });
  await h.session.start();
  equal("starting an attempt drops whatever was there", getQrCode(), null);
  await h.session.stop();
}

section("shutdown leaves nothing running");

{
  const h = makeHarness({ paired: true, retryDelaysMs: [20, 40] });
  await h.session.start();
  const sock = h.latest();
  sock.user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.connectionLost),
  });
  equal("a retry is pending", h.session.state, S.RECONNECTING);

  await h.session.shutdown();
  equal("the pending retry is cancelled", h.session.getState().nextRetryAt, null);
  await sleep(120);
  equal("nothing reconnected during shutdown", h.sockets.length, 1);

  await h.session.start();
  equal("and a start after shutdown does nothing", h.sockets.length, 1);
}

section("a pending reconnect keeps a headless process alive");

{
  // Not a style point: with an unref'd timer this child exits during the wait
  // and a headless Levix silently stops reconnecting. Only a separate process
  // can answer "did it stay alive".
  const { spawnSync } = await import("node:child_process");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");

  const here = fileURLToPath(new URL(".", import.meta.url));
  const result = spawnSync(
    process.execPath,
    [
      join(here, "fixtures", "reconnect-liveness.mjs"),
      "--data",
      mkdtempSync(join(tmpdir(), "levix-liveness-")),
    ],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, LEVIX_DATA_DIR: "" } },
  );

  const out = `${result.stdout || ""}${result.stderr || ""}`;
  ok(
    "the process was still there when the retry fired",
    out.includes("RECONNECTED"),
    out.trim().split("\n").slice(-3).join(" | "),
  );
  ok("…and not because it never left", !out.includes("EXITED_BEFORE_RETRY"));
}

section("a socket that will not even be created");

{
  const h = makeHarness();
  h.session.createSocket = async () => {
    throw new Error("no network");
  };
  await h.session.start();
  equal("the failure is a state, not a crash", h.session.state, S.ERROR);
  ok("and it can be retried by hand", h.session.getState().canStart);
}

section("pairing phone numbers are digits with a country code");

{
  equal("strips plus and spaces", normalizePairingPhone("+20 10 1234 5678"), "201012345678");
  equal("accepts Arabic-Indic digits", normalizePairingPhone("٢٠١٠١٢٣٤٥٦٧٨"), "201012345678");
  let leadingZero = false;
  try {
    normalizePairingPhone("01012345678");
  } catch (error) {
    leadingZero = error.code === "PAIRING_PHONE";
  }
  ok("a local number starting with 0 is rejected", leadingZero);
  equal("qr is the default method", parseStartOptions({}).method, "qr");
  equal(
    "pairing keeps the number",
    parseStartOptions({ method: "pairing", phone: "201012345678" }).phone,
    "201012345678",
  );
  let threw = false;
  try {
    parseStartOptions({ method: "pairing", phone: "12" });
  } catch (error) {
    threw = error.code === "PAIRING_PHONE";
  }
  ok("a short number is rejected before a socket exists", threw);
}

section("pairing code is chosen before the socket is created");

{
  const h = makeHarness();
  let threw = false;
  try {
    await h.session.start({ method: "pairing", phone: "99" });
  } catch (error) {
    threw = error.code === "PAIRING_PHONE";
  }
  ok("invalid pairing start throws", threw);
  equal("and creates no socket", h.sockets.length, 0);
}

{
  const h = makeHarness();
  await h.session.start({ method: "pairing", phone: "201012345678" });
  equal("one socket", h.sockets.length, 1);
  await h.push({ qr: "should-not-be-shown" });
  equal("the pairing code is on offer", h.session.pairingCode, "ABCD1234");
  equal("the QR is not stored", h.session.qr, null);
  ok("no qr event was emitted", !h.events.some((e) => e.event === "qr"));
  ok(
    "the pairing_code event carries the code",
    h.events.some(
      (e) =>
        e.event === "pairing_code" &&
        e.payload.code === "ABCD1234" &&
        e.payload.phone === "201012345678",
    ),
  );
  equal("the number was given to Baileys", h.latest().pairingPhone, "201012345678");
  ok("getState does not include the code", h.session.getState().hasPairingCode === true);
  ok("the snapshot has no code field", h.session.getState().pairingCode === undefined);
}

{
  const h = makeHarness({ paired: true });
  await h.session.start({ method: "pairing", phone: "201012345678" });
  equal("a paired install still just connects", h.session.state, S.STARTING);
  equal("it never asked for a code", h.latest().pairingPhone, undefined);
  equal("createSocket was not asked for a pairing code", h.latest().pairingCodeOption, false);
  ok("getState.linked is true for a known session", h.session.getState().linked === true);
}

section("internet state: pausing when offline and restarting when online");

{
  const h = makeHarness({ paired: true, retryDelaysMs: [100, 200, 300] });
  await h.session.start();
  await h.push({ connection: "open" });
  equal("starts connected", h.session.state, S.CONNECTED);

  // Device goes offline
  await h.session.setInternetOnline(false);
  equal("session is paused when offline", h.session.state, S.PAUSED);
  equal("isOnline is false in state", h.session.getState().isOnline, false);
  equal("socket was ended", h.latest().ended, 1);

  // A close while offline stays paused and does not burn retries
  await h.push(closedWith(500, "network down"));
  equal("stays paused after close", h.session.state, S.PAUSED);
  equal("retry count stays 0", h.session.getState().attempt, 0);

  // Device comes back online
  await h.session.setInternetOnline(true);
  equal("restoring internet restarts session", h.session.state, S.STARTING);
  equal("new socket created", h.sockets.length, 2);
  await h.push({ connection: "open" });
  equal("connected again", h.session.state, S.CONNECTED);
}

section(
  "auth fence closes before clearing credentials and on socket teardown, without affecting reconnect",
);

{
  // 1. logout() fences the old auth state before clearAll and clearDirectory run.
  const order = [];
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      order.push(`clearAll:fenced=${h.sockets[0].fenced}`);
    },
  });
  const realCreate = h.session.createSocket;
  h.session.createSocket = async (...args) => {
    const created = await realCreate(...args);
    const origFence = created.fence;
    created.fence = () => {
      order.push("fence");
      origFence();
    };
    return created;
  };
  h.session.clearDirectory = () => {
    order.push(`clearDirectory:fenced=${h.sockets[0].fenced}`);
  };

  await h.session.start();
  await h.push({ connection: "open" });
  equal("active socket is not fenced while connected", h.sockets[0].fenced, 0);

  await h.session.logout();
  equal("logout fenced the socket auth state", h.sockets[0].fenced, 1);
  equal(
    "logout fenced before clearAll and clearDirectory",
    order.join(","),
    "fence,clearAll:fenced=1,clearDirectory:fenced=1",
  );
}

{
  // 2. DisconnectReason.loggedOut close fences before clearAll and clearDirectory.
  const order = [];
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      order.push(`clearAll:fenced=${h.sockets[0].fenced}`);
    },
  });
  const realCreate = h.session.createSocket;
  h.session.createSocket = async (...args) => {
    const created = await realCreate(...args);
    const origFence = created.fence;
    created.fence = () => {
      order.push("fence");
      origFence();
    };
    return created;
  };
  h.session.clearDirectory = () => {
    order.push(`clearDirectory:fenced=${h.sockets[0].fenced}`);
  };

  await h.session.start();
  await h.push({ connection: "open" });
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.loggedOut) });

  equal("loggedOut close fenced the socket auth state", h.sockets[0].fenced, 1);
  equal(
    "loggedOut close fenced before clearAll and clearDirectory",
    order.join(","),
    "fence,clearAll:fenced=1,clearDirectory:fenced=1",
  );
}

{
  // 3. Reconnect and stop fence the old socket without fencing the new socket.
  const h = makeHarness({ paired: true, retryDelaysMs: [20, 40] });
  await h.session.start();
  await h.push({ connection: "open" });
  equal("first socket starts unfenced", h.sockets[0].fenced, 0);

  await h.session.reconnect();
  equal("reconnect created second socket", h.sockets.length, 2);
  equal("first socket was fenced on teardown", h.sockets[0].fenced, 1);
  equal("second socket auth state is unfenced", h.sockets[1].fenced, 0);

  await h.session.stop();
  equal("stop fenced the second socket", h.sockets[1].fenced, 1);
}

{
  // 4. Overtaken start fences the discarded socket.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = makeHarness({ paired: true });
  const realCreate = h.session.createSocket;
  h.session.createSocket = async (...args) => {
    await gate;
    return realCreate(...args);
  };

  const starting = h.session.start();
  const stopping = h.session.stop();
  release();
  await Promise.all([starting, stopping]);
  equal("overtaken socket auth state was fenced when discarded", h.sockets[0].fenced, 1);
}

{
  // 5. Real useDatabaseAuthState wired into WhatsAppSession: a pending Baileys
  // commitWithRetry from the old socket is blocked when session.logout() runs.
  const { addTransactionCapability } = await import("@whiskeysockets/baileys");
  const { AUTH_STORE_FENCED, useDatabaseAuthState } = await import(
    "../src/auth/use-database-auth-state.js"
  );
  const store = harnessRequire("./src/db/store.cjs");
  store.authClearAll();

  const authStates = [];
  const session = new WhatsAppSession({
    createSocket: async () => {
      const auth = await useDatabaseAuthState();
      authStates.push(auth);
      const sock = {
        user: { id: "1@s.whatsapp.net" },
        ev: new EventEmitter(),
        async end() {},
        async logout() {},
      };
      return {
        sock,
        saveCreds: auth.saveCreds,
        clearAll: auth.clearAll,
        fence: auth.fence,
        isPaired: true,
      };
    },
    attachListeners: (sock, { onConnectionUpdate }) => {
      sock.updates = onConnectionUpdate;
    },
    onOpen: async () => {},
    checkConsent: () => ({ ok: true }),
    log: silent,
    isLinked: () => true,
    clearDirectory: () => {},
  });

  await session.start();
  equal("session starts in starting state", session.state, S.STARTING);
  equal("one real auth state created", authStates.length, 1);
  const oldAuth = authStates[0];
  const txKeys = addTransactionCapability(oldAuth.state.keys, silent, {
    maxCommitRetries: 4,
    delayBetweenTriesMs: 25,
  });

  let attempts = 0;
  let logoutPromise = null;
  const originalApply = store.authApply;
  store.authApply = (entries) => {
    attempts += 1;
    if (attempts === 1) {
      setTimeout(() => {
        logoutPromise = session.logout();
      }, 5);
      throw new Error("sqlite-busy-before-logout");
    }
    return originalApply(entries);
  };

  let commitErr = null;
  try {
    await txKeys.transaction(async () => {
      await txKeys.set({ session: { "stale-peer@s.whatsapp.net": { v: 1 } } });
    }, "send-before-logout");
  } catch (err) {
    commitErr = err;
  } finally {
    store.authApply = originalApply;
  }

  if (logoutPromise) await logoutPromise;
  equal("session is logged out", session.state, S.LOGGED_OUT);
  equal("commitWithRetry rejected with AUTH_STORE_FENCED", commitErr?.code, AUTH_STORE_FENCED);
  equal(
    "stale key was not written after session.logout()",
    store.authRead("session-stale-peer@s.whatsapp.net"),
    null,
  );
}

{
  // 6. Pairing-code failure leaves socket A in ERROR; calling start() while
  // logout() awaits A's teardown must not leave an unfenced socket B or
  // repopulate auth after unlink.
  const { AUTH_STORE_FENCED, useDatabaseAuthState } = await import(
    "../src/auth/use-database-auth-state.js"
  );
  const store = harnessRequire("./src/db/store.cjs");
  store.authClearAll();

  let notifyEnteredTeardown;
  const enteredTeardown = new Promise((resolve) => {
    notifyEnteredTeardown = resolve;
  });
  let releaseTeardown;
  const teardownGate = new Promise((resolve) => {
    releaseTeardown = resolve;
  });

  const sockets = [];
  const authStates = [];
  const session = new WhatsAppSession({
    createSocket: async () => {
      const auth = await useDatabaseAuthState();
      const idx = sockets.length;
      const sock = {
        index: idx,
        user: null,
        ended: 0,
        loggedOut: 0,
        fenced: 0,
        ev: new EventEmitter(),
        async logout() {
          this.loggedOut += 1;
          if (idx === 0) {
            notifyEnteredTeardown();
            await teardownGate;
          }
        },
        async end() {
          this.ended += 1;
        },
        async requestPairingCode() {
          throw new Error("pairing code rejected");
        },
        updates: null,
      };
      sockets.push(sock);
      authStates.push(auth);
      return {
        sock,
        saveCreds: auth.saveCreds,
        clearAll: auth.clearAll,
        fence: () => {
          sock.fenced += 1;
          auth.fence();
        },
        isPaired: false,
      };
    },
    attachListeners: (sock, { onConnectionUpdate }) => {
      sock.updates = onConnectionUpdate;
    },
    onOpen: async () => {},
    checkConsent: () => ({ ok: true }),
    log: silent,
    pairingCodeDelayMs: 0,
    isLinked: () => false,
    clearDirectory: () => {},
  });

  await session.start({ method: "pairing", phone: "201012345678" });
  await sockets[0].updates({ qr: "pair-device-stanza" });
  equal("pairing failure puts session in ERROR", session.state, S.ERROR);
  equal("socket A is still present in ERROR", session.socket, sockets[0]);
  ok("creds row exists before unlink", store.authRead("creds") !== null);

  const unlinking = session.logout();
  await enteredTeardown;
  equal("socket A is fenced as soon as logout starts", sockets[0].fenced, 1);
  equal("canStart is false while logout is in flight", session.getState().canStart, false);
  equal("canUnlink is false while logout is in flight", session.getState().canUnlink, false);

  // Attempt to start while logout() is still awaiting socket A's teardown.
  const overlappingStart = session.start();
  releaseTeardown();
  const [logoutState, startState] = await Promise.all([unlinking, overlappingStart]);

  equal("logout finishes in LOGGED_OUT", logoutState.state, S.LOGGED_OUT);
  equal("overlapping start resolves to LOGGED_OUT", startState.state, S.LOGGED_OUT);
  equal("no live socket remains on session", session.socket, null);
  ok(
    "every created socket was ended and fenced",
    sockets.every((s) => s.ended >= 1 && s.fenced >= 1),
  );
  for (const auth of authStates) {
    await auth.saveCreds();
    let setCode = null;
    try {
      await auth.state.keys.set({ session: { "after-overlap@s.whatsapp.net": { v: 1 } } });
    } catch (err) {
      setCode = err?.code;
    }
    equal("fenced auth state rejects keys.set after overlap", setCode, AUTH_STORE_FENCED);
  }
  equal("auth creds stay cleared after overlapping start", store.authRead("creds"), null);
  equal(
    "no session key written after overlapping start",
    store.authRead("session-after-overlap@s.whatsapp.net"),
    null,
  );
}

section("logout closes reaction automation before it waits for the socket");

{
  const { attachReactionIntake } = await import("../src/automation/reactions.js");
  const h = makeHarness({ paired: true });
  await h.session.start();
  await h.push({ connection: "open" });
  const sock = h.sockets[0];

  let reactionCloses = 0;
  attachReactionIntake(sock, { onClose: () => (reactionCloses += 1) });

  let resolveLogout;
  sock.logout = () => {
    sock.loggedOut += 1;
    return new Promise((resolve) => {
      resolveLogout = resolve;
    });
  };

  const unlinking = h.session.logout();
  await sleep(10);
  equal("logout() was called on the socket and is still pending", sock.loggedOut, 1);
  equal("reaction intake closed while socket logout() is pending", reactionCloses, 1);

  resolveLogout();
  const state = await unlinking;
  equal("logout finishes in LOGGED_OUT", state.state, S.LOGGED_OUT);
  equal("reaction intake closed exactly once", reactionCloses, 1);
  equal("no live socket remains on session", h.session.socket, null);
}

section("logout advances accountEpoch before its first await");

{
  const before = accountEpoch();
  let atLogout = null;
  const h = makeHarness({ paired: true });
  await h.session.start();
  await h.push({ connection: "open" });
  h.sockets[0].logout = async () => {
    h.sockets[0].loggedOut += 1;
    atLogout = accountEpoch();
  };
  await h.session.logout();
  equal("epoch advanced before socket logout", atLogout, before + 1);
}

section("a logged-out close advances accountEpoch before clearAll");

{
  const before = accountEpoch();
  let atClear = null;
  const h = makeHarness({
    paired: true,
    clearAll: async () => {
      atClear = accountEpoch();
    },
  });
  await h.session.start();
  await h.push({ connection: "open" });
  // #onConnectionUpdate only closes on connection === "close".
  await h.push({
    connection: "close",
    lastDisconnect: closedWith(DisconnectReason.loggedOut, "logged out"),
  });
  equal("epoch advanced before clearAll", atClear, before + 1);
}

section("work started after the first epoch advance writes nothing after the wipe");

{
  const { handleIncomingMessage } = await import("../src/handlers/message.handler.js");
  const { getUserMetadata, listAutoDeleteLog } = await import("../src/utils/storage.esm.js");
  const autoDelete = harnessRequire("./src/services/autoDelete.cjs");
  const realIncoming = autoDelete.handleIncoming;
  const matchSender = "201888888889@s.whatsapp.net";
  const plainSender = "201888888888@s.whatsapp.net";
  let rule;
  let releaseLogout;
  let releaseDelete;
  let releasePlain;
  let plainWaiting = false;
  const plainGate = new Promise((resolve) => {
    releasePlain = resolve;
  });
  autoDelete.handleIncoming = async function (...args) {
    if (String(args[2]).includes("plain hello")) {
      plainWaiting = true;
      await plainGate;
      return false;
    }
    return realIncoming.apply(this, args);
  };

  try {
    rule = autoDelete.createRule({ keywords: ["epochword"], keepCopy: true });
    const before = accountEpoch();
    const h = makeHarness({
      paired: true,
      realClear: true,
      clearAll: async () => {},
    });
    await h.session.start();
    await h.push({ connection: "open" });
    const sock = h.sockets[0];
    sock.logout = () =>
      new Promise((resolve) => {
        releaseLogout = resolve;
      });
    sock.chatModify = () =>
      new Promise((resolve) => {
        releaseDelete = resolve;
      });

    const unlinking = h.session.logout();
    equal("first advance is before the wipe", accountEpoch(), before + 1);

    const matchPending = handleIncomingMessage(sock, {
      type: "notify",
      messages: [
        {
          key: { remoteJid: matchSender, fromMe: false, id: "epoch-late-match" },
          messageTimestamp: 1_700_000_000,
          message: { conversation: "epochword please" },
          pushName: "Match",
        },
      ],
    });
    const plainPending = handleIncomingMessage(sock, {
      type: "notify",
      messages: [
        {
          key: { remoteJid: plainSender, fromMe: false, id: "epoch-late-plain" },
          messageTimestamp: 1_700_000_000,
          message: { conversation: "plain hello" },
          pushName: "Plain",
        },
      ],
    });

    const started = Date.now();
    while (!releaseDelete || !plainWaiting) {
      if (Date.now() - started > 1000) throw new Error("late work did not park before the wipe");
      await sleep(5);
    }
    equal("both handlers sampled the post-advance epoch", accountEpoch(), before + 1);

    releaseLogout();
    await unlinking;
    equal("clearAccountScopedState advances the epoch again", accountEpoch(), before + 2);
    equal("logout finished", h.session.state, S.LOGGED_OUT);

    releaseDelete();
    releasePlain();
    await matchPending;
    await plainPending;

    equal("late counter write did not land", autoDelete.getRule(rule.id).deletedCount, 0);
    equal("late keepCopy did not land", listAutoDeleteLog({ ruleId: rule.id, limit: 5 }).length, 0);
    equal("late metadata write did not land", getUserMetadata(plainSender), null);
    equal("match sender metadata did not land", getUserMetadata(matchSender), null);
  } finally {
    autoDelete.handleIncoming = realIncoming;
    if (rule) autoDelete.deleteRule(rule.id);
  }
}

section("offline during socket creation discards the socket and stays paused");

{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const h = makeHarness({ paired: true });
  const real = h.session.createSocket;
  h.session.createSocket = async (opts) => {
    await gate;
    return real(opts);
  };
  const starting = h.session.start();
  await h.session.setInternetOnline(false);
  release();
  await starting;
  equal("state stays paused", h.session.state, S.PAUSED);
  equal("the late socket was ended", h.sockets[0].ended, 1);
  equal("no socket was adopted", h.session.socket, null);
  equal("only the discarded socket exists", h.sockets.length, 1);
  ok("offline creation does not become ERROR", h.session.state !== S.ERROR);
}

section("a late createSocket rejection during offline does not become ERROR");

{
  let rejectGate;
  const gate = new Promise((_, reject) => {
    rejectGate = reject;
  });
  const h = makeHarness({ paired: true });
  h.session.createSocket = () => gate;
  const starting = h.session.start();
  await h.session.setInternetOnline(false);
  rejectGate(new Error("late failure"));
  await starting;
  equal("rejection while offline stays paused", h.session.state, S.PAUSED);
  equal("no socket was created", h.sockets.length, 0);
  equal("the reason stays offline", h.session.getState().reason, "offline");
}

section("offline then online during creation starts exactly one replacement");

{
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let creates = 0;
  const h = makeHarness({ paired: true });
  const real = h.session.createSocket;
  h.session.createSocket = async (opts) => {
    creates += 1;
    if (creates === 1) await gate;
    return real(opts);
  };
  const starting = h.session.start();
  await h.session.setInternetOnline(false);
  const restored = h.session.setInternetOnline(true);
  release();
  await starting;
  await restored;
  equal("exactly one replacement socket", h.sockets.length, 2);
  equal("the overtaken socket was ended", h.sockets[0].ended, 1);
  equal("the replacement is the live socket", h.session.socket, h.sockets[1]);
  equal("the replacement is starting", h.session.state, S.STARTING);
}

section("stop during a resume leaves no socket installed");

{
  // A blocks in createSocket. Offline invalidates A. Online starts waiter B.
  // Stop starts waiter C. A must not let B install a socket after Stop.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let creates = 0;
  const h = makeHarness({ paired: true });
  const real = h.session.createSocket;
  h.session.createSocket = async (opts) => {
    creates += 1;
    if (creates === 1) await gate;
    return real(opts);
  };
  const starting = h.session.start();
  await h.session.setInternetOnline(false);
  const restored = h.session.setInternetOnline(true);
  const stopping = h.session.stop();
  release();
  await starting;
  await restored;
  await stopping;
  equal("stop leaves no socket", h.session.socket, null);
  equal("stop leaves the session idle", h.session.state, S.IDLE);
  equal("the blocked attempt was ended", h.sockets[0].ended, 1);
  equal("no replacement socket was created", h.sockets.length, 1);
}

section("detach disposes listeners and a queued contained callback does not run");

{
  let disposed = 0;
  const h = makeHarness({ paired: true });
  h.session.attachListeners = () => () => {
    disposed += 1;
  };
  await h.session.start();
  await h.session.stop();
  equal("stop calls the disposer", disposed, 1);
}

{
  const h = makeHarness({ paired: true });
  await h.session.start();
  await h.session.stop();
  equal("a listener factory that returns undefined still reaches idle", h.session.state, S.IDLE);
}

{
  const { setupEventListeners } = await import("../src/core/events.js");
  const { disposeReactionIntake } = await import("../src/automation/reactions.js");
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  const sock = { ev, ws, user: { id: "201000000099@s.whatsapp.net" } };
  let updates = 0;
  let handshake = null;
  const dispose = setupEventListeners(sock, {
    onConnectionUpdate: () => {
      updates += 1;
    },
    onHandshakeRejected: (response) => {
      handshake = response;
    },
  });
  try {
    ws.emit("unexpected-response", { url: "https://example.invalid" }, { statusCode: 407 });
    await Promise.resolve();
    equal("407 reaches onHandshakeRejected", handshake?.statusCode, 407);
    ev.emit("connection.update", { connection: "close" });
    dispose();
    await Promise.resolve();
    equal("a disposed connection update does not run", updates, 0);
  } finally {
    dispose();
    disposeReactionIntake(sock);
  }
}

finish();
