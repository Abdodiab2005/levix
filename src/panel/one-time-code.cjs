// One in-memory code, shared by every channel that proves the operator.
//
// WhatsApp and email password resets use a local 6-digit code, hashed in
// memory, dead after 10 minutes or five wrong guesses. Recovery-email
// verification uses the relay's own code and attempts. Both reuse the send
// throttle here so a loop cannot turn into a stream of messages.
// This file does not know about WhatsApp, email, or the password.

const crypto = require("node:crypto");

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const REQUEST_WINDOW_MS = 15 * 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 3;
const GLOBAL_COOLDOWN_MS = 60 * 1000;

function hashCode(code, salt) {
  return crypto.createHash("sha256").update(`${salt}:${code}`).digest("hex");
}

/**
 * A fresh code plus the record to keep. The plaintext `code` is for the
 * delivery step only — callers must not store it.
 *
 * @param {number} [now]
 * @returns {{ code: string, pending: { salt: string, hash: string, expiresAt: number, attempts: number } }}
 */
function generateCode(now = Date.now()) {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const salt = crypto.randomBytes(16).toString("hex");
  return {
    code,
    pending: {
      salt,
      hash: hashCode(code, salt),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
    },
  };
}

/**
 * Check a guess. Increments `pending.attempts`. Does not delete the record —
 * `clear: true` means the caller should drop it (expired, or no attempts left).
 * A matching code returns `{ ok: true }` and leaves the record in place so the
 * caller can still reject a bad new password without burning the code.
 *
 * @param {{ salt: string, hash: string, expiresAt: number, attempts: number } | null} pending
 * @param {unknown} code
 * @param {number} [now]
 */
function checkAttempt(pending, code, now = Date.now()) {
  if (!pending) return { ok: false, reason: "no_pending" };
  if (now > pending.expiresAt) return { ok: false, reason: "expired", clear: true };

  pending.attempts += 1;
  const expected = Buffer.from(pending.hash, "hex");
  const actual = Buffer.from(hashCode(String(code ?? "").trim(), pending.salt), "hex");
  const matches = expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  if (!matches) {
    const attemptsLeft = MAX_CODE_ATTEMPTS - pending.attempts;
    if (attemptsLeft <= 0) return { ok: false, reason: "too_many_attempts", clear: true };
    return { ok: false, reason: "wrong_code", attemptsLeft };
  }
  return { ok: true };
}

/**
 * Per-purpose send throttle. Password reset uses one instance for every
 * channel (a WhatsApp send and an email send share the cooldown). Recovery
 * verification uses a second instance so adding an address does not lock the
 * operator out of resetting the password, or the reverse.
 */
function createThrottle() {
  let lastRequestAt = 0;
  const requests = new Map();

  function check(peer, now = Date.now()) {
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
    return { ok: true, entry: entry || null };
  }

  function record(peer, entry, now = Date.now()) {
    lastRequestAt = now;
    if (entry) entry.count += 1;
    else requests.set(peer, { count: 1, firstAt: now });
  }

  /**
   * Take one slot before any await. Concurrent callers then see the cooldown
   * instead of all passing `check` while the first delivery is still running.
   * `release` gives the slot back when delivery fails — a failed send must not
   * spend the cooldown.
   */
  function reserve(peer, now = Date.now()) {
    const gate = check(peer, now);
    if (!gate.ok) return gate;
    const reservation = {
      peer,
      previousLast: lastRequestAt,
      entry: gate.entry,
      previousCount: gate.entry ? gate.entry.count : 0,
      previousFirstAt: gate.entry ? gate.entry.firstAt : 0,
    };
    record(peer, gate.entry, now);
    return { ok: true, reservation };
  }

  function release(reservation) {
    if (!reservation) return;
    lastRequestAt = reservation.previousLast;
    if (!reservation.entry) {
      requests.delete(reservation.peer);
      return;
    }
    reservation.entry.count = reservation.previousCount;
    reservation.entry.firstAt = reservation.previousFirstAt;
  }

  function reset() {
    lastRequestAt = 0;
    requests.clear();
  }

  return { check, record, reserve, release, reset };
}

module.exports = {
  CODE_TTL_MS,
  MAX_CODE_ATTEMPTS,
  REQUEST_WINDOW_MS,
  MAX_REQUESTS_PER_WINDOW,
  GLOBAL_COOLDOWN_MS,
  hashCode,
  generateCode,
  checkAttempt,
  createThrottle,
};
