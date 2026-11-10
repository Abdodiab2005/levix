// Entitlement token checks. Pure: no clock, no disk, no network.
//
// A compact JWS is accepted only when the header is the canonical three-field
// object, the kid is a trusted Ed25519 key, the signature covers the signing
// input, and every claim matches the wire contract. Time is judged later.

const crypto = require("node:crypto");

const { canonicalJson } = require("../../legal/document.cjs");
const { findTrustedKey, TRUSTED_KEYS } = require("./keys.cjs");

const MAX_TOKEN_BYTES = 4096;
const MAX_LIFETIME_SEC = 259200;
const MAX_GRACE_SEC = 86400;
const INACTIVE_LIFETIME_SEC = 86400;
const HEADER_TYPE = "levix-ent+jwt";
const ISSUER = "levix-plus-verifier";
const AUDIENCE = "levix-core";
const STATES = new Set(["active", "grace", "canceled", "inactive"]);
const REASONS = new Set(["expired", "on_hold", "paused", "pending", "revoked", "rebound", "not_found"]);
const PAYLOAD_KEYS = Object.freeze(["aud", "ent", "exp", "iat", "iss", "jti", "pexp", "rsn", "seq", "st", "sub"]);

function fail(reason) {
  return { ok: false, claims: null, reason };
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) return null;
  return bytes;
}

function utf8Json(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  try {
    return { text, value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function exactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value, min = 0) {
  return Number.isSafeInteger(value) && value >= min;
}

function claimsFrom(value, options) {
  if (!exactKeys(value, PAYLOAD_KEYS)) return fail("bad_payload");
  if (value.iss !== ISSUER) return fail("bad_iss");
  if (value.aud !== AUDIENCE) return fail("bad_aud");
  if (typeof value.sub !== "string" || value.sub !== options.installationId) return fail("bad_sub");
  if (!Array.isArray(value.ent) || value.ent.length > 1 || (value.ent.length === 1 && value.ent[0] !== "plus")) {
    return fail("bad_ent");
  }
  if (!STATES.has(value.st)) return fail("bad_st");
  const inactive = value.st === "inactive";
  if (inactive) {
    if (!REASONS.has(value.rsn) || value.ent.length !== 0) return fail("bad_rsn");
  } else if (value.rsn !== null) {
    return fail("bad_rsn");
  }
  if (!integer(value.iat) || !integer(value.exp)) return fail("bad_exp");
  if (value.exp <= value.iat) return fail("bad_exp");
  if (value.exp - value.iat > MAX_LIFETIME_SEC) return fail("bad_exp");
  if (value.st === "grace" && value.exp - value.iat > MAX_GRACE_SEC) return fail("bad_exp");
  if (inactive && value.exp - value.iat !== INACTIVE_LIFETIME_SEC) return fail("bad_exp");
  if (!integer(value.seq)) return fail("bad_seq");
  const jti = decodeBase64Url(value.jti);
  if (!jti || jti.length !== 16) return fail("bad_jti");
  if (value.pexp !== null && !integer(value.pexp)) return fail("bad_pexp");
  if (value.st === "canceled" && (!integer(value.pexp) || value.exp > value.pexp)) return fail("bad_pexp");

  const storedSeq = options.storedSeq;
  if (storedSeq != null) {
    if (!integer(storedSeq)) return fail("bad_seq");
    if (value.seq < storedSeq || (value.seq === storedSeq && value.jti !== options.storedJti)) {
      return fail("replay");
    }
  }

  return {
    ok: true,
    reason: null,
    claims: Object.freeze({
      iss: value.iss,
      aud: value.aud,
      sub: value.sub,
      ent: Object.freeze([...value.ent]),
      st: value.st,
      rsn: value.rsn,
      iat: value.iat,
      exp: value.exp,
      seq: value.seq,
      jti: value.jti,
      pexp: value.pexp,
    }),
  };
}

/**
 * @param {string} compact
 * @param {{ keys?: Array<{keyId: string, publicKey: string}>, installationId?: string, storedSeq?: number|null, storedJti?: string|null }} [options]
 * @returns {{ ok: boolean, claims: object|null, reason: string|null }}
 */
function verifyToken(compact, options = {}) {
  if (typeof compact !== "string") return fail("malformed");
  if (Buffer.byteLength(compact, "utf8") > MAX_TOKEN_BYTES) return fail("oversized");
  const parts = compact.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return fail("malformed");

  const headerBytes = decodeBase64Url(parts[0]);
  const headerJson = headerBytes && utf8Json(headerBytes);
  if (!headerJson || !headerJson.value || typeof headerJson.value !== "object" || Array.isArray(headerJson.value)) {
    return fail("bad_header");
  }
  const header = headerJson.value;
  if (!exactKeys(header, ["alg", "kid", "typ"])) return fail("bad_header");
  if (header.alg !== "EdDSA" || header.typ !== HEADER_TYPE || !/^[0-9a-f]{16}$/.test(header.kid)) {
    return fail("bad_header");
  }
  if (headerJson.text !== canonicalJson({ alg: "EdDSA", kid: header.kid, typ: HEADER_TYPE })) {
    return fail("bad_header");
  }

  const key = findTrustedKey(options.keys ?? TRUSTED_KEYS, header.kid);
  if (!key) return fail("unknown_kid");
  const signature = decodeBase64Url(parts[2]);
  if (!signature || signature.length !== 64) return fail("bad_signature");
  let signed = false;
  try {
    signed = crypto.verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), key.keyObject, signature);
  } catch {
    signed = false;
  }
  if (!signed) return fail("bad_signature");

  const payloadBytes = decodeBase64Url(parts[1]);
  const payloadJson = payloadBytes && utf8Json(payloadBytes);
  if (!payloadJson) return fail("bad_payload");
  return claimsFrom(payloadJson.value, options);
}

module.exports = {
  MAX_TOKEN_BYTES,
  verifyToken,
};
