// Recovery email: mask, sealed storage, the settings routes, and the login-page
// reset channel. The relay is a local stub. LEVIX_RECOVERY_URL is read at call
// time, the same way LEVIX_FEEDBACK_URL is.
//
// In-process checks use the first temp directory. The HTTP child gets its own
// --data directory, because paths.cjs freezes DATA_DIR on first require.

import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  require,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

const ADDRESS = "recover.me@example.com";
const OTHER = "other.box@gmail.com";
const NEXT_PASSWORD = "replacement-password";

const dataDir = useTempDataDir("levix-recovery");

const received = [];
let relayMode = "ok";
const stub = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {}
    received.push(body);
    const status = relayMode === "invalid" ? 400 : relayMode === "rate" ? 429 : relayMode === "down" ? 503 : 200;
    const error =
      relayMode === "invalid" ? "invalid" : relayMode === "rate" ? "rate_limited" : "unavailable";
    const payload = relayMode === "ok" ? { ok: true } : { ok: false, error };
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.LEVIX_RECOVERY_URL = `http://127.0.0.1:${stub.address().port}/api/recovery-email`;

const recovery = require("./src/panel/recovery-email.cjs");
const reset = require("./src/panel/password-reset.cjs");
const secrets = require("./src/config/secrets.cjs");
const transfer = require("./src/services/settingsTransfer.cjs");
const store = require("./src/db/store.cjs");

secrets.setDashboardPassword("a-good-password");

function lastRelay() {
  return received[received.length - 1];
}

function wrongCodes(real) {
  const codes = [];
  for (let i = 0; codes.length < 5 && i < 20; i += 1) {
    const candidate = String(i).padStart(6, "0");
    if (candidate !== real) codes.push(candidate);
  }
  return codes;
}

