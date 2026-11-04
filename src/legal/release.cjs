// A signed Terms release: pure checks, no network and no disk.
//
// The signed bytes are the canonical JSON of one release, so every locale
// carries the same version (ADR-019). `verifyEnvelope` is the gate the client
// and the cache share. `buildRelease` and `signRelease` are for the owner
// script and the tests; the private key never comes from this repository.

const crypto = require("node:crypto");
const {
  LOCALES,
  LegalDocumentError,
  canonicalJson,
  documentHash,
  parseVersion,
  validateDocument,
} = require("./document.cjs");
const {
  keyIdForRaw,
  publicKeyObjectFromRaw,
  rawFromKeyObject,
  rawPublicKeyFromBase64,
} = require("./keys.cjs");

const RELEASE_KEYS = Object.freeze(["schema", "version", "documents"]);
const ENVELOPE_KEYS = Object.freeze(["keyId", "payload", "signature"]);

class LegalReleaseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LegalReleaseError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new LegalReleaseError(code, message);
}

function exactKeys(value, keys, code, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${where} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    fail(code, `${where} must have exactly the keys ${keys.join(", ")}`);
  }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function decodeBase64Strict(value, label) {
  const alphabet = typeof value === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
  const strict = alphabet && value.length % 4 === 0;
  if (!strict) fail("BAD_BASE64", `${label} is not strict base64`);
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail("BAD_BASE64", `${label} is not strict base64`);
  return bytes;
}

/** Throws unless `release` is one schema-1 release of section-1 documents. Returns it. */
function assertRelease(release) {
  exactKeys(release, RELEASE_KEYS, "INVALID_RELEASE", "release");
  if (release.schema !== 1) fail("INVALID_RELEASE", "release.schema must be 1");
  if (!parseVersion(release.version)) fail("INVALID_RELEASE", "release.version is invalid");
  const { documents } = release;
  if (!documents || typeof documents !== "object" || Array.isArray(documents)) {
    fail("INVALID_RELEASE", "release.documents must be an object");
  }
  const locales = Object.keys(documents);
  for (const locale of locales) {
    if (!LOCALES.includes(locale)) fail("INVALID_RELEASE", `unknown locale ${locale}`);
  }
  if (!Object.hasOwn(documents, "en")) fail("INVALID_RELEASE", "release is missing en");
  for (const locale of locales) {
    let document;
    try {
      document = validateDocument(documents[locale]);
    } catch (error) {
      if (error instanceof LegalDocumentError) fail("INVALID_RELEASE", error.message);
      throw error;
    }
    if (document.locale !== locale) {
      fail("INVALID_RELEASE", `locale key ${locale} declares ${document.locale}`);
    }
    if (document.version !== release.version) {
      fail("INVALID_RELEASE", `document version for ${locale} does not match the release`);
    }
  }
  return release;
}

function asRemoteRelease(release) {
  const documents = {};
  for (const locale of LOCALES) {
    if (!Object.hasOwn(release.documents, locale)) continue;
    const document = release.documents[locale];
    documents[locale] = Object.freeze({ document, sha256: documentHash(document) });
  }
  return Object.freeze({
    version: release.version,
    source: "remote",
    documents: Object.freeze(documents),
  });
}

/**
 * Verify an envelope against `keys` (`{ keyId, publicKey }`, publicKey base64 raw).
 * Returns the frozen release `{ version, source: "remote", documents }`.
 * Throws LegalReleaseError. Does not touch disk.
 */
function verifyEnvelope(envelope, keys) {
  exactKeys(envelope, ENVELOPE_KEYS, "ENVELOPE_SHAPE", "envelope");
  if (typeof envelope.keyId !== "string" || !/^[0-9a-f]{16}$/.test(envelope.keyId)) {
    fail("ENVELOPE_SHAPE", "keyId must be 16 lowercase hex characters");
  }
  if (typeof envelope.payload !== "string" || typeof envelope.signature !== "string") {
    fail("ENVELOPE_SHAPE", "payload and signature must be strings");
  }
  if (!Array.isArray(keys)) fail("UNKNOWN_KEY", "keyId is not trusted");
  const entry = keys.find((item) => item && item.keyId === envelope.keyId);
  if (!entry || keys.filter((item) => item && item.keyId === envelope.keyId).length !== 1) {
    fail("UNKNOWN_KEY", "keyId is not trusted");
  }

  let raw;
  try {
    raw = rawPublicKeyFromBase64(entry.publicKey);
  } catch {
    fail("UNKNOWN_KEY", "trusted public key is not usable");
  }
  if (keyIdForRaw(raw) !== entry.keyId) {
    fail("UNKNOWN_KEY", "trusted keyId does not match its public key");
  }

  const payload = decodeBase64Strict(envelope.payload, "payload");
  const signature = decodeBase64Strict(envelope.signature, "signature");
  let publicKey;
  try {
    publicKey = publicKeyObjectFromRaw(raw);
  } catch {
    fail("UNKNOWN_KEY", "trusted public key is not usable");
  }
  let signed = false;
  try {
    signed = crypto.verify(null, payload, publicKey, signature);
  } catch {
    signed = false;
  }
  if (!signed) fail("BAD_SIGNATURE", "signature does not verify");

  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
  } catch {
    fail("BAD_PAYLOAD", "payload is not UTF-8");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("BAD_PAYLOAD", "payload is not JSON");
  }
  const canonical = Buffer.from(canonicalJson(parsed), "utf8");
  if (!canonical.equals(payload)) fail("NOT_CANONICAL", "payload is not canonical JSON");

  assertRelease(parsed);
  return asRemoteRelease(parsed);
}

/** `{ schema, version, documents }` from locale -> document. Frozen. Throws LegalReleaseError. */
function buildRelease(documentsByLocale) {
  const bag = documentsByLocale;
  if (!bag || typeof bag !== "object" || Array.isArray(bag)) {
    fail("INVALID_RELEASE", "documents must be an object");
  }
  const documents = {};
  let version = null;
  for (const locale of Object.keys(documentsByLocale)) {
    let copy;
    try {
      copy = JSON.parse(JSON.stringify(documentsByLocale[locale]));
    } catch {
      fail("INVALID_RELEASE", `document ${locale} is not plain JSON`);
    }
    if (version === null && copy && typeof copy.version === "string") version = copy.version;
    documents[locale] = copy;
  }
  if (version === null) fail("INVALID_RELEASE", "release is missing a version");
  const release = assertRelease({ schema: 1, version, documents });
  return deepFreeze(release);
}

/** Envelope `{ keyId, payload, signature }` over the canonical release bytes. */
function signRelease(release, privateKey) {
  if (!privateKey || privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    fail("BAD_SIGNATURE", "private key must be an Ed25519 KeyObject");
  }
  assertRelease(release);
  const payload = Buffer.from(canonicalJson(release), "utf8");
  let signature;
  try {
    signature = crypto.sign(null, payload, privateKey);
  } catch {
    fail("BAD_SIGNATURE", "could not sign the release");
  }
  const raw = rawFromKeyObject(crypto.createPublicKey(privateKey));
  return {
    keyId: keyIdForRaw(raw),
    payload: payload.toString("base64"),
    signature: signature.toString("base64"),
  };
}

module.exports = {
  LegalReleaseError,
  verifyEnvelope,
  buildRelease,
  signRelease,
  assertRelease,
};
