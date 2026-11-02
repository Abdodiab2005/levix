// The public keys that may sign a remote Terms release (ADR-019).
//
// The private key never lives here. The owner generates it outside this
// repository (`scripts/legal-release.mjs keygen`) and adds only the public
// half. An empty list is the shipped state: the remote client stays off.
//
// Callers read `TRUSTED_KEYS` from this module at the moment they verify, not
// a copy taken when they were loaded.

const crypto = require("node:crypto");

// Ed25519 SubjectPublicKeyInfo: algorithm OID 1.3.101.112, then the 32 raw bytes.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

class LegalKeyError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegalKeyError";
    this.code = "LEGAL_KEY_INVALID";
  }
}

function keyIdForRaw(raw) {
  return crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

function rawPublicKeyFromBase64(value) {
  const alphabet = typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
  if (!alphabet || value.length % 4 !== 0) {
    throw new LegalKeyError("publicKey must be strict base64");
  }
  const raw = Buffer.from(value, "base64");
  if (raw.toString("base64") !== value || raw.length !== 32) {
    throw new LegalKeyError("publicKey must be 32 bytes of strict base64");
  }
  return raw;
}

function publicKeyObjectFromRaw(raw) {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) {
    throw new LegalKeyError("public key must be 32 bytes");
  }
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, raw]),
    format: "der",
    type: "spki",
  });
}

function rawFromKeyObject(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  const prefix = der.subarray(0, SPKI_PREFIX.length);
  const prefixOk = der.length === SPKI_PREFIX.length + 32 && prefix.equals(SPKI_PREFIX);
  if (!prefixOk) throw new LegalKeyError("key is not an Ed25519 public key");
  return Buffer.from(der.subarray(SPKI_PREFIX.length));
}

/** Throws LegalKeyError when an entry is not `{ keyId, publicKey }` for its own raw key. */
function assertTrustedKeys(entries) {
  if (!Array.isArray(entries)) throw new LegalKeyError("TRUSTED_KEYS must be an array");
  const seen = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new LegalKeyError(`trusted key ${index} must be an object`);
    }
    const names = Object.keys(entry);
    const hasId = Object.hasOwn(entry, "keyId");
    const hasKey = Object.hasOwn(entry, "publicKey");
    if (names.length !== 2 || !hasId || !hasKey) {
      throw new LegalKeyError(`trusted key ${index} must have exactly keyId and publicKey`);
    }
    const raw = rawPublicKeyFromBase64(entry.publicKey);
    const derived = keyIdForRaw(raw);
    if (entry.keyId !== derived) {
      throw new LegalKeyError(`trusted key ${index} keyId does not match the public key`);
    }
    if (seen.has(derived)) throw new LegalKeyError(`trusted key ${index} repeats a keyId`);
    seen.add(derived);
    publicKeyObjectFromRaw(raw);
  }
}

// The owner adds `{ keyId, publicKey }` here. `publicKey` is the base64 raw
// 32-byte key printed by `legal-release.mjs keygen`. Empty until then.
const TRUSTED_KEYS = Object.freeze([]);
assertTrustedKeys(TRUSTED_KEYS);

module.exports = {
  TRUSTED_KEYS,
  LegalKeyError,
  assertTrustedKeys,
  keyIdForRaw,
  rawPublicKeyFromBase64,
  publicKeyObjectFromRaw,
  rawFromKeyObject,
};
