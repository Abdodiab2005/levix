// The one group-metadata cache, and the cache-first resolver every
// per-message path should use.
//
// Why a shared module: Baileys' `sock.groupMetadata()` is ALWAYS a live server
// query — it never consults the `cachedGroupMetadata` config hook (that hook
// only serves the message-send path). Without this module, every prefixed
// group message and every moderation check cost its own network round-trip.
// Now the hot path reads the cache and only the first caller after a miss
// pays for one query, which is then shared by everyone.
//
// The cache is populated from four places:
//   * `groupFetchAllParticipating()` on connection open (see
//     src/core/connection.js — itself TTL-gated to avoid full rosters on every
//     reconnect),
//   * pushed `groups.upsert` and full `groups.update` events,
//   * a shared refresh after `group-participants.update`,
//   * the write-back in resolveGroupMetadata() below.
//
// A roster event marks the entry stale before any await. The send hook
// (groupMetadataForSend) refuses a stale roster. getCached still returns the
// last known entry so the Reply Router can check membership during a refresh.
// A failed refresh keeps that entry. It does not delete it.
//
// CommonJS on purpose: the consumers are the CJS command files and the ESM
// handlers/ middleware, and this module must be loadable from both.

const NodeCache = require("node-cache");

// Same values the old src/config/constants.js CACHE_CONFIG had (1h entries,
// swept every 5m). constants.js is ESM and this module must be CJS, so the
// literals live here now. The sweep timer is unref'd by node-cache.
const CACHE_CONFIG = {
  stdTTL: 60 * 60, // 1 hour
  checkperiod: 60 * 5, // 5 minutes
};

const cache = new NodeCache(CACHE_CONFIG);

// jid -> { gen, stale, inflight, again }. Only stale or in-flight groups stay
// here. A fresh idle entry does not, so the map tracks refreshes, not the cache.
const state = new Map();

// Follow one coalesced refetch, then stop. A burst schedules at most one more
// fetch; this cap only bounds a pathological chain of events across fetches.
const MAX_FETCH_CHAIN = 8;

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function ensureState(jid) {
  let entry = state.get(jid);
  if (!entry) {
    entry = { gen: 0, stale: false, inflight: null, again: false };
    state.set(jid, entry);
  }
  return entry;
}

function freshEntry(jid) {
  const entry = cache.get(jid);
  if (!entry || !Array.isArray(entry.participants)) return undefined;
  if (state.get(jid)?.stale) return undefined;
  return entry;
}

/** Last known metadata, fresh or stale. The Reply Router depends on this. */
function getCached(jid) {
  return cache.get(jid);
}

function remainingTtlSeconds(jid) {
  const expiresAt = cache.getTtl(jid);
  if (expiresAt == null) return null;
  if (expiresAt === 0) return 0;
  if (!Number.isFinite(expiresAt)) return null;
  const seconds = (expiresAt - Date.now()) / 1000;
  if (seconds <= 0) return null;
  return seconds;
}

function dropIdleState(jid) {
  const entry = state.get(jid);
  if (!entry || entry.inflight) return;
  state.delete(jid);
}

// Unlink and backup activation call NodeCache.flushAll() directly
// (session.js, connection.js). Bump gen first so an in-flight answer cannot
// write the roster back after the cache was cleared.
function dropAllRosterState() {
  for (const entry of state.values()) {
    entry.gen += 1;
    entry.again = false;
    entry.stale = false;
    entry.inflight = null;
  }
  state.clear();
}

cache.on("del", (key) => dropIdleState(key));
cache.on("expired", (key) => dropIdleState(key));
cache.on("flush", () => dropAllRosterState());

/**
 * Store a full roster. Bumps the generation and clears stale. An in-flight
 * fetch that started earlier can no longer write over this answer.
 */
function storeFullGroupMetadata(jid, metadata) {
  if (!isGroupJid(jid) || !metadata || !Array.isArray(metadata.participants)) return null;
  const entry = ensureState(jid);
  entry.gen += 1;
  entry.stale = false;
  entry.again = false;
  cache.set(jid, metadata);
  if (!entry.inflight) state.delete(jid);
  return metadata;
}

/**
 * Merge a partial groups.update into an existing entry. Keeps the remaining
 * TTL. Does not create an entry, does not bump the generation, and does not
 * clear stale.
 */
function mergePartialGroupMetadata(jid, patch) {
  if (!isGroupJid(jid) || !patch || typeof patch !== "object") return null;
  if (!cache.has(jid)) return null;
  const current = cache.get(jid);
  if (!current || typeof current !== "object") return null;
  const ttl = remainingTtlSeconds(jid);
  if (ttl == null) return null;
  const next = { ...current, ...patch };
  cache.set(jid, next, ttl);
  return next;
}

