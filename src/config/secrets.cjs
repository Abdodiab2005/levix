// Secrets, generated rather than configured.
//
// There is no .env file. Anything that used to be a secret an operator had to
// invent and paste — the session signing key, the dashboard password — is
// either generated here on first start or set once from the browser.
//
// What is stored, and how:
//
//   secret:session   the express-session signing key. 48 random bytes, made on
//                    first start and reused forever after. Nobody ever sees it.
//   auth:password    the dashboard password as an scrypt hash + salt. The
//                    password itself is never written anywhere.
//
// Both live in `bot_settings`, i.e. inside the same SQLite file as the rest of
// the bot's state — so a backup of that one file is a backup of the login too.

const crypto = require("node:crypto");

const store = require("../db/store.cjs");
const logger = require("../utils/logger.cjs");

const SESSION_KEY = "secret:session";
const PASSWORD_KEY = "auth:password";

const MIN_PASSWORD_LENGTH = 8;
const SCRYPT_KEYLEN = 64;

// ===================================================================
// --- Session signing key ---
// ===================================================================

/**
 * The express-session secret. Generated on first call and persisted, so
 * sessions survive a restart but nothing has to be configured by hand.
 */
function getSessionSecret() {
  const existing = store.getBotSetting(SESSION_KEY, null);
  if (typeof existing === "string" && existing.length >= 32) return existing;

  const generated = crypto.randomBytes(48).toString("hex");
  store.saveBotSetting(SESSION_KEY, generated);
  logger.info("[secrets] Generated a new session signing key");
  return generated;
}

// ===================================================================
// --- Dashboard password ---
// ===================================================================

function hashPassword(plain, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return { salt: salt.toString("hex"), hash: hash.toString("hex") };
}

function hasDashboardPassword() {
  const record = store.getBotSetting(PASSWORD_KEY, null);
  return !!(record && record.hash && record.salt);
}

/**
 * @throws {Error} when the password is too short — the dashboard holds a full
 *   WhatsApp account, so this is not a place for a 3-character password.
 */
function setDashboardPassword(plain) {
  const password = String(plain ?? "");
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
    );
  }

  const { salt, hash } = hashPassword(password);
  store.saveBotSetting(PASSWORD_KEY, { alg: "scrypt", salt, hash, updatedAt: Date.now() });
  logger.info("[secrets] Dashboard password updated");
}

/** Constant-time check. False (never a throw) when no password is set yet. */
function verifyDashboardPassword(candidate) {
  const record = store.getBotSetting(PASSWORD_KEY, null);
  if (!record?.hash || !record?.salt) return false;
  if (typeof candidate !== "string") return false;

  const expected = Buffer.from(record.hash, "hex");
  const actual = crypto.scryptSync(
    candidate,
    Buffer.from(record.salt, "hex"),
    expected.length
  );
  return crypto.timingSafeEqual(expected, actual);
}

// ===================================================================
// --- First-run setup code ---
// ===================================================================
//
// Until a password exists the dashboard shows a "choose your password" page.
// From localhost that is all it asks — whoever is at the machine is the
// operator. From anywhere else it also asks for this code, which is printed in
// the terminal at startup, so a bot that comes up on a public IP can't be
// claimed by the first stranger who finds the port.
//
// It is generated per process and never stored: restart the bot and you get a
// new one.

let setupCode = null;

function getSetupCode() {
  if (!setupCode) {
    setupCode = crypto.randomBytes(4).toString("hex").toUpperCase();
  }
  return setupCode;
}

// The exact shape the code is printed in, and the exact string the install
// instructions tell people to grep for. Both come from here so they cannot
// drift apart again — tests/setup-code.test.mjs boots Levix for real and greps
// its output with the documented command.
//
// Printed with console.log rather than through the logger on purpose: the
// documented way to find it is `journalctl -u levix` / `docker compose logs`,
// which read stdout, and pino's pretty transport wraps its messages in colour
// escapes that a naive grep-and-copy would carry along. It also keeps a claim
// credential out of the log file that sits on disk forever.
const SETUP_CODE_LOG_PREFIX = "[Setup] Setup code:";

/** The one line that carries the code. Stable — docs grep for its prefix. */
function formatSetupCodeLine(code = getSetupCode()) {
  return `${SETUP_CODE_LOG_PREFIX} ${code}`;
}

function setupCodeMatches(candidate) {
  if (typeof candidate !== "string") return false;
  const expected = Buffer.from(getSetupCode());
  const actual = Buffer.from(candidate.trim().toUpperCase());
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  getSessionSecret,
  hasDashboardPassword,
  setDashboardPassword,
  verifyDashboardPassword,
  getSetupCode,
  setupCodeMatches,
  SETUP_CODE_LOG_PREFIX,
  formatSetupCodeLine,
};