function diskHas(dir, needle) {
  const bytes = Buffer.from(needle);
  return ["levix.db", "levix.db-wal", "levix.db-shm"].some((name) => {
    const path = join(dir, name);
    return existsSync(path) && readFileSync(path).includes(bytes);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

section("masking");

equal("two local characters and the tld", recovery.maskEmail("abdelrhman@gmail.com"), "ab***@g***.com");
equal("a one-character local part", recovery.maskEmail("a@x.io"), "a***@x***.io");
equal("the last label only", recovery.maskEmail("user.name+tag@mail.example.co.uk"), "us***@m***.uk");
equal("the settings address", recovery.maskEmail(ADDRESS), "re***@e***.com");
equal("the replacement address", recovery.maskEmail(OTHER), "ot***@g***.com");
equal("no at-sign", recovery.maskEmail("not-an-email"), "***");
equal("relay timeout is 15 seconds", recovery.RELAY_TIMEOUT_MS, 15_000);

section("a bad address never reaches the relay");

const rejected = [
  "",
  "not-an-email",
  "a@b",
  "a@b.c",
  "user@localhost",
  "مستخدم@example.com",
  "a b@example.com",
  "a@example.com\n",
  ".a@example.com",
  "a..b@example.com",
  "a@[127.0.0.1]",
  '"quoted"@example.com',
];
for (const email of rejected) {
  const result = await recovery.startVerification(email, "en", "10.0.0.1");
  equal(`rejected ${JSON.stringify(email)}`, result.reason, "invalid_email");
}
equal("the stub saw none of them", received.length, 0);

section("reset refuses a missing email and an unknown channel before the throttle");

let result = await reset.requestResetCode("10.0.0.1", { channel: "email" });
equal("no saved address", result.reason, "no_email");
result = await reset.requestResetCode("10.0.0.1", { channel: "carrier-pigeon" });
equal("unknown channel", result.reason, "invalid");
result = await reset.requestResetCode("10.0.0.1");
equal("an empty channel is still WhatsApp", result.reason, "no_session");
equal("none of those called the relay", received.length, 0);
result = await reset.requestResetCode("10.0.0.1", { channel: "email" });
equal("the unknown channel did not spend the cooldown", result.reason, "no_email");

section("relay errors become stable codes and leave no code behind");

for (const [mode, reason] of [
  ["invalid", "invalid"],
  ["rate", "rate_limited"],
  ["down", "unavailable"],
]) {
  relayMode = mode;
  const before = received.length;
  result = await recovery.startVerification(ADDRESS, "en", "10.0.0.2");
  equal(`${mode} -> ${reason}`, result.reason, reason);
  equal(`${mode} did not store a code`, recovery.confirmVerification("000000").reason, "no_pending");
  equal(`${mode} did reach the stub`, received.length, before + 1);
}
relayMode = "ok";
equal("a failed send did not spend the cooldown", (await recovery.startVerification(ADDRESS, "ar", "10.0.0.2")).ok, true);

section("the verify code is hashed, timed, and limited");

let relayBody = lastRelay();
equal("kind is verify", relayBody.kind, "verify");
equal("the address is normalized", relayBody.to, ADDRESS);
equal("lang follows the panel", relayBody.lang, "ar");
equal("the body is exactly the contract", Object.keys(relayBody).sort().join(","), "code,kind,lang,to");
ok("the code is 6 digits", /^\d{6}$/.test(relayBody.code));
equal("nothing is saved before verify", recovery.publicStatus().verified, false);
equal("the vault row is still empty", secrets.getRecoveryEmail(), null);

recovery._expireForTests();
equal("an expired code is refused", recovery.confirmVerification(relayBody.code).reason, "expired");
equal("expiry did not save the address", secrets.getRecoveryEmail(), null);

recovery._resetForTests();
result = await recovery.startVerification(`  ${ADDRESS.toUpperCase()}  `, undefined, "10.0.0.3");
equal("a fresh start defaults lang to en", lastRelay().lang, "en");
const verifyCode = lastRelay().code;
const guesses = wrongCodes(verifyCode);
equal("first wrong guess", recovery.confirmVerification(guesses[0]).attemptsLeft, 4);
equal("second wrong guess", recovery.confirmVerification(guesses[1]).attemptsLeft, 3);
equal("third wrong guess", recovery.confirmVerification(guesses[2]).attemptsLeft, 2);
equal("fourth wrong guess", recovery.confirmVerification(guesses[3]).attemptsLeft, 1);
equal("fifth wrong guess kills it", recovery.confirmVerification(guesses[4]).reason, "too_many_attempts");
equal("the real code is dead too", recovery.confirmVerification(verifyCode).reason, "no_pending");
equal("a burned code saved nothing", secrets.getRecoveryEmail(), null);

section("verify seals the address and export cannot see it");

recovery._resetForTests();
await recovery.startVerification(ADDRESS, "en", "10.0.0.4");
const savedCode = lastRelay().code;
result = recovery.confirmVerification(savedCode);
equal("verify succeeds", result.ok, true);
equal("the API mask", result.masked, "re***@e***.com");
equal("status is the mask", recovery.publicStatus().masked, "re***@e***.com");
equal("status has no address field", Object.hasOwn(recovery.publicStatus(), "email"), false);
equal("delivery can still read it", recovery.getAddress(), ADDRESS);

const sealed = store.getBotSetting("auth:recovery-email");
ok("the row is sealed", typeof sealed === "string" && sealed.startsWith("enc:v1:"));
ok("the database does not contain the address", !diskHas(dataDir, ADDRESS));

const exported = transfer.exportSettings();
const dumped = JSON.stringify(exported);
ok("export omits the address", !dumped.includes(ADDRESS));
ok("export omits the key", !dumped.includes("auth:recovery-email"));
exported.settings["auth:recovery-email"] = "planted@evil.test";
const imported = transfer.applyImport(exported);
ok(
  "import skips the planted key",
  imported.skipped.some((row) => row.key === "auth:recovery-email"),
);
equal("the planted value did not stick", secrets.getRecoveryEmail(), ADDRESS);

section("the previous address stays until the new one is verified");

recovery._resetForTests();
await recovery.startVerification(OTHER, "en", "10.0.0.5");
const otherCode = lastRelay().code;
equal("still the first address", secrets.getRecoveryEmail(), ADDRESS);
equal("the mask is still the first", recovery.publicStatus().masked, "re***@e***.com");
equal("a wrong code does not swap it", recovery.confirmVerification(wrongCodes(otherCode)[0]).reason, "wrong_code");
equal("still the first after the wrong code", secrets.getRecoveryEmail(), ADDRESS);
result = recovery.confirmVerification(otherCode);
equal("the new mask", result.masked, "ot***@g***.com");
equal("now the second address", secrets.getRecoveryEmail(), OTHER);

section("email reset shares the WhatsApp throttle and bumps the epoch");

const sent = [];
reset.setSession({
  socket: {
    user: { id: "201234567890@s.whatsapp.net" },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: "fake" } };
    },
  },
});

