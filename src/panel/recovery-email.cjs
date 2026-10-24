// The panel's recovery email.
//
// Account security, stored like the password hash: one `bot_settings` row,
// sealed with the install key (src/config/vault.cjs), never a `setting:*`
// value, so settings export/import cannot see it. The row exists only after
// the operator verifies a code. Until then the candidate address lives in
// this process next to the relay's verification id, and a restart drops it.
//
// Delivery is a Levix-operated relay (levix-ui, src/lib/recovery-relay.ts).
// Contract v2, so the relay cannot be used to mail strangers:
//
//   verify  { kind, to, lang }               the relay makes the code and
//                                            emails it; the answer is an id
//   confirm { kind, verification, code }     the operator's guess; a match
//                                            answers a token for the address
//   reset   { kind, to, code, token, lang }  refused without that token
//
// This process never sees a verify code, so the relay checks it: five
// guesses per code, single use. The token is sealed with the address and is
// the only thing that lets this install ask for a reset email. No free text
// goes to the relay. `LEVIX_RECOVERY_URL` points the requests at a local
// server in tests; operators do not set it.

const logger = require("../utils/logger.cjs");
const secrets = require("../config/secrets.cjs");
const { CODE_TTL_MS, createThrottle } = require("./one-time-code.cjs");

const DEFAULT_ENDPOINT = "https://levix.leviro.net/api/recovery-email";
const RELAY_TIMEOUT_MS = 15_000;

// Verification sends have their own throttle. Reset sends share one throttle
// inside password-reset.cjs, across WhatsApp and email.
const verifyThrottle = createThrottle();

/** @type {{ verification: string, expiresAt: number, email: string, inFlight?: boolean } | null} */
let pendingVerify = null;
// Same rule as the reset slot: the commit after `await` runs only for the
// latest request. `remove` bumps this so a send still in flight cannot land.
let verifyGeneration = 0;

const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const VERIFICATION_RE = /^[0-9a-f]{32}$/;
const TOKEN_RE = /^v1\.[A-Za-z0-9_-]{43}$/;

// Relay error codes passed through unchanged. Anything else is `unavailable`.
const RELAY_REASONS = new Set([
  "invalid",
  "rate_limited",
  "unverified",
  "wrong_code",
  "expired",
  "too_many_attempts",
  "no_pending",
]);
// Relay answers that end a verification: the next guess cannot succeed.
const VERIFY_DEAD = new Set(["expired", "too_many_attempts", "no_pending"]);

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

/** The verified address and its relay token, or null. For delivery only. */
function getRecord() {
  try {
    return secrets.getRecoveryRecord();
  } catch (error) {
    logger.warn({ err: error }, "[recovery-email] Could not read the recovery address");
    return null;
  }
}

/** The verified address, or null. For delivery — never for an API response. */
function getAddress() {
  return getRecord()?.email ?? null;
}

/** What an API may return. Never the address itself. */
function publicStatus() {
  const record = getRecord();
  if (!record) return { verified: false };
  return { verified: true, masked: maskEmail(record.email) };
}

/**
 * POST one relay request. Network failures, timeouts, 5xx and unknown answers
 * are `unavailable`. The address, the code and the token are not logged.
 *
 * @param {object} body exactly one v2 contract body
 * @returns {Promise<{ ok: true, data: object } | { ok: false, reason: string, attemptsLeft?: number }>}
 */
async function callRelay(body) {
  const endpoint = process.env.LEVIX_RECOVERY_URL || DEFAULT_ENDPOINT;
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
    logger.warn({ err: error, kind: body.kind }, "[recovery-email] Could not reach the relay");
    return { ok: false, reason: "unavailable" };
  }

  if (response.ok && data?.ok === true) return { ok: true, data };

  let reason = "unavailable";
  if (RELAY_REASONS.has(data?.error)) reason = data.error;
  else if (response.status === 400) reason = "invalid";
  else if (response.status === 429) reason = "rate_limited";
  const failure = { ok: false, reason };
  if (reason === "wrong_code" && Number.isInteger(data?.attemptsLeft)) {
    failure.attemptsLeft = data.attemptsLeft;
  }

  logger.warn(
    { kind: body.kind, status: response.status, reason },
    "[recovery-email] The relay refused the request",
  );
  return failure;
}

