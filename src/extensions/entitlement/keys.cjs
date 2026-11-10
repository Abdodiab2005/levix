// Public keys that may sign a Levix Plus entitlement token.
//
// The private key never lives here. The owner generates it outside this
// repository and adds only the public half, the same way as a Terms key.
// An empty list is intentional: nothing verifies, and Plus stays off.
// Callers pass the list into the verifier. There is no setter.

const {
  assertTrustedKeys,
  keyIdForRaw,
  publicKeyObjectFromRaw,
  rawFromKeyObject,
  rawPublicKeyFromBase64,
} = require("../../legal/keys.cjs");

const TRUSTED_KEYS = Object.freeze([]);
assertTrustedKeys(TRUSTED_KEYS);
const loadedKeyCache = new Map();

function keyIdFor(rawPublicKey) {
  if (!Buffer.isBuffer(rawPublicKey) && !(rawPublicKey instanceof Uint8Array)) {
    const error = new Error("public key must be 32 bytes");
    error.code = "ENTITLEMENT_KEY_INVALID";
    throw error;
  }
  const raw = Buffer.from(rawPublicKey);
  if (raw.length !== 32) {
    const error = new Error("public key must be 32 bytes");
    error.code = "ENTITLEMENT_KEY_INVALID";
    throw error;
  }
  return keyIdForRaw(raw);
}

/** One frozen `{ keyId, publicKey, raw, keyObject }` from a trusted entry. Throws when the entry is not that key. */
function loadTrustedKey(entry) {
  assertTrustedKeys([entry]);
  const cacheKey = `${entry.keyId}:${entry.publicKey}`;
  const cached = loadedKeyCache.get(cacheKey);
  if (cached) return cached;
  const raw = rawPublicKeyFromBase64(entry.publicKey);
  const loaded = Object.freeze({
    keyId: entry.keyId,
    publicKey: entry.publicKey,
    raw: Buffer.from(raw),
    keyObject: publicKeyObjectFromRaw(raw),
  });
  loadedKeyCache.set(cacheKey, loaded);
  return loaded;
}

/** The single trusted entry for `kid`, or null when it is missing, repeated, or unusable. */
function findTrustedKey(keys, kid) {
  if (typeof kid !== "string" || !/^[0-9a-f]{16}$/.test(kid) || !Array.isArray(keys)) return null;
  const matches = keys.filter((entry) => entry && entry.keyId === kid);
  if (matches.length !== 1) return null;
  try {
    return loadTrustedKey(matches[0]);
  } catch {
    return null;
  }
}

module.exports = {
  TRUSTED_KEYS,
  assertTrustedKeys,
  keyIdFor,
  loadTrustedKey,
  findTrustedKey,
  publicKeyObjectFromRaw,
  rawFromKeyObject,
};
