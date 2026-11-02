// Fetch, cache and schedule a signed Terms release (ADR-019).
//
// Shipped off: `TRUSTED_KEYS` is empty, so the schedule does not arm a timer
// and does not request anything. A Leviro outage never blocks an acceptance.
// The bundled release stays the fallback. Nothing here reads an environment
// variable or a setting. The URL is fixed.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { dataPath } = require("../config/paths.cjs");
const { compareVersions } = require("./document.cjs");
const { verifyEnvelope } = require("./release.cjs");

const RELEASE_URL = "https://levix.leviro.net/api/legal/v1/release";
const LOG_FAILED = "[legal] remote terms refresh failed";
const LOG_IGNORED = "[legal] remote terms release is not newer";
const LOG_UPDATED = "[legal] remote terms updated";
const MAX_BODY_BYTES = 393216;
const TIMEOUT_MS = 5000;
const FIRST_DELAY_MS = 60 * 1000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function keyList(options) {
  if (options && Object.hasOwn(options, "keys")) return options.keys;
  return require("./keys.cjs").TRUSTED_KEYS;
}

function cachePath(dataDir) {
  if (typeof dataDir === "string" && dataDir.length > 0) {
    return path.join(dataDir, "legal", "remote-release.json");
  }
  return dataPath("legal", "remote-release.json");
}

function stamp(now) {
  try {
    const value = typeof now === "function" ? now() : (now ?? Date.now());
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) return new Date().toISOString();
    return date.toISOString();
  } catch {
    return new Date().toISOString();
  }
}

function report(level, fields, message) {
  try {
    require("../utils/logger.cjs")[level](fields, message);
  } catch {
    // A log failure must not decide whether a release is trusted.
  }
}

function fsyncDirectory(folder) {
  let fd = null;
  try {
    fd = fs.openSync(folder, "r");
    fs.fsyncSync(fd);
  } catch {
    // The rename already committed the file. Directory fsync is best-effort.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing the directory handle is cleanup.
      }
    }
  }
}

