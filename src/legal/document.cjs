// The Terms and Privacy document format: validation, canonical bytes, hash.
//
// One shape for the bundled release and for a remote one (Phase 04c), so the
// same checks decide what the operator is shown and what their acceptance is
// bound to. The rules are in docs/plans/v5/LEGAL_CONSENT_CONTRACT.md section 1.
//
// Every string is rendered as text by every client. That is why the checks
// refuse URLs and bidi overrides instead of trying to sanitize them: a
// document is not allowed to point anywhere or to reorder what it says.

const crypto = require("node:crypto");

const SCHEMA = 1;
const LOCALES = Object.freeze(["ar", "en", "pt-BR", "es-419"]);
const VERSION_RE = /^(\d{4})-(\d{2})-(\d{2})(?:\.([1-9]\d{0,2}))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

const LIMITS = Object.freeze({
  maxBytes: 65536,
  maxTitle: 160,
  maxSections: 30,
  maxParagraphs: 20,
  maxParagraph: 2000,
});

// C0 and C1 controls, bidi embeddings and overrides (U+202A..U+202E) and bidi
// isolates (U+2066..U+2069).
// biome-ignore lint/suspicious/noControlCharactersInRegex: these are exactly the characters refused
const FORBIDDEN_CHARS_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;
const LINK_RE = /:\/\/|www\./i;

class LegalDocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = "LegalDocumentError";
    this.code = "LEGAL_DOCUMENT_INVALID";
  }
}

function fail(message) {
  throw new LegalDocumentError(message);
}

function exactKeys(value, keys, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${where} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, i) => key !== expected[i])) {
    fail(`${where} must have exactly the keys ${expected.join(", ")}`);
  }
}

function text(value, max, where) {
  if (typeof value !== "string") fail(`${where} must be a string`);
  if (value.length < 1 || value.length > max) fail(`${where} must be 1 to ${max} characters`);
  if (value.trim() !== value || value.trim().length === 0) fail(`${where} has leading or trailing space`);
  if (value.normalize("NFC") !== value) fail(`${where} must be NFC`);
  if (FORBIDDEN_CHARS_RE.test(value)) fail(`${where} has a control or bidi override character`);
  if (LINK_RE.test(value)) fail(`${where} must not contain a link`);
}

function part(value, where) {
  exactKeys(value, ["title", "sections"], where);
  text(value.title, LIMITS.maxTitle, `${where}.title`);
  const { sections } = value;
  if (!Array.isArray(sections) || sections.length < 1 || sections.length > LIMITS.maxSections) {
    fail(`${where}.sections must hold 1 to ${LIMITS.maxSections} sections`);
  }
  sections.forEach((section, i) => {
    const at = `${where}.sections[${i}]`;
    exactKeys(section, ["heading", "paragraphs"], at);
    text(section.heading, LIMITS.maxTitle, `${at}.heading`);
    const { paragraphs } = section;
    if (!Array.isArray(paragraphs) || paragraphs.length < 1 || paragraphs.length > LIMITS.maxParagraphs) {
      fail(`${at}.paragraphs must hold 1 to ${LIMITS.maxParagraphs} paragraphs`);
    }
    paragraphs.forEach((paragraph, j) => text(paragraph, LIMITS.maxParagraph, `${at}.paragraphs[${j}]`));
  });
}

function validDate(value) {
  if (!DATE_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseVersion(version) {
  const match = typeof version === "string" ? VERSION_RE.exec(version) : null;
  if (!match || !validDate(version.slice(0, 10))) return null;
  return { date: version.slice(0, 10), revision: match[4] ? Number(match[4]) : 0 };
}

/** Negative when a is older than b, zero when equal, positive when newer. */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new LegalDocumentError("Cannot compare an invalid version");
  if (left.date !== right.date) return left.date < right.date ? -1 : 1;
  return left.revision - right.revision;
}

/** Keys sorted, no whitespace. Only plain JSON values reach here. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Throws LegalDocumentError unless `doc` follows the contract. Returns it frozen. */
function validateDocument(doc) {
  exactKeys(doc, ["schema", "version", "locale", "effective", "terms", "privacy"], "document");
  if (doc.schema !== SCHEMA) fail(`document.schema must be ${SCHEMA}`);
  if (!parseVersion(doc.version)) fail("document.version must be YYYY-MM-DD or YYYY-MM-DD.N");
  if (!LOCALES.includes(doc.locale)) fail(`document.locale must be one of ${LOCALES.join(", ")}`);
  if (typeof doc.effective !== "string" || !validDate(doc.effective)) fail("document.effective must be YYYY-MM-DD");
  part(doc.terms, "document.terms");
  part(doc.privacy, "document.privacy");
  if (Buffer.byteLength(canonicalJson(doc), "utf8") > LIMITS.maxBytes) {
    fail(`document is larger than ${LIMITS.maxBytes} bytes`);
  }
  return deepFreeze(doc);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Lowercase hex sha256 of the document's canonical UTF-8 bytes. */
function documentHash(doc) {
  return crypto.createHash("sha256").update(canonicalJson(doc), "utf8").digest("hex");
}

module.exports = {
  SCHEMA,
  LOCALES,
  LIMITS,
  HASH_RE,
  LegalDocumentError,
  validateDocument,
  canonicalJson,
  documentHash,
  parseVersion,
  compareVersions,
};
