// The current Terms and Privacy release.
//
// Phase 04a ships one source: the release bundled with the app, trusted because
// it ships inside the app package and pinned by a test (ADR-019). Phase 04c
// adds verified remote releases; this module stays the one place that answers
// "which document is current for this locale".
//
// Validation is lazy and the result is memoized, so a broken bundle never
// crashes a boot: consent fails closed instead (src/legal/consent.cjs).

const brand = require("../config/brand.cjs");
const { LOCALES, LegalDocumentError, documentHash, validateDocument } = require("./document.cjs");

// Every bundled locale. One `require` per file so the single-executable build
// bundles them (scripts/build-sea.mjs cannot read a directory at run time).
const BUNDLED = Object.freeze({
  en: () => require("./bundled/en.json"),
});

const DEFAULT_LOCALE = "en";

// Links shown beside the documents. They come from code, never from a
// document, so a document cannot send anybody anywhere.
const LINKS = Object.freeze({
  privacyPolicy: `${brand.repo}/blob/main/PRIVACY.md`,
  license: `${brand.repo}/blob/main/LICENSE`,
  website: "https://levix.leviro.net",
});

let memo = null;

function loadBundled() {
  const documents = {};
  let version = null;
  for (const [locale, load] of Object.entries(BUNDLED)) {
    // A deep copy: the validated object is frozen, and require's cache keeps
    // the original untouched for anything else that reads it.
    const document = validateDocument(JSON.parse(JSON.stringify(load())));
    if (document.locale !== locale) throw new LegalDocumentError(`bundled ${locale} declares ${document.locale}`);
    if (version !== null && document.version !== version) {
      throw new LegalDocumentError("bundled documents have different versions");
    }
    version = document.version;
    documents[locale] = Object.freeze({ document, sha256: documentHash(document) });
  }
  if (!documents[DEFAULT_LOCALE]) throw new LegalDocumentError("the bundled release has no English document");
  return Object.freeze({ version, source: "bundled", documents: Object.freeze(documents) });
}

/** The current release. Throws LegalDocumentError when it is not usable. */
function currentRelease() {
  if (!memo) {
    try {
      memo = { release: loadBundled() };
    } catch (error) {
      memo = { error };
    }
  }
  if (memo.error) throw memo.error;
  return memo.release;
}

function availableLocales() {
  return Object.keys(currentRelease().documents);
}

/** The locale itself when the release has it, otherwise English. */
function resolveLocale(locale) {
  const release = currentRelease();
  return typeof locale === "string" && release.documents[locale] ? locale : DEFAULT_LOCALE;
}

/**
 * The document for one locale: `{ version, locale, sha256, document, source }`,
 * or null when the release has no document in that locale.
 */
function documentFor(locale) {
  const release = currentRelease();
  const entry = typeof locale === "string" ? release.documents[locale] : null;
  if (!entry) return null;
  return { version: release.version, locale, sha256: entry.sha256, document: entry.document, source: release.source };
}

module.exports = {
  DEFAULT_LOCALE,
  LINKS,
  LOCALES,
  currentRelease,
  availableLocales,
  resolveLocale,
  documentFor,
};
