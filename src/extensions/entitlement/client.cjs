// Signed claim and refresh calls to the Plus verifier.
//
// The purchase token and the request signature stay in the request. Failures
// report a code only. An empty trusted-key list returns UNCONFIGURED and does
// not touch the network.

const crypto = require("node:crypto");

const { canonicalJson } = require("../../legal/document.cjs");

const ORIGIN = "https://plus.leviro.net";
const CLAIM_PATH = "/v1/claim";
const REFRESH_PATH = "/v1/refresh";
const AUDIENCE = "levix-plus-verifier";
const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 16 * 1024;
const PURCHASE_TOKEN_RE = /^[A-Za-z0-9._:-]{1,2048}$/;
const PRODUCT_ID_RE = /^[a-z0-9][a-z0-9._]{0,63}$/;
const PACKAGE_NAME_RE = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$/;
const ERROR_CODES = new Set([
  "BAD_REQUEST",
  "BAD_SIGNATURE",
  "STALE_TIMESTAMP",
  "REPLAY",
  "UNKNOWN_INSTALLATION",
  "PURCHASE_INVALID",
  "TEST_PURCHASE_REFUSED",
  "ACCOUNT_MISMATCH",
  "REBIND_LIMIT",
  "RATE_LIMITED",
  "UNAVAILABLE",
]);

function validateClaimBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const names = Object.keys(body);
  if (names.length !== 3) return false;
  return typeof body.purchaseToken === "string"
    && PURCHASE_TOKEN_RE.test(body.purchaseToken)
    && typeof body.productId === "string"
    && PRODUCT_ID_RE.test(body.productId)
    && typeof body.packageName === "string"
    && PACKAGE_NAME_RE.test(body.packageName);
}

function unconfigured(keys) {
  return !Array.isArray(keys) || keys.length === 0;
}

function fail(code, extra = {}) {
  return { ok: false, code, retryable: extra.retryable === true, ...extra, code };
}

function defaultFetch(url, init) {
  const { safeProviderFetch } = require("../../utils/providerUrl.cjs");
  return safeProviderFetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: "manual",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }, { allowLoopback: false });
}

function logFailure(logger, code, status) {
  try {
    logger?.warn?.({ code, status }, "[plus] verifier request failed");
  } catch {
    // A logging failure must not change the result or carry the request.
  }
}

async function discard(response) {
  try {
    if (response?.body?.cancel) await response.body.cancel();
    else if (typeof response?.body?.getReader === "function") {
      const reader = response.body.getReader();
      await reader.cancel();
    }
  } catch {
    // The status result is what the caller sees.
  }
}

async function readLimited(response) {
  const declared = response.headers?.get?.("content-length");
  if (declared != null && /^\d+$/.test(String(declared).trim()) && Number(declared) > MAX_RESPONSE_BYTES) {
    await discard(response);
    const error = new Error("oversized");
    error.code = "OVERSIZED";
    throw error;
  }
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const bytes = Buffer.from(value);
        total += bytes.length;
        if (total > MAX_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch { /* size error wins */ }
          const error = new Error("oversized");
          error.code = "OVERSIZED";
          throw error;
        }
        chunks.push(bytes);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* already released when cancel won */ }
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response.arrayBuffer === "function") {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_RESPONSE_BYTES) {
      const error = new Error("oversized");
      error.code = "OVERSIZED";
      throw error;
    }
    return bytes;
  }
  const error = new Error("no body");
  error.code = "NO_BODY";
  throw error;
}

function retryAfterSeconds(response) {
  const raw = response.headers?.get?.("retry-after");
  if (raw == null || !/^\d+$/.test(String(raw).trim())) return null;
  const seconds = Number(String(raw).trim());
  const max = Math.floor((2 ** 31 - 1) / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return Math.min(seconds, max);
}

function interpret(status, bytes, response) {
  let parsed = null;
  if (bytes.length) {
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      parsed = null;
    }
  }
  if (status === 200) {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.token !== "string") {
      return fail("BAD_REQUEST");
    }
    if (Object.keys(parsed).length !== 1 || Buffer.byteLength(parsed.token, "utf8") > 4096 || parsed.token.length === 0) {
      return fail("BAD_REQUEST");
    }
    return { ok: true, token: parsed.token };
  }
  const code = parsed && typeof parsed.error?.code === "string" && ERROR_CODES.has(parsed.error.code)
    ? parsed.error.code
    : status === 429 ? "RATE_LIMITED" : status >= 500 ? "UNAVAILABLE" : "BAD_REQUEST";
  const retryable = typeof parsed?.error?.retryable === "boolean"
    ? parsed.error.retryable
    : code === "UNAVAILABLE" || code === "RATE_LIMITED";
  const retryAfter = retryAfterSeconds(response);
  return fail(code, { retryable, ...(retryAfter == null ? {} : { retryAfter }) });
}

