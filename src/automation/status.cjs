// Execution diagnostics stay in RAM and contain no event or provider data.
const store = require("../db/store.cjs");
const CODES = new Set([
  "REACTION_CANCELLED",
  "REACTION_TIMEOUT",
  "REACTION_STALE",
  "REACTION_INACCESSIBLE",
  "REACTION_FORBIDDEN",
  "REACTION_STT_DISABLED",
  "REACTION_DELIVERY_REFUSED",
  "REACTION_CAPACITY",
  "REACTION_IDENTITY_INVALID",
  "REACTION_VOICE_REQUIRED",
  "STT_KEY_REQUIRED",
  "STT_OUTPUT_INVALID",
  "MEDIA_AUDIO_INVALID",
  "MEDIA_TOO_LARGE",
  "MEDIA_NOT_AVAILABLE",
  "MEDIA_URL_INVALID",
  "DELIVERED",
  "NO_MATCH",
  "BUSY",
  "ACTION_FAILED",
  "RATE_LIMIT",
  "CAPACITY",
  "EVENT_MISSING",
  "DUPLICATE",
]);
const entries = new Map();
let globalEntry = null;

function record(ruleId, code, at = Date.now()) {
  if (ruleId !== null && (typeof ruleId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(ruleId)))
    return;
  const safeCode = CODES.has(code) ? code : "ACTION_FAILED";
  const entry = (ruleId === null ? globalEntry : entries.get(ruleId)) || {
    lastCode: null,
    lastAt: null,
    counts: {},
  };
  entry.lastCode = safeCode;
  entry.lastAt = Number.isSafeInteger(at) && at >= 0 ? at : Date.now();
  entry.counts[safeCode] = (entry.counts[safeCode] || 0) + 1;
  if (ruleId === null) globalEntry = entry;
  else {
    if (!entries.has(ruleId) && entries.size >= 1000) entries.delete(entries.keys().next().value);
    entries.set(ruleId, entry);
  }
}

function get(ruleId) {
  return structuredClone(entries.get(ruleId) || null);
}
function global() {
  return structuredClone(globalEntry);
}
function clear(ruleId) {
  entries.delete(ruleId);
}
function reset() {
  entries.clear();
  globalEntry = null;
}

store.subscribeReactionChanges((change) => {
  if (change.type === "rule") clear(change.id);
});

module.exports = { record, get, global, clear, reset };
