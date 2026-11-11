// src/config/official-links.cjs
// Official links and trustworthy external navigation validator (Phase 09).
//
// Links are frozen constants representing official Levix destinations.
// safeOfficialUrl() ensures only exact official destinations or validated
// GitHub release detail URLs are accepted, preventing arbitrary redirects,
// credential spoofing, port injection, or hash injection.

const LINKS = Object.freeze({
  website: "https://levix.leviro.net",
  docs: "https://levix.leviro.net/docs",
  github: "https://github.com/Abdodiab2005/levix",
  releases: "https://github.com/Abdodiab2005/levix/releases",
  play: "https://play.google.com/store/apps/details?id=net.leviro.levix",
  studio: "https://leviro.net",
  portfolio: "https://abdelrhman.leviro.net",
  support: "https://levix.leviro.net/feedback",
});

const FIXED_URLS = new Set(Object.values(LINKS));

// Strict SemVer tag regex: matches v1.2.3, 1.2.3, v5.0.0-beta.1, 5.0.0+android.69
const TAG_REGEX =
  /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function isValidTag(tag) {
  return typeof tag === "string" && tag.length <= 128 && TAG_REGEX.test(tag);
}

/**
 * Builds a trustworthy release detail URL from a validated tag.
 * Returns null if the tag is not valid SemVer.
 */
function releaseDetailUrl(tag) {
  if (typeof tag !== "string") return null;
  if (!isValidTag(tag)) return null;
  return `${LINKS.releases}/tag/${tag}`;
}

/**
 * Validates that a URL is an exact official link or a validated version-tag
 * release detail URL. Disallows credentials, non-standard ports, hashes,
 * search parameters (unless part of the exact fixed links), and hostile schemes.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function safeOfficialUrl(value) {
  if (typeof value !== "string" || !value) return false;
  if (FIXED_URLS.has(value)) return true;

  const prefix = `${LINKS.releases}/tag/`;
  return value.startsWith(prefix) && isValidTag(value.slice(prefix.length));
}

module.exports = {
  LINKS,
  safeOfficialUrl,
  releaseDetailUrl,
  isValidTag,
};
