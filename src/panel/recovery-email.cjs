// The panel's recovery email.
//
// Account security, stored like the password hash: one `bot_settings` row,
// sealed with the install key (src/config/vault.cjs), never a `setting:*`
// value, so settings export/import cannot see it. The row exists only after
// the operator verifies a code. Until then the candidate address lives in
// this process next to its hashed code, and a restart drops it.
//
// Delivery is a Levix-operated relay. The body is exactly the address, the
// code, the purpose, and the UI language — no free text. `LEVIX_RECOVERY_URL`
// points the request at a local server in tests; operators do not set it.

const logger = require("../utils/logger.cjs");
const secrets = require("../config/secrets.cjs");
const {
  CODE_TTL_MS,
  generateCode,
  checkAttempt,
  createThrottle,
} = require("./one-time-code.cjs");

const DEFAULT_ENDPOINT = "https://levix.leviro.net/api/recovery-email";
const RELAY_TIMEOUT_MS = 15_000;

// Verification sends have their own throttle. Reset sends share one throttle
// inside password-reset.cjs, across WhatsApp and email.
const verifyThrottle = createThrottle();

/** @type {{ salt: string, hash: string, expiresAt: number, attempts: number, email: string } | null} */
let pendingVerify = null;

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function normalizeLang(lang) {
  return lang === "ar" ? "ar" : "en";
}

/**
 * Trim, lowercase, and refuse anything the relay should not be asked to accept.
 * ASCII only: one @, a dotted domain, a TLD of at least two characters.
 * A newline or other control is rejected before trim. trim() would otherwise
 * turn "a@example.com\n" into a deliverable address (header injection).
 *
 * @param {unknown} value
 * @returns {{ ok: true, email: string } | { ok: false }}
 */
function normalizeEmail(value) {
  const raw = String(value ?? "");
  if (/[\u0000-\u001F\u007F\u2028\u2029]/.test(raw)) return { ok: false };
  const email = raw.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return { ok: false };
  if (email.includes("..")) return { ok: false };
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return { ok: false };
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".")) return { ok: false };
  const tld = domain.slice(domain.lastIndexOf(".") + 1);
  if (tld.length < 2) return { ok: false };
  if (!EMAIL_RE.test(email)) return { ok: false };
  return { ok: true, email };
}

/**
 * `abdelrhman@gmail.com` → `ab***@g***.com`.
 * Two characters of the local part (one, when that is all there is), one
 * character of the domain, and the last label. The stars are fixed, so the
 * mask does not reveal how long the address is.
 *
 * @param {string} email a normalized address
 */
function maskEmail(email) {
  const at = String(email ?? "").lastIndexOf("@");
  if (at <= 0) return "***";
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const localShown = local.slice(0, Math.min(2, local.length));
  const dot = domain.lastIndexOf(".");
  const domainShown = domain.slice(0, 1);
  const tld = dot > 0 ? domain.slice(dot) : "";
  return `${localShown}***@${domainShown}***${tld}`;
}

function readAddress() {
  try {
    return secrets.getRecoveryEmail();
  } catch (error) {
    logger.warn({ err: error }, "[recovery-email] Could not read the recovery address");
    return null;
  }
}

/** The verified address, or null. For delivery — never for an API response. */
function getAddress() {
  return readAddress();
}

/** What an API may return. Never the address itself. */
function publicStatus() {
  const email = readAddress();
  if (!email) return { verified: false };
  return { verified: true, masked: maskEmail(email) };
}

/**
 * POST the relay contract. Network failures, timeouts, and 5xx are
 * `unavailable`. The address and the code are not logged.
 *
 * @param {{ kind: "verify" | "reset", to: string, code: string, lang: string }} message
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function deliver({ kind, to, code, lang }) {
  if (kind !== "verify" && kind !== "reset") return { ok: false, reason: "invalid" };
  if (!to || !code) return { ok: false, reason: "invalid" };

  const endpoint = process.env.LEVIX_RECOVERY_URL || DEFAULT_ENDPOINT;
  const body = {
    kind,
    to,
    code: String(code),
    lang: normalizeLang(lang),
  };

  let response;
  let data = null;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    data = await response.json().catch(() => null);
  } catch (error) {
    logger.warn({ err: error, kind }, "[recovery-email] Could not reach the relay");
    return { ok: false, reason: "unavailable" };
  }

  if (response.ok && data?.ok === true) return { ok: true };

  let reason = "unavailable";
  if (response.status === 400 || data?.error === "invalid") reason = "invalid";
  else if (response.status === 429 || data?.error === "rate_limited") reason = "rate_limited";

  logger.warn({ kind, status: response.status, reason }, "[recovery-email] The relay refused the code");
  return { ok: false, reason };
}

/**
 * Start verification of a new address. The previously verified address stays
 * in the database until `confirmVerification` succeeds.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, retryAfter?: number }>}
 */
async function startVerification(email, lang, peer) {
  const normalized = normalizeEmail(email);
  if (!normalized.ok) return { ok: false, reason: "invalid_email" };

  const now = Date.now();
  const key = String(peer ?? "");
  const gate = verifyThrottle.check(key, now);
  if (!gate.ok) return { ok: false, reason: gate.reason, retryAfter: gate.retryAfter };

  const generated = generateCode(now);
  const sent = await deliver({
    kind: "verify",
    to: normalized.email,
    code: generated.code,
    lang,
  });
  if (!sent.ok) return sent;

  // Stored only after the relay accepts it, so a code that was never delivered
  // cannot be confirmed, and a failed send does not discard a live one.
  pendingVerify = { ...generated.pending, email: normalized.email };
  verifyThrottle.record(key, gate.entry, now);
  logger.info("[recovery-email] Verification code sent");
  return { ok: true, expiresInMinutes: Math.round(CODE_TTL_MS / 60000) };
}

/**
 * @param {unknown} code
 * @returns {{ ok: true, verified: true, masked: string } | { ok: false, reason: string, attemptsLeft?: number }}
 */
function confirmVerification(code) {
  const result = checkAttempt(pendingVerify, code);
  if (!result.ok) {
    if (result.clear) pendingVerify = null;
    const failure = { ok: false, reason: result.reason };
    if (result.attemptsLeft != null) failure.attemptsLeft = result.attemptsLeft;
    return failure;
  }

  const email = pendingVerify.email;
  try {
    secrets.setRecoveryEmail(email);
  } catch (error) {
    logger.error({ err: error }, "[recovery-email] Could not store the verified address");
    return { ok: false, reason: "unavailable" };
  }

  pendingVerify = null;
  return { ok: true, verified: true, masked: maskEmail(email) };
}

function remove() {
  pendingVerify = null;
  secrets.clearRecoveryEmail();
}

function _resetForTests() {
  pendingVerify = null;
  verifyThrottle.reset();
}

function _expireForTests() {
  if (pendingVerify) pendingVerify.expiresAt = Date.now() - 1;
}

module.exports = {
  DEFAULT_ENDPOINT,
  RELAY_TIMEOUT_MS,
  normalizeEmail,
  maskEmail,
  getAddress,
  publicStatus,
  deliver,
  startVerification,
  confirmVerification,
  remove,
  _resetForTests,
  _expireForTests,
};