reset._resetForTests();
const beforeEpoch = secrets.getPasswordUpdatedAt();
result = await reset.requestResetCode("10.4.0.1", { channel: "email", lang: "ar" });
equal("email reset sends", result.ok, true);
equal("reset kind", lastRelay().kind, "reset");
equal("reset lang", lastRelay().lang, "ar");
equal("reset goes to the verified address", lastRelay().to, OTHER);
const resetCode = lastRelay().code;
const sentBefore = sent.length;
result = await reset.requestResetCode("10.4.0.2");
equal("WhatsApp is throttled by the email send", result.reason, "throttled");
equal("the throttled request sent nothing", sent.length, sentBefore);

const resetGuesses = wrongCodes(resetCode);
equal("mismatch does not burn it", reset.completeReset(resetCode, "one-pass", "other-pass").reason, "mismatch");
equal("first reset wrong guess", reset.completeReset(resetGuesses[0], "good-password", "good-password").attemptsLeft, 4);
equal("second reset wrong guess", reset.completeReset(resetGuesses[1], "good-password", "good-password").attemptsLeft, 3);
equal("third reset wrong guess", reset.completeReset(resetGuesses[2], "good-password", "good-password").attemptsLeft, 2);
equal(
  "a short password does not burn the matching code",
  reset.completeReset(resetCode, "short", "short").reason,
  "invalid_password",
);
equal(
  "the attempt was given back",
  reset.completeReset(resetGuesses[3], "good-password", "good-password").attemptsLeft,
  1,
);
result = reset.completeReset(resetCode, "email-reset-password", "email-reset-password");
equal("the email code still resets", result.ok, true);
ok("the epoch moved", secrets.getPasswordUpdatedAt() > beforeEpoch);
equal("the new password works", secrets.verifyDashboardPassword("email-reset-password"), true);
equal("the code is single use", reset.completeReset(resetCode, "email-reset-password", "email-reset-password").reason, "no_pending");

section("a WhatsApp send throttles the email channel, not verification");

reset._resetForTests();
sent.length = 0;
result = await reset.requestResetCode("10.4.0.3");
equal("WhatsApp send works", result.ok, true);
const waCode = /\b(\d{6})\b/.exec(sent[0].content.text)?.[1];
ok("the WhatsApp text still carries the code", Boolean(waCode));
const relayBefore = received.length;
result = await reset.requestResetCode("10.4.0.4", { channel: "email", lang: "en" });
equal("email is throttled by the WhatsApp send", result.reason, "throttled");
equal("the throttled email did not call the relay", received.length, relayBefore);
equal("the WhatsApp code is still the live one", reset.completeReset(waCode, "wa-reset-password", "wa-reset-password").ok, true);

recovery._resetForTests();
result = await recovery.startVerification(ADDRESS, "en", "10.4.0.5");
equal("verification has its own throttle", result.ok, true);
const crossVerify = lastRelay().code;
equal("the saved address is unchanged until verify", secrets.getRecoveryEmail(), OTHER);

reset._resetForTests();
result = await reset.requestResetCode("10.4.0.6", { channel: "email", lang: "en" });
equal("a new email reset sends", result.ok, true);
const crossReset = lastRelay().code;
equal("the verify code is not the reset code", reset.completeReset(crossVerify, "cross-password-1", "cross-password-1").reason, "wrong_code");
equal("the reset code is not the verify code", recovery.confirmVerification(crossReset).reason, "wrong_code");
equal("the verify code still verifies", recovery.confirmVerification(crossVerify).ok, true);
equal("verification replaced the address", secrets.getRecoveryEmail(), ADDRESS);
const epochBeforeCross = secrets.getPasswordUpdatedAt();
equal("the reset code still resets", reset.completeReset(crossReset, "cross-password-1", "cross-password-1").ok, true);
ok("that reset bumped the epoch too", secrets.getPasswordUpdatedAt() > epochBeforeCross);

