// Entitlement state evaluation, clock rollback protection, high-water persistence,
// subscriber notifications, copy exclusions, and debug-log redaction.

import crypto from "node:crypto";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-entitlement-state");

const keys = require("./src/extensions/entitlement/keys.cjs");
const state = require("./src/extensions/entitlement/state.cjs");
const vault = require("./src/config/vault.cjs");
const {
  createInstallation,
  INSTALLATION_KEY,
} = require("./src/extensions/entitlement/installation.cjs");
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
  ok("claim writes a sealed high-water row", vault.isSealed(backing.get(state.HW_KEY)));
  const hwAfterClaim = state.openHighWater(backing.get(state.HW_KEY), vault);
  equal(
    "sealed offset matches accepted server time",
    hwAfterClaim?.serverOffsetMs,
    2 * 3600 * 1000,
  );
  equal("sealed sequence matches accepted token", hwAfterClaim?.maxSeq, 1);
  equal("sealed jti matches accepted token", hwAfterClaim?.jti, storedAfterClaim.jti);
  equal(
    "sealed installation matches this installation",
    hwAfterClaim?.installationId,
    ent.prepare().installationId,
  );

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
  equal(
    "sealed highWater also advances",
    state.openHighWater(backing.get(state.HW_KEY), vault)?.highWaterMs,
    serverNowMs + 360_000,
  );
  const reloaded = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => currentNowMs,
  });
  equal("reloaded accepted pair is active", reloaded.status().state, "active");

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

section("database rollback cannot replace the authenticated sequence or clock");

