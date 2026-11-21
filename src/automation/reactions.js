// Bounded verified transport intake. Execution belongs to engine.js.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { deserialize, serialize } from "node:v8";
import { sameUser } from "../utils/permissions.esm.js";
import { isOutboundId } from "../utils/recentMessageCache.esm.js";

const require = createRequire(import.meta.url);
const store = require("../db/store.cjs");
const { linkedIdentity } = require("../messaging/identity.cjs");
const { canonicalJid } = require("../messaging/router.cjs");
const { isReactionEmoji } = require("./rules.cjs");
const { MAX_IDENTITY_ALIASES } = require("./limits.cjs");
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
const jidPattern =
  /^(?:\d{1,30}(?::\d{1,5})?@(s\.whatsapp\.net|lid|g\.us)|\d{1,30}-\d{1,30}@g\.us)$/;
const mediaFields = [
  "url",
  "directPath",
  "mediaKey",
  "fileEncSha256",
  "fileSha256",
  "fileLength",
  "mimetype",
  "seconds",
  "ptt",
  "width",
  "height",
  "caption",
  "fileName",
];
const contentKeys = [
  "conversation",
  "extendedTextMessage",
  "audioMessage",
  "imageMessage",
  "videoMessage",
  "documentMessage",
  "stickerMessage",
];
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const numberOf = (value) => (value == null ? NaN : Number(String(value)));

