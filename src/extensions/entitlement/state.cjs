// Persisted entitlement cache and the clock rules that decide if it still counts.
//
// Trusted time is local time plus the offset captured when the token arrived
// (`iat` minus the local clock). The high-water mark only moves forward. A
// clock set back past that mark, or before `iat` by more than five minutes,
// fails closed until a newer token is accepted.

const { verifyToken } = require("./token.cjs");
const { TRUSTED_KEYS } = require("./keys.cjs");

const RECORD_KEY = "plus:entitlement";
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
  return !!record
    && typeof record === "object"
    && !Array.isArray(record)
    && typeof record.token === "string"
    && Number.isFinite(record.serverOffsetMs)
    && Number.isFinite(record.highWaterMs);
}

/**
 * @returns {{ state: string, until: string|null, reason: string|null, claims: object|null }}
 */
function evaluate(record, localNowMs, options = {}) {
  if (record == null) return NONE;
  if (!recordShape(record) || !Number.isFinite(localNowMs)) return unverified("bad_record");
  const verified = verifyToken(record.token, {
    keys: options.keys ?? TRUSTED_KEYS,
    installationId: options.installationId,
    storedSeq: null,
    storedJti: null,
  });
  if (!verified.ok) return unverified(verified.reason);

  const claims = verified.claims;
  const trustedNow = localNowMs + record.serverOffsetMs;
  const until = untilFor(claims);
  if (!Number.isFinite(trustedNow)) return unverified("bad_record");
  if (trustedNow < record.highWaterMs - SKEW_MS || trustedNow < claims.iat * 1000 - SKEW_MS) {
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
function noteHighWater(record, localNowMs, lastPersistMs) {
  if (!recordShape(record) || !Number.isFinite(localNowMs)) {
    return { record, lastPersistMs, persisted: false };
  }
  const trusted = localNowMs + record.serverOffsetMs;
  if (!Number.isFinite(trusted) || trusted <= record.highWaterMs) {
    return { record, lastPersistMs, persisted: false };
  }
  const next = { ...record, highWaterMs: trusted };
  if (lastPersistMs != null && localNowMs - lastPersistMs < HIGH_WATER_PERSIST_MS) {
    return { record: next, lastPersistMs, persisted: false };
  }
  return { record: next, lastPersistMs: localNowMs, persisted: true };
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
  SKEW_MS,
  HIGH_WATER_PERSIST_MS,
  evaluate,
  noteHighWater,
  publicFields,
  recordShape,
};
