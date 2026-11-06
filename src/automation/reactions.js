// Phase 07a: transport intake only. No command, provider, download or send path.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deserialize, serialize } from "node:v8";
import { sameUser } from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const store = require("../db/store.cjs");
const { canonicalJid } = require("../messaging/router.cjs");
const logger = require("../utils/logger.cjs");

export const REACTION_LIMITS = Object.freeze({
  ttlMs: 30 * 60_000,
  futureSkewMs: 30_000,
  maxItems: 500,
  maxBytes: 8 * 1024 * 1024,
  maxEntryBytes: 64 * 1024,
  maxBatch: 100,
});
const sockets = new WeakMap();
const idPattern = /^[A-Za-z0-9_-]{1,128}$/;
const jidPattern = /^\d{1,30}(?::\d{1,5})?@(s\.whatsapp\.net|lid|g\.us)$/;
const mediaFields = [
  "url", "directPath", "mediaKey", "fileEncSha256", "fileSha256", "fileLength",
  "mimetype", "seconds", "ptt", "width", "height", "caption", "fileName",
];
const contentKeys = ["conversation", "extendedTextMessage", "audioMessage", "imageMessage",
  "videoMessage", "documentMessage", "stickerMessage"];
const graphemes = new Intl.Segmenter("en", { granularity: "grapheme" });
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const numberOf = (value) => value == null ? NaN : Number(String(value));

// Validate BEFORE normalization; normalizeJid deliberately accepts legacy inputs.
function jid(value) {
  if (typeof value !== "string" || !jidPattern.test(value)) return null;
  if (value.endsWith("@g.us") && value.includes(":")) return null;
  return canonicalJid(value);
}
function aliases(value) {
  const ids = store.reactionIdentityAliases(value);
  return ids.length <= 4 && ids.every((id) => jid(id)) ? ids : [];
}
function sameIdentity(a, b) {
  if (a === b) return true;
  if (!a || !b || a.endsWith("@g.us") || b.endsWith("@g.us")) return false;
  // sameUser's legacy numeric fallback alone is not proof of a LID/PN link.
  return aliases(a).includes(b) && sameUser(a, b);
}
function user(value) {
  const normalized = jid(value);
  return normalized && !normalized.endsWith("@g.us") ? normalized : null;
}
function messageKey(key) {
  const chat = jid(key?.remoteJid);
  if (!chat || key?.isViewOnce || typeof key?.id !== "string" || !idPattern.test(key.id) || key?.fromMe !== false) return null;
  const author = chat.endsWith("@g.us") ? user(key.participant) : chat;
  if (!author || (key.participant && !sameIdentity(author, user(key.participant)))) return null;
  return { remoteJid: chat, id: key.id, fromMe: false, ...(chat.endsWith("@g.us") ? { participant: author } : {}) };
}
const identityOf = (key) => [key.remoteJid, key.id, key.fromMe, key.participant || key.remoteJid];
const lookupKey = (key) => JSON.stringify(identityOf(key));
const invalidationKeys = (chat, id = "*") => aliases(chat).map((alias) => hash([alias, id]));

