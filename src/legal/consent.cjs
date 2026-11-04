// The installation's Terms acceptance (ADR-020).
//
// One `bot_settings` row, `legal:acceptance`, outside the `setting:*`
// namespace: settings export reads only `setting:*`, and backups carry only
// RESTORABLE_BOT_KEYS, so the record never leaves this device. It holds no
// identifier of a person, a device or a WhatsApp account.
//
// The session asks consentStatus() before every socket it builds
// (src/core/session.js). Anything that cannot be read counts as "not
// accepted": the gate fails closed. That includes the release identity
// (src/config/release.cjs): a build file that exists but cannot be read
// is not a reason to keep an old acceptance.

const { releaseIdentity } = require("../config/release.cjs");
const { HASH_RE, parseVersion } = require("./document.cjs");
const terms = require("./terms.cjs");

const KEY = "legal:acceptance";
const RECORD_SCHEMA = 1;
const RECORD_KEYS = Object.freeze([
  "schema",
  "appVersion",
  "termsVersion",
  "sha256",
  "locale",
  "acceptedAt",
  "via",
]);
const VIA = Object.freeze(["panel", "cli", "provision"]);

const REASONS = Object.freeze({
  NOT_ACCEPTED: "terms_not_accepted",
  CHANGED: "terms_changed",
  APP_UPDATED: "app_updated",
  UNREADABLE: "consent_unreadable",
});

const DESCRIPTIONS = Object.freeze({
  [REASONS.NOT_ACCEPTED]: "The Terms of Use and the Privacy Notice have not been accepted on this installation.",
  [REASONS.CHANGED]: "The Terms of Use or the Privacy Notice changed since they were accepted.",
  [REASONS.APP_UPDATED]: "Levix was updated since the Terms of Use were accepted.",
  [REASONS.UNREADABLE]: "The Terms acceptance record could not be read.",
});

class ConsentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConsentError";
    this.code = code;
  }
}

let cachedAppVersion = null;
// Tests only. A string stands in for releaseIdentity(); undefined uses it.
let appVersionOverride;

/** The release identity an acceptance is bound to. The export name stays appVersion. */
function appVersion() {
  if (appVersionOverride !== undefined) return appVersionOverride;
  if (cachedAppVersion === null) cachedAppVersion = releaseIdentity();
  return cachedAppVersion;
}

/** Test seam. Pass a release-identity string, or undefined to use releaseIdentity(). */
function _setAppVersionForTests(identity) {
  appVersionOverride = identity;
}

// Required lazily: `levix terms show` and the tests of the document format
// must not open a database just by loading this module.
function store() {
  return require("../db/store.cjs");
}

function isIsoUtcTimestamp(value) {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function isRecord(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === RECORD_KEYS.length &&
    RECORD_KEYS.every((key) => Object.hasOwn(value, key)) &&
    value.schema === RECORD_SCHEMA &&
    typeof value.appVersion === "string" &&
    value.appVersion.length > 0 &&
    value.appVersion.length <= 64 &&
    parseVersion(value.termsVersion) !== null &&
    typeof value.sha256 === "string" &&
    HASH_RE.test(value.sha256) &&
    terms.LOCALES.includes(value.locale) &&
    isIsoUtcTimestamp(value.acceptedAt) &&
    VIA.includes(value.via)
  );
}

/** The stored record, or null when there is none or it is malformed. Throws on a database error. */
function readAcceptance() {
  const value = store().getBotSetting(KEY, null);
  return isRecord(value) ? value : null;
}

/**
 * Whether this installation may connect to WhatsApp.
 *
 * `{ ok, reason, current, accepted }`. `reason` is null when ok, otherwise one
 * of REASONS. Never throws.
 */
function consentStatus() {
  let release;
  let accepted;
  let identity;
  try {
    release = terms.currentRelease();
    accepted = readAcceptance();
    identity = appVersion();
  } catch {
    return { ok: false, reason: REASONS.UNREADABLE, current: null, accepted: null };
  }
  const current = { version: release.version, locales: Object.keys(release.documents), appVersion: identity };
  const result = (ok, reason) => ({ ok, reason, current, accepted });

  if (!accepted) return result(false, REASONS.NOT_ACCEPTED);
  const document = terms.documentFor(accepted.locale);
  if (!document || accepted.termsVersion !== document.version || accepted.sha256 !== document.sha256) {
    return result(false, REASONS.CHANGED);
  }
  if (accepted.appVersion !== identity) return result(false, REASONS.APP_UPDATED);
  return result(true, null);
}

/**
 * Record an acceptance of the document the operator was shown.
 *
 * `version` and `sha256` must equal the current document for `locale`; any
 * difference means the operator saw something else, and nothing is written.
 */
function recordAcceptance({ version, sha256, locale, via, now = new Date() } = {}) {
  if (!VIA.includes(via)) throw new ConsentError("CONSENT_BAD_REQUEST", "Unknown acceptance channel");
  // This process may have shown an older memo while the bot cached a newer release.
  terms.invalidate();
  const document = typeof locale === "string" ? terms.documentFor(locale) : null;
  if (!document) throw new ConsentError("CONSENT_BAD_LOCALE", "No Terms document in that language");
  if (version !== document.version || sha256 !== document.sha256) {
    throw new ConsentError("TERMS_MISMATCH", "The Terms version or SHA-256 does not match the current document");
  }
  // A broken release identity throws here, before the write.
  const identity = appVersion();
  const record = {
    schema: RECORD_SCHEMA,
    appVersion: identity,
    termsVersion: document.version,
    sha256: document.sha256,
    locale: document.locale,
    acceptedAt: now.toISOString(),
    via,
  };
  store().saveBotSetting(KEY, record);
  return record;
}

/** Remove the acceptance. A live connection stays; the next start asks again. */
function revokeAcceptance() {
  store().deleteBotSetting(KEY);
}

/** One English sentence per reason, for logs, the CLI and the session detail. */
function describeReason(reason) {
  return DESCRIPTIONS[reason] || DESCRIPTIONS[REASONS.NOT_ACCEPTED];
}

module.exports = {
  KEY,
  REASONS,
  VIA,
  ConsentError,
  appVersion,
  _setAppVersionForTests,
  readAcceptance,
  consentStatus,
  recordAcceptance,
  revokeAcceptance,
  describeReason,
};