section("removing the address does not cancel a code already sent");

reset._resetForTests();
await reset.requestResetCode("10.5.0.1", { channel: "email" });
const orphan = lastRelay().code;
recovery.remove();
equal("remove clears the address", secrets.getRecoveryEmail(), null);
equal("remove clears the public status", recovery.publicStatus().verified, false);
equal("the reset code still works", reset.completeReset(orphan, "after-remove-1", "after-remove-1").ok, true);

recovery._resetForTests();
await recovery.startVerification(ADDRESS, "en", "10.5.0.2");
recovery.remove();
equal("remove drops a verify code", recovery.confirmVerification(lastRelay().code).reason, "no_pending");
equal("the address stays gone", secrets.getRecoveryEmail(), null);

section("the panel routes and the login page");

received.length = 0;
const webDir = useTempDataDir("levix-recovery-http");
let server;
let server2;
try {
  server = await startServer({ dataDir: webDir, trust: "", routes: true });
  const http = httpClient(server.base);
  const anon = httpClient(server.base);

  let res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("setup signs in", res.status, 303);

  res = await anon.call("/login");
  equal("anonymous login renders", res.status, 200);
  let html = await res.text();
  ok("WhatsApp is offered", html.includes('data-channel="whatsapp"'));
  ok("email is hidden until an address exists", !html.includes('data-channel="email"'));
  ok("the page has no address", !html.includes(ADDRESS));

  res = await anon.call("/dashboard/api/recovery-email");
  equal("the status route requires the session", res.status, 401);
  ok("the 401 body has no address", !(await res.text()).includes(ADDRESS));

  const beforeCross = received.length;
  res = await http.call("/dashboard/api/recovery-email/start", {
    method: "POST",
    headers: {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
      "content-type": "application/json",
    },
    body: JSON.stringify({ email: ADDRESS, lang: "en" }),
  });
  equal("a cross-site start is rejected", res.status, 403);
  equal("the cross-site start did not call the relay", received.length, beforeCross);

  res = await http.json("/dashboard/api/recovery-email/start", { email: "not-an-email", lang: "en" });
  equal("the route rejects a bad address", res.status, 400);
  equal("the stable code is invalid_email", (await res.json()).error, "invalid_email");
  equal("a bad address still did not call the relay", received.length, beforeCross);

  res = await http.json("/dashboard/api/recovery-email/start", { email: ADDRESS, lang: "en" });
  equal("start is 200", res.status, 200);
  let body = await res.json();
  ok("start does not echo the address", !JSON.stringify(body).includes(ADDRESS));
  const code = lastRelay().code;
  equal("the route sent a verify code", lastRelay().kind, "verify");

  res = await http.json("/dashboard/api/recovery-email/verify", { code: wrongCodes(code)[0] });
  equal("a wrong code is 400, not a logged-out 401", res.status, 400);
  body = await res.json();
  equal("wrong code", body.error, "wrong_code");
  equal("attempts left", body.attemptsLeft, 4);

  res = await http.json("/dashboard/api/recovery-email/verify", { code });
  equal("verify is 200", res.status, 200);
  body = await res.json();
  equal("verify returns the mask", body.masked, "re***@e***.com");
  ok("verify does not return the address", !JSON.stringify(body).includes(ADDRESS));

  res = await http.call("/dashboard/api/recovery-email");
  body = await res.json();
  equal("GET is verified", body.verified, true);
  equal("GET is the mask", body.masked, "re***@e***.com");
  ok("GET has no address", !JSON.stringify(body).includes(ADDRESS));
  ok("the child database does not contain the address", !diskHas(webDir, ADDRESS));
  ok("the child database holds the sealed row", diskHas(webDir, "enc:v1:"));

  res = await http.call("/dashboard/api/settings/export");
  const exportText = await res.text();
  ok("HTTP export omits the address", !exportText.includes(ADDRESS));
  ok("HTTP export omits the key", !exportText.includes("auth:recovery-email"));

  res = await http.call("/dashboard/api/settings");
  const settingsText = await res.text();
  ok("settings list omits the address", !settingsText.includes(ADDRESS));
  ok("settings list omits the key", !settingsText.includes("auth:recovery-email"));

  const planted = JSON.parse(exportText);
  planted.settings["auth:recovery-email"] = "planted@evil.test";
  res = await http.json("/dashboard/api/settings/import", planted);
  equal("import accepts the file", res.status, 200);
  body = await res.json();
  ok("import skipped the planted key", body.skipped.some((row) => row.key === "auth:recovery-email"));
  res = await http.call("/dashboard/api/recovery-email");
  body = await res.json();
  equal("the mask survived the import", body.masked, "re***@e***.com");

  res = await anon.call("/login");
  html = await res.text();
  ok("the login page shows the mask", html.includes("re***@e***.com"));
  ok("the login page offers email", html.includes('data-channel="email"'));
  ok("the login page still hides the address", !html.includes(ADDRESS));

  const resetsBefore = received.length;
  res = await anon.json("/reset/request", { channel: "email", lang: "ar" });
  equal("email reset is 200", res.status, 200);
  body = await res.json();
  equal("email reset ok", body.ok, true);
  equal("email reset channel", body.channel, "email");
  equal("HTTP reset kind", lastRelay().kind, "reset");
  equal("HTTP reset lang", lastRelay().lang, "ar");
  equal("HTTP reset recipient", lastRelay().to, ADDRESS);
  const httpResetCode = lastRelay().code;

  res = await anon.json("/reset/request", {});
  equal("the shared throttle is 429", res.status, 429);
  equal("the reason is throttled", (await res.json()).reason, "throttled");
  equal("the throttled WhatsApp request did not send mail", received.length, resetsBefore + 1);

  res = await anon.json("/reset/confirm", {
    code: httpResetCode,
    password: NEXT_PASSWORD,
    confirm: NEXT_PASSWORD,
  });
  equal("confirm is 200", res.status, 200);
  equal("confirm ok", (await res.json()).ok, true);

  res = await http.call("/dashboard/api/stats");
  equal("the old session died with the epoch", res.status, 401);

  res = await anon.form("/login", { password: "a-good-password" });
  equal("the old password is refused", res.status, 401);
  res = await anon.form("/login", { password: NEXT_PASSWORD });
  equal("the new password signs in", res.status, 303);

  server.stop();
  server = null;
  await sleep(400);

  server2 = await startServer({ dataDir: webDir, trust: "", routes: true });
  const again = httpClient(server2.base);
  res = await again.form("/login", { password: NEXT_PASSWORD });
  equal("the new password survives a restart", res.status, 303);

  res = await again.json("/reset/request", { channel: "email", lang: "en" });
  equal("a restarted process can still email a code", res.status, 200);
  const live = lastRelay().code;
  const liveGuesses = wrongCodes(live);
  let lastReason = "";
  for (const guess of liveGuesses) {
    res = await again.json("/reset/confirm", {
      code: guess,
      password: "another-good-1",
      confirm: "another-good-1",
    });
    equal("a wrong reset confirm stays 401", res.status, 401);
    lastReason = (await res.json()).reason;
  }
  equal("the fifth wrong confirm burns the code", lastReason, "too_many_attempts");

  const locked = httpClient(server2.base);
  res = await locked.form("/login", { password: NEXT_PASSWORD });
  equal("those guesses locked login", res.status, 429);

  res = await again.call("/dashboard/api/recovery-email", { method: "DELETE" });
  equal("delete is 200", res.status, 200);
  body = await res.json();
  equal("delete clears verified", body.verified, false);
  ok("delete does not return an address", !JSON.stringify(body).includes(ADDRESS));

  const fresh = httpClient(server2.base);
  res = await fresh.call("/login");
  html = await res.text();
  ok("email leaves the login page with the address", !html.includes('data-channel="email"'));
  ok("WhatsApp remains", html.includes('data-channel="whatsapp"'));
  ok("the mask is gone", !html.includes("re***@e***.com"));
} catch (error) {
  ok("http section ran", false, error?.stack || String(error));
} finally {
  server?.stop();
  server2?.stop();
  await new Promise((resolve) => stub.close(resolve));
}

finish();
