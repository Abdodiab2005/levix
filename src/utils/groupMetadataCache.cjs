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
// A bulk answer (cacheAllGroups) and a full roster whose request start is
// unknown (groups.upsert, groups.update with participants) must not overwrite
// a group that had a roster event after that answer was requested. Those
// paths use captureRosterCursor / storeBulkGroupMetadata and
// storeUnsolicitedFullRoster. storeFullGroupMetadata itself stays the
// "this roster is current" writer.
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

// Unknown-start full rosters are stored only when this group had no roster
// event in this window. Baileys can deliver that payload long after its query:
// rc14 times the query out at 60s and the event buffer can hold the update
// about 30s more. Records stay at least this long, so the gate and the prune
// cannot drift. No timer: prune runs when an event is recorded, when a bulk
// cursor is captured, and on flush.
const ROSTER_EVENT_WINDOW_MS = 10 * 60 * 1000;

// Monotonic count of roster events. A bulk fetch captures the value before
// its request and stores a group only when that group is still at or below it.
let rosterEventSeq = 0;
// Bumped on flush so an in-flight bulk answer cannot refill a cleared cache.
let rosterEpoch = 0;
// jid -> { seq, at }. Survives a finished refresh so a late bulk answer still
// sees the event. Separate from `state`, which only tracks stale fetches.
const rosterEvents = new Map();
// Unlike refresh state and event retention, these versions survive cache expiry.
// A caller may use its message-time roster only until newer information exists.
const rosterVersions = new Map();

function bumpRosterVersion(jid) {
  if (isGroupJid(jid)) rosterVersions.set(jid, (rosterVersions.get(jid) || 0) + 1);
}

/** Read-only marker for writes, deletions, roster events and cache flushes. */
function getRosterVersion(jid) {
  return `${rosterEpoch}:${rosterVersions.get(jid) || 0}`;
}

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
  rosterEpoch += 1;
  rosterVersions.clear();
  rosterEvents.clear();
  for (const entry of state.values()) {
    entry.gen += 1;
    entry.again = false;
    entry.stale = false;
    entry.inflight = null;
  }
  state.clear();
}

function pruneRosterEvents(now = Date.now()) {
  for (const [jid, record] of rosterEvents) {
    if (!record || now - record.at > ROSTER_EVENT_WINDOW_MS) rosterEvents.delete(jid);
  }
}

function noteRosterEvent(jid, now = Date.now()) {
  bumpRosterVersion(jid);
  rosterEventSeq += 1;
  rosterEvents.set(jid, { seq: rosterEventSeq, at: now });
  pruneRosterEvents(now);
}

function hadRosterEventSince(jid, seq) {
  const record = rosterEvents.get(jid);
  return Boolean(record && record.seq > seq);
}

function hadRosterEventWithin(jid, withinMs, now = Date.now()) {
  const record = rosterEvents.get(jid);
  return Boolean(record && now - record.at < withinMs);
}

/**
 * Sequence and flush epoch at the moment a bulk roster request starts.
 * `now` is only for pruning; production passes the clock cacheAllGroups uses.
 */
function captureRosterCursor(now = Date.now()) {
  pruneRosterEvents(now);
  return { seq: rosterEventSeq, epoch: rosterEpoch };
}

cache.on("set", (key) => bumpRosterVersion(key));
cache.on("del", (key) => {
  bumpRosterVersion(key);
  dropIdleState(key);
});
cache.on("expired", (key) => {
  bumpRosterVersion(key);
  dropIdleState(key);
});
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

/**
 * Store one group from a bulk fetch that captured `cursor` before the request.
 * A later roster event, an open refresh, or a flush wins. The bulk answer is
 * left unused for that group so it cannot mark an older roster fresh.
 */
function storeBulkGroupMetadata(jid, metadata, cursor) {
  if (!cursor || cursor.epoch !== rosterEpoch) return null;
  const entry = state.get(jid);
  if (entry?.stale || entry?.inflight) return null;
  if (hadRosterEventSince(jid, cursor.seq)) return null;
  return storeFullGroupMetadata(jid, metadata);
}

/**
 * Full roster whose request started at an unknown time (groups.upsert, or
 * groups.update that carries participants). Store it only when this group had
 * no roster event in the last 10 minutes. Otherwise leave any in-flight
 * refresh alone, or start one, so a live groupMetadata answer decides.
 */
function storeUnsolicitedFullRoster(sock, jid, metadata, now = Date.now()) {
  if (!isGroupJid(jid) || !metadata || !Array.isArray(metadata.participants)) return null;
  pruneRosterEvents(now);
  const entry = state.get(jid);
  const quiet =
    !entry?.stale && !entry?.inflight && !hadRosterEventWithin(jid, ROSTER_EVENT_WINDOW_MS, now);
  if (quiet) return storeFullGroupMetadata(jid, metadata);
  if (!entry?.inflight && canFetch(sock)) beginRosterRefresh(sock, jid);
  return null;
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
 * Mark the roster stale and start or coalesce one shared groupMetadata fetch.
 * Does not record a roster event. markRosterChanged does that first.
 * A second call while a fetch is open bumps gen so the older answer is dropped
 * and one follow-up runs. storeUnsolicitedFullRoster does not call this while
 * a fetch is already open, so a late full roster cannot discard that refresh.
 */
function beginRosterRefresh(sock, jid) {
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

/**
 * Roster event. Records the event and sets stale synchronously, before any
 * await, then starts or coalesces one shared groupMetadata fetch.
 */
function markRosterChanged(sock, jid) {
  if (!isGroupJid(jid)) return null;
  noteRosterEvent(jid);
  return beginRosterRefresh(sock, jid);
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

/** Live-only authorization read. Joins an open fetch; never falls back to cache. */
async function readLiveGroupMetadata(sock, jid) {
  if (!isGroupJid(jid) || !canFetch(sock)) return null;
  const last = await drainFetches(sock, jid);
  if (acceptedLive(jid, last) && Array.isArray(last.live.participants)) return last.live;
  return null;
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
 *
 * `{ fresh: true }` is the authorization read. It returns a fresh cache hit
 * or a live answer, and null when the only roster left is a stale one.
 * Display, moderation protection and the Reply Router omit the option.
 */
async function resolveGroupMetadata(sock, jid, options) {
  if (!isGroupJid(jid)) return null;
  const fresh = Boolean(options && options.fresh);
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
  if (fresh) return null;
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
  getRosterVersion,
  setCached,
  flushAll,
  keys,
  resolveGroupMetadata,
  readLiveGroupMetadata,
  groupMetadataForSend,
  storeFullGroupMetadata,
  mergePartialGroupMetadata,
  captureRosterCursor,
  storeBulkGroupMetadata,
  storeUnsolicitedFullRoster,
  markRosterChanged,
  isRosterStale,
  rosterStateSize,
};
