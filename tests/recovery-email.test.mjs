// Recovery email: mask, sealed storage, the settings routes, and the login-page
// reset channel. The relay is a local stub that speaks contract v2: it makes
// the verify code, checks the guesses, and refuses a reset without the token.
// LEVIX_RECOVERY_URL is read at call time, the same way LEVIX_FEEDBACK_URL is.
//
// In-process checks use the first temp directory. The HTTP child gets its own
// --data directory, because paths.cjs freezes DATA_DIR on first require.

import { createHash, randomBytes, randomInt } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  ROOT,
  require,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

const ADDRESS = "recover.me@example.com";
const OTHER = "other.box@gmail.com";
const PASSWORD = "a-good-password";
const NEXT_PASSWORD = "replacement-password";

const dataDir = useTempDataDir("levix-recovery");

// --- the relay stub -------------------------------------------------------

/** What the stub answers as the token for an address. */
function stubToken(to) {
  return `v1.${createHash("sha256").update(`stub:${to}`).digest("base64url")}`;
}

const received = []; // every body, in order
const mailed = []; // per body: the code that would reach an inbox, or null
const verifications = new Map(); // id -> { to, code, attempts }
const held = [];
let relayMode = "ok";

function relayAnswer(body) {
  if (relayMode === "invalid") return [400, { ok: false, error: "invalid" }];
  if (relayMode === "rate") return [429, { ok: false, error: "rate_limited" }];
  if (relayMode === "down") return [503, { ok: false, error: "unavailable" }];
  if (relayMode === "smtp_wrong_reason") return [503, { ok: false, error: "unverified" }];
  if (relayMode === "expired") return [400, { ok: false, error: "expired" }];
  if (relayMode === "bad_success") return [200, { ok: true }];
  if (body?.kind === "verify") {
    const id = randomBytes(16).toString("hex");
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    verifications.set(id, { to: body.to, code, attempts: 0 });
    mailed.push(code);
    return [200, { ok: true, verification: id }];
  }
  if (body?.kind === "confirm") {
    mailed.push(null);
    const row = verifications.get(body.verification);
    if (!row) return [400, { ok: false, error: "no_pending" }];
    if (row.code === body.code) {
      verifications.delete(body.verification);
      return [200, { ok: true, token: stubToken(row.to) }];
    }
    row.attempts += 1;
    if (row.attempts >= 5) {
      verifications.delete(body.verification);
      return [400, { ok: false, error: "too_many_attempts" }];
    }
    return [400, { ok: false, error: "wrong_code", attemptsLeft: 5 - row.attempts }];
  }
  if (body?.kind === "reset") {
    if (body.token !== stubToken(body.to)) {
      mailed.push(null);
      return [403, { ok: false, error: "unverified" }];
    }
    mailed.push(body.code);
    return [200, { ok: true }];
  }
  return [400, { ok: false, error: "invalid" }];
}

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
    const answer = () => {
      const [status, payload] = relayAnswer(body);
      res.writeHead(status, {
        "content-type": "application/json",
        ...(status === 429 ? { "Retry-After": "173" } : {}),
      });
      res.end(JSON.stringify(payload));
    };
    if (relayMode === "hold") {
      held.push(answer);
      return;
    }
    if (relayMode === "invalid" || relayMode === "rate" || relayMode === "down") mailed.push(null);
    answer();
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.LEVIX_RECOVERY_URL = `http://127.0.0.1:${stub.address().port}/api/recovery-email`;

const recovery = require("./src/panel/recovery-email.cjs");
const reset = require("./src/panel/password-reset.cjs");
const secrets = require("./src/config/secrets.cjs");
const vault = require("./src/config/vault.cjs");
const transfer = require("./src/services/settingsTransfer.cjs");
const store = require("./src/db/store.cjs");

secrets.setDashboardPassword(PASSWORD);

function lastRelay() {
  return received[received.length - 1];
}

/** The code the last relay request would have put in an inbox. */
function lastCode() {
  return mailed[mailed.length - 1];
}

