// Persisted entitlement cache and the clock rules that decide if it still counts.
//
// Trusted time is local time plus the offset captured when the token arrived
// (`iat` minus the local clock). The high-water mark only moves forward. A
// clock set back past that mark, or before `iat` by more than five minutes,
// fails closed until a newer token is accepted.

const { MAX_TOKEN_BYTES, verifyToken } = require("./token.cjs");
const { TRUSTED_KEYS } = require("./keys.cjs");

const RECORD_KEY = "plus:entitlement";
const HW_KEY = "plus:entitlement-hw";
const SKEW_MS = 300_000;
const HIGH_WATER_PERSIST_MS = 300_000;
const NONE = Object.freeze({ state: "none", until: null, reason: null, claims: null });

function unverified(reason) {
  return { state: "unverified", until: null, reason, claims: null };
}

function untilFor(claims) {
  return new Date(claims.exp * 1000).toISOString();
}

function recordShape(record) {
  return (
    !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    Buffer.byteLength(record.token, "utf8") <= MAX_TOKEN_BYTES
  );
}

function hwShape(hw) {
  return (
    !!hw &&
    typeof hw === "object" &&
    !Array.isArray(hw) &&
    typeof hw.installationId === "string" &&
    hw.installationId.length > 0 &&
    Number.isSafeInteger(hw.maxSeq) &&
    hw.maxSeq >= 0 &&
    typeof hw.jti === "string" &&
    hw.jti.length > 0 &&
    Number.isFinite(hw.highWaterMs) &&
    Number.isFinite(hw.serverOffsetMs)
  );
}

function sealHighWater(hw, vaultImpl) {
  const v = vaultImpl ?? require("../../config/vault.cjs");
  return v.seal(
    JSON.stringify({
      installationId: hw.installationId,
      maxSeq: hw.maxSeq,
      highWaterMs: hw.highWaterMs,
      serverOffsetMs: hw.serverOffsetMs,
      jti: hw.jti,
    }),
  );
}

function openHighWater(sealed, vaultImpl) {
  if (typeof sealed !== "string" || sealed.length === 0) return null;
  const v = vaultImpl ?? require("../../config/vault.cjs");
  if (typeof v.isSealed === "function" && !v.isSealed(sealed)) return null;
  let raw;
  try {
    raw = v.open(sealed);
  } catch {
    return null;
  }
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return hwShape(parsed) ? parsed : null;
}

/**
 * @returns {{ state: string, until: string|null, reason: string|null, claims: object|null }}
 */
function evaluate(record, localNowMs, options = {}) {
  if (record == null) return NONE;
  if (!recordShape(record) || !Number.isFinite(localNowMs)) return unverified("bad_record");
  let installationId = options.installationId;
  if (!Object.hasOwn(options, "installationId")) {
    try {
      installationId = require("./installation.cjs").getInstallation()?.installationId ?? null;
    } catch {
      installationId = null;
    }
  }
  const verified =
    options.verified ??
    verifyToken(record.token, {
      keys: options.keys ?? TRUSTED_KEYS,
      installationId,
      storedSeq: null,
      storedJti: null,
    });
  if (!verified.ok) return unverified(verified.reason);

  const claims = verified.claims;
  if (Number.isSafeInteger(options.maxSeq)) {
    if (
      claims.seq < options.maxSeq ||
      (claims.seq === options.maxSeq &&
        typeof options.maxJti === "string" &&
        claims.jti !== options.maxJti)
    ) {
      return unverified("rollback");
    }
  }
  if (
    (record.seq != null && record.seq !== claims.seq) ||
    (record.jti != null && record.jti !== claims.jti)
  ) {
    return unverified("bad_record");
  }
  const hw = options.hw;
  if (!hwShape(hw) || hw.installationId !== installationId) {
    return unverified("bad_record");
  }
  if (claims.seq < hw.maxSeq || (claims.seq === hw.maxSeq && claims.jti !== hw.jti)) {
    return unverified("rollback");
  }
  if (claims.seq > hw.maxSeq) {
    return unverified("bad_record");
  }
  const trustedNow = localNowMs + hw.serverOffsetMs;
  const until = untilFor(claims);
  if (!Number.isFinite(trustedNow)) return unverified("bad_record");
  if (trustedNow < hw.highWaterMs - SKEW_MS || trustedNow < claims.iat * 1000 - SKEW_MS) {
    return { state: "clock", until, reason: "clock", claims };
  }
  if (trustedNow >= claims.exp * 1000) {
    return { state: "expired", until, reason: "expired", claims };
  }
  if (claims.st === "inactive") {
    return { state: "inactive", until, reason: claims.rsn, claims };
  }
  return { state: claims.st, until, reason: null, claims };
}

/**
 * Move `highWaterMs` up to trusted now. The caller persists only when
 * `persisted` is set, which is at most once per five minutes.
 */
function noteHighWater(target, localNowMs, lastPersistMs) {
  if (
    !target ||
    typeof target !== "object" ||
    !Number.isFinite(target.serverOffsetMs) ||
    !Number.isFinite(target.highWaterMs) ||
    !Number.isFinite(localNowMs)
  ) {
    return { record: target, hw: target, lastPersistMs, persisted: false };
  }
  const trusted = localNowMs + target.serverOffsetMs;
  if (!Number.isFinite(trusted) || trusted <= target.highWaterMs) {
    return { record: target, hw: target, lastPersistMs, persisted: false };
  }
  const next = { ...target, highWaterMs: trusted };
  if (lastPersistMs != null && localNowMs - lastPersistMs < HIGH_WATER_PERSIST_MS) {
    return { record: next, hw: next, lastPersistMs, persisted: false };
  }
  return { record: next, hw: next, lastPersistMs: localNowMs, persisted: true };
}

function publicFields(record) {
  return {
    token: record.token,
    seq: record.seq,
    jti: record.jti,
    serverOffsetMs: record.serverOffsetMs,
    highWaterMs: record.highWaterMs,
    lastRefreshAt: record.lastRefreshAt ?? null,
    nextRefreshAt: record.nextRefreshAt ?? null,
    lastError: record.lastError ?? null,
  };
}

module.exports = {
  RECORD_KEY,
  HW_KEY,
  SKEW_MS,
  HIGH_WATER_PERSIST_MS,
  evaluate,
  noteHighWater,
  publicFields,
  recordShape,
  hwShape,
  sealHighWater,
  openHighWater,
};
