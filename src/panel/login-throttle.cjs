// Guess-throttling for the panel password. Shared by /login, /setup, and
// POST /dashboard/api/security/password so a locked-out peer cannot keep
// trying the same secret on another door.
//
// Keyed on the TCP peer, never on `req.ip`: with `trust proxy` set, a client
// picks its own `req.ip` by writing a header.

const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const attempts = new Map();

function blockedFor(ip) {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAt > ATTEMPT_WINDOW_MS) attempts.delete(key);
  }
  const entry = attempts.get(ip);
  if (!entry || entry.count < MAX_ATTEMPTS) return 0;
  const remaining = ATTEMPT_WINDOW_MS - (now - entry.firstAt);
  return remaining > 0 ? Math.ceil(remaining / 1000) : 0;
}

function recordFailure(ip) {
  const now = Date.now();
  const entry = attempts.get(ip);
  if (!entry || now - entry.firstAt > ATTEMPT_WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now });
    return;
  }
  entry.count += 1;
}

function clearAttempts(ip) {
  attempts.delete(ip);
}

module.exports = {
  ATTEMPT_WINDOW_MS,
  MAX_ATTEMPTS,
  blockedFor,
  recordFailure,
  clearAttempts,
};