function wrongCodes(real, count = 5) {
  const codes = [];
  for (let i = 0; codes.length < count && i < 40; i += 1) {
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

async function waitFor(predicate, ms = 2000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (predicate()) return true;
    await sleep(10);
  }
  return false;
}

/** Verify `email` through the stub, as Settings would. */
async function verifyAddress(email, peer) {
  recovery._resetForTests();
  const started = await recovery.startVerification(email, "en", peer);
  if (!started.ok) return started;
  return recovery.confirmVerification(lastCode());
}

section("masking");

equal(
  "two local characters and the tld",
  recovery.maskEmail("abdelrhman@gmail.com"),
  "ab***@g***.com",
);
equal("a one-character local part", recovery.maskEmail("a@x.io"), "a***@x***.io");
equal(
  "the last label only",
  recovery.maskEmail("user.name+tag@mail.example.co.uk"),
  "us***@m***.uk",
);
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
  "a@example.123",
  "a@example.c0m",
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

section("verification sends only the four relay language codes");

for (const [input, expected] of [
  ["ar", "ar"],
  ["en", "en"],
  ["pt-BR", "pt-BR"],
  ["es-419", "es-419"],
  ["pt", "en"],
  ["fr", "en"],
  ["PT-BR", "en"],
  [undefined, "en"],
]) {
  recovery._resetForTests();
  const sent = await recovery.startVerification(ADDRESS, input, "language-check");
  equal(`verification with ${String(input)} succeeds`, sent.ok, true);
  equal(`verification with ${String(input)} sends ${expected}`, lastRelay().lang, expected);
}
recovery._resetForTests();

section("relay errors become stable codes and leave nothing pending");

for (const [mode, reason] of [
  ["invalid", "invalid"],
  ["rate", "rate_limited"],
  ["down", "unavailable"],
]) {
  relayMode = mode;
  const before = received.length;
  result = await recovery.startVerification(ADDRESS, "en", "10.0.0.2");
  equal(`${mode} -> ${reason}`, result.reason, reason);
  if (mode === "rate") equal("relay retry delay is preserved", result.retryAfter, 173);
  equal(
    `${mode} left nothing to confirm`,
    (await recovery.confirmVerification("000000")).reason,
    "no_pending",
  );
  equal(`${mode} reached the stub once`, received.length, before + 1);
}
relayMode = "ok";
equal(
  "a failed send did not spend the cooldown",
  (await recovery.startVerification(ADDRESS, "ar", "10.0.0.2")).ok,
  true,
);

section("verify: the relay makes and checks the code");

const relayBody = lastRelay();
equal("kind is verify", relayBody.kind, "verify");
equal("the address is normalized", relayBody.to, ADDRESS);
equal("lang follows the panel", relayBody.lang, "ar");
equal("the body is exactly the contract", Object.keys(relayBody).sort().join(","), "kind,lang,to");
equal("nothing is saved before verify", recovery.publicStatus().verified, false);
equal("the vault row is still empty", secrets.getRecoveryEmail(), null);

const relayBefore = received.length;
equal(
  "a malformed guess is refused locally",
  (await recovery.confirmVerification("12ab56")).reason,
  "wrong_code",
);
equal("the malformed guess never reached the relay", received.length, relayBefore);

recovery._expireForTests();
equal(
  "an expired verification is refused",
  (await recovery.confirmVerification(lastCode())).reason,
  "expired",
);
equal("the expired one never reached the relay", received.length, relayBefore);
equal("expiry did not save the address", secrets.getRecoveryEmail(), null);

recovery._resetForTests();
result = await recovery.startVerification(`  ${ADDRESS.toUpperCase()}  `, undefined, "10.0.0.3");
equal("a fresh start defaults lang to en", lastRelay().lang, "en");
const verifyCode = lastCode();
const verifyId = [...verifications.keys()].at(-1);
const guesses = wrongCodes(verifyCode);
equal("first wrong guess", (await recovery.confirmVerification(guesses[0])).attemptsLeft, 4);
equal("the guess went to the relay", lastRelay().kind, "confirm");
equal("with the verification id", lastRelay().verification, verifyId);
equal(
  "confirm body is exactly the contract",
  Object.keys(lastRelay()).sort().join(","),
  "code,kind,verification",
);
equal("second wrong guess", (await recovery.confirmVerification(guesses[1])).attemptsLeft, 3);
equal("third wrong guess", (await recovery.confirmVerification(guesses[2])).attemptsLeft, 2);
equal("fourth wrong guess", (await recovery.confirmVerification(guesses[3])).attemptsLeft, 1);
equal(
  "fifth wrong guess kills it",
  (await recovery.confirmVerification(guesses[4])).reason,
  "too_many_attempts",
);
const deadBefore = received.length;
equal(
  "the real code is dead too",
  (await recovery.confirmVerification(verifyCode)).reason,
  "no_pending",
);
equal("a dead verification is not sent again", received.length, deadBefore);
equal("a burned code saved nothing", secrets.getRecoveryEmail(), null);

section("verify seals the address with the token and export cannot see it");

result = await verifyAddress(ADDRESS, "10.0.0.4");
equal("verify succeeds", result.ok, true);
equal("the API mask", result.masked, "re***@e***.com");
equal("status is the mask", recovery.publicStatus().masked, "re***@e***.com");
equal("status has no address field", Object.hasOwn(recovery.publicStatus(), "email"), false);
equal("delivery can still read it", recovery.getAddress(), ADDRESS);
equal("the token is kept with it", recovery.getRecord().token, stubToken(ADDRESS));

const sealed = store.getBotSetting("auth:recovery-email");
ok("the row is sealed", typeof sealed === "string" && sealed.startsWith("enc:v1:"));
ok("the database does not contain the address", !diskHas(dataDir, ADDRESS));
ok("the database does not contain the token", !diskHas(dataDir, stubToken(ADDRESS)));

const exported = transfer.exportSettings();
const dumped = JSON.stringify(exported);
ok("export omits the address", !dumped.includes(ADDRESS));
ok("export omits the token", !dumped.includes(stubToken(ADDRESS)));
ok("export omits the key", !dumped.includes("auth:recovery-email"));
exported.settings["auth:recovery-email"] = "planted@evil.test";
const imported = transfer.applyImport(exported);
ok(
  "import skips the planted key",
  imported.skipped.some((row) => row.key === "auth:recovery-email"),
);
equal("the planted value did not stick", secrets.getRecoveryEmail(), ADDRESS);

section("a record from before the token reads as not set");

const currentRow = store.getBotSetting("auth:recovery-email");
store.saveBotSetting(
  "auth:recovery-email",
  vault.seal(JSON.stringify({ email: ADDRESS, verifiedAt: Date.now() })),
);
equal("no token, no address", recovery.getAddress(), null);
equal("no token, not verified", recovery.publicStatus().verified, false);
result = await reset.requestResetCode("10.0.0.9", { channel: "email" });
equal("no token, email needs verification", result.reason, "unverified");
equal("legacy status explains verification", recovery.publicStatus().needsVerification, true);
equal("legacy address mask survives", recovery.publicStatus().masked, "re***@e***.com");
let threw = false;
try {
  secrets.setRecoveryEmail(ADDRESS);
} catch {
  threw = true;
}
ok("an address cannot be saved without a token", threw);
store.saveBotSetting("auth:recovery-email", currentRow);
equal("the real record is back", recovery.getAddress(), ADDRESS);
equal(
  "stale authorization refusal cannot flag a newer token",
  secrets.markRecoveryUnverified(ADDRESS, "old-token"),
  false,
);
equal("newer authorization stays usable", recovery.publicStatus().verified, true);

section("relay failures preserve saved credentials and pending verification");

recovery._resetForTests();
await recovery.startVerification(OTHER, "en", "failure-proof");
const validPendingCode = lastCode();
const savedBeforeFailure = store.getBotSetting("auth:recovery-email");
for (const mode of ["down", "smtp_wrong_reason", "bad_success", "rate"]) {
  relayMode = mode;
  const outcome = await recovery.confirmVerification(validPendingCode);
  equal(`${mode} does not confirm`, outcome.ok, false);
  equal(
    `${mode} preserves sealed settings`,
    store.getBotSetting("auth:recovery-email"),
    savedBeforeFailure,
  );
}
relayMode = "ok";
equal(
  "retry succeeds with the original code",
  (await recovery.confirmVerification(validPendingCode)).ok,
  true,
);
await verifyAddress(ADDRESS, "restore-after-failures");

recovery._resetForTests();
await recovery.startVerification(OTHER, "en", "server-expiry");
relayMode = "expired";
equal(
  "server expiry is understood",
  (await recovery.confirmVerification(lastCode())).reason,
  "expired",
);
equal(
  "server expiry clears only pending state",
  (await recovery.confirmVerification("000000")).reason,
  "no_pending",
);
equal("server expiry preserves verified address", recovery.getAddress(), ADDRESS);
relayMode = "ok";

section("timeouts and offline requests preserve authorization without logging secrets");

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout;
const logger = require("./src/utils/logger.cjs");
const realWarn = logger.warn;
const warnings = [];
logger.warn = (...args) => warnings.push(args);
try {
  const currentToken = recovery.getRecord().token;
  for (const mode of ["offline", "timeout"]) {
    let requestedTimeout;
    AbortSignal.timeout = (ms) => {
      requestedTimeout = ms;
      return realTimeout(5);
    };
    globalThis.fetch = async (_url, options) => {
      if (mode === "offline") throw new Error(`${ADDRESS} ${currentToken} 123456`);
      await new Promise((resolve, reject) =>
        options.signal.addEventListener("abort", () => reject(options.signal.reason), {
          once: true,
        }),
      );
    };
    // Keep the test alive while AbortSignal.timeout's unref'ed timer fires.
    const keepAlive = setInterval(() => {}, 100);
    reset._resetForTests();
    try {
      equal(
        `${mode} is unavailable`,
        (await reset.requestResetCode("failure", { channel: "email" })).reason,
        "unavailable",
      );
    } finally {
      clearInterval(keepAlive);
    }
    equal(`${mode} uses the bounded relay timeout`, requestedTimeout, 15000);
    equal(`${mode} preserves the saved token`, recovery.getRecord().token, currentToken);
    equal(
      `${mode} creates no local code`,
      reset.completeReset("123456", PASSWORD, PASSWORD).reason,
      "no_pending",
    );
  }
  ok(
    "relay exception text never enters logs",
    !JSON.stringify(warnings).includes(currentToken) &&
      !JSON.stringify(warnings).includes(ADDRESS) &&
      !JSON.stringify(warnings).includes("123456"),
  );
} finally {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  logger.warn = realWarn;
}

section("the previous address stays until the new one is verified");

recovery._resetForTests();
await recovery.startVerification(OTHER, "en", "10.0.0.5");
const otherCode = lastCode();
equal("still the first address", secrets.getRecoveryEmail(), ADDRESS);
equal("the mask is still the first", recovery.publicStatus().masked, "re***@e***.com");
equal(
  "a wrong code does not swap it",
  (await recovery.confirmVerification(wrongCodes(otherCode)[0])).reason,
  "wrong_code",
);
equal("still the first after the wrong code", secrets.getRecoveryEmail(), ADDRESS);
result = await recovery.confirmVerification(otherCode);
equal("the new mask", result.masked, "ot***@g***.com");
equal("now the second address", secrets.getRecoveryEmail(), OTHER);
equal("with the second address's token", recovery.getRecord().token, stubToken(OTHER));

section("email reset sends only the four relay language codes");

for (const [input, expected] of [
  ["ar", "ar"],
  ["en", "en"],
  ["pt-BR", "pt-BR"],
  ["es-419", "es-419"],
  ["pt", "en"],
  ["fr", "en"],
  ["PT-BR", "en"],
  [undefined, "en"],
]) {
  reset._resetForTests();
  const options = input === undefined ? { channel: "email" } : { channel: "email", lang: input };
  const sent = await reset.requestResetCode("reset-language-check", options);
  equal(`reset with ${String(input)} succeeds`, sent.ok, true);
  equal(`reset with ${String(input)} sends ${expected}`, lastRelay().lang, expected);
}

section("email reset sends the token, shares the WhatsApp throttle, and bumps the epoch");

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
equal("reset carries the address's token", lastRelay().token, stubToken(OTHER));
equal(
  "reset body is exactly the contract",
  Object.keys(lastRelay()).sort().join(","),
  "code,kind,lang,to,token",
);
const resetCode = lastCode();
const sentBefore = sent.length;
result = await reset.requestResetCode("10.4.0.2");
equal("WhatsApp is throttled by the email send", result.reason, "throttled");
equal("the throttled request sent nothing", sent.length, sentBefore);

const resetGuesses = wrongCodes(resetCode);
equal(
  "mismatch does not burn it",
  reset.completeReset(resetCode, "one-pass", "other-pass").reason,
  "mismatch",
);
equal(
  "first reset wrong guess",
  reset.completeReset(resetGuesses[0], "good-password", "good-password").attemptsLeft,
  4,
);
equal(
  "second reset wrong guess",
  reset.completeReset(resetGuesses[1], "good-password", "good-password").attemptsLeft,
  3,
);
equal(
  "third reset wrong guess",
  reset.completeReset(resetGuesses[2], "good-password", "good-password").attemptsLeft,
  2,
);
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
equal(
  "the code is single use",
  reset.completeReset(resetCode, "email-reset-password", "email-reset-password").reason,
  "no_pending",
);

section("a token the relay refuses is unverified and leaves no code");

reset._resetForTests();
const realRecord = store.getBotSetting("auth:recovery-email");
secrets.setRecoveryEmail(OTHER, stubToken("someone.else@example.com"));
result = await reset.requestResetCode("10.4.0.9", { channel: "email" });
equal("the relay answer is unverified", result.reason, "unverified");
equal("rejected authorization is flagged", recovery.publicStatus().needsVerification, true);
equal("rejected address is retained as a mask", recovery.publicStatus().masked, "ot***@g***.com");
equal("flagged authorization cannot send", recovery.getRecord(), null);
const restartedStatus = spawnSync(
  process.execPath,
  [
    "-e",
    `
  const recovery = require(${JSON.stringify(join(ROOT, "src/panel/recovery-email.cjs"))});
  if (recovery.publicStatus().needsVerification !== true || recovery.getRecord() !== null) process.exit(1);
`,
  ],
  { env: { ...process.env, LEVIX_DATA_DIR: dataDir }, encoding: "utf8" },
);
equal("reverification requirement survives restart", restartedStatus.status, 0);
const afterReject = received.length;
equal(
  "flagged reset explains verification",
  (await reset.requestResetCode("10.4.0.9", { channel: "email" })).reason,
  "unverified",
);
equal("flagged reset sends no request", received.length, afterReject);
equal(
  "nothing is pending",
  reset.completeReset("000000", "x-password", "x-password").reason,
  "no_pending",
);
result = await reset.requestResetCode("10.4.0.9");
equal("the refused send did not spend the cooldown", result.ok, true);
store.saveBotSetting("auth:recovery-email", realRecord);

section("a WhatsApp send throttles the email channel, not verification");

reset._resetForTests();
sent.length = 0;
result = await reset.requestResetCode("10.4.0.3");
equal("WhatsApp send works", result.ok, true);
const waCode = /\b(\d{6})\b/.exec(sent[0].content.text)?.[1];
ok("the WhatsApp text still carries the code", Boolean(waCode));
const relayCount = received.length;
result = await reset.requestResetCode("10.4.0.4", { channel: "email", lang: "en" });
equal("email is throttled by the WhatsApp send", result.reason, "throttled");
equal("the throttled email did not call the relay", received.length, relayCount);
equal(
  "the WhatsApp code is still the live one",
  reset.completeReset(waCode, "wa-reset-password", "wa-reset-password").ok,
  true,
);

recovery._resetForTests();
result = await recovery.startVerification(ADDRESS, "en", "10.4.0.5");
equal("verification has its own throttle", result.ok, true);
const crossVerify = lastCode();
equal("the saved address is unchanged until verify", secrets.getRecoveryEmail(), OTHER);

reset._resetForTests();
result = await reset.requestResetCode("10.4.0.6", { channel: "email", lang: "en" });
equal("a new email reset sends", result.ok, true);
const crossReset = lastCode();
equal(
  "the verify code is not the reset code",
  reset.completeReset(crossVerify, "cross-password-1", "cross-password-1").reason,
  "wrong_code",
);
equal(
  "the reset code is not the verify code",
  (await recovery.confirmVerification(crossReset)).reason,
  "wrong_code",
);
equal("the verify code still verifies", (await recovery.confirmVerification(crossVerify)).ok, true);
equal("verification replaced the address", secrets.getRecoveryEmail(), ADDRESS);
const epochBeforeCross = secrets.getPasswordUpdatedAt();
const replaced = reset.completeReset(crossReset, "cross-password-1", "cross-password-1");
equal("replacing the address kills the email reset code", replaced.ok, false);
equal("the dead email code is no longer pending", replaced.reason, "no_pending");
equal(
  "the password stayed the WhatsApp reset",
  secrets.verifyDashboardPassword("wa-reset-password"),
  true,
);
ok(
  "a dead email code does not move the epoch",
  secrets.getPasswordUpdatedAt() === epochBeforeCross,
);

section("removing the address cancels an email code and leaves a WhatsApp code");

reset._resetForTests();
const epochBeforeRemove = secrets.getPasswordUpdatedAt();
await reset.requestResetCode("10.5.0.1", { channel: "email" });
const orphan = lastCode();
recovery.remove();
equal("remove clears the address", secrets.getRecoveryEmail(), null);
equal("remove clears the public status", recovery.publicStatus().verified, false);
equal(
  "remove drops the email reset code",
  reset.completeReset(orphan, "after-remove-1", "after-remove-1").reason,
  "no_pending",
);
equal(
  "remove did not change the password",
  secrets.verifyDashboardPassword("wa-reset-password"),
  true,
);
ok("remove did not move the epoch", secrets.getPasswordUpdatedAt() === epochBeforeRemove);

recovery._resetForTests();
await recovery.startVerification(ADDRESS, "en", "10.5.0.2");
const removedCode = lastCode();
recovery.remove();
equal(
  "remove drops a verification",
  (await recovery.confirmVerification(removedCode)).reason,
  "no_pending",
);
equal("the address stays gone", secrets.getRecoveryEmail(), null);

secrets.setRecoveryEmail(ADDRESS, stubToken(ADDRESS));
reset._resetForTests();
await reset.requestResetCode("10.5.0.3", { channel: "email" });
const rebound = lastCode();
secrets.setRecoveryEmail("replaced.byhand@example.com", stubToken("replaced.byhand@example.com"));
equal(
  "redeem refuses when the saved address differs",
  reset.completeReset(rebound, "after-swap-1", "after-swap-1").reason,
  "address_changed",
);
equal(
  "the swap did not change the password",
  secrets.verifyDashboardPassword("wa-reset-password"),
  true,
);
equal(
  "the refused code cannot be retried",
  reset.completeReset(rebound, "after-swap-1", "after-swap-1").reason,
  "no_pending",
);

reset._resetForTests();
sent.length = 0;
await reset.requestResetCode("10.5.0.4");
const waKept = /\b(\d{6})\b/.exec(sent.at(-1).content.text)?.[1];
recovery.remove();
equal(
  "a WhatsApp code survives removing the address",
  reset.completeReset(waKept, "wa-after-remove", "wa-after-remove").ok,
  true,
);

section("wrong reset codes across many codes lock reset for the day");

reset._resetForTests();
sent.length = 0;
let lockedResult = null;
let issued = 0;
for (let round = 0; round < 4 && !lockedResult; round += 1) {
  // Each round is a new code from a new peer once the cooldown is gone, the
  // most an attacker rotating addresses could get.
  reset._resetThrottleForTests();
  result = await reset.requestResetCode(`10.6.0.${round}`);
  if (!result.ok) {
    lockedResult = result;
    break;
  }
  issued += 1;
  const live = /\b(\d{6})\b/.exec(sent.at(-1).content.text)?.[1];
  for (const guess of wrongCodes(live)) {
    const answer = reset.completeReset(guess, "lock-password-1", "lock-password-1");
    if (answer.reason === "locked") {
      lockedResult = answer;
      break;
    }
  }
}
equal(
  "two codes of five wrong guesses each reach the cap",
  issued,
  reset.MAX_FAILED_CODES_PER_DAY / 5,
);
equal("the next request is locked", lockedResult?.reason, "locked");
ok(
  "locked carries a retryAfter of up to a day",
  lockedResult?.retryAfter > 0 && lockedResult?.retryAfter <= 86_400,
);
reset._resetThrottleForTests();
const sentBeforeLock = sent.length;
result = await reset.requestResetCode("10.6.0.99");
equal("a fresh peer is locked too", result.reason, "locked");
equal("the locked request sent nothing", sent.length, sentBeforeLock);
equal("the password did not change", secrets.verifyDashboardPassword("wa-after-remove"), true);
reset._resetForTests();

section("concurrent sends reserve one slot before the relay answers");

recovery._resetForTests();
relayMode = "hold";
const beforeVerifyBurst = received.length;
const verifyBurst = Promise.all(
  Array.from({ length: 8 }, () => recovery.startVerification(ADDRESS, "en", "10.9.0.1")),
);
ok(
  "the first verify reached the relay",
  await waitFor(() => received.length >= beforeVerifyBurst + 1),
);
await sleep(100);
equal("seven other verifies did not reach the relay", received.length, beforeVerifyBurst + 1);
for (const release of held.splice(0, held.length)) release();
relayMode = "ok";
const verifyResults = await verifyBurst;
equal("one verify was accepted", verifyResults.filter((row) => row.ok).length, 1);
equal(
  "seven verifies were throttled",
  verifyResults.filter((row) => row.reason === "throttled").length,
  7,
);
const burstVerifyCode = lastCode();

section("concurrent guesses: one at a time, and a removal mid-flight stores nothing");

const beforeGuesses = received.length;
const confirms = await Promise.all(
  Array.from({ length: 4 }, () => recovery.confirmVerification(burstVerifyCode)),
);
equal("one guess verified", confirms.filter((row) => row.ok).length, 1);
equal(
  "the others waited their turn",
  confirms.filter((row) => row.reason === "throttled").length,
  3,
);
equal("only one guess reached the relay", received.length, beforeGuesses + 1);
equal("the address is stored", secrets.getRecoveryEmail(), ADDRESS);

recovery._resetForTests();
await recovery.startVerification(OTHER, "en", "10.9.0.3");
const inFlightCode = lastCode();
relayMode = "hold";
const inFlight = recovery.confirmVerification(inFlightCode);
ok("the guess reached the relay", await waitFor(() => held.length === 1));
recovery.remove();
for (const release of held.splice(0, held.length)) release();
relayMode = "ok";
equal("a guess that lands after remove is dropped", (await inFlight).reason, "no_pending");
equal("remove won: no address", secrets.getRecoveryEmail(), null);

secrets.setRecoveryEmail(ADDRESS, stubToken(ADDRESS));
reset._resetForTests();
relayMode = "hold";
const beforeResetBurst = received.length;
const resetBurst = Promise.all(
  Array.from({ length: 8 }, () =>
    reset.requestResetCode("10.9.0.2", { channel: "email", lang: "en" }),
  ),
);
ok(
  "the first email reset reached the relay",
  await waitFor(() => received.length >= beforeResetBurst + 1),
);
await sleep(100);
equal("seven other email resets did not reach the relay", received.length, beforeResetBurst + 1);
for (const release of held.splice(0, held.length)) release();
relayMode = "ok";
const resetResults = await resetBurst;
equal("one email reset was accepted", resetResults.filter((row) => row.ok).length, 1);
equal(
  "seven email resets were throttled",
  resetResults.filter((row) => row.reason === "throttled").length,
  7,
);
const burstResetCode = received[beforeResetBurst].code;
equal(
  "only the accepted email code resets",
  reset.completeReset(burstResetCode, "burst-password-1", "burst-password-1").ok,
  true,
);

section("the panel routes and the login page");

received.length = 0;
mailed.length = 0;
const webDir = useTempDataDir("levix-recovery-http");
let server;
let server2;
try {
  server = await startServer({ dataDir: webDir, trust: "", routes: true });
  const http = httpClient(server.base);
  const anon = httpClient(server.base);

  let res = await http.form("/setup", { password: PASSWORD, confirm: PASSWORD });
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
    body: JSON.stringify({ email: ADDRESS, current: PASSWORD, lang: "en" }),
  });
  equal("a cross-site start is rejected", res.status, 403);
  equal("the cross-site start did not call the relay", received.length, beforeCross);

  res = await http.json("/dashboard/api/recovery-email/start", { email: ADDRESS, lang: "en" });
  equal("a session alone cannot bind an address", res.status, 400);
  equal("the stable code is wrong_password", (await res.json()).error, "wrong_password");
  res = await http.json("/dashboard/api/recovery-email/start", {
    email: ADDRESS,
    current: "not-the-password",
    lang: "en",
  });
  equal("a wrong password is 400, not a logged-out 401", res.status, 400);
  equal("a wrong password did not call the relay", received.length, beforeCross);

  res = await http.json("/dashboard/api/recovery-email/start", {
    email: "not-an-email",
    current: PASSWORD,
    lang: "en",
  });
  equal("the route rejects a bad address", res.status, 400);
  equal("the stable code is invalid_email", (await res.json()).error, "invalid_email");
  equal("a bad address still did not call the relay", received.length, beforeCross);

  relayMode = "rate";
  res = await http.json("/dashboard/api/recovery-email/start", {
    email: ADDRESS,
    current: PASSWORD,
    lang: "en",
  });
  equal("relay rate limit remains HTTP 429", res.status, 429);
  equal("relay Retry-After reaches the browser", res.headers.get("retry-after"), "173");
  equal("relay retry delay is in JSON", (await res.json()).retryAfter, 173);
  relayMode = "ok";
  res = await http.json("/dashboard/api/recovery-email/start", {
    email: ADDRESS,
    current: PASSWORD,
    lang: "en",
  });
  equal("start is 200", res.status, 200);
  let body = await res.json();
  ok("start does not echo the address", !JSON.stringify(body).includes(ADDRESS));
  ok("start does not return the verification id", !JSON.stringify(body).includes("verification"));
  const code = lastCode();
  equal("the route asked the relay for a verify code", lastRelay().kind, "verify");

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
  ok("verify does not return the token", !JSON.stringify(body).includes(stubToken(ADDRESS)));

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
  ok(
    "import skipped the planted key",
    body.skipped.some((row) => row.key === "auth:recovery-email"),
  );
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
  ok("the reset answer has no token", !JSON.stringify(body).includes("v1."));
  equal("HTTP reset kind", lastRelay().kind, "reset");
  equal("HTTP reset lang", lastRelay().lang, "ar");
  equal("HTTP reset recipient", lastRelay().to, ADDRESS);
  equal("HTTP reset token", lastRelay().token, stubToken(ADDRESS));
  const httpResetCode = lastCode();

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

  res = await anon.form("/login", { password: PASSWORD });
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
  const live = lastCode();
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

  res = await locked.json("/reset/confirm", {
    code: live,
    password: "another-good-1",
    confirm: "another-good-1",
  });
  equal("and they lock /reset/confirm for the same peer", res.status, 429);
  equal("the reason is throttled", (await res.json()).reason, "throttled");
  ok("with Retry-After", Number(res.headers.get("retry-after")) > 0);

  res = await again.json("/dashboard/api/recovery-email/start", {
    email: OTHER,
    current: NEXT_PASSWORD,
    lang: "en",
  });
  equal("a locked-out peer cannot bind an address either", res.status, 429);

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
}