function writeAtomic(file, bytes) {
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const name = `.${path.basename(file)}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  const temp = path.join(folder, name);
  let fd = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, file);
    fsyncDirectory(folder);
  } catch (error) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // The original error is the one that matters.
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // The temp file is leftover only when unlink also fails.
    }
    throw error;
  }
}

function httpsUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return "invalid url";
  }
  if (parsed.protocol !== "https:") return "url must use https";
  if (parsed.username || parsed.password) return "url must not contain credentials";
  if (parsed.search) return "url must not contain a query string";
  if (parsed.hash) return "url must not contain a hash";
  return null;
}

function responseHeader(response, name) {
  const headers = response && response.headers;
  if (!headers) return "";
  if (typeof headers.get === "function") {
    const value = headers.get(name);
    return typeof value === "string" ? value : "";
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key]) : "";
}

async function cancelBody(response) {
  try {
    await response?.body?.cancel();
  } catch {
    // Dropping an unused body must not hide the status error.
  }
}

function openSignals() {
  // AbortSignal.timeout does not keep the event loop alive, so an idle process
  // would exit before the abort. The ref'd timer is the same deadline and is
  // cleared when the request ends. The schedule timers stay unref'd.
  const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
  const controller = new AbortController();
  let timedOut = false;
  const fire = () => {
    if (timedOut || controller.signal.aborted) return;
    timedOut = true;
    const reason = timeoutSignal.reason;
    controller.abort(reason === undefined ? new Error("timeout") : reason);
  };
  if (timeoutSignal.aborted) fire();
  else timeoutSignal.addEventListener("abort", fire, { once: true });
  const keepAlive = setTimeout(fire, TIMEOUT_MS);
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    abort: () => controller.abort(),
    close: () => clearTimeout(keepAlive),
  };
}

async function readCapped(response, signals) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const error = new Error("response has no body");
    error.code = "NO_BODY";
    throw error;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      const bytes = Buffer.from(value);
      total += bytes.length;
      if (total > MAX_BODY_BYTES) {
        const error = new Error("response exceeds 393216 bytes");
        error.code = "BODY_TOO_LARGE";
        try {
          await reader.cancel();
        } catch {
          // The size error is what the caller sees.
        }
        signals.abort();
        throw error;
      }
      chunks.push(bytes);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The lock is already released when cancel won the race.
    }
  }
}

function failureReason(error, signals) {
  if (signals.timedOut()) return "timeout";
  if (error && error.code === "BODY_TOO_LARGE") return "response exceeds 393216 bytes";
  const message = error && typeof error.message === "string" ? error.message : "";
  if (message.length > 0 && message.length < 200) return message;
  return "network error";
}

/**
 * The verified cached release, or null when there is no file or it does not
 * verify with the current keys. A cache that fails stays on disk. Throws only
 * when the file cannot be read.
 */
function readCachedRelease(options = {}) {
  const file = cachePath(options.dataDir);
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch (error) {
    if (error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const envelope = JSON.parse(text);
    return verifyEnvelope(envelope, keyList(options));
  } catch {
    return null;
  }
}

/**
 * Fetch and maybe replace the cache. Never throws.
 * `{ updated, version, error }`. `error` is null when nothing went wrong,
 * including when a verified release is not strictly newer.
 */
async function refreshRemoteRelease(options = {}) {
  const keys = keyList(options);
  const at = stamp(options.now);
  try {
    if (!Array.isArray(keys) || keys.length === 0) {
      return { updated: false, version: null, error: null };
    }
    const url = options.url ?? RELEASE_URL;
    const refused = httpsUrl(url);
    if (refused) {
      report("warn", { reason: refused, at }, LOG_FAILED);
      return { updated: false, version: null, error: refused };
    }

    const httpGet = options.fetchImpl ?? globalThis.fetch;
    const signals = openSignals();
    try {
      let response;
      try {
        response = await httpGet(url, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "application/json" },
          signal: signals.signal,
        });
      } catch (error) {
        const reason = failureReason(error, signals);
        report("warn", { reason, at }, LOG_FAILED);
        return { updated: false, version: null, error: reason };
      }

      if (!response || typeof response.status !== "number") {
        report("warn", { reason: "bad response", at }, LOG_FAILED);
        return { updated: false, version: null, error: "bad response" };
      }
      const redirected =
        response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400);
      if (redirected) {
        await cancelBody(response);
        report("warn", { reason: "redirect", status: response.status, at }, LOG_FAILED);
        return { updated: false, version: null, error: "redirect refused" };
      }
      if (response.status !== 200) {
        await cancelBody(response);
        const reason = `status ${response.status}`;
        report("warn", { reason, status: response.status, at }, LOG_FAILED);
        return { updated: false, version: null, error: reason };
      }
      const contentType = responseHeader(response, "content-type").trim().toLowerCase();
      if (!contentType.startsWith("application/json")) {
        await cancelBody(response);
        report("warn", { reason: "content-type", at }, LOG_FAILED);
        return { updated: false, version: null, error: "content-type refused" };
      }

      let body;
      try {
        body = await readCapped(response, signals);
      } catch (error) {
        const reason = failureReason(error, signals);
        report("warn", { reason, at }, LOG_FAILED);
        return { updated: false, version: null, error: reason };
      }

      let envelope;
      try {
        envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
      } catch {
        report("warn", { reason: "not json", at }, LOG_FAILED);
        return { updated: false, version: null, error: "response is not JSON" };
      }

      const verified = verifyEnvelope(envelope, keys);
      const terms = require("./terms.cjs");
      const bundled = terms.bundledRelease();
      if (compareVersions(verified.version, bundled.version) <= 0) {
        report("info", { version: verified.version, at }, LOG_IGNORED);
        return { updated: false, version: bundled.version, error: null };
      }
      const cached = readCachedRelease({ dataDir: options.dataDir, keys });
      if (cached && compareVersions(verified.version, cached.version) <= 0) {
        report("info", { version: verified.version, at }, LOG_IGNORED);
        return { updated: false, version: cached.version, error: null };
      }

      writeAtomic(cachePath(options.dataDir), body);
      terms.invalidate();
      report("info", { version: verified.version, at }, LOG_UPDATED);
      return { updated: true, version: verified.version, error: null };
    } finally {
      signals.close();
    }
  } catch (error) {
    const reason = error && typeof error.message === "string" ? error.message : "refresh failed";
    report("warn", { reason, at }, LOG_FAILED);
    return { updated: false, version: null, error: reason };
  }
}

/**
 * First refresh 60s after boot, then every 24h. Timers are unref'd.
 * An empty key list returns a stop function and does nothing else.
 */
function startRemoteTermsSchedule(options = {}) {
  const keys = keyList(options);
  if (!Array.isArray(keys) || keys.length === 0) return function stop() {};

  let stopped = false;
  let pending = null;
  let interval = null;

  const tick = () => {
    if (stopped) return;
    Promise.resolve()
      .then(() => refreshRemoteRelease(options))
      .catch((error) => {
        report("warn", { reason: error?.message || "refresh failed" }, LOG_FAILED);
      });
  };

  pending = setTimeout(() => {
    pending = null;
    if (stopped) return;
    tick();
    interval = setInterval(tick, INTERVAL_MS);
    interval.unref?.();
  }, FIRST_DELAY_MS);
  pending.unref?.();

  return function stop() {
    stopped = true;
    if (pending) {
      clearTimeout(pending);
      pending = null;
    }
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };
}

module.exports = {
  RELEASE_URL,
  MAX_BODY_BYTES,
  TIMEOUT_MS,
  FIRST_DELAY_MS,
  INTERVAL_MS,
  readCachedRelease,
  refreshRemoteRelease,
  startRemoteTermsSchedule,
};