// Validate BEFORE normalization; normalizeJid deliberately accepts legacy inputs.
function jid(value) {
  if (typeof value !== "string" || !jidPattern.test(value)) return null;
  if (value.endsWith("@g.us") && value.includes(":")) return null;
  return canonicalJid(value);
}
function aliases(value) {
  const ids = store.reactionIdentityAliases(value);
  return ids.length <= MAX_IDENTITY_ALIASES && ids.every((id) => jid(id)) ? ids : [];
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
function linkedIdsFor(sock) {
  const ids = [];
  const add = (value) => {
    const id = user(value);
    if (id && !ids.includes(id)) ids.push(id);
  };
  add(sock?.user?.id);
  add(sock?.user?.lid);
  try {
    const linked = linkedIdentity();
    add(linked.phone);
    add(linked.lid);
    for (const id of linked.selfJids || []) add(id);
  } catch {
    // A live socket identity still counts when the credential row is unreadable.
  }
  return ids;
}
function isLinkedActor(sock, author) {
  return linkedIdsFor(sock).some((id) => sameIdentity(id, author));
}
// Baileys alts on this event are verified for this stanza only. They are not stored.
function expand(primary, alts) {
  const base = aliases(primary);
  if (!base.length) return [];
  const out = [...base];
  const list = Array.isArray(alts) ? alts : alts == null ? [] : [alts];
  for (const alt of list) {
    const extra = user(alt);
    if (!extra || out.includes(extra)) continue;
    const counterpart =
      sameIdentity(primary, extra) ||
      (String(primary).endsWith("@lid") && extra.endsWith("@s.whatsapp.net")) ||
      (String(primary).endsWith("@s.whatsapp.net") && extra.endsWith("@lid"));
    if (!counterpart) continue;
    out.push(extra);
  }
  return out.length <= MAX_IDENTITY_ALIASES ? out : [];
}
function cleanPushName(entry) {
  const raw =
    typeof entry?.reaction?.pushName === "string" ? entry.reaction.pushName : entry?.pushName;
  if (typeof raw !== "string" || raw.length < 1 || raw.length > 128) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: a push name with control characters is refused.
  if (/[\u0000-\u001F\u007F]/.test(raw)) return undefined;
  return raw;
}
function messageKey(key, sock, enforce) {
  const chat = jid(key?.remoteJid);
  if (
    !chat ||
    key?.isViewOnce ||
    typeof key?.id !== "string" ||
    !idPattern.test(key.id) ||
    (key?.fromMe !== true && key?.fromMe !== false) ||
    isOutboundId(key.id)
  )
    return null;
  const fromMe = key.fromMe === true;
  const group = chat.endsWith("@g.us");
  // A DM alt that is missing, not a user JID, or not part of this chat's
  // verified expansion is an unresolved PN/LID identity.
  if (!group && key?.remoteJidAlt != null) {
    const expanded = expand(chat, key.remoteJidAlt);
    const alt = user(key.remoteJidAlt);
    if (!expanded.length || !alt || !expanded.includes(alt)) return null;
  }
  let author;
  let participant;
  if (fromMe) {
    // The phone's own echo. remoteJid in a DM is the peer, never the reactor.
    const linked = linkedIdsFor(sock);
    if (!linked.length) return null;
    if (group) {
      const stated = key.participant ? user(key.participant) : null;
      if (key.participant && (!stated || !isLinkedActor(sock, stated))) return null;
      author = stated || linked[0];
      participant = author;
    } else {
      if (key.participant) {
        const stated = user(key.participant);
        if (!stated || !isLinkedActor(sock, stated)) return null;
      }
      author = linked[0];
    }
  } else {
    author = group ? user(key.participant) : chat;
    if (!author || (key.participant && !sameIdentity(author, user(key.participant)))) return null;
    // fromMe false naming the linked account is a forged echo, not a phone send.
    if (isLinkedActor(sock, author)) return null;
    if (group) participant = author;
  }
  const linked = fromMe || isLinkedActor(sock, author);
  if (enforce && linked) {
    const stamp = enforce.timestampMs;
    if (enforce.inbound !== true || !Number.isSafeInteger(stamp) || stamp < enforce.connectionAt)
      return null;
  }
  return {
    remoteJid: chat,
    id: key.id,
    fromMe,
    ...(participant ? { participant } : {}),
    author,
  };
}
const identityOf = (key) => [key.remoteJid, key.id, key.fromMe, key.participant || key.remoteJid];
const lookupKey = (key) => JSON.stringify(identityOf(key));
const invalidationKeys = (chat, id = "*") => aliases(chat).map((alias) => hash([alias, id]));

function safeContent(message) {
  // Disappearing, view-once and edited content is deliberately unsupported.
  let inner = message;
  if (inner?.documentWithCaptionMessage?.message) inner = inner.documentWithCaptionMessage.message;
  if (
    !inner ||
    Object.keys(inner).some(
      (key) =>
        !contentKeys.includes(key) &&
        !["messageContextInfo", "senderKeyDistributionMessage"].includes(key),
    )
  )
    return null;
  const keys = contentKeys.filter((key) => inner[key] != null);
  if (keys.length !== 1) return null;
  const key = keys[0];
  const source = inner[key];
  if (
    inner.messageContextInfo?.botMetadata ||
    inner.messageContextInfo?.botMessageSecret ||
    source?.contextInfo?.botMessageSharingInfo ||
    source?.contextInfo?.botMessageInvokerJid
  )
    return null;
  if (source?.viewOnce || source?.contextInfo?.expiration || inner.messageContextInfo?.expiration)
    return null;
  if (key === "conversation")
    return typeof source === "string" && source.length <= 65536 ? { conversation: source } : null;
  if (key === "extendedTextMessage") {
    return typeof source?.text === "string" && source.text.length <= 65536
      ? { extendedTextMessage: { text: source.text } }
      : null;
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
      if (typeof value !== "string" || value.length > (field === "caption" ? 65536 : 4096))
        return null;
      media[field] = value;
    }
  }
  return { [key]: media };
}

