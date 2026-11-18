// Code-owned build target. Public/production defaults; no runtime override.
// A private staging build pairs its staging origin with staging PUBLIC keys
// here before packaging. It must never ship or trust production credentials.
module.exports = Object.freeze({
  ORIGIN: "https://levix-plus.leviro.net",
  TRUSTED_KEYS: Object.freeze([]),
});
