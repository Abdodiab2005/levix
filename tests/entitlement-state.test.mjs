// Entitlement state evaluation, clock rollback protection, high-water persistence,
// subscriber notifications, copy exclusions, and debug-log redaction.

import crypto from "node:crypto";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-entitlement-state");

const keys = require("./src/extensions/entitlement/keys.cjs");
const state = require("./src/extensions/entitlement/state.cjs");
const { createEntitlement } = require("./src/extensions/entitlement/index.cjs");
const { isSecretBotKey } = require("./src/db/copy.cjs");
const { sanitizeRecord } = require("./src/diagnostics/debugLog.cjs");

function makeSigner() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const raw = keys.rawFromKeyObject(publicKey);
  const keyId = keys.keyIdFor(raw);
  return {
    privateKey,
    entry: Object.freeze({ keyId, publicKey: raw.toString("base64") }),
    keyId,
  };
}

function makeToken(signer, installationId, overrides = {}) {
  const iat = overrides.iat ?? 1_762_780_000;
  const st = overrides.st ?? "active";
  const inactive = st === "inactive";
  const header = Buffer.from(
    JSON.stringify({ alg: "EdDSA", kid: signer.keyId, typ: "levix-ent+jwt" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      aud: "levix-core",
      ent: inactive ? [] : ["plus"],
      exp: overrides.exp ?? (inactive ? iat + 86_400 : iat + 259_200),
      iat,
      iss: "levix-plus-verifier",
      jti: overrides.jti ?? Buffer.alloc(16, overrides.seq ?? 1).toString("base64url"),
      pexp: overrides.pexp ?? iat + 2_592_000,
      rsn: inactive ? (overrides.rsn ?? "expired") : null,
      seq: overrides.seq ?? 1,
      st,
      sub: overrides.sub ?? installationId,
    }),
    "utf8",
  ).toString("base64url");
  const sig = crypto
    .sign(null, Buffer.from(`${header}.${payload}`, "utf8"), signer.privateKey)
    .toString("base64url");
  return `${header}.${payload}.${sig}`;
}

const signer = makeSigner();
const validClaimInput = {
  purchaseToken: "pt_state_test_token_12345",
  productId: "levix_plus_monthly",
  packageName: "net.leviro.levix",
};

section("no record and empty TRUSTED_KEYS do not contact network or arm timers");

{
  let fetches = 0;
  let timers = 0;
  const entEmptyRecord = createEntitlement({
    keys: [signer.entry],
    storage: new Map(),
    fetch: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
    setTimer: () => {
      timers += 1;
      return {};
    },
  });

  equal("no record status is none", entEmptyRecord.status().state, "none");
  equal("no record isActive is false", entEmptyRecord.isActive("plus"), false);
  const stopEmpty = entEmptyRecord.start();
  equal("start with no record arms zero timers", timers, 0);
  equal("start with no record makes zero fetches", fetches, 0);
  stopEmpty();

  const seededStorage = new Map();
  seededStorage.set(state.RECORD_KEY, {
    token: "a.b.c",
    seq: 1,
    jti: "jti",
    serverOffsetMs: 0,
    highWaterMs: 1_000_000,
  });
  const entNoKeys = createEntitlement({
    keys: [],
    storage: seededStorage,
    fetch: async () => {
      fetches += 1;
      throw new Error("must not fetch");
    },
    setTimer: () => {
      timers += 1;
      return {};
    },
  });
  const stopNoKeys = entNoKeys.start();
  equal("start with empty TRUSTED_KEYS arms zero timers", timers, 0);
  equal("start with empty TRUSTED_KEYS makes zero fetches", fetches, 0);
  const claimUnconf = await entNoKeys.claim(validClaimInput);
  equal("claim with empty TRUSTED_KEYS returns UNCONFIGURED", claimUnconf.code, "UNCONFIGURED");
  const refreshUnconf = await entNoKeys.refresh({ force: true });
  equal("refresh with empty TRUSTED_KEYS returns UNCONFIGURED", refreshUnconf.code, "UNCONFIGURED");
  equal("empty TRUSTED_KEYS still made zero fetches", fetches, 0);
  stopNoKeys();
}

section("server offset, clock rollback, recovery on fresh refresh, and highWater persistence");