{
  const iat = 1_762_780_000;
  const backing = new Map();
  let tokenSpec = { seq: 1, iat };
  let sentSeq = null;
  const ent = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => iat * 1000,
    fetch: async (url, init) => {
      if (url.endsWith("/refresh")) sentSeq = JSON.parse(init.body).seq;
      const token = makeToken(signer, ent.prepare().installationId, tokenSpec);
      return new Response(JSON.stringify({ token }));
    },
  });
  await ent.claim(validClaimInput);
  const oldRecord = backing.get(state.RECORD_KEY);
  const oldHw = backing.get(state.HW_KEY);
  tokenSpec = { seq: 2, iat, st: "inactive", rsn: "revoked" };
  await ent.refresh({ force: true });
  const revokedRecord = backing.get(state.RECORD_KEY);
  const revokedHw = backing.get(state.HW_KEY);
  const reload = () =>
    createEntitlement({
      keys: [signer.entry],
      storage: backing,
      now: () => iat * 1000,
    });
  equal("revocation survives reload", reload().status().state, "inactive");

  backing.set(state.RECORD_KEY, { ...oldRecord, serverOffsetMs: -999999, highWaterMs: 0 });
  equal("older active token fails closed in process", ent.isActive(), false);
  equal("older active token reports rollback", ent.status().reason, "rollback");
  equal(
    "sealed barrier rejects older active token after reload",
    reload().status().reason,
    "rollback",
  );
  backing.set(state.HW_KEY, oldHw);
  equal("rolling back both rows cannot lower the process maximum", ent.status().reason, "rollback");

  backing.set(state.HW_KEY, revokedHw);
  backing.set(state.RECORD_KEY, {
    ...revokedRecord,
    token: makeToken(signer, ent.prepare().installationId, { seq: 2, iat, jti: "different" }),
    jti: "different",
  });
  equal("same sequence with another jti is rollback", ent.status().reason, "rollback");
  equal(
    "same sequence with another jti is rollback after reload",
    reload().status().reason,
    "rollback",
  );

  backing.set(state.RECORD_KEY, revokedRecord);
  const hw = state.openHighWater(revokedHw, vault);
  const badHighWater = [
    null,
    `${revokedHw.slice(0, -2)}${revokedHw.endsWith("00") ? "01" : "00"}`,
    JSON.stringify(hw),
    vault.seal("invalid JSON"),
    vault.seal(JSON.stringify({ ...hw, installationId: "another-installation" })),
    vault.seal(JSON.stringify({ ...hw, maxSeq: -1 })),
    oldHw,
  ];
  for (const [index, value] of badHighWater.entries()) {
    if (value == null) backing.delete(state.HW_KEY);
    else backing.set(state.HW_KEY, value);
    equal(`invalid high-water row #${index} fails closed`, ent.status().state, "unverified");
    equal(
      `invalid high-water row #${index} fails closed after reload`,
      reload().status().state,
      "unverified",
    );
  }

  backing.set(state.HW_KEY, revokedHw);
  backing.set(state.RECORD_KEY, { ...revokedRecord, seq: 999999, jti: "spoofed" });
  tokenSpec = { seq: 3, iat };
  equal(
    "fresh token repairs tampered plain metadata",
    (await ent.refresh({ force: true })).ok,
    true,
  );
  equal("refresh sends authenticated sequence", sentSeq, 2);
  equal(
    "fresh token replaces sealed sequence",
    state.openHighWater(backing.get(state.HW_KEY), vault)?.maxSeq,
    3,
  );
  equal("repaired pair is active after reload", reload().isActive(), true);

  const activeRecord = backing.get(state.RECORD_KEY);
  backing.set(state.RECORD_KEY, { ...activeRecord, serverOffsetMs: 1e15, highWaterMs: 1e15 });
  equal("plain clock fields do not override sealed time", reload().isActive(), true);
  backing.delete(state.HW_KEY);
  equal("removing the barrier invalidates a cached active token", ent.status().state, "unverified");
  tokenSpec = { seq: 4, iat };
  equal(
    "higher-sequence claim repairs missing barrier",
    (await ent.claim(validClaimInput)).entitlement.state,
    "active",
  );
  equal(
    "claim repair persists the new barrier",
    state.openHighWater(backing.get(state.HW_KEY), vault)?.maxSeq,
    4,
  );
  backing.delete(state.RECORD_KEY);
  backing.delete(state.HW_KEY);
  equal("deleting both rows does not forget process acceptance", ent.status().state, "unverified");

  const originalInstallation = backing.get(INSTALLATION_KEY);
  const newBacking = new Map();
  createInstallation({ storage: newBacking, vault }).getOrCreateInstallation();
  backing.set(INSTALLATION_KEY, newBacking.get(INSTALLATION_KEY));
  tokenSpec = { seq: 1, iat };
  equal(
    "a new installation has its own sequence space",
    (await ent.claim(validClaimInput)).entitlement.state,
    "active",
  );
  backing.set(INSTALLATION_KEY, originalInstallation);
  backing.set(state.RECORD_KEY, oldRecord);
  backing.set(state.HW_KEY, oldHw);
  equal("switching installations does not forget the old maximum", ent.status().reason, "rollback");
}

section("an interrupted acceptance pair cannot expose the previous active token");

{
  const iat = 1_762_780_000;
  const backing = new Map();
  let seq = 1;
  let failRecordWrite = false;
  const ent = createEntitlement({
    keys: [signer.entry],
    now: () => iat * 1000,
    storage: {
      getBotSetting: (key, fallback) => backing.get(key) ?? fallback,
      saveBotSetting: (key, value) => {
        if (failRecordWrite && key === state.RECORD_KEY) throw new Error("fake write failure");
        backing.set(key, value);
      },
    },
    fetch: async () => {
      const token = makeToken(signer, ent.prepare().installationId, {
        iat,
        seq,
        st: seq === 1 ? "active" : "inactive",
        rsn: "revoked",
      });
      return new Response(JSON.stringify({ token }));
    },
  });
  await ent.claim(validClaimInput);
  seq = 2;
  failRecordWrite = true;
  let rejected = false;
  try {
    await ent.refresh({ force: true });
  } catch {
    rejected = true;
  }
  equal("failed pair write rejects refresh", rejected, true);
  equal(
    "authenticated barrier was written first",
    state.openHighWater(backing.get(state.HW_KEY), vault)?.maxSeq,
    2,
  );
  equal("previous active row is still present", backing.get(state.RECORD_KEY).seq, 1);
  equal("failed write invalidates in-memory acceptance", ent.status().reason, "rollback");
  const reloaded = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => iat * 1000,
  });
  equal("failed write remains closed after reload", reloaded.status().reason, "rollback");
}