async function post(path, body, deps, includeKey) {
  const keys = deps.keys ?? require("./keys.cjs").TRUSTED_KEYS;
  if (unconfigured(keys)) return { ok: false, code: "UNCONFIGURED" };
  const installation = deps.installation;
  if (!installation || typeof installation.sign !== "function" || !Buffer.isBuffer(installation.publicKeyRaw)) {
    return fail("NO_INSTALLATION");
  }
  const derived = crypto.createHash("sha256").update(installation.publicKeyRaw).digest("base64url");
  if (derived !== installation.installationId || installation.publicKeyRaw.length !== 32) {
    return fail("UNAVAILABLE", { retryable: false });
  }
  const ts = deps.now();
  if (!Number.isSafeInteger(ts)) return fail("UNAVAILABLE", { retryable: true });
  const nonceBytes = deps.randomBytes(16);
  if (!Buffer.isBuffer(nonceBytes) || nonceBytes.length !== 16) return fail("UNAVAILABLE", { retryable: true });
  const nonce = nonceBytes.toString("base64url");
  const rawBody = Buffer.from(body, "utf8");
  const signed = canonicalJson({
    aud: AUDIENCE,
    bodySha256: crypto.createHash("sha256").update(rawBody).digest("base64url"),
    installation: installation.installationId,
    method: "POST",
    nonce,
    path,
    ts,
  });
  let signature;
  try {
    signature = installation.sign(Buffer.from(signed, "utf8")).toString("base64url");
  } catch {
    return fail("UNAVAILABLE", { retryable: false });
  }
  const headers = {
    "content-type": "application/json",
    "x-levix-installation": installation.installationId,
    "x-levix-nonce": nonce,
    "x-levix-timestamp": String(ts),
    "x-levix-signature": signature,
  };
  if (includeKey) headers["x-levix-key"] = installation.publicKeyRaw.toString("base64url");
  const fetchImpl = deps.fetch ?? defaultFetch;
  let response;
  try {
    response = await fetchImpl(`${ORIGIN}${path}`, {
      method: "POST",
      redirect: "manual",
      headers,
      body,
    });
  } catch {
    logFailure(deps.logger, "UNAVAILABLE", 0);
    return fail("UNAVAILABLE", { retryable: true });
  }
  const status = Number(response?.status);
  if (status >= 300 && status < 400) {
    await discard(response);
    logFailure(deps.logger, "REDIRECT", status);
    return fail("REDIRECT", { retryable: false });
  }
  try {
    const bytes = await readLimited(response ?? {});
    const result = interpret(status, bytes, response);
    if (!result.ok) logFailure(deps.logger, result.code, status);
    return result;
  } catch (error) {
    const code = error?.code === "OVERSIZED" ? "OVERSIZED" : "UNAVAILABLE";
    logFailure(deps.logger, code, status);
    return fail(code, { retryable: code === "UNAVAILABLE" });
  }
}

async function claim(input, deps = {}) {
  const keys = deps.keys ?? require("./keys.cjs").TRUSTED_KEYS;
  if (unconfigured(keys)) return { ok: false, code: "UNCONFIGURED" };
  if (!validateClaimBody(input)) return fail("BAD_REQUEST");
  const body = JSON.stringify({
    purchaseToken: input.purchaseToken,
    productId: input.productId,
    packageName: input.packageName,
  });
  return post(CLAIM_PATH, body, { ...deps, keys }, true);
}

async function refresh(deps = {}) {
  const keys = deps.keys ?? require("./keys.cjs").TRUSTED_KEYS;
  if (unconfigured(keys)) return { ok: false, code: "UNCONFIGURED" };
  if (!Number.isSafeInteger(deps.seq) || deps.seq < 0) return fail("BAD_REQUEST");
  return post(REFRESH_PATH, JSON.stringify({ seq: deps.seq }), { ...deps, keys }, false);
}

module.exports = {
  ORIGIN,
  CLAIM_PATH,
  REFRESH_PATH,
  MAX_RESPONSE_BYTES,
  validateClaimBody,
  claim,
  refresh,
};