/**
 * Ask the relay to email a reset code to the verified address.
 *
 * @param {{ to: string, token: string, code: string, lang?: string }} message
 * @returns {Promise<{ ok: true } | { ok: false, reason: string }>}
 */
async function sendResetCode({ to, token, code, lang }) {
  if (!to || !token || !code) return { ok: false, reason: "invalid" };
  const sent = await callRelay({
    kind: "reset",
    to,
    code: String(code),
    token,
    lang: normalizeLang(lang),
  });
  return sent.ok ? { ok: true } : sent;
}

/**
 * Start verification of a new address. The previously verified address stays
 * in the database until `confirmVerification` succeeds. The route has already
 * checked the panel password.
 *
 * @returns {Promise<{ ok: true } | { ok: false, reason: string, retryAfter?: number }>}
 */
async function startVerification(email, lang, peer) {
  const normalized = normalizeEmail(email);
  if (!normalized.ok) return { ok: false, reason: "invalid_email" };

  const now = Date.now();
  const key = String(peer ?? "");
  const gate = verifyThrottle.reserve(key, now);
  if (!gate.ok) return { ok: false, reason: gate.reason, retryAfter: gate.retryAfter };

  const generation = ++verifyGeneration;
  const sent = await callRelay({ kind: "verify", to: normalized.email, lang: normalizeLang(lang) });
  const verification = sent.ok ? sent.data.verification : null;
  if (!sent.ok || typeof verification !== "string" || !VERIFICATION_RE.test(verification)) {
    verifyThrottle.release(gate.reservation);
    return sent.ok ? { ok: false, reason: "unavailable" } : sent;
  }

  // Kept only after the relay accepts it, and only if this request is still
  // the latest one. A failed send does not discard a live verification, and
  // two overlapping sends cannot both become the pending one.
  if (generation !== verifyGeneration) return { ok: false, reason: "throttled" };
  pendingVerify = { verification, expiresAt: now + CODE_TTL_MS, email: normalized.email };
  logger.info("[recovery-email] Verification code sent");
  return { ok: true, expiresInMinutes: Math.round(CODE_TTL_MS / 60000) };
}

/**
 * Send the operator's guess to the relay. A match stores the address with the
 * relay's token.
 *
 * @param {unknown} code
 * @returns {Promise<{ ok: true, verified: true, masked: string } | { ok: false, reason: string, attemptsLeft?: number }>}
 */
async function confirmVerification(code) {
  const pending = pendingVerify;
  if (!pending) return { ok: false, reason: "no_pending" };
  if (Date.now() > pending.expiresAt) {
    pendingVerify = null;
    return { ok: false, reason: "expired" };
  }
  // Not a guess the relay would accept: nothing sent, no attempt spent.
  const guess = String(code ?? "").trim();
  if (!/^\d{6}$/.test(guess)) return { ok: false, reason: "wrong_code" };
  // One guess at a time. Otherwise a second guess answered "no_pending" after
  // the first one matched could drop the token the first one earned.
  if (pending.inFlight) return { ok: false, reason: "throttled", retryAfter: 1 };

  pending.inFlight = true;
  let result;
  try {
    result = await callRelay({ kind: "confirm", verification: pending.verification, code: guess });
  } finally {
    pending.inFlight = false;
  }

  // Removed, replaced or already confirmed while this guess was in flight.
  if (pendingVerify !== pending) return { ok: false, reason: "no_pending" };

  if (!result.ok) {
    if (VERIFY_DEAD.has(result.reason)) pendingVerify = null;
    return result;
  }
  const token = result.data.token;
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return { ok: false, reason: "unavailable" };

  try {
    secrets.setRecoveryEmail(pending.email, token);
  } catch (error) {
    logger.error({ err: error }, "[recovery-email] Could not store the verified address");
    return { ok: false, reason: "unavailable" };
  }

  pendingVerify = null;
  // The saved address just changed. An email reset bound to the previous one
  // must not still redeem.
  require("./password-reset.cjs").noteRecoveryAddress(pending.email);
  return { ok: true, verified: true, masked: maskEmail(pending.email) };
}

function remove() {
  pendingVerify = null;
  verifyGeneration += 1;
  secrets.clearRecoveryEmail();
  require("./password-reset.cjs").noteRecoveryAddress(null);
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
  getRecord,
  getAddress,
  publicStatus,
  sendResetCode,
  startVerification,
  confirmVerification,
  remove,
  _resetForTests,
  _expireForTests,
};