section("fresh verifier tokens rebase a high-water mark poisoned by a forward jump");

for (const action of ["claim", "refresh"]) {
  const iat = 1_762_780_000;
  let nowMs = iat * 1000;
  let tokenSpec = { seq: 1, iat };
  const backing = new Map();
  const ent = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => nowMs,
    fetch: async () => {
      const token = makeToken(signer, ent.prepare().installationId, tokenSpec);
      return new Response(JSON.stringify({ token }));
    },
  });
  await ent.claim(validClaimInput);
  nowMs += 8 * 86_400_000;
  equal(`${action}: forward jump expires the token`, ent.status().state, "expired");
  nowMs = (iat + 3600) * 1000;
  equal(`${action}: correcting the clock exposes poisoned high water`, ent.status().state, "clock");
  tokenSpec = { seq: 2, iat: iat + 3600 };
  const result =
    action === "claim" ? await ent.claim(validClaimInput) : await ent.refresh({ force: true });
  equal(`${action}: fresh higher sequence recovers`, result.entitlement.state, "active");
  const hw = state.openHighWater(backing.get(state.HW_KEY), vault);
  equal(`${action}: sealed high water rebased to server iat`, hw?.highWaterMs, nowMs);
  equal(`${action}: sealed server offset rebased`, hw?.serverOffsetMs, 0);
  const reloaded = createEntitlement({
    keys: [signer.entry],
    storage: backing,
    now: () => nowMs,
  });
  equal(`${action}: recovery survives reload`, reloaded.isActive(), true);
}

section("expiry stops rearming when clock state wins after the deadline");

