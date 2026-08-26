// Values that are fixed at build time — not settings, not secrets.
//
// Anything an operator can change lives in the database and is read through
// src/config/settings.cjs (the dashboard writes it) or
// src/config/runtime-config.cjs (the command table). Anything secret is
// generated in src/config/secrets.cjs. There is no .env file.

// Connection retry configuration
export const MAX_RETRIES = 5;
export const RETRY_DELAY_MS = 5000;

// Group metadata cache
export const CACHE_CONFIG = {
  stdTTL: 60 * 60, // 1 hour
  checkperiod: 60 * 5, // 5 minutes
};
