// In-memory store for outbound messages the bot itself sent.
//
// Sole purpose: back Baileys' getMessage callback so retry receipts can resend
// the exact proto.IMessage that was relayed when Baileys' 5-minute internal
// cache misses.
//
// Privacy and persistence:
// - Memory only; nothing is written to disk or logs, and nothing other people
//   send is kept here.
// - Cleared on account unlink (clearAccountScopedState -> clearRecentMessages).
// - After a process restart nothing is recoverable; a retry for a pre-restart
//   message returns undefined so Baileys skips the resend instead of sending an
//   empty message.
//
// Bounds: at most 500 entries, 1 hour TTL, 8 MiB total encoded protobuf budget,
// and 1 MiB maximum per single message, evicting oldest entries first.

import { proto } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import normalizeJid, { isLidJid, isPnJid } from "./normalizeJid.esm.js";
import { getLidForPn, getLidsForPn, getPnForLid } from "./storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("./logger.cjs");

const DEFAULT_TTL_MS = 1000 * 60 * 60; // 1 hour
const DEFAULT_MAX_ITEMS = 500;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024; // 8 MiB
const DEFAULT_MAX_ENTRY_BYTES = 1024 * 1024; // 1 MiB
const KEY_SEPARATOR = "\u0000";

const recent = new Map(); // "${chatJid}\u0000${id}" -> { chatJid, id, message, bytes, expiresAt }
let totalBytes = 0;
let accountEpoch = 0;
let ttlMs = DEFAULT_TTL_MS;
let maxItems = DEFAULT_MAX_ITEMS;
let maxBytes = DEFAULT_MAX_BYTES;
let maxEntryBytes = DEFAULT_MAX_ENTRY_BYTES;

// Ids Levix assigned before sendMessage. No message body. Separate from the
// content cache: an echo can arrive before that cache is written, and the
// content cache is empty after a restart.
// Ids only, and not the content cache. The default count is far above the
// 500-message body cap. An id that is still inside its TTL is never evicted:
// the reaction window can outlive a content-cache eviction. A full store
// fails closed instead of forgetting a young id.
const DEFAULT_OUTBOUND_MAX_ITEMS = 100_000;
const outboundIds = new Map(); // id -> expiresAt
let outboundTtlMs = DEFAULT_TTL_MS;
let outboundMaxItems = DEFAULT_OUTBOUND_MAX_ITEMS;
let outboundSaturated = false;

function gcOutbound(now = Date.now()) {
  for (const [id, expiresAt] of outboundIds) {
    if (expiresAt <= now) outboundIds.delete(id);
  }
  if (outboundIds.size > outboundMaxItems) outboundSaturated = true;
  else if (outboundIds.size < outboundMaxItems) outboundSaturated = false;
}

function makeCacheKey(chatJid, id) {
  return `${chatJid}${KEY_SEPARATOR}${id}`;
}

function normalizeChatJid(jid) {
  if (typeof jid !== "string") return "";
  const trimmed = jid.trim();
  if (!trimmed) return "";
  if (trimmed.endsWith("@g.us")) {
    return trimmed.includes(":") ? "" : trimmed;
  }
  return normalizeJid(trimmed) || "";
}

function deleteEntry(mapKey) {
  const existing = recent.get(mapKey);
  if (!existing) return;
  totalBytes = Math.max(0, totalBytes - existing.bytes);
  recent.delete(mapKey);
}

function gc(now = Date.now()) {
  // Drop expired entries first.
  for (const [mapKey, entry] of recent) {
    if (entry.expiresAt <= now) {
      deleteEntry(mapKey);
    }
  }
  // If still over the item or byte cap, drop oldest insertions (Map preserves order).
  while (recent.size > maxItems || totalBytes > maxBytes) {
    const oldest = recent.keys().next().value;
    if (oldest === undefined) break;
    deleteEntry(oldest);
  }
}