section("legacy and revoked addresses stay in Settings, not login recovery choices");
for (const state of ["legacy", "revoked"]) {
  const dir = useTempDataDir(`levix-recovery-${state}-login`);
  const seed = spawnSync(
    process.execPath,
    [
      "-e",
      `
    const secrets = require(${JSON.stringify(join(ROOT, "src/config/secrets.cjs"))});
    const store = require(${JSON.stringify(join(ROOT, "src/db/store.cjs"))});
    const vault = require(${JSON.stringify(join(ROOT, "src/config/vault.cjs"))});
    secrets.setDashboardPassword(${JSON.stringify(PASSWORD)});
    if (${JSON.stringify(state)} === "legacy") {
      store.saveBotSetting("auth:recovery-email", vault.seal(JSON.stringify({ email: ${JSON.stringify(ADDRESS)} })));
    } else {
      secrets.setRecoveryEmail(${JSON.stringify(ADDRESS)}, ${JSON.stringify(stubToken(ADDRESS))});
      secrets.markRecoveryUnverified(${JSON.stringify(ADDRESS)}, ${JSON.stringify(stubToken(ADDRESS))});
    }
  `,
    ],
    { env: { ...process.env, LEVIX_DATA_DIR: dir }, encoding: "utf8" },
  );
  equal(`${state}: seed saved record`, seed.status, 0);
  const fixture = await startServer({ dataDir: dir, trust: "", routes: true });
  try {
    const anon = httpClient(fixture.base);
    const login = await (await anon.call("/login")).text();
    ok(`${state}: login hides unusable email option`, !login.includes('data-channel="email"'));
    ok(`${state}: login keeps WhatsApp`, login.includes('data-channel="whatsapp"'));
    ok(`${state}: login hides saved mask`, !login.includes("re***@e***.com"));
    const operator = httpClient(fixture.base);
    equal(
      `${state}: operator signs in`,
      (await operator.form("/login", { password: PASSWORD })).status,
      303,
    );
    const status = await (await operator.call("/dashboard/api/recovery-email")).json();
    equal(`${state}: Settings retains mask`, status.masked, "re***@e***.com");
    equal(`${state}: Settings requests re-verification`, status.needsVerification, true);
    equal(`${state}: Settings does not claim verified`, status.verified, false);
    const started = await operator.json("/dashboard/api/recovery-email/start", {
      email: ADDRESS,
      current: PASSWORD,
      lang: "en",
    });
    equal(`${state}: authenticated re-verification starts`, started.status, 200);
    equal(
      `${state}: re-verification succeeds`,
      (await operator.json("/dashboard/api/recovery-email/verify", { code: lastCode() })).status,
      200,
    );
    const verifiedLogin = await (await anon.call("/login")).text();
    ok(
      `${state}: verified address restores Email option`,
      verifiedLogin.includes('data-channel="email"'),
    );
  } finally {
    fixture.stop();
  }
}

await new Promise((resolve) => stub.close(resolve));
finish();
