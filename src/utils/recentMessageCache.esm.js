// In-memory store for messages the bot itself sent.
//
// Sole purpose: back Baileys' getMessage callback so retries succeed. When a
// recipient can't decrypt something we sent, Baileys asks for it again through
// getMessage; rc10's enableAutoSessionRecreation needs this to recover from
// "this message can take a while".
//
// Nothing is written to disk and nothing other people send is kept here.
//
// Eviction: time-based + size-cap, both small — a retry request arrives within
// minutes or not at all.

const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour
const DEFAULT_MAX_ITEMS = 500;

const recent = new Map(); // id -> { value, expiresAt }
let ttlMs = DEFAULT_TTL_MS;
let maxItems = DEFAULT_MAX_ITEMS;

function gc(now = Date.now()) {
  // Drop expired entries first.
  for (const [id, entry] of recent) {
    if (entry.expiresAt <= now) recent.delete(id);
  }
  // If still over the cap, drop oldest insertions (Map preserves order).
  while (recent.size > maxItems) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    recent.delete(oldest);
  }
}

export function configureRecentCache({ ttlMs: nextTtl, maxItems: nextMax } = {}) {
  if (Number.isFinite(nextTtl) && nextTtl > 0) ttlMs = nextTtl;
  if (Number.isFinite(nextMax) && nextMax > 0) maxItems = nextMax;
}

export function rememberMessage(id, value) {
  if (!id) return;
  const expiresAt = Date.now() + ttlMs;
  recent.set(id, { value, expiresAt });
  if (recent.size > maxItems) gc();
}

export function recallMessage(id) {
  if (!id) return null;
  const entry = recent.get(id);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    recent.delete(id);
    return null;
  }
  return entry.value;
}

export function forgetMessage(id) {
  if (!id) return;
  recent.delete(id);
}

// Used by Baileys getMessage; expects a `proto.IMessage` (or undefined).
export async function getMessageFromRecent(key) {
  if (!key?.id) return undefined;
  const stored = recallMessage(key.id);
  if (!stored) return undefined;
  // Stored archive uses { message, ... } shape -- we only need .message
  return stored.message || stored.rawMessage || undefined;
}

setInterval(() => gc(), 1000 * 60 * 5).unref?.();
