// src/services/updateCheck.cjs
// Update checker service for Phase 09.
//
// Detects channel (Google Play vs GitHub releases), performs strict SemVer
// comparison, bounds network streams and deadlines, caches public metadata
// in RAM with promise coalescing, and ensures zero startup requests.

const { LINKS, safeOfficialUrl, releaseDetailUrl } = require("../config/official-links.cjs");
const logger = require("../utils/logger.cjs");

const GITHUB_RELEASES_URL = "https://api.github.com/repos/Abdodiab2005/levix/releases?per_page=10";
const GITHUB_LATEST_URL = "https://api.github.com/repos/Abdodiab2005/levix/releases/latest";
const SUCCESS_TTL_MS = 15 * 60 * 1000; // 15 minutes
const ERROR_TTL_MS = 60 * 1000; // 1 minute
const TIMEOUT_MS = 8000; // 8 seconds maximum for request + body
const MAX_RESPONSE_BYTES = 1024 * 1024; // Includes GitHub's asset metadata, never asset bytes.
const MAX_RELEASE_NOTES_LENGTH = 6000; // 6000 characters plain text

function packageVersion() {
  return String(require("../../package.json").version);
}

/**
 * Determines installation channel:
 * Play ONLY when LEVIX_ANDROID === '1' and argv has '--levix-play-install'.
 * Internal native boot fact, not a database setting.
 */
function getInstallChannel(env = process.env, argv = process.argv) {
  if (env?.LEVIX_ANDROID === "1" && Array.isArray(argv) && argv.includes("--levix-play-install")) {
    return "play";
  }
  return "github";
}

const SEMVER_REGEX =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/**
 * Strictly parses a SemVer string. Accepts an optional leading 'v' tag prefix.
 */
function parseSemVer(versionString) {
  if (typeof versionString !== "string") return null;
  if (versionString.length > 128) return null;
  const normalized = versionString.replace(/^v/, "");
  const match = normalized.match(SEMVER_REGEX);
  if (!match) return null;

  return {
    raw: versionString,
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
    build: match[5] ? match[5].split(".") : null,
  };
}

/**
 * Compares two SemVer representations (objects or strings) per SemVer 2.0.0 rules:
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Build metadata is ignored in precedence.
 */
function compareSemVer(a, b) {
  const vA = typeof a === "string" ? parseSemVer(a) : a;
  const vB = typeof b === "string" ? parseSemVer(b) : b;
  if (!vA || !vB) throw new Error("Invalid SemVer comparison operands");

  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;

  if (!vA.prerelease && !vB.prerelease) return 0;
  if (!vA.prerelease && vB.prerelease) return 1;
  if (vA.prerelease && !vB.prerelease) return -1;

  const len = Math.max(vA.prerelease.length, vB.prerelease.length);
  for (let i = 0; i < len; i++) {
    if (i >= vA.prerelease.length) return -1;
    if (i >= vB.prerelease.length) return 1;

    const partA = vA.prerelease[i];
    const partB = vB.prerelease[i];
    if (partA === partB) continue;

    const numA = /^\d+$/.test(partA);
    const numB = /^\d+$/.test(partB);

    if (numA && numB) {
      const nA = BigInt(partA);
      const nB = BigInt(partB);
      if (nA !== nB) return nA > nB ? 1 : -1;
    } else if (numA && !numB) {
      return -1;
    } else if (!numA && numB) {
      return 1;
    } else {
      return partA > partB ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Checks if a candidate release is eligible for the current installation:
 * - Stable installations never receive prereleases.
 * - Prerelease installations can receive newer same-base prereleases OR stable/newer releases.
 */
function isEligibleCandidate(candidate, current) {
  const vCand = typeof candidate === "string" ? parseSemVer(candidate) : candidate;
  const vCurr = typeof current === "string" ? parseSemVer(current) : current;
  if (!vCand || !vCurr) return false;

  if (compareSemVer(vCand, vCurr) <= 0) return false;

  if (!vCurr.prerelease) {
    return !vCand.prerelease;
  }

  if (!vCand.prerelease) return true;

  return vCand.major === vCurr.major && vCand.minor === vCurr.minor && vCand.patch === vCurr.patch;
}

/**
 * Sanitizes plain-text release notes to at most 6000 characters.
 */
function sanitizeReleaseNotes(body) {
  if (typeof body !== "string") return null;
  const cleaned = body.replace(/\p{Cc}/gu, (char) => ("\t\r\n".includes(char) ? char : "")).trim();
  if (!cleaned) return null;
  if (cleaned.length > MAX_RELEASE_NOTES_LENGTH) {
    return cleaned.slice(0, MAX_RELEASE_NOTES_LENGTH);
  }
  return cleaned;
}

/**
 * Reads a response body safely with a maximum byte limit and abortion check.
 */
async function fetchReleases(fetchImpl, timeoutMs = TIMEOUT_MS, url = GITHUB_RELEASES_URL) {
  const controller = new AbortController();
  let reader;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Update check timed out"));
    }, timeoutMs);
  });
  const request = async () => {
    const res = await fetchImpl(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Levix-UpdateCheck" },
      redirect: "error",
      signal: controller.signal,
    });
    if (res.url && res.url !== url) throw new Error("Invalid response URL");
    if (res.status === 404 && url === GITHUB_LATEST_URL) return [];
    if (!res.ok) throw new Error("Invalid response");
    if (!(res.headers.get("content-type") || "").toLowerCase().includes("application/json")) {
      throw new Error("Invalid content type");
    }
    const length = res.headers.get("content-length");
    if (length && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) {
      throw new Error("Response too large");
    }
    if (!res.body?.getReader) throw new Error("Missing response stream");
    reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (true) {
      controller.signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("Response too large");
      chunks.push(value);
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (url === GITHUB_LATEST_URL) {
      if (!data || Array.isArray(data) || typeof data.tag_name !== "string")
        throw new Error("Invalid latest release");
      return [data];
    }
    if (!Array.isArray(data) || data.length > 10) throw new Error("Invalid releases payload");
    return data;
  };
  try {
    return await Promise.race([request(), deadline]);
  } finally {
    clearTimeout(timer);
    controller.abort();
    try {
      reader?.cancel().catch(() => {});
    } catch {}
    try {
      reader?.releaseLock();
    } catch {}
  }
}