/** One bounded lookup per live socket. Timers/closures are disposed with it. */
export function createReactionIntake(
  sock,
  {
    now = Date.now,
    limits = REACTION_LIMITS,
    onTransition = () => {},
    onInvalidate = () => {},
    onClose = () => {},
  } = {},
) {
  const cache = new Map();
  const verified = new WeakMap();
  // Transport id -> "notify" | "append". Notify is never downgraded.
  const provenance = new Map();
  let bytes = 0;
  let active = false;
  let closed = false;
  let connectionAt = Infinity;
  function noteProvenance(id, type) {
    if (typeof id !== "string" || !idPattern.test(id)) return;
    if (type !== "notify" && type !== "append") return;
    if (provenance.get(id) === "notify") return;
    if (provenance.has(id)) provenance.delete(id);
    provenance.set(id, type);
    while (provenance.size > limits.maxItems) provenance.delete(provenance.keys().next().value);
  }
  function block() {
    cache.clear();
    provenance.clear();
    bytes = 0;
    onInvalidate();
    store.invalidateReactionLookup(null, now() + limits.ttlMs + limits.futureSkewMs, now());
  }
  const enabled = (chat) => aliases(chat).some((id) => store.isReactionChatEnabled(id));
  const fresh = (timestamp, time) =>
    Number.isSafeInteger(timestamp) &&
    timestamp > time - limits.ttlMs &&
    timestamp <= time + limits.futureSkewMs;

  function drop(key) {
    const entry = cache.get(key);
    if (entry) bytes -= entry.size;
    cache.delete(key);
    if (entry) onInvalidate(entry.chat, entry.id);
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
    return (
      !ids.length ||
      store.isReactionLookupInvalidated(
        [...invalidationKeys(chat), ...invalidationKeys(chat, id)],
        now(),
      )
    );
  }
  function invalidate(chatValue, id) {
    const chat = jid(chatValue);
    if (!active || !chat) return;
    onInvalidate(chat, id);
    // A configured but disabled chat still needs negative lookup state: a
    // delete during disablement must not revive when the rule is re-enabled.
    const tracked = [...cache.values()].some((entry) => sameIdentity(entry.chat, chat));
    if (!tracked && !aliases(chat).some((alias) => store.isReactionChatConfigured(alias))) return;
    sweep();
    for (const [key, entry] of cache) {
      if (sameIdentity(entry.chat, chat) && (!id || entry.id === id)) drop(key);
    }
    const keys = invalidationKeys(chat, id);
    const blocked = store.invalidateReactionLookup(
      keys.length ? keys : null,
      now() + limits.ttlMs + limits.futureSkewMs,
      now(),
      limits.maxItems,
    );
    if (blocked) {
      cache.clear();
      bytes = 0;
    }
  }
  function findOriginal(key) {
    const exact = cache.get(lookupKey(key));
    if (exact) return exact;
    const wanted = key.fromMe === true;
    const author = key.author || key.participant || key.remoteJid;
    return [...cache.values()].find(
      (entry) =>
        entry.id === key.id &&
        entry.fromMe === wanted &&
        sameIdentity(entry.chat, key.remoteJid) &&
        sameIdentity(entry.author, author),
    );
  }
  function remember(msg) {
    if (!active || !linkedIdsFor(sock).length) return false;
    const stamp = numberOf(msg.messageTimestamp) * 1000;
    const key = messageKey(msg?.key, sock, {
      inbound: true,
      timestampMs: stamp,
      connectionAt,
    });
    const time = now();
    if (!key || !enabled(key.remoteJid)) return false;
    sweep();
    if (
      invalidated(key.remoteJid, key.id) ||
      !fresh(numberOf(msg.messageTimestamp) * 1000, time) ||
      msg.messageStubType != null ||
      numberOf(msg.ephemeralStartTimestamp) > 0 ||
      numberOf(msg.ephemeralDuration) > 0
    )
      return false;
    const content = safeContent(msg.message);
    if (!content) return false;
    const value = { key, message: content, messageTimestamp: numberOf(msg.messageTimestamp) };
    const data = serialize(value);
    if (data.byteLength > limits.maxEntryBytes || data.byteLength > limits.maxBytes) return false;
    const index = lookupKey(key);
    // Redelivery never extends retention or replaces a verified snapshot.
    if (findOriginal(key)) return false;
    const configurationRevision = store.getBotSetting("reaction:revision", "");
    const size = data.byteLength + serialize(configurationRevision).byteLength;
    if (size > limits.maxEntryBytes || size > limits.maxBytes) return false;
    while (cache.size >= limits.maxItems || bytes + size > limits.maxBytes)
      drop(cache.keys().next().value);
    cache.set(index, {
      chat: key.remoteJid,
      id: key.id,
      author: key.author || key.participant || key.remoteJid,
      fromMe: key.fromMe === true,
      data,
      receivedAt: time,
      configurationRevision,
      size,
      expiresAt: Math.min(time, numberOf(msg.messageTimestamp) * 1000) + limits.ttlMs,
    });
    bytes += size;
    return true;
  }
  function observeUpsert(payload) {
    if (!active || payload?.requestId || !Array.isArray(payload.messages)) return;
    const type = payload?.type;
    // Live messages are notify. The phone's own offline echo is append.
    if (type !== "notify" && type !== "append") return;
    if (payload.messages.length > limits.maxBatch) {
      block();
      return;
    }
    sweep();
    const folded = [];
    for (const msg of payload.messages.slice(0, limits.maxBatch)) {
      if (typeof msg?.key?.id === "string") noteProvenance(msg.key.id, type);
      const protocol = msg?.message?.protocolMessage;
      if (protocol?.key?.id) {
        const chat = jid(msg?.key?.remoteJid);
        // Revoke and edit envelopes are invalidations, never new originals.
        if (chat && (!protocol.key.remoteJid || jid(protocol.key.remoteJid) === chat))
          invalidate(chat, protocol.key.id);
      }
      // Live server delivery is notify. append is a local echo or history
      // replay and is never an original, including the linked account's.
      if (type !== "notify") continue;
      remember(msg);
      if (Array.isArray(msg?.reactions)) {
        if (folded.length + msg.reactions.length > limits.maxBatch) {
          block();
          return [];
        }
        for (const reaction of msg.reactions) folded.push({ key: msg.key, reaction });
      }
    }
    // Baileys can fold dedicated reactions into an original's buffered upsert.
    return observeReactions(folded, type === "notify" ? "notify" : undefined);
  }
  function observeUpdates(updates) {
    if (!Array.isArray(updates)) return;
    if (updates.length > limits.maxBatch) {
      block();
      return;
    }
    for (const item of updates.slice(0, limits.maxBatch)) {
      if (item?.key?.id && item.update && Object.hasOwn(item.update, "message"))
        invalidate(item.key.remoteJid, item.key.id);
    }
  }
  function observeDeletes(payload) {
    if (payload?.all === true) invalidate(payload.jid);
    else if (Array.isArray(payload?.keys)) {
      if (payload.keys.length > limits.maxBatch) {
        block();
        return;
      }
      for (const key of payload.keys.slice(0, limits.maxBatch))
        if (key?.id) invalidate(key.remoteJid, key.id);
    }
  }
  function reaction(entry, sourceType) {
    if (!active || !linkedIdsFor(sock).length) return null;
    // The original was vetted when it was cached. Re-checking its provenance
    // here would drop it. Outbound ids are still rejected.
    const originalKey = messageKey(entry?.key, sock);
    const actorId = entry?.reaction?.key?.id;
    const noted = typeof actorId === "string" ? provenance.get(actorId) : undefined;
    const inbound = sourceType === "notify" || noted === "notify";
    const timestampMs = numberOf(entry?.reaction?.senderTimestampMs);
    const actorKey = messageKey(entry?.reaction?.key, sock, {
      inbound,
      timestampMs,
      connectionAt,
    });
    const emoji = entry?.reaction?.text ?? "";
    const time = now();
    if (
      !originalKey ||
      !actorKey ||
      !sameIdentity(originalKey.remoteJid, actorKey.remoteJid) ||
      typeof emoji !== "string" ||
      emoji.length > 32 ||
      (emoji && !isReactionEmoji(emoji)) ||
      !fresh(timestampMs, time) ||
      !enabled(originalKey.remoteJid)
    )
      return null;
    const actor = actorKey.author || actorKey.participant || actorKey.remoteJid;
    sweep();
    if (invalidated(originalKey.remoteJid, originalKey.id)) return null;
    const stored = findOriginal(originalKey);
    if (!stored) return null;
    const account = linkedIdsFor(sock)[0];
    // Transport ids are account-wide. Conservatively refuse any reuse, even
    // across PN/LID chat aliases learned after the original claim.
    const eventKey = hash([account, actorKey.id]);
    const chatIds = expand(originalKey.remoteJid, entry?.key?.remoteJidAlt);
    const authorIds = expand(
      originalKey.author || originalKey.participant || originalKey.remoteJid,
      [
        entry?.key?.participantAlt,
        originalKey.remoteJid.endsWith("@g.us") ? null : entry?.key?.remoteJidAlt,
      ],
    );
    const actorIds = expand(actor, [
      entry?.reaction?.key?.participantAlt,
      entry?.reaction?.key?.remoteJidAlt,
    ]);
    if (!chatIds.length || !authorIds.length || !actorIds.length) return null;
    const slotKeys = [];
    for (const chat of chatIds) {
      for (const authorId of authorIds) {
        for (const sender of actorIds)
          slotKeys.push(
            hash([account, chat, originalKey.id, originalKey.fromMe === true, authorId, sender]),
          );
      }
    }
    if (!slotKeys.length) return null;
    const transition = store.claimReactionEvent(
      {
        eventKey,
        slotKeys,
        timestampMs,
        emoji,
        expiresAt: timestampMs + limits.ttlMs + limits.futureSkewMs,
      },
      time,
      true,
    );
    if (!transition) return null;
    const pushName = cleanPushName(entry);
    const value = {
      eventKey,
      ...transition,
      emoji,
      timestampMs,
      actorKey,
      original: deserialize(stored.data),
      receivedAt: stored.receivedAt,
      configurationRevision: stored.configurationRevision,
      connectionAt,
      slotKeys,
      authorAliases: authorIds,
      ...(pushName ? { pushName } : {}),
    };
    verified.set(value, { stored, data: serialize(value) });
    onTransition(value);
    return value;
  }
  function observeReactions(entries, sourceType) {
    if (!Array.isArray(entries)) return [];
    sweep();
    return entries
      .slice(0, limits.maxBatch)
      .map((entry) => reaction(entry, sourceType))
      .filter(Boolean);
  }
  function close() {
    closed = true;
    active = false;
    cache.clear();
    provenance.clear();
    bytes = 0;
    onClose();
    clearInterval(timer);
  }
  const timer = setInterval(() => {
    try {
      sweep();
    } catch {
      close();
      logger.warn("[Reactions] lookup sweep failed; cached originals discarded");
    }
  }, 60_000);
  timer.unref?.();
  return {
    open() {
      if (!closed && !active) {
        active = true;
        connectionAt = now();
      }
    },
    close,
    observeUpsert,
    observeUpdates,
    observeDeletes,
    observeReactions,
    resetLookup() {
      for (const key of cache.keys()) drop(key);
    },
    resolveTransition(value) {
      const record = verified.get(value);
      if (
        !active ||
        !record ||
        record.stored.expiresAt <= now() ||
        !enabled(record.stored.chat) ||
        invalidated(record.stored.chat, record.stored.id) ||
        findOriginal(deserialize(record.stored.data).key) !== record.stored
      )
        return null;
      return deserialize(record.data);
    },
    // Resource counters only; no private cache contents in diagnostics.
    stats() {
      sweep();
      return { items: cache.size, bytes };
    },
  };
}

export function attachReactionIntake(sock, options) {
  disposeReactionIntake(sock);
  const intake = createReactionIntake(sock, options);
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