{
  const serverIatSec = 1_762_780_000;
  const serverNowMs = serverIatSec * 1000;
  // Local clock starts 2 hours behind server time; serverOffsetMs corrects it.
  let currentNowMs = serverNowMs - 2 * 3600 * 1000;
  let persistWrites = 0;
  const backing = new Map();
  const trackedStorage = {
    getBotSetting(k, fb = null) {
      return backing.has(k) ? backing.get(k) : fb;
    },
    saveBotSetting(k, v) {
      if (k === state.RECORD_KEY) persistWrites += 1;
      backing.set(k, v);
    },
  };

  const events = [];
  let nextSeq = 1;
  let nextIat = serverIatSec;
  const ent = createEntitlement({
    keys: [signer.entry],
    storage: trackedStorage,
    now: () => currentNowMs,
    fetch: async () => {
      const id = ent.prepare().installationId;
      const token = makeToken(signer, id, { seq: nextSeq, iat: nextIat });
      return new Response(JSON.stringify({ token }), { status: 200 });
    },
  });

  ent.subscribe((st) => events.push(st));

  const claimed = await ent.claim(validClaimInput);
  equal("claim succeeds despite wrong local clock", claimed.ok, true);
  equal("entitlement is active via serverOffsetMs", ent.isActive("plus"), true);
  equal("status state is active", ent.status().state, "active");
  equal("subscriber notified of active state", events.at(-1)?.state, "active");

  const storedAfterClaim = backing.get(state.RECORD_KEY);
  equal(
    "serverOffsetMs equals iat*1000 - localNow",
    storedAfterClaim.serverOffsetMs,
    2 * 3600 * 1000,
  );
  equal("highWaterMs starts at iat*1000", storedAfterClaim.highWaterMs, serverNowMs);

  const writesAfterClaim = persistWrites;
  // Advance local clock by 2 minutes (< 5 minutes): highWater moves in memory, not persisted yet.
  currentNowMs += 120_000;
  equal("still active at +2 min", ent.isActive("plus"), true);
  equal("highWater not persisted before 5 minutes", persistWrites, writesAfterClaim);

  // Advance local clock by another 4 minutes (total +6 min >= 5 min): highWater persisted once.
  currentNowMs += 240_000;
  equal("still active at +6 min", ent.isActive("plus"), true);
  equal("highWater persisted after 5 minutes", persistWrites, writesAfterClaim + 1);
  equal(
    "persisted highWaterMs advanced by 6 minutes",
    backing.get(state.RECORD_KEY).highWaterMs,
    serverNowMs + 360_000,
  );

  // Roll local clock backwards by 10 minutes (> 5 min skew below highWaterMs).
  currentNowMs -= 600_000;
  equal(
    "isActive computed at call time turns false on clock rollback",
    ent.isActive("plus"),
    false,
  );
  equal("status state is clock", ent.status().state, "clock");
  equal("status reason is clock", ent.status().reason, "clock");
  equal("subscriber notified of clock state", events.at(-1)?.state, "clock");
  equal(
    "highWaterMs did not move backwards",
    backing.get(state.RECORD_KEY).highWaterMs,
    serverNowMs + 360_000,
  );

  // Fresh refresh with higher seq recalibrates serverOffsetMs and recovers to active.
  nextSeq = 2;
  nextIat = serverIatSec + 600;
  const refreshed = await ent.refresh({ force: true });
  equal("refresh succeeds", refreshed.ok, true);
  equal("entitlement recovers to active after fresh refresh", ent.isActive("plus"), true);
  equal("status state back to active", ent.status().state, "active");
  equal("subscriber notified of recovery to active", events.at(-1)?.state, "active");
}

section("expiry, inactive token with higher seq, replay ignore, and cache tampering");

