// Password reset over WhatsApp or a verified recovery email.
//
// The panel password is a one-way hash (src/config/secrets.cjs) — there is
// nothing to "recover" from the hash. The operator proves they still hold a
// channel they set up: the linked WhatsApp account's own chat, or the recovery
// email saved in Settings. Both channels share one pending code, one throttle,
// and one `completeReset` (src/panel/one-time-code.cjs). A second request
// before the cooldown replaces nothing — it is refused, and the live code
// stays valid. An email code is bound to the address it was sent to. Removing
// or replacing that address drops it, and redeeming it is refused when the
// saved address is no longer that one. A WhatsApp code is not.
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
//
// Five guesses per code and one code a minute still add up to 7,200 guesses
// a day against a 6-digit code. So wrong codes also count against one budget
// for the whole process: after MAX_FAILED_CODES_PER_DAY of them in 24 hours,
// reset is locked (requests and redemptions) until the oldest one ages out.
// That caps an attacker at about 1 in 100,000 per day. `levix reset-password`
// on the server is not affected.

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
let pending = null; // { salt, hash, expiresAt, attempts, channel, email }
const throttle = createThrottle();
// Bumped by every reset request and by an address change. The commit after
// `await` stores a code only when it still owns this number, so a later
// request (or a removed address) cannot lose to an older in-flight send.
let resetGeneration = 0;
let emailGeneration = 0;

const FAILURE_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_FAILED_CODES_PER_DAY = 10;
/** Times of the wrong codes inside the window, oldest first. */
let failures = [];

/** Seconds until reset unlocks, or 0. */
function lockedFor(now = Date.now()) {
  failures = failures.filter((at) => now - at < FAILURE_WINDOW_MS);
  if (failures.length < MAX_FAILED_CODES_PER_DAY) return 0;
  return Math.max(1, Math.ceil((failures[0] + FAILURE_WINDOW_MS - now) / 1000));
}

function setSession(manager) {
  session = manager;
}

/** Tests: drop the in-memory reset code and the shared reset throttle. */
function _resetForTests() {
  pending = null;
  failures = [];
  throttle.reset();
}

/** Tests: drop only the send throttle, keeping codes and the failure budget. */
function _resetThrottleForTests() {
  throttle.reset();
}

function _expireForTests() {
  if (pending) pending.expiresAt = Date.now() - 1;
}

/**
 * The verified recovery address changed. Drop an email reset bound to the
 * previous one. A WhatsApp code is left alone. An email send still in flight
 * sees `emailGeneration` move and does not become the pending code.
 *
 * @param {string | null} address the address now on file, or null
 */
function noteRecoveryAddress(address) {
  if (pending?.channel === "email" && pending.email !== address) pending = null;
  emailGeneration += 1;
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

  const lang = opts.lang === "ar" ? "ar" : "en";

  const now = Date.now();
  const locked = lockedFor(now);
  if (locked) return { ok: false, reason: "locked", retryAfter: locked };

  const key = String(peer ?? "");
  // An open cooldown answers first, including when the session or address is
  // already gone. The check does not take a slot.
  const early = throttle.check(key, now);
  if (!early.ok) return { ok: false, reason: early.reason, retryAfter: early.retryAfter };

  // Preconditions before a code exists, so a missing channel does not replace
  // a live code and does not spend the cooldown.
  let record = null;
  let sock = null;
  if (channel === "email") {
    record = recoveryEmail.getRecord();
    if (!record) {
      return {
        ok: false,
        reason: recoveryEmail.publicStatus().needsVerification ? "unverified" : "no_email",
      };
    }
  } else {
    sock = session?.socket ?? null;
    if (!sock?.user?.id) return { ok: false, reason: "no_session" };
  }
  const address = record?.email ?? null;

  const gate = throttle.reserve(key, now);
  if (!gate.ok) return { ok: false, reason: gate.reason, retryAfter: gate.retryAfter };

  const generated = generateCode(now);
  const generation = ++resetGeneration;
  const emailGen = channel === "email" ? ++emailGeneration : 0;

  if (channel === "email") {
    const sent = await recoveryEmail.sendResetCode({
      to: record.email,
      token: record.token,
      code: generated.code,
      lang,
    });
    if (!sent.ok) {
      throttle.release(gate.reservation);
      return sent;
    }
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
      throttle.release(gate.reservation);
      logger.error({ err: error }, "[reset] failed to send the reset code over WhatsApp");
      return { ok: false, reason: "send_failed" };
    }
    logger.info({ ip: peer }, "[reset] Reset code sent over WhatsApp");
  }

  // Only a code the operator can actually have is stored. A failed send leaves
  // any previous code in place. A newer request, or an address change while
  // this send was in flight, owns the slot instead.
  if (generation !== resetGeneration) return { ok: false, reason: "throttled" };
  if (channel === "email" && (emailGen !== emailGeneration || recoveryEmail.getAddress() !== address)) {
    return { ok: false, reason: "no_email" };
  }
  pending = {
    ...generated.pending,
    channel,
    email: channel === "email" ? address : null,
  };
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
  const locked = lockedFor();
  if (locked) {
    pending = null;
    return { ok: false, reason: "locked", retryAfter: locked };
  }
  if (Date.now() > pending.expiresAt) {
    pending = null;
    return { ok: false, reason: "expired" };
  }
  if (pending.channel === "email" && recoveryEmail.getAddress() !== pending.email) {
    pending = null;
    return { ok: false, reason: "address_changed" };
  }
  if (String(password ?? "") !== String(confirm ?? "")) {
    return { ok: false, reason: "mismatch" };
  }

  const result = checkAttempt(pending, code);
  if (!result.ok) {
    if (result.reason === "wrong_code" || result.reason === "too_many_attempts") {
      failures.push(Date.now());
    }
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
  MAX_FAILED_CODES_PER_DAY,
  setSession,
  requestResetCode,
  completeReset,
  noteRecoveryAddress,
  _resetForTests,
  _resetThrottleForTests,
  _expireForTests,
};
