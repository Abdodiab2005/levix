// Password reset over WhatsApp or a verified recovery email.
//
// The panel password is a one-way hash (src/config/secrets.cjs) — there is
// nothing to "recover" from the hash. The operator proves they still hold a
// channel they set up: the linked WhatsApp account's own chat, or the recovery
// email saved in Settings. Both channels share one pending code, one throttle,
// and one `completeReset` (src/panel/one-time-code.cjs). A second request
// before the cooldown replaces nothing — it is refused, and the live code
// stays valid.
//
// Why a code rather than passkeys / biometrics (WebAuthn)? WebAuthn only
// exists in a secure context: HTTPS or localhost. A Levix panel is very often
// opened at plain http://<lan-ip>:3001, where no browser will offer a passkey
// at all. The code works on every shape of install, and `levix reset-password`
// on the server stays the offline fallback for when both channels are down.
//
// The code lives only in this process's memory — hashed, 10 minutes, five
// verification attempts, single use. A restart clears it, which is fine:
// requesting a new one costs one message. Requests are throttled per TCP peer
// (never `req.ip`, same discipline as login-throttle) and globally, and the
// throttle is the same whether the message goes to WhatsApp or to the relay.

const logger = require("../utils/logger.cjs");
const secrets = require("../config/secrets.cjs");
const brand = require("../config/brand.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const { withLang, detectLang, tr } = require("../utils/i18n.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;
const recoveryEmail = require("./recovery-email.cjs");
const {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  generateCode,
  checkAttempt,
  createThrottle,
} = require("./one-time-code.cjs");

// The backend's WhatsApp session manager, handed over by bootstrapPanel()
// next to the dashboard API's setSession(). Re-read the socket every time —
// a reconnect replaces it.
let session = null;
let pending = null; // { salt, hash, expiresAt, attempts }
const throttle = createThrottle();

function setSession(manager) {
  session = manager;
}

/** Tests: drop the in-memory reset code and the shared reset throttle. */
function _resetForTests() {
  pending = null;
  throttle.reset();
}

function _expireForTests() {
  if (pending) pending.expiresAt = Date.now() - 1;
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

function resolveChannel(channel) {
  if (channel == null || channel === "" || channel === "whatsapp") return "whatsapp";
  if (channel === "email") return "email";
  return null;
}

/**
 * Generate a reset code and deliver it.
 *
 * `options.channel` is `"whatsapp"` (the default, including a missing value)
 * or `"email"`. `options.lang` is `"en"` or `"ar"` and is sent to the relay;
 * anything else is English. The WhatsApp text keeps the bot's reply language.
 *
 * @param {string} peer TCP peer, from clientAddress() — never req.ip
 * @param {{ channel?: string, lang?: string }} [options]
 * @returns {Promise<object>} { ok: true } or { ok: false, reason, ... }
 */
async function requestResetCode(peer, options = {}) {
  const opts = options && typeof options === "object" ? options : {};
  const channel = resolveChannel(opts.channel);
  if (!channel) return { ok: false, reason: "invalid" };

  const now = Date.now();
  const key = String(peer ?? "");
  const gate = throttle.check(key, now);
  if (!gate.ok) return { ok: false, reason: gate.reason, retryAfter: gate.retryAfter };

  const lang = opts.lang === "ar" ? "ar" : "en";

  // Preconditions before a code exists, so a missing channel does not replace
  // a live code and does not spend the cooldown.
  let address = null;
  let sock = null;
  if (channel === "email") {
    address = recoveryEmail.getAddress();
    if (!address) return { ok: false, reason: "no_email" };
  } else {
    sock = session?.socket ?? null;
    if (!sock?.user?.id) return { ok: false, reason: "no_session" };
  }

  const generated = generateCode(now);

  if (channel === "email") {
    const sent = await recoveryEmail.deliver({
      kind: "reset",
      to: address,
      code: generated.code,
      lang,
    });
    if (!sent.ok) return sent;
    logger.info({ channel }, "[reset] Reset code sent by email");
  } else {
    try {
      await sendBotMessage(
        sock,
        normalizeJid(sock.user.id),
        { text: codeMessage(generated.code) },
        { typing: false, delayMs: 0 },
      );
    } catch (error) {
      logger.error({ err: error }, "[reset] failed to send the reset code over WhatsApp");
      return { ok: false, reason: "send_failed" };
    }
    logger.info({ ip: peer }, "[reset] Reset code sent over WhatsApp");
  }

  // Only a code the operator can actually have is stored. A failed send leaves
  // any previous code in place.
  pending = generated.pending;
  throttle.record(key, gate.entry, now);
  return { ok: true, channel, expiresInMinutes: Math.round(CODE_TTL_MS / 60000) };
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

  const result = checkAttempt(pending, code);
  if (!result.ok) {
    if (result.clear) pending = null;
    const failure = { ok: false, reason: result.reason };
    if (result.attemptsLeft != null) failure.attemptsLeft = result.attemptsLeft;
    return failure;
  }

  try {
    // Bumps the password epoch, so every panel session stamped before this
    // moment — including any an attacker might hold — stops being valid.
    secrets.setDashboardPassword(password);
  } catch (error) {
    // The code matched, so checkAttempt already counted this guess. A rejected
    // new password is the operator's typo, not a failed proof — give the
    // attempt back. The code stays pending.
    pending.attempts = Math.max(0, pending.attempts - 1);
    return { ok: false, reason: "invalid_password", message: error.message };
  }

  pending = null;
  logger.info("[reset] Panel password reset via one-time code");
  return { ok: true };
}

module.exports = {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  setSession,
  requestResetCode,
  completeReset,
  _resetForTests,
  _expireForTests,
};