{
  const iat = 1_762_780_000;
  let currentNowMs = iat * 1000;
  const backing = new Map();
  let tokenSpec = { seq: 1, iat, st: "active", exp: iat + 3600 };
  let expiryCallback = null;

  const ent = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => currentNowMs,
    setTimer: (fn, ms) => {
      // Capture the 1h expiry timer (3600_000 ms).
      if (ms === 3_600_000) expiryCallback = fn;
      return { ms };
    },
    clearTimer: () => {},
    fetch: async () => {
      const id = ent.prepare().installationId;
      const token = makeToken(signer, id, tokenSpec);
      return new Response(JSON.stringify({ token }), { status: 200 });
    },
  });

  const events = [];
  ent.subscribe((st) => events.push(st));
  ent.start();

  await ent.claim(validClaimInput);
  equal("active after claim", ent.isActive("plus"), true);
  ok("expiry timer was armed", typeof expiryCallback === "function");

  // Lower seq replay during refresh is ignored and keeps seq 1 active.
  tokenSpec = { seq: 0, iat: iat + 10, st: "inactive", rsn: "revoked", exp: iat + 10 + 86_400 };
  await ent.refresh({ force: true });
  equal("lower seq inactive replay is ignored", ent.isActive("plus"), true);
  equal("stored seq remains 1", backing.get(state.RECORD_KEY).seq, 1);

  // Advance clock to exp and fire the expiry timer: subscribers hear about expiry without a refresh.
  currentNowMs = (iat + 3600) * 1000;
  expiryCallback();
  equal("expiry timer notifies subscribers of expired state", events.at(-1)?.state, "expired");
  equal("isActive is false when expired", ent.isActive("plus"), false);

  // Refresh with a new active token (seq 2), then receive an inactive token with higher seq (seq 3).
  tokenSpec = { seq: 2, iat: iat + 3600, st: "active", exp: iat + 3600 + 7200 };
  await ent.refresh({ force: true });
  equal("active at seq 2", ent.isActive("plus"), true);

  tokenSpec = { seq: 3, iat: iat + 3700, st: "inactive", rsn: "revoked", exp: iat + 3700 + 86_400 };
  await ent.refresh({ force: true });
  equal("inactive token with higher seq turns Plus off immediately", ent.isActive("plus"), false);
  equal("status state is inactive", ent.status().state, "inactive");
  equal("status reason is revoked", ent.status().reason, "revoked");
  equal("subscriber notified of inactive state", events.at(-1)?.state, "inactive");

  // Re-activate at seq 4, then tamper with the stored record in bot_settings.
  tokenSpec = { seq: 4, iat: iat + 3800, st: "active", exp: iat + 3800 + 7200 };
  await ent.refresh({ force: true });
  equal("active at seq 4", ent.isActive("plus"), true);

  const saved = backing.get(state.RECORD_KEY);
  backing.set(state.RECORD_KEY, { ...saved, token: `${saved.token.slice(0, -4)}AAAA` });
  equal("tampered stored token signature turns isActive false", ent.isActive("plus"), false);
  equal("tampered stored token status is unverified", ent.status().state, "unverified");

  backing.set(state.RECORD_KEY, { ...saved, seq: 999 });
  equal("tampered stored seq turns isActive false", ent.isActive("plus"), false);
  equal("tampered stored seq status is unverified", ent.status().state, "unverified");
  ent.stop();
}

section("isSecretBotKey and debugLog redaction");

{
  equal("plus:installation-key is secret", isSecretBotKey("plus:installation-key"), true);
  equal("plus:entitlement is secret", isSecretBotKey("plus:entitlement"), true);
  equal("plus:any is secret", isSecretBotKey("plus:any"), true);
  equal("ext:levix-plus:acct:chats is secret", isSecretBotKey("ext:levix-plus:acct:chats"), true);
  equal("ext:x:acct:y is secret", isSecretBotKey("ext:x:acct:y"), true);
  equal(
    "ext:levix-plus:cfg:templates is not secret",
    isSecretBotKey("ext:levix-plus:cfg:templates"),
    false,
  );
  equal("setting:bot_language is not secret", isSecretBotKey("setting:bot_language"), false);

  const sanitized = sanitizeRecord({
    entitlement: "eyJhbGciOiJFZERTQSJ9.payload.sig",
    entitlementToken: "secret-jws",
    obfuscatedAccountId: "43_char_installation_id_value_here_12345678",
    installationId: "43_char_installation_id_value_here_12345678",
    installationKey: "enc:v1:iv.tag.cipher",
    purchaseToken: "play-purchase-token-secret",
    purchase: { id: "secret" },
    password: "secret-password",
    statusCode: 200,
  });

  equal("entitlement is redacted", sanitized.entitlement, "[redacted]");
  equal("entitlementToken is redacted", sanitized.entitlementToken, "[redacted]");
  equal("obfuscatedAccountId is redacted", sanitized.obfuscatedAccountId, "[redacted]");
  equal("installationId is redacted", sanitized.installationId, "[redacted]");
  equal("installationKey is redacted", sanitized.installationKey, "[redacted]");
  equal("purchaseToken is redacted", sanitized.purchaseToken, "[redacted]");
  equal("purchase is redacted", sanitized.purchase, "[redacted]");
  equal("existing password key stays redacted", sanitized.password, "[redacted]");
  equal("non-secret statusCode stays intact", sanitized.statusCode, 200);
}

finish();
