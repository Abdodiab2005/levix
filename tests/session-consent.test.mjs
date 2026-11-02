// Terms consent belongs to the session's socket-creation boundary.
// Every socket and listener here is fake; the record integration uses isolated data.

import { EventEmitter } from "node:events";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-session-consent");

const { WhatsAppSession, SESSION_STATES } = await import("../src/core/session.js");
const { sessionStartupPolicy } = await import("../src/bootstrap/session-startup-policy.js");
const { DisconnectReason } = await import("@whiskeysockets/baileys");
const S = SESSION_STATES;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, label, timeoutMs = 600) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await sleep(5);
  ok(label, predicate());
}

function makeHarness({ accepted = false, paired = true, checkConsent, useRealConsent = false } = {}) {
  const sockets = [];
  const socketOptions = [];
  const warnings = [];
  let checks = 0;
  let clears = 0;
  let allowed = accepted;
  const options = {
    createSocket: async (given) => {
      socketOptions.push(given);
      const sock = {
        ev: new EventEmitter(),
        async end() {},
        async logout() {},
      };
      sockets.push(sock);
      return { sock, saveCreds: async () => {}, clearAll: async () => {}, isPaired: paired };
    },
    attachListeners: (sock, { onConnectionUpdate }) => {
      sock.update = onConnectionUpdate;
    },
    clearCredentials: async () => {
      clears += 1;
    },
    clearDirectory: () => {},
    isLinked: () => paired,
    onOpen: async () => {},
    loadProxy: () => null,
    buildProxyAgents: () => null,
    pairingCodeDelayMs: 0,
    retryDelaysMs: [20, 40],
    consentPollMs: 30,
    log: {
      info() {},
      warn(message) { warnings.push(message); },
      error() {},
      debug() {},
    },
  };
  if (!useRealConsent) {
    options.checkConsent = () => {
      checks += 1;
      return checkConsent ? checkConsent() : { ok: allowed, reason: allowed ? null : "terms_not_accepted" };
    };
  }
  const session = new WhatsAppSession(options);
  return {
    session,
    sockets,
    socketOptions,
    warnings,
    get checks() { return checks; },
    get clears() { return clears; },
    accept() { allowed = true; },
    reject() { allowed = false; },
    push(update) { return sockets.at(-1).update(update); },
  };
}

section("start waits before creating a socket or touching credentials");
{
  const h = makeHarness();
  await h.session.start();
  equal("state", h.session.state, S.CONSENT_REQUIRED);
  equal("sockets", h.sockets.length, 0);
  equal("consentRequired", h.session.getState().consentRequired, true);
  equal("reason", h.session.getState().reason, "terms_not_accepted");
  equal("canStart", h.session.getState().canStart, true);
  equal("credentials untouched", h.clears, 0);
  await h.session.stop();
}

section("the poll resumes a blocked start without another Start");
{
  const h = makeHarness();
  await h.session.start();
  h.accept();
  await waitFor(() => h.sockets.length === 1, "one socket appears after acceptance");
  ok("state leaves consent_required", h.session.state !== S.CONSENT_REQUIRED);
  await h.session.stop();
}

section("recheckConsent resumes immediately only with valid consent");
{
  const h = makeHarness();
  await h.session.start();
  await h.session.recheckConsent();
  equal("invalid consent creates no socket", h.sockets.length, 0);
  h.accept();
  await h.session.recheckConsent();
  equal("valid consent creates one socket", h.sockets.length, 1);
  await h.session.stop();
}

section("pairing-code intent survives consent and a second default Start");
{
  const h = makeHarness({ paired: false });
  await h.session.start({ method: "pairing", phone: "+20 100 000 0000" });
  await h.session.start();
  equal("still no socket", h.sockets.length, 0);
  h.accept();
  await h.session.recheckConsent();
  equal("pairing code requested", h.socketOptions[0]?.pairingCode, true);
  await h.session.stop();
}

section("a live socket stays connected; its next retry checks consent");
{
  const h = makeHarness({ accepted: true });
  await h.session.start();
  const original = h.sockets[0];
  await h.push({ connection: "open" });
  h.reject();
  await sleep(110);
  equal("still connected", h.session.state, S.CONNECTED);
  equal("same socket", h.session.socket, original);
  equal("no extra socket", h.sockets.length, 1);
  await h.push({
    connection: "close",
    lastDisconnect: { error: { message: "test", output: { statusCode: DisconnectReason.timedOut } } },
  });
  await waitFor(() => h.session.state === S.CONSENT_REQUIRED, "retry reaches consent_required");
  equal("retry creates no socket", h.sockets.length, 1);
  await h.session.stop();
}

