// The current Terms and Privacy release.
//
// The bundled release ships inside the app package and is pinned by a test
// (ADR-019). A verified remote release replaces it only when its version is
// strictly newer. Equal versions keep the bundle. A broken bundle still fails
// closed. A cache that cannot be read or verified falls back to the bundle.
//
// Validation is lazy and the result is memoized, so a broken bundle never
// crashes a boot: consent fails closed instead (src/legal/consent.cjs).

const brand = require("../config/brand.cjs");
const {
  LOCALES,
  LegalDocumentError,
  compareVersions,
  documentHash,
  validateDocument,
} = require("./document.cjs");

// Every bundled locale. One `require` per file so the single-executable build
// bundles them (scripts/build-sea.mjs cannot read a directory at run time).
const BUNDLED = Object.freeze({
  ar: () => require("./bundled/ar.json"),
  en: () => require("./bundled/en.json"),
  "pt-BR": () => require("./bundled/pt-BR.json"),
  "es-419": () => require("./bundled/es-419.json"),
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
    if (document.locale !== locale) {
      throw new LegalDocumentError(`bundled ${locale} declares ${document.locale}`);
    }
    if (version !== null && document.version !== version) {
      throw new LegalDocumentError("bundled documents have different versions");
    }
    version = document.version;
    documents[locale] = Object.freeze({ document, sha256: documentHash(document) });
  }
  if (!documents[DEFAULT_LOCALE]) {
    throw new LegalDocumentError("the bundled release has no English document");
  }
  return Object.freeze({ version, source: "bundled", documents: Object.freeze(documents) });
}

// Remote is loaded lazily so requiring this file does not open the cache, and
// so remote.cjs can call back into invalidate() without a load cycle.
function chooseRelease(bundled) {
  let remote = null;
  try {
    remote = require("./remote.cjs").readCachedRelease();
  } catch {
    return bundled;
  }
  if (!remote) return bundled;
  try {
    if (compareVersions(remote.version, bundled.version) > 0) return remote;
  } catch {
    return bundled;
  }
  return bundled;
}

/** The bundled release, ignoring the cache. Throws LegalDocumentError when it is not usable. */
function bundledRelease() {
  return loadBundled();
}

/** Drop the memo so the next currentRelease() re-reads the bundle and the cache. */
function invalidate() {
  memo = null;
}

/** The current release. Throws LegalDocumentError when the bundle is not usable. */
function currentRelease() {
  if (!memo) {
    try {
      memo = { release: chooseRelease(loadBundled()) };
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
  if (typeof locale === "string" && Object.hasOwn(release.documents, locale)) return locale;
  return DEFAULT_LOCALE;
}

/**
 * The document for one locale: `{ version, locale, sha256, document, source }`,
 * or null when the release has no document in that locale.
 */
function documentFor(locale) {
  const release = currentRelease();
  if (typeof locale !== "string" || !Object.hasOwn(release.documents, locale)) return null;
  const entry = release.documents[locale];
  return {
    version: release.version,
    locale,
    sha256: entry.sha256,
    document: entry.document,
    source: release.source,
  };
}

module.exports = {
  DEFAULT_LOCALE,
  LINKS,
  LOCALES,
  bundledRelease,
  invalidate,
  currentRelease,
  availableLocales,
  resolveLocale,
  documentFor,
};
