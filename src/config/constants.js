// Values that are fixed at build time — not settings, not secrets.
//
// Anything an operator can change lives in the database and is read through
// src/config/settings.cjs (the dashboard writes it) or
// src/config/runtime-config.cjs (the command table). Anything secret is
// generated in src/config/secrets.cjs. There is no .env file.

// Connection retry configuration.
//
// Staged linear backoff, NOT exponential: attempt N waits N * 5 seconds, so the
// schedule is 5s, 10s, 15s, 20s, 25s and then Levix stops trying and waits for
// somebody to press Start in the panel. The process stays up either way — a
// WhatsApp connection that will not come back is not a reason to take the
// control panel down with it.
export const RETRY_DELAY_MS = 5000;
export const MAX_RETRIES = 5;
export const RETRY_SCHEDULE_MS = Object.freeze(
  Array.from({ length: MAX_RETRIES }, (_, index) => RETRY_DELAY_MS * (index + 1))
);

// Group metadata cache
export const CACHE_CONFIG = {
  stdTTL: 60 * 60, // 1 hour
  checkperiod: 60 * 5, // 5 minutes
};