function setCached(jid, metadata) {
  if (!isGroupJid(jid) || !metadata) return;
  if (Array.isArray(metadata.participants)) {
    storeFullGroupMetadata(jid, metadata);
    return;
  }
  cache.set(jid, metadata);
}

function fetchRoster(sock, jid, entry) {
  const gen = entry.gen;
  let finish;
  const inflight = new Promise((resolve) => {
    finish = resolve;
  });
  // Set before groupMetadata so a roster event inside that call coalesces.
  entry.inflight = inflight;

  let pending;
  try {
    pending = sock.groupMetadata(jid);
  } catch (error) {
    pending = Promise.reject(error);
  }

  Promise.resolve(pending)
    .then(
      (live) => {
        const current = entry.gen === gen;
        if (current && live && Array.isArray(live.participants)) {
          cache.set(jid, live);
          entry.stale = false;
        }
        return { current, failed: false, live };
      },
      () => ({ current: entry.gen === gen, failed: true, live: undefined }),
    )
    .then((result) => {
      try {
        if (entry.inflight !== inflight) return;
        if (entry.again) {
          entry.again = false;
          fetchRoster(sock, jid, entry);
          return;
        }
        entry.inflight = null;
        // A failed refresh keeps the last entry and stays stale. Drop state only
        // when nothing is left to hide, or the entry is fresh and idle.
        if (!cache.has(jid) || !entry.stale) state.delete(jid);
      } finally {
        finish(result);
      }
    });

  return inflight;
}

function canFetch(sock) {
  return Boolean(sock && typeof sock.groupMetadata === "function");
}

/**
 * Roster event. Bumps gen and sets stale synchronously, then starts or
 * coalesces one shared groupMetadata fetch. No await before the flag.
 */
function markRosterChanged(sock, jid) {
  if (!isGroupJid(jid)) return null;
  const entry = ensureState(jid);
  entry.gen += 1;
  entry.stale = true;
  if (entry.inflight) {
    entry.again = true;
    return entry.inflight;
  }
  if (!canFetch(sock)) {
    if (!cache.has(jid)) state.delete(jid);
    return null;
  }
  return fetchRoster(sock, jid, entry);
}

async function drainFetches(sock, jid) {
  const entry = state.get(jid) || ensureState(jid);
  if (!entry.inflight) fetchRoster(sock, jid, entry);
  let last;
  for (let i = 0; i < MAX_FETCH_CHAIN; i += 1) {
    const current = state.get(jid);
    if (!current?.inflight) break;
    last = await current.inflight;
  }
  return last;
}

function acceptedLive(jid, result) {
  return Boolean(
    result && result.current && !result.failed && result.live && !state.get(jid)?.stale,
  );
}

/**
 * Baileys send-path hook. A fresh roster, or the shared fetch's answer.
 * Never a stale roster. Undefined on failure so Baileys queries itself.
 */
async function groupMetadataForSend(sock, jid) {
  if (!isGroupJid(jid)) return undefined;
  const ready = freshEntry(jid);
  if (ready) return ready;
  if (!canFetch(sock)) return undefined;
  const last = await drainFetches(sock, jid);
  const after = freshEntry(jid);
  if (after) return after;
  if (acceptedLive(jid, last) && Array.isArray(last.live.participants)) return last.live;
  return undefined;
}

/**
 * Group metadata, cache-first. A fresh hit costs nothing. A miss or a stale
 * entry joins the shared fetch. A failing fetch returns the last known entry
 * (stale) or null when there is none.
 */
async function resolveGroupMetadata(sock, jid) {
  if (!isGroupJid(jid)) return null;
  const ready = freshEntry(jid);
  if (ready) return ready;
  let last;
  if (canFetch(sock)) {
    try {
      last = await drainFetches(sock, jid);
    } catch {
      last = undefined;
    }
  }
  const after = freshEntry(jid);
  if (after) return after;
  // A live answer with no participants array is not stored. Callers that
  // already accept that shape (the low-data retry) still receive it.
  if (acceptedLive(jid, last)) return last.live;
  return cache.get(jid) || null;
}

function flushAll() {
  cache.flushAll();
}

function keys() {
  return cache.keys();
}

function isRosterStale(jid) {
  return Boolean(state.get(jid)?.stale);
}

function rosterStateSize() {
  return state.size;
}

module.exports = {
  cache,
  CACHE_CONFIG,
  isGroupJid,
  getCached,
  setCached,
  flushAll,
  keys,
  resolveGroupMetadata,
  groupMetadataForSend,
  storeFullGroupMetadata,
  mergePartialGroupMetadata,
  markRosterChanged,
  isRosterStale,
  rosterStateSize,
};
