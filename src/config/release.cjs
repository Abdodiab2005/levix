// The release identity an acceptance is bound to (ADR-020).
//
// npm, Docker, the single executable and headless have only the package.json
// version. An Android archive also ships levix-build.json, written by
// android/scripts/stage-levix-app.sh, and the identity is
// "<version>+android.<versionCode>". A missing file is the non-Android case.
// A file that is present but cannot be read or parsed fails closed, so a
// broken build cannot keep an acceptance recorded for some other build.
//
// The file is read on the first releaseIdentity() call, not when this module
// loads. Nothing here reads the environment. LEVIX_ANDROID_VERSION_CODE is
// the stage script's build-time input, not a Node setting.

const fs = require("node:fs");

const BUILD_FILE = "levix-build.json";
const VERSION_CODE_MAX = 2100000000;
const BUILD_KEYS = Object.freeze(["schema", "platform", "versionCode"]);

let cachedIdentity;

function packageVersion() {
  return String(require("../../package.json").version);
}

function invalidBuildInfo(message) {
  const error = new Error(message);
  error.code = "BUILD_INFO_INVALID";
  return error;
}

/** Pure. Accepts exactly schema 1, platform "android", versionCode 1..2100000000. */
function parseBuildInfo(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalidBuildInfo("levix-build.json is not JSON");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidBuildInfo("levix-build.json must be an object");
  }
  const keys = Object.keys(value);
  if (keys.length !== BUILD_KEYS.length || BUILD_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw invalidBuildInfo("levix-build.json must have only schema, platform and versionCode");
  }
  if (value.schema !== 1) throw invalidBuildInfo("levix-build.json schema must be 1");
  if (value.platform !== "android") throw invalidBuildInfo("levix-build.json platform must be android");
  const code = value.versionCode;
  if (typeof code !== "number" || !Number.isInteger(code) || code < 1 || code > VERSION_CODE_MAX) {
    throw invalidBuildInfo("levix-build.json versionCode must be an integer from 1 to 2100000000");
  }
  return { schema: 1, platform: "android", versionCode: code };
}

/** Pure. No build info keeps the version; Android appends "+android.<versionCode>". */
function composeIdentity(version, buildInfo) {
  const base = String(version);
  if (buildInfo == null) return base;
  return `${base}+android.${buildInfo.versionCode}`;
}

function releaseIdentity() {
  if (cachedIdentity !== undefined) return cachedIdentity;
  // Lazy so loading this module does not create the data directory.
  const { assetPath } = require("./paths.cjs");
  const file = assetPath(BUILD_FILE);
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      cachedIdentity = packageVersion();
      return cachedIdentity;
    }
    throw error;
  }
  // parseBuildInfo runs before the assignment. A bad file is not cached.
  cachedIdentity = composeIdentity(packageVersion(), parseBuildInfo(text));
  return cachedIdentity;
}

module.exports = {
  parseBuildInfo,
  composeIdentity,
  releaseIdentity,
};
