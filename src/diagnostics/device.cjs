// The device diagnostics object (contract section 1).
//
// One function decides what an operator's panel page is allowed to tell the
// server about the machine it is running on. It is a strict allowlist: only the
// keys in the contract survive, anything else is dropped, the two server-owned
// triples of keys (levix/node/platform) are written by this process and never
// read from the client, and the whole object is kept under 2 KB.
//
// This same function builds the preview the operator sees, so the preview and
// the forwarded object cannot drift apart.

const { stripControl } = require("./sanitize.cjs");

/** String client fields and their caps, straight from the contract. */
const STRING_CAPS = Object.freeze({
  nativeApp: 40,
  android: 40,
  device: 80,
  abi: 24,
  webview: 40,
  screen: 24,
});

/** Enumerated client fields. Anything outside the list is dropped. */
const ENUMS = Object.freeze({
  language: ["ar", "en"],
  theme: ["light", "dark"],
  connectivity: ["wifi", "cellular", "ethernet", "vpn", "none", "unknown"],
  memory: ["ok", "low", "unknown"],
  storage: ["ok", "low", "unknown"],
});

const DIAGNOSTICS_MAX_BYTES = 2048;

/**
 * Trim, take out control characters, cap. Section 1 only promises these; the
 * section 4 substitutions would mangle a legitimate value (`412x915@2.63`
 * reads as an e-mail, a long hex `device` as a secret), so they are deliberately
 * NOT applied here. Empty means "do not send".
 */
function clip(value, max) {
  if (typeof value !== "string") return "";
  return stripControl(value).trim().slice(0, max);
}

/**
 * Only the client-owned keys of section 1, validated. Used by `buildDiagnostics`
 * and by the crash-report store for its `device` block (which is section 1's
 * Android and page keys without levix/node/platform).
 *
 * @param {unknown} client
 * @returns {Record<string, string>}
 */
function sanitizeClientFields(client) {
  const out = {};
  if (!client || typeof client !== "object" || Array.isArray(client)) return out;

  for (const [key, cap] of Object.entries(STRING_CAPS)) {
    const text = clip(client[key], cap);
    if (text) out[key] = text;
  }

  for (const [key, allowed] of Object.entries(ENUMS)) {
    const raw = client[key];
    if (typeof raw !== "string") continue;
    const value = raw.trim().toLowerCase();
    if (allowed.includes(value)) out[key] = value;
  }

  return out;
}

/** describeRuntime() may need the database; the server keys are never fatal. */
function runtimeFacts() {
  try {
    const { describeRuntime } = require("../panel/feedback.cjs");
    const runtime = describeRuntime();
    return { version: runtime?.version || "unknown", platform: runtime?.platform || "unknown" };
  } catch {
    return { version: "unknown", platform: "unknown" };
  }
}

/** The 2 KB ceiling is a safety net; the caps above already keep it small. */
function enforceSize(object) {
  const dropOrder = ["device", "abi", "webview", "nativeApp", "android", "screen"];
  for (const key of dropOrder) {
    if (Buffer.byteLength(JSON.stringify(object), "utf8") <= DIAGNOSTICS_MAX_BYTES) break;
    delete object[key];
  }
  return object;
}

/**
 * Build the section 1 object from a client object plus this server's own facts.
 * A client value for levix/node/platform is ignored by construction.
 *
 * @param {unknown} client
 * @returns {Record<string, unknown>}
 */
function buildDiagnostics(client) {
  const runtime = runtimeFacts();
  const object = {
    schema: 1,
    levix: clip(runtime.version, 32) || "unknown",
    node: clip(process.version, 32) || "unknown",
    platform: clip(runtime.platform, 32) || "unknown",
    ...sanitizeClientFields(client),
  };
  return enforceSize(object);
}

module.exports = {
  DIAGNOSTICS_MAX_BYTES,
  STRING_CAPS,
  ENUMS,
  buildDiagnostics,
  sanitizeClientFields,
};