export function configureRecentCache({
  ttlMs: nextTtl,
  maxItems: nextMax,
  maxBytes: nextMaxBytes,
  maxEntryBytes: nextMaxEntryBytes,
} = {}) {
  if (Number.isFinite(nextTtl) && nextTtl > 0) ttlMs = nextTtl;
  if (Number.isFinite(nextMax) && nextMax > 0) maxItems = Math.floor(nextMax);
  if (Number.isFinite(nextMaxBytes) && nextMaxBytes > 0) maxBytes = Math.floor(nextMaxBytes);
  if (Number.isFinite(nextMaxEntryBytes) && nextMaxEntryBytes > 0) {
    maxEntryBytes = Math.floor(nextMaxEntryBytes);
  }
  gc();
}

export function getRecentCacheEpoch() {
  return accountEpoch;
}

export function clearRecentMessages() {
  accountEpoch += 1;
  recent.clear();
  totalBytes = 0;
  outboundIds.clear();
  outboundSaturated = false;
  return accountEpoch;
}

export function configureOutboundIds({ maxItems: nextMax, ttlMs: nextTtl } = {}) {
  if (Number.isFinite(nextMax) && nextMax > 0) outboundMaxItems = Math.floor(nextMax);
  if (Number.isFinite(nextTtl) && nextTtl > 0) outboundTtlMs = nextTtl;
  gcOutbound();
}

/** Record an id before Baileys relays it. Ids only. */
export function rememberOutboundId(id, now = Date.now()) {
  if (typeof id !== "string" || !id) return false;
  gcOutbound(now);
  if (outboundIds.has(id)) {
    outboundIds.delete(id);
    outboundIds.set(id, now + outboundTtlMs);
    return true;
  }
  if (outboundIds.size >= outboundMaxItems) {
    outboundSaturated = true;
    return false;
  }
  outboundIds.set(id, now + outboundTtlMs);
  return true;
}

export function isOutboundId(id, now = Date.now()) {
  if (typeof id !== "string" || !id) return false;
  const expiresAt = outboundIds.get(id);
  if (expiresAt == null) return false;
  if (expiresAt <= now) {
    outboundIds.delete(id);
    if (outboundIds.size < outboundMaxItems) outboundSaturated = false;
    return false;
  }
  return true;
}

/** True once a young id was refused because the id store was full. */
export function outboundIdsSaturated() {
  return outboundSaturated;
}

export function clearOutboundIds() {
  outboundIds.clear();
  outboundSaturated = false;
}

function normalizeEpochArg(candidate) {
  if (typeof candidate === "number" && Number.isInteger(candidate)) return candidate;
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.epoch === "number" &&
    Number.isInteger(candidate.epoch)
  ) {
    return candidate.epoch;
  }
  return undefined;
}

function extractOutboundArgs(arg1, arg2, arg3, arg4) {
  if (typeof arg1 === "string" && typeof arg2 === "string") {
    return {
      remoteJid: arg1,
      id: arg2,
      message: arg3,
      expectedEpoch: normalizeEpochArg(arg4),
    };
  }
  if (arg1 && typeof arg1 === "object") {
    if (
      arg1.key &&
      typeof arg1.key === "object" &&
      (arg2 === undefined || normalizeEpochArg(arg2) !== undefined)
    ) {
      return {
        remoteJid: arg1.key.remoteJid,
        id: arg1.key.id,
        message: arg1.message,
        expectedEpoch: normalizeEpochArg(arg2),
      };
    }
    return {
      remoteJid: arg1.remoteJid,
      id: arg1.id,
      message: arg2,
      expectedEpoch: normalizeEpochArg(arg3),
    };
  }
  if (typeof arg1 === "string" && arg2 && typeof arg2 === "object" && arg2.key?.remoteJid) {
    return {
      remoteJid: arg2.key.remoteJid,
      id: arg1 || arg2.key.id,
      message: arg2.message,
      expectedEpoch: normalizeEpochArg(arg3),
    };
  }
  return { remoteJid: null, id: null, message: null, expectedEpoch: undefined };
}