/**
 * Creates an update checker instance with deterministic dependencies for testing.
 */
function createUpdateChecker(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const version = options.version ?? packageVersion();
  const channelOption = options.channel !== undefined ? options.channel : getInstallChannel;

  let cache = null; // { result, expiresAt }
  let inFlightPromise = null;

  async function doCheck() {
    const currentChannel = typeof channelOption === "function" ? channelOption() : channelOption;
    const currentVersion = String(version);

    if (currentChannel === "play") {
      return {
        channel: "play",
        status: "play",
        currentVersion,
        latestVersion: null,
        url: LINKS.play,
        releaseNotes: null,
      };
    }

    const currentSemVer = parseSemVer(currentVersion);
    if (!currentSemVer) {
      return {
        channel: "github",
        status: "unavailable",
        currentVersion,
        latestVersion: null,
        url: LINKS.releases,
        releaseNotes: null,
      };
    }

    try {
      const timeout = Math.min(TIMEOUT_MS, Math.max(1, options.timeoutMs ?? TIMEOUT_MS));
      const [stable, previews] = await Promise.all([
        fetchReleases(fetchImpl, timeout, GITHUB_LATEST_URL),
        currentSemVer.prerelease ? fetchReleases(fetchImpl, timeout) : Promise.resolve([]),
      ]);
      const releases = [...stable, ...previews];
      const eligible = [];

      for (const item of releases) {
        if (!item || typeof item !== "object") continue;
        if (item.draft === true) continue;
        if (typeof item.tag_name !== "string") continue;

        const tag = item.tag_name;
        const candidateSemVer = parseSemVer(tag);
        if (!candidateSemVer) continue;

        const trustedUrl = releaseDetailUrl(tag);
        if (!trustedUrl || !safeOfficialUrl(trustedUrl)) continue;
        if (item.html_url !== trustedUrl) continue;
        if (typeof item.draft !== "boolean" || typeof item.prerelease !== "boolean") continue;
        if (item.prerelease !== Boolean(candidateSemVer.prerelease)) continue;

        if (!isEligibleCandidate(candidateSemVer, currentSemVer)) continue;

        eligible.push({
          semver: candidateSemVer,
          version: candidateSemVer.raw.replace(/^[vV]/, ""),
          url: trustedUrl,
          releaseNotes: sanitizeReleaseNotes(item.body),
        });
      }

      if (eligible.length === 0) {
        if (previews.length === 10) throw new Error("Preview channel scan incomplete");
        return {
          channel: "github",
          status: "up_to_date",
          currentVersion,
          latestVersion: null,
          url: LINKS.releases,
          releaseNotes: null,
        };
      }

      eligible.sort((a, b) => compareSemVer(b.semver, a.semver));
      const best = eligible[0];

      return {
        channel: "github",
        status: "available",
        currentVersion,
        latestVersion: best.version,
        url: best.url,
        releaseNotes: best.releaseNotes,
      };
    } catch (err) {
      logger.debug?.("[updateCheck] Official release metadata unavailable");
      return {
        channel: "github",
        status: "unavailable",
        currentVersion,
        latestVersion: null,
        url: LINKS.releases,
        releaseNotes: null,
      };
    }
  }

  async function checkForUpdates() {
    const currentTime = now();
    if (cache && currentTime < cache.expiresAt) {
      return cache.result;
    }

    if (inFlightPromise) {
      return inFlightPromise;
    }

    inFlightPromise = (async () => {
      try {
        const result = await doCheck();
        const isError = result.status === "unavailable";
        const ttl = isError ? ERROR_TTL_MS : SUCCESS_TTL_MS;
        cache = {
          result: Object.freeze(result),
          expiresAt: now() + ttl,
        };
        return result;
      } finally {
        inFlightPromise = null;
      }
    })();

    return inFlightPromise;
  }

  return { checkForUpdates };
}

const defaultChecker = createUpdateChecker();
function checkForUpdates() {
  return defaultChecker.checkForUpdates();
}

module.exports = {
  createUpdateChecker,
  checkForUpdates,
  getInstallChannel,
  parseSemVer,
  compareSemVer,
  isEligibleCandidate,
  sanitizeReleaseNotes,
  GITHUB_RELEASES_URL,
  GITHUB_LATEST_URL,
  SUCCESS_TTL_MS,
  ERROR_TTL_MS,
  TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_RELEASE_NOTES_LENGTH,
};