function safeContent(message) {
  // Disappearing, view-once and edited content is deliberately unsupported.
  let inner = message;
  if (inner?.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;
  if (!inner || Object.keys(inner).some((key) =>
    !contentKeys.includes(key) && !["messageContextInfo", "senderKeyDistributionMessage"].includes(key))) return null;
  const keys = contentKeys.filter((key) => inner[key] != null);
  if (keys.length !== 1) return null;
  const key = keys[0];
  const source = inner[key];
  if (source?.viewOnce || source?.contextInfo?.expiration || inner.messageContextInfo?.expiration) return null;
  if (key === "conversation") return typeof source === "string" && source.length <= 65536 ? { conversation: source } : null;
  if (key === "extendedTextMessage") {
    return typeof source?.text === "string" && source.text.length <= 65536 ? { extendedTextMessage: { text: source.text } } : null;
  }
  if (!source || typeof source !== "object") return null;
  const media = {};
  for (const field of mediaFields) {
    const value = source[field];
    if (value == null) continue;
    if (["mediaKey", "fileEncSha256", "fileSha256"].includes(field)) {
      if (!(value instanceof Uint8Array) || value.byteLength > 64) return null;
      media[field] = value;
    } else if (field === "ptt") {
      if (typeof value !== "boolean") return null;
      media[field] = value;
    } else if (["seconds", "width", "height", "fileLength"].includes(field)) {
      const number = numberOf(value);
      if (!Number.isSafeInteger(number) || number < 0) return null;
      media[field] = number;
    } else {
      if (typeof value !== "string" || value.length > (field === "caption" ? 65536 : 4096)) return null;
      media[field] = value;
    }
  }
  return { [key]: media };
}

/** One bounded lookup per live socket. Timers/closures are disposed with it. */
export function createReactionIntake(sock, { now = Date.now, limits = REACTION_LIMITS } = {}) {
  const cache = new Map();
  let bytes = 0;
  let active = false;
  let closed = false;
  function block() {
    cache.clear(); bytes = 0;
    store.invalidateReactionLookup(null, now() + limits.ttlMs + limits.futureSkewMs, now());
  }
  const self = () => [user(sock?.user?.id), user(sock?.user?.lid)].filter(Boolean);
  const isSelf = (author) => self().some((id) => sameIdentity(id, author));
  const enabled = (chat) => aliases(chat).some((id) => store.isReactionChatEnabled(id));
  const fresh = (timestamp, time) => Number.isSafeInteger(timestamp) &&
    timestamp > time - limits.ttlMs && timestamp <= time + limits.futureSkewMs;

  function drop(key) {
    const entry = cache.get(key);
    if (entry) bytes -= entry.data.byteLength;
    cache.delete(key);
  }
  function sweep() {
    const time = now();
    const scopes = new Map();
    for (const [key, entry] of cache) {
      if (!scopes.has(entry.chat)) scopes.set(entry.chat, enabled(entry.chat));
      if (entry.expiresAt <= time || !scopes.get(entry.chat)) drop(key);
    }
  }
  function invalidated(chat, id) {
    const ids = aliases(chat);
    return !ids.length || store.isReactionLookupInvalidated([
      ...invalidationKeys(chat), ...invalidationKeys(chat, id),
    ], now());
  }
  function invalidate(chatValue, id) {
    const chat = jid(chatValue);
    if (!active || !chat) return;
    // A configured but disabled chat still needs negative lookup state: a
    // delete during disablement must not revive when the rule is re-enabled.
    const tracked = [...cache.values()].some((entry) => sameIdentity(entry.chat, chat));
    if (!tracked && !aliases(chat).some((alias) => store.isReactionChatConfigured(alias))) return;
    sweep();
    for (const [key, entry] of cache) {
      if (sameIdentity(entry.chat, chat) && (!id || entry.id === id)) drop(key);
    }
    const keys = invalidationKeys(chat, id);
    const blocked = store.invalidateReactionLookup(keys.length ? keys : null,
      now() + limits.ttlMs + limits.futureSkewMs, now(), limits.maxItems);
    if (blocked) { cache.clear(); bytes = 0; }
  }
  function findOriginal(key) {
    const exact = cache.get(lookupKey(key));
    if (exact) return exact;
    return [...cache.values()].find((entry) => entry.id === key.id &&
      sameIdentity(entry.chat, key.remoteJid) &&
      sameIdentity(entry.author, key.participant || key.remoteJid));
  }
  function remember(msg) {
    if (!active || !self().length) return false;
    const key = messageKey(msg?.key);
    const time = now();
    if (!key || !enabled(key.remoteJid) || isSelf(key.participant || key.remoteJid)) return false;
    sweep();
    if (invalidated(key.remoteJid, key.id) || !fresh(numberOf(msg.messageTimestamp) * 1000, time) ||
      msg.messageStubType != null || numberOf(msg.ephemeralStartTimestamp) > 0 ||
      numberOf(msg.ephemeralDuration) > 0) return false;
    const content = safeContent(msg.message);
    if (!content) return false;
    const value = { key, message: content, messageTimestamp: numberOf(msg.messageTimestamp) };
    const data = serialize(value);
    if (data.byteLength > limits.maxEntryBytes || data.byteLength > limits.maxBytes) return false;
    const index = lookupKey(key);
    // Redelivery never extends retention or replaces a verified snapshot.
    if (findOriginal(key)) return false;
    while (cache.size >= limits.maxItems || bytes + data.byteLength > limits.maxBytes) drop(cache.keys().next().value);
    cache.set(index, { chat: key.remoteJid, id: key.id, author: key.participant || key.remoteJid, data,
      expiresAt: Math.min(time, numberOf(msg.messageTimestamp) * 1000) + limits.ttlMs });
    bytes += data.byteLength;
    return true;
  }
  function observeUpsert(payload) {
    if (!active || payload?.type !== "notify" || payload.requestId || !Array.isArray(payload.messages)) return;
    if (payload.messages.length > limits.maxBatch) { block(); return; }
    sweep();
    const folded = [];
    for (const msg of payload.messages.slice(0, limits.maxBatch)) {
      const protocol = msg?.message?.protocolMessage;
      if (protocol?.key?.id) {
        const chat = jid(msg?.key?.remoteJid);
        // Revoke and edit envelopes are invalidations, never new originals.
        if (chat && (!protocol.key.remoteJid || jid(protocol.key.remoteJid) === chat)) invalidate(chat, protocol.key.id);
      }
      remember(msg);
      if (Array.isArray(msg?.reactions)) {
        if (folded.length + msg.reactions.length > limits.maxBatch) { block(); return []; }
        for (const reaction of msg.reactions) folded.push({ key: msg.key, reaction });
      }
    }
    // Baileys can fold dedicated reactions into an original's buffered upsert.
    return observeReactions(folded);
  }
  function observeUpdates(updates) {
    if (!Array.isArray(updates)) return;
    if (updates.length > limits.maxBatch) { block(); return; }
    for (const item of updates.slice(0, limits.maxBatch)) {
      if (item?.key?.id && item.update && Object.hasOwn(item.update, "message")) invalidate(item.key.remoteJid, item.key.id);
    }
  }
  function observeDeletes(payload) {
    if (payload?.all === true) invalidate(payload.jid);
    else if (Array.isArray(payload?.keys)) {
      if (payload.keys.length > limits.maxBatch) { block(); return; }
      for (const key of payload.keys.slice(0, limits.maxBatch)) if (key?.id) invalidate(key.remoteJid, key.id);
    }
  }
  function reaction(entry) {
    if (!active || !self().length) return null;
    const originalKey = messageKey(entry?.key);
    const actorKey = messageKey(entry?.reaction?.key);
    const emoji = entry?.reaction?.text ?? "";
    const time = now();
    const timestampMs = numberOf(entry?.reaction?.senderTimestampMs);
    if (!originalKey || !actorKey || !sameIdentity(originalKey.remoteJid, actorKey.remoteJid) ||
      typeof emoji !== "string" || emoji.length > 32 ||
      (emoji && (!/^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3|[#*0-9])+$/u.test(emoji) ||
        !/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(emoji) ||
        [...graphemes.segment(emoji)].length !== 1)) ||
      !fresh(timestampMs, time) || !enabled(originalKey.remoteJid)) return null;
    const actor = actorKey.participant || actorKey.remoteJid;
    if (isSelf(actor) || isSelf(originalKey.participant || originalKey.remoteJid)) return null;
    sweep();
    if (invalidated(originalKey.remoteJid, originalKey.id)) return null;
    const stored = findOriginal(originalKey);
    if (!stored) return null;
    const account = self()[0];
    // Transport ids are account-wide. Conservatively refuse any reuse, even
    // across PN/LID chat aliases learned after the original claim.
    const eventKey = hash([account, actorKey.id]);
    const slotKeys = [];
    for (const chat of aliases(originalKey.remoteJid)) {
      for (const author of aliases(originalKey.participant || originalKey.remoteJid)) {
        for (const sender of aliases(actor)) slotKeys.push(hash([account, chat, originalKey.id, false, author, sender]));
      }
    }
    if (!slotKeys.length) return null;
    const type = store.claimReactionEvent({ eventKey, slotKeys, timestampMs, emoji,
      expiresAt: timestampMs + limits.ttlMs + limits.futureSkewMs }, time);
    if (!type) return null;
    // Data only. Future 07b must resolve current reactor permissions afresh.
    return { eventKey, type, emoji, timestampMs, actorKey,
      original: deserialize(stored.data) };
  }
  function observeReactions(entries) {
    if (!Array.isArray(entries)) return [];
    sweep();
    return entries.slice(0, limits.maxBatch).map(reaction).filter(Boolean);
  }
  function close() {
    closed = true; active = false;
    cache.clear(); bytes = 0;
    clearInterval(timer);
  }
  const timer = setInterval(() => {
    try { sweep(); }
    catch {
      close();
      logger.warn("[Reactions] lookup sweep failed; cached originals discarded");
    }
  }, 60_000);
  timer.unref?.();
  return {
    open() { if (!closed) active = true; },
    close, observeUpsert, observeUpdates, observeDeletes, observeReactions,
    // Resource counters only; no private cache contents in diagnostics.
    stats() { sweep(); return { items: cache.size, bytes }; },
  };
}

export function attachReactionIntake(sock) {
  disposeReactionIntake(sock);
  const intake = createReactionIntake(sock);
  sockets.set(sock, intake);
  return intake;
}
export function disposeReactionIntake(sock) {
  sockets.get(sock)?.close();
  sockets.delete(sock);
}
export function invalidateReactionMessage(sock, key) {
  sockets.get(sock)?.observeDeletes({ keys: [key] });
}
