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
import {
  useTempDataDir,
  require as harnessRequire,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";

useTempDataDir("levix-session");

const { WhatsAppSession, SESSION_STATES } = await import("../src/core/session.js");
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
function makeHarness({ paired = false, retryDelaysMs, clearAll } = {}) {
  const sockets = [];
  const events = [];

  const createSocket = async () => {
    const sock = {
      index: sockets.length,
      user: null,
      ended: 0,
      loggedOut: 0,
      ev: new EventEmitter(),
      async end() {
        this.ended += 1;
      },
      async logout() {
        this.loggedOut += 1;
      },
      updates: null,
    };
    sockets.push(sock);
    return { sock, saveCreds: async () => {}, clearAll, isPaired: paired };
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
    log: silent,
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
  JSON.stringify([5000, 10000, 15000, 20000, 25000])
);
equal("five attempts", MAX_RETRIES, 5);
ok("the schedule is frozen", Object.isFrozen(RETRY_SCHEDULE_MS));
{
  const steps = RETRY_SCHEDULE_MS.map((ms, i) => (i ? ms - RETRY_SCHEDULE_MS[i - 1] : ms));
  ok("every step is the same 5s — linear, not exponential", steps.every((s) => s === 5000));
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
  // The same window, but the operator unlinks instead of stopping. Unlinking
  // while a socket is being created must not leave that socket alive.
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
  equal("the credentials were cleared", cleared, 1);
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
  ok("the QR went out to whoever is listening", h.events.some((e) => e.event === "qr"));

  // The connection drops before a phone ever scanned it.
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.timedOut) });

  equal("the pairing attempt ends", h.session.state, S.DISCONNECTED);
  equal("no second socket was created", h.sockets.length, 1);
  equal("the stale code is gone", h.session.qr, null);
  ok("the panel is told the code is gone", h.events.some((e) => e.event === "qr_cleared"));
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

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.restartRequired) });
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

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionClosed) });

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
    Array.isArray(h.events) && h.session.getState().nextRetryAt !== null
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
    observed.every((ms, i) => i === 0 || ms > observed[i - 1])
  );

  // One more close, with the schedule used up.
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
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
      "utf8"
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

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
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

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
  equal("one attempt used", h.session.getState().attempt, 1);
  await sleep(60);

  h.latest().user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("connected again", h.session.state, S.CONNECTED);
  equal("the counter is back to zero", h.session.getState().attempt, 0);

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
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

  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
  await sleep(60);
  equal("a second socket exists", h.sockets.length, 2);
  h.sockets[1].user = { id: "1@s.whatsapp.net" };
  await h.push({ connection: "open" });
  equal("and it is the live one", h.session.state, S.CONNECTED);

  // The old socket finally gets round to reporting its own death.
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) }, first);
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

  await h.push({ connection: "close", lastDisconnect: closedWith(CONNECTION_FAILURE_405, "Connection Failure") });

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
  ok("…and marked as the pairing handshake", classifyDisconnect(DisconnectReason.restartRequired).restartRequired);

  for (const code of [DisconnectReason.connectionClosed, DisconnectReason.connectionLost, DisconnectReason.badSession, DisconnectReason.unavailableService, undefined]) {
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
  await h.push({ connection: "close", lastDisconnect: closedWith(DisconnectReason.connectionLost) });
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
    [join(here, "fixtures", "reconnect-liveness.mjs"), "--data", mkdtempSync(join(tmpdir(), "levix-liveness-"))],
    { encoding: "utf8", timeout: 30000, env: { ...process.env, LEVIX_DATA_DIR: "" } }
  );

  const out = `${result.stdout || ""}${result.stderr || ""}`;
  ok(
    "the process was still there when the retry fired",
    out.includes("RECONNECTED"),
    out.trim().split("\n").slice(-3).join(" | ")
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

finish();
