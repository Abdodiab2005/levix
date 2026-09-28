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
// The cache is populated from three places:
//   * `groupFetchAllParticipating()` on connection open (see
//     src/core/connection.js — itself TTL-gated to avoid full rosters on every
//     reconnect),
//   * pushed `groups.upsert` / `groups.update` events (src/core/events.js),
//   * the write-back in resolveGroupMetadata() below.
//
// CommonJS on purpose: the consumers are the CJS command files and the ESM
// handlers/ middleware, and this module must be loadable from both.

const NodeCache = require("node-cache");

// Same values the old src/config/constants.js CACHE_CONFIG had (1h entries,
// swept every 5m). constants.js is ESM and this module must be CJS, so the
// literals live here now.
const CACHE_CONFIG = {
  stdTTL: 60 * 60, // 1 hour
  checkperiod: 60 * 5, // 5 minutes
};

const cache = new NodeCache(CACHE_CONFIG);

function isGroupJid(jid) {
  return String(jid || "").endsWith("@g.us");
}

function getCached(jid) {
  return cache.get(jid);
}

function setCached(jid, metadata) {
  if (isGroupJid(jid) && metadata) cache.set(jid, metadata);
}

function flushAll() {
  cache.flushAll();
}

function keys() {
  return cache.keys();
}

/**
 * Group metadata, cache-first. A cache hit costs nothing; a miss makes ONE
 * live query and writes the answer back so concurrent and later readers share
 * it. A failing live query resolves null without caching anything, so the
 * next caller retries — correctness beats request avoidance.
 */
async function resolveGroupMetadata(sock, jid) {
  if (!isGroupJid(jid)) return null;

  const hit = cache.get(jid);
  if (hit) return hit;

  try {
    const live = await sock.groupMetadata(jid);
    if (live) setCached(jid, live);
    return live;
  } catch {
    return null;
  }
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
};