export function rememberMessage(arg1, arg2, arg3, arg4) {
  try {
    const { remoteJid, id, message, expectedEpoch } = extractOutboundArgs(arg1, arg2, arg3, arg4);
    if (expectedEpoch !== undefined && expectedEpoch !== accountEpoch) return false;
    if (typeof id !== "string" || !id) return false;
    if (!message || typeof message !== "object") return false;
    const chatJid = normalizeChatJid(remoteJid);
    if (!chatJid) return false;

    const bytes = proto.Message.encode(message).finish().length;
    if (bytes > maxEntryBytes || bytes > maxBytes) {
      return false;
    }

    const now = Date.now();
    gc(now);

    const mapKey = makeCacheKey(chatJid, id);
    if (recent.has(mapKey)) {
      deleteEntry(mapKey);
    }

    while (recent.size >= maxItems || totalBytes + bytes > maxBytes) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      deleteEntry(oldest);
    }

    recent.set(mapKey, {
      chatJid,
      id,
      message,
      bytes,
      expiresAt: now + ttlMs,
    });
    totalBytes += bytes;
    return true;
  } catch (err) {
    logger.debug({ err: err?.message }, "[RecentCache] failed to cache outbound message");
    return false;
  }
}

function readEntry(chatJid, id, now) {
  const mapKey = makeCacheKey(chatJid, id);
  const entry = recent.get(mapKey);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    deleteEntry(mapKey);
    return undefined;
  }
  return entry.message;
}

function resolveDirectChatAliases(chatJid, rawRemoteJid) {
  const aliases = [];
  const add = (candidate) => {
    const norm = normalizeChatJid(candidate);
    if (
      norm &&
      norm !== chatJid &&
      !norm.endsWith("@g.us") &&
      (isPnJid(norm) || isLidJid(norm)) &&
      !aliases.includes(norm)
    ) {
      aliases.push(norm);
    }
  };

  try {
    if (isLidJid(chatJid)) {
      const pn =
        getPnForLid(chatJid) ||
        (rawRemoteJid && rawRemoteJid !== chatJid ? getPnForLid(rawRemoteJid) : null);
      if (pn) {
        add(pn);
        const normPn = normalizeChatJid(pn);
        if (normPn) {
          add(getLidForPn(normPn));
          for (const lid of getLidsForPn(normPn)) add(lid);
        }
      }
    } else if (isPnJid(chatJid)) {
      add(getLidForPn(chatJid));
      for (const lid of getLidsForPn(chatJid)) add(lid);
      if (rawRemoteJid && rawRemoteJid !== chatJid) {
        add(getLidForPn(rawRemoteJid));
      }
    }
  } catch {}

  return aliases;
}

// Used by Baileys getMessage; expects a `proto.IMessage` (or undefined).
export async function getMessageFromRecent(key) {
  if (!key || typeof key.id !== "string" || !key.id) return undefined;
  if (typeof key.remoteJid !== "string" || !key.remoteJid) return undefined;

  const chatJid = normalizeChatJid(key.remoteJid);
  if (!chatJid) return undefined;

  const now = Date.now();
  const exact = readEntry(chatJid, key.id, now);
  if (exact !== undefined) return exact;

  // Group chats must match the exact group JID.
  if (chatJid.endsWith("@g.us")) return undefined;
  if (!isLidJid(chatJid) && !isPnJid(chatJid)) return undefined;

  const rawRemoteJid = key.remoteJid.trim();
  for (const aliasJid of resolveDirectChatAliases(chatJid, rawRemoteJid)) {
    const found = readEntry(aliasJid, key.id, now);
    if (found !== undefined) return found;
  }

  return undefined;
}

/** True when this id is a message Levix itself sent. Sync; safe on the intake path. */
export function wasSentByLevix(key) {
  if (!key || typeof key.id !== "string" || !key.id) return false;
  if (typeof key.remoteJid !== "string" || !key.remoteJid) return false;
  const chatJid = normalizeChatJid(key.remoteJid);
  if (!chatJid) return false;
  const now = Date.now();
  if (readEntry(chatJid, key.id, now) !== undefined) return true;
  if (chatJid.endsWith("@g.us")) return false;
  if (!isLidJid(chatJid) && !isPnJid(chatJid)) return false;
  const rawRemoteJid = key.remoteJid.trim();
  for (const aliasJid of resolveDirectChatAliases(chatJid, rawRemoteJid)) {
    if (readEntry(aliasJid, key.id, now) !== undefined) return true;
  }
  return false;
}

setInterval(
  () => {
    gc();
    gcOutbound();
  },
  1000 * 60 * 5,
).unref?.();