{
  const iat = 1_762_780_000;
  let nowMs = iat * 1000;
  const timers = [];
  const events = [];
  const ent = createEntitlement({
    keys: [signer.entry],
    storage: new Map(),
    now: () => nowMs,
    random: () => 0,
    setTimer: (fn, ms) => {
      const timer = { fn, ms };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
    fetch: async () => {
      const token = makeToken(signer, ent.prepare().installationId, { iat, exp: iat + 3600 });
      return new Response(JSON.stringify({ token }));
    },
  });
  ent.subscribe((status) => events.push(status));
  ent.start();
  await ent.claim(validClaimInput);
  const expiry = timers.find((timer) => timer.ms === 3_600_000);
  ok("expiry initially has a future deadline", !!expiry);
  nowMs += 4 * 3_600_000;
  ent.status();
  nowMs = (iat + 7200) * 1000;
  equal("corrected time past exp reports clock", ent.status().state, "clock");
  const count = timers.length;
  expiry?.fn();
  equal("past deadline does not create another timer", timers.length, count);
  equal(
    "clock transition is published once",
    events.filter((event) => event.state === "clock").length,
    1,
  );
  ent.stop();
  ent.start();
  equal("restart arms only the first refresh", timers.length, count + 1);
  ok(
    "no zero-delay expiry timers",
    timers.every((timer) => timer.ms > 0),
  );
  ent.stop();
}

section("verification and installation public views are cached and invalidate on raw changes");

{
  const iat = 1_762_780_000;
  let nowMs = iat * 1000;
  const backing = new Map();
  const trusted = [signer.entry];
  let verificationCalls = 0;
  let keyImports = 0;
  let installationOpens = 0;
  const originalVerify = crypto.verify;
  const originalImport = crypto.createPrivateKey;
  const trackedVault = {
    ...vault,
    open(sealed) {
      if (sealed === backing.get(INSTALLATION_KEY)) installationOpens += 1;
      return vault.open(sealed);
    },
  };
  crypto.verify = (...args) => {
    verificationCalls += 1;
    return originalVerify(...args);
  };
  crypto.createPrivateKey = (...args) => {
    keyImports += 1;
    return originalImport(...args);
  };
  try {
    const installations = createInstallation({ storage: backing, vault: trackedVault });
    const ent = createEntitlement({
      keys: trusted,
      storage: backing,
      vault: trackedVault,
      installation: installations,
      now: () => nowMs,
      fetch: async () => {
        const token = makeToken(signer, ent.prepare().installationId, { iat, exp: iat + 3600 });
        return new Response(JSON.stringify({ token }));
      },
    });
    await ent.claim(validClaimInput);
    const view = installations.getInstallation();
    const initialVerifications = verificationCalls;
    const initialImports = keyImports;
    const initialOpens = installationOpens;
    for (let index = 0; index < 100; index += 1) {
      ent.isActive();
      ent.status();
      installations.getInstallation();
    }
    equal("repeated checks reuse signature verification", verificationCalls, initialVerifications);
    equal("repeated checks do not import the private key", keyImports, initialImports);
    equal(
      "repeated public reads do not open the installation vault row",
      installationOpens,
      initialOpens,
    );
    equal("public view is reused", installations.getInstallation(), view);

    const saved = backing.get(state.RECORD_KEY);
    backing.set(state.RECORD_KEY, JSON.parse(JSON.stringify(saved)));
    ent.isActive();
    equal(
      "equal raw row values preserve verification cache",
      verificationCalls,
      initialVerifications,
    );
    backing.set(state.RECORD_KEY, { ...saved, lastError: "UNAVAILABLE" });
    equal("changed plain row is rechecked", ent.isActive(), true);
    equal(
      "plain row change invalidates signature cache",
      verificationCalls,
      initialVerifications + 1,
    );
    const hw = state.openHighWater(backing.get(state.HW_KEY), vault);
    backing.set(state.HW_KEY, state.sealHighWater(hw, vault));
    equal("resealed high-water row is rechecked", ent.isActive(), true);
    equal(
      "sealed row change invalidates signature cache",
      verificationCalls,
      initialVerifications + 2,
    );

    trusted.length = 0;
    equal(
      "removing trusted keys invalidates active verification",
      ent.status().reason,
      "unknown_kid",
    );
    trusted.push(signer.entry);
    equal("restoring trusted keys verifies again", ent.isActive(), true);
    equal(
      "trusted key change invalidates signature cache",
      verificationCalls,
      initialVerifications + 3,
    );

    const installationKey = backing.get(INSTALLATION_KEY);
    const otherBacking = new Map();
    createInstallation({ storage: otherBacking, vault }).getOrCreateInstallation();
    backing.set(INSTALLATION_KEY, otherBacking.get(INSTALLATION_KEY));
    equal("changed installation rejects the cached token", ent.status().reason, "bad_sub");
    const afterReplacement = verificationCalls;
    ent.isActive();
    equal("invalid verification is also cached", verificationCalls, afterReplacement);
    backing.set(INSTALLATION_KEY, installationKey);
    equal("restored installation rechecks the token", ent.isActive(), true);

    const beforeSigning = keyImports;
    view.sign(Buffer.from("one"));
    view.sign(Buffer.from("two"));
    equal("each request signing imports its private key afresh", keyImports, beforeSigning + 2);

    const beforeTimeChecks = verificationCalls;
    nowMs = (iat + 3600) * 1000;
    equal("cached signature still expires at call time", ent.isActive(), false);
    equal("time checks do not verify again", verificationCalls, beforeTimeChecks);
  } finally {
    crypto.verify = originalVerify;
    crypto.createPrivateKey = originalImport;
  }
}

section("isSecretBotKey and debugLog redaction");

{
  equal("plus:installation-key is secret", isSecretBotKey("plus:installation-key"), true);
  equal("plus:entitlement is secret", isSecretBotKey("plus:entitlement"), true);
  equal("plus:entitlement-hw is secret", isSecretBotKey(state.HW_KEY), true);
  const { RESTORABLE_BOT_KEYS } = require("./src/backup/content.cjs");
  equal(
    "portable backups exclude high-water row",
    RESTORABLE_BOT_KEYS.includes(state.HW_KEY),
    false,
  );
  const { exportSettings } = require("./src/services/settingsTransfer.cjs");
  const store = require("./src/db/store.cjs");
  const exportMarker = vault.seal("high-water-export-marker");
  store.saveBotSetting(state.HW_KEY, exportMarker);
  const exported = JSON.stringify(exportSettings());
  ok(
    "settings export excludes high-water row and value",
    !exported.includes(state.HW_KEY) && !exported.includes(exportMarker),
  );
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