section("network restoration and reconnect both pass the gate");
{
  const network = makeHarness();
  await network.session.start();
  await network.session.setInternetOnline(false);
  equal("going offline leaves the consent state", network.session.state, S.PAUSED);
  const checks = network.checks;
  await sleep(110);
  equal("offline transition cancels polling", network.checks, checks);
  await network.session.setInternetOnline(true);
  equal("network restore waits", network.session.state, S.CONSENT_REQUIRED);
  equal("network restore creates no socket", network.sockets.length, 0);
  await network.session.stop();

  const reconnect = makeHarness();
  await reconnect.session.reconnect();
  equal("reconnect waits", reconnect.session.state, S.CONSENT_REQUIRED);
  equal("reconnect creates no socket", reconnect.sockets.length, 0);
  await reconnect.session.stop();
}

section("stop, shutdown, and logout cancel consent polling");
for (const [action, expected] of [["stop", S.IDLE], ["shutdown", S.IDLE], ["logout", S.LOGGED_OUT]]) {
  const h = makeHarness();
  await h.session.start();
  await h.session[action]();
  equal(`${action} state`, h.session.state, expected);
  const checks = h.checks;
  await sleep(110);
  equal(`${action} stops checks`, h.checks, checks);
}

section("unreadable consent fails closed");
for (const [name, checkConsent] of [
  ["throws", () => { throw new Error("database unavailable"); }],
  ["undefined", () => undefined],
]) {
  const h = makeHarness({ checkConsent });
  await h.session.start();
  equal(`${name} state`, h.session.state, S.CONSENT_REQUIRED);
  equal(`${name} reason`, h.session.getState().reason, "consent_unreadable");
  equal(`${name} sockets`, h.sockets.length, 0);
  await h.session.stop();
}

section("one warning per entry, even after several polls");
{
  const h = makeHarness();
  await h.session.start();
  await sleep(110);
  ok("polling happened", h.checks >= 3);
  equal("one warning", h.warnings.length, 1);
  await h.session.stop();
  await h.session.start();
  equal("second entry adds one warning", h.warnings.length, 2);
  await h.session.stop();
}

section("consent owns one ref'd poll timer");
{
  const nativeSetInterval = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (...args) => {
    const timer = nativeSetInterval(...args);
    timers.push(timer);
    return timer;
  };
  const h = makeHarness();
  try {
    await h.session.start();
    await h.session.start();
    await h.session.recheckConsent();
    equal("one interval was created", timers.length, 1);
    equal("the interval keeps headless alive", timers[0]?.hasRef(), true);
  } finally {
    await h.session.stop();
    globalThis.setInterval = nativeSetInterval;
  }
}

section("resume-paired boot policy still waits for consent");
{
  const policy = sessionStartupPolicy({ wasPaired: true });
  equal("boot starts", policy.start, true);
  equal("boot reason", policy.reason, "resume-paired");
  const h = makeHarness();
  await h.session.start({ reason: policy.reason });
  equal("boot waits", h.session.state, S.CONSENT_REQUIRED);
  equal("boot makes no socket", h.sockets.length, 0);
  await h.session.stop();
}

section("the real acceptance record releases the gate without changing paired credentials");
{
  const store = require("./src/db/store.cjs");
  const { documentFor } = require("./src/legal/terms.cjs");
  const { recordAcceptance } = require("./src/legal/consent.cjs");
  const creds = JSON.stringify({ registered: true, me: { id: "201000000000@s.whatsapp.net" } });
  store.authWrite("creds", creds);
  const h = makeHarness({ useRealConsent: true });
  await h.session.start();
  equal("real missing record waits", h.session.state, S.CONSENT_REQUIRED);
  equal("real missing record makes no socket", h.sockets.length, 0);
  equal("paired credentials are byte-identical", store.authRead("creds"), creds);
  const document = documentFor("en");
  recordAcceptance({ version: document.version, sha256: document.sha256, locale: "en", via: "panel" });
  await h.session.recheckConsent();
  equal("record allows one socket", h.sockets.length, 1);
  await h.session.stop();
}

finish();
