// Password reset over WhatsApp.
//
// The panel password is a one-way hash (src/config/secrets.cjs) — there is
// nothing to "recover". This is the recovery path that matches the product:
// the bot itself messages the operator's WhatsApp with a one-time code. It
// works because the paired account IS the operator's account, so "send the
// code over WhatsApp" means "drop it in your own chat" — reachable whenever
// the session is up, with no email server and nothing to configure.
//
// Why a WhatsApp code rather than passkeys / biometrics (WebAuthn)? WebAuthn
// only exists in a secure context: HTTPS or localhost. A Levix panel is very
// often opened at plain http://<lan-ip>:3001, where no browser will offer a
// passkey at all. The code works on every shape of install, and
// `levix reset-password` on the server stays the offline fallback for when
// WhatsApp itself is down.
//
// The code lives only in this process's memory — hashed, 10 minutes, five
// verification attempts, single use. A restart clears it, which is fine:
// requesting a new one costs nothing. Requests are throttled per TCP peer
// (never `req.ip`, same discipline as login-throttle) and globally, because
// every accepted request costs the operator one WhatsApp message.

const crypto = require("node:crypto");

const logger = require("../utils/logger.cjs");
const secrets = require("../config/secrets.cjs");
const brand = require("../config/brand.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const { withLang, detectLang, tr } = require("../utils/i18n.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 3;
// Any peer may not trigger two sends closer than this — the code goes to the
// operator's own WhatsApp, and nobody should be able to machine-gun it.
const GLOBAL_COOLDOWN_MS = 60 * 1000;

// The backend's WhatsApp session manager, handed over by bootstrapPanel()
// next to the dashboard API's setSession(). Re-read the socket every time —
// a reconnect replaces it.
let session = null;
let pending = null; // { salt, hash, expiresAt, attempts }
let lastRequestAt = 0;
const requests = new Map(); // peer -> { count, firstAt }

function setSession(manager) {
  session = manager;
}

/** Tests: drop the in-memory code and throttle state. */
function _resetForTests() {
  pending = null;
  lastRequestAt = 0;
  requests.clear();
}

function hashCode(code, salt) {
  return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

function codeMessage(code) {
  return withLang(detectLang(""), () =>
    tr(
      `🔐 *${brand.name} — password reset code: ${code}*\n\n` +
        `Enter it in the control panel within 10 minutes. ` +
        `If you didn't request this, ignore this message — nobody else can use it.`,
      `🔐 *${brand.name} — كود إعادة تعيين كلمة السر: ${code}*\n\n` +
        `ادخل الكود في لوحة التحكم خلال ١٠ دقائق. ` +
        `إذا لم تطلب هذا الرمز، فتجاهل الرسالة — لا يمكن لأحد سواك استخدامه.`,
    ),
  );
}

/**
 * Generate a reset code and WhatsApp it to the linked account's own chat.
 *
 * @returns {Promise<object>} { ok: true } or { ok: false, reason, ... }
 */
async function requestResetCode(peer) {
  const now = Date.now();

  for (const [key, entry] of requests) {
    if (now - entry.firstAt > REQUEST_WINDOW_MS) requests.delete(key);
  }
  const entry = requests.get(peer);
  if (entry && entry.count >= MAX_REQUESTS_PER_WINDOW) {
    return {
      ok: false,
      reason: "throttled",
      retryAfter: Math.ceil((REQUEST_WINDOW_MS - (now - entry.firstAt)) / 1000),
    };
  }
  const sinceLast = now - lastRequestAt;
  if (lastRequestAt && sinceLast < GLOBAL_COOLDOWN_MS) {
    return {
      ok: false,
      reason: "throttled",
      retryAfter: Math.ceil((GLOBAL_COOLDOWN_MS - sinceLast) / 1000),
    };
  }

  const sock = session?.socket ?? null;
  if (!sock?.user?.id) {
    return { ok: false, reason: "no_session" };
  }

  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  pending = { salt, hash: hashCode(code, salt), expiresAt: now + CODE_TTL_MS, attempts: 0 };

  try {
    await sendBotMessage(
      sock,
      normalizeJid(sock.user.id),
      { text: codeMessage(code) },
      {
        typing: false,
        delayMs: 0,
      },
    );
  } catch (error) {
    pending = null;
    logger.error({ err: error }, "[reset] failed to send the reset code over WhatsApp");
    return { ok: false, reason: "send_failed" };
  }

  lastRequestAt = now;
  if (entry) entry.count += 1;
  else requests.set(peer, { count: 1, firstAt: now });

  logger.info({ ip: peer }, "[reset] Reset code sent over WhatsApp");
  return { ok: true, expiresInMinutes: Math.round(CODE_TTL_MS / 60000) };
}

/**
 * Verify the code and, when it matches, set the new password. A wrong code
 * burns one of the five attempts; a mismatched confirmation or a too-short
 * password does not.
 *
 * @returns {object} { ok: true } or { ok: false, reason, ... }
 */
function completeReset(code, password, confirm) {
  if (!pending) return { ok: false, reason: "no_pending" };
  if (Date.now() > pending.expiresAt) {
    pending = null;
    return { ok: false, reason: "expired" };
  }
  if (String(password ?? "") !== String(confirm ?? "")) {
    return { ok: false, reason: "mismatch" };
  }

  pending.attempts += 1;
  const expected = Buffer.from(pending.hash, "hex");
  const actual = Buffer.from(hashCode(String(code ?? "").trim(), pending.salt), "hex");
  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    const attemptsLeft = MAX_CODE_ATTEMPTS - pending.attempts;
    if (attemptsLeft <= 0) {
      pending = null;
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason: "wrong_code", attemptsLeft };
  }

  try {
    // Bumps the password epoch, so every panel session stamped before this
    // moment — including any an attacker might hold — stops being valid.
    secrets.setDashboardPassword(password);
  } catch (error) {
    // The code is still good; the operator may fix the password and retry.
    return { ok: false, reason: "invalid_password", message: error.message };
  }

  pending = null;
  logger.info("[reset] Panel password reset via WhatsApp code");
  return { ok: true };
}

module.exports = {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  setSession,
  requestResetCode,
  completeReset,
  _resetForTests,
};
