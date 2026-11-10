// Core-owned Auto Reply intake and AI turn. The extension only considers a
// frozen event; this module owns forwarding, rate limits, the caller, and send.

const { visibleText, unwrapMessage } = require("../utils/messageContent.cjs");
const { isLinkedSelf, linkedIdentity } = require("../messaging/identity.cjs");
const { getSenderCandidates } = require("../utils/permissions.esm.js");
const normalizeJid = require("../utils/normalizeJid.cjs");

const MAX_TEXT = 4000;
const MAX_INSTRUCTIONS = 1000;
const PENDING_MAX = 50;
const PENDING_TTL_MS = 2 * 60 * 1000;
const GLOBAL_CONCURRENT = 2;
const CHAT_CONCURRENT = 1;
const CHAT_PER_MINUTE = 6;
const GLOBAL_PER_MINUTE = 30;
const WINDOW_MS = 60_000;
const AI_TIMEOUT_CAP_MS = 120_000;

const injected = {};
const pending = new Map();
const inflightAbort = new Set();
const chatInFlight = new Map();
let globalInFlight = 0;
const globalHits = [];
const chatHits = new Map();

function setAutoReplyDeps(partial) {
  Object.assign(injected, partial || {});
}

function resetAutoReplyDeps() {
  for (const key of Object.keys(injected)) delete injected[key];
  pending.clear();
  inflightAbort.clear();
  chatInFlight.clear();
  globalInFlight = 0;
  globalHits.length = 0;
  chatHits.clear();
}

function dep(name, loader) {
  if (Object.hasOwn(injected, name) && injected[name] != null) {
    return injected[name];
  }
  return loader();
}

function nowMs() {
  const fn = injected.now;
  return typeof fn === "function" ? fn() : Date.now();
}

function accountEpochNow() {
  const fn = injected.accountEpoch;
  if (typeof fn === "function") return fn();
  return require("../db/store.cjs").accountEpoch();
}

function withDeadline(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error("deadline");
      err.code = "DEADLINE";
      reject(err);
    }, ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function prunePending(now) {
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  while (pending.size > PENDING_MAX) {
    const oldest = pending.keys().next().value;
    pending.delete(oldest);
  }
}

function abortAccountJobs() {
  pending.clear();
  for (const controller of inflightAbort) {
    try {
      controller.abort();
    } catch {}
  }
  inflightAbort.clear();
}

function hasBotMetadata(msg) {
  const inner = unwrapMessage(msg?.message);
  if (!inner || typeof inner !== "object") return false;
  const top = inner.messageContextInfo;
  if (top?.botMetadata || top?.botMessageSecret) return true;
  for (const key of Object.keys(inner)) {
    const ctx = inner[key]?.contextInfo;
    if (!ctx) continue;
    if (
      ctx.botMetadata ||
      ctx.botMessageSecret ||
      ctx.botMessageSharingInfo ||
      ctx.botMessageInvokerJid
    ) {
      return true;
    }
  }
  return false;
}

function contextInfoOf(msg) {
  const inner = unwrapMessage(msg?.message);
  if (!inner || typeof inner !== "object") return null;
  for (const key of [
    "extendedTextMessage",
    "imageMessage",
    "videoMessage",
    "audioMessage",
    "documentMessage",
  ]) {
    if (inner[key]?.contextInfo) return inner[key].contextInfo;
  }
  return inner.messageContextInfo || null;
}

function inScope(chatJid, scope) {
  if (!scope || typeof scope.has !== "function") return false;
  if (scope.has(chatJid)) return true;
  const norm = normalizeJid(chatJid);
  return Boolean(norm) && scope.has(norm);
}

function pruneHits(list, now) {
  while (list.length && now - list[0] >= WINDOW_MS) list.shift();
  return list;
}

function admit(chatJid, now) {
  if (globalInFlight >= GLOBAL_CONCURRENT) return false;
  if ((chatInFlight.get(chatJid) || 0) >= CHAT_CONCURRENT) return false;
  pruneHits(globalHits, now);
  if (globalHits.length >= GLOBAL_PER_MINUTE) return false;
  let chatList = chatHits.get(chatJid);
  if (!chatList) {
    chatList = [];
    chatHits.set(chatJid, chatList);
  }
  pruneHits(chatList, now);
  if (chatList.length >= CHAT_PER_MINUTE) return false;
  return true;
}

function beginTurn(chatJid, now) {
  globalInFlight += 1;
  chatInFlight.set(chatJid, (chatInFlight.get(chatJid) || 0) + 1);
  globalHits.push(now);
  const chatList = chatHits.get(chatJid) || [];
  chatList.push(now);
  chatHits.set(chatJid, chatList);
}

function endTurn(chatJid) {
  globalInFlight = Math.max(0, globalInFlight - 1);
  const n = (chatInFlight.get(chatJid) || 1) - 1;
  if (n <= 0) chatInFlight.delete(chatJid);
  else chatInFlight.set(chatJid, n);
}

function anySignal(signals) {
  const controller = new AbortController();
  const onAbort = () => {
    try {
      controller.abort();
    } catch {}
  };
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      onAbort();
      return controller;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller;
}

function liveSignal(runtime) {
  return typeof runtime.signal === "function" ? runtime.signal() : runtime.signal;
}

async function ownRecent(msg) {
  const fn = injected.getMessageFromRecent;
  if (typeof fn === "function") return fn(msg.key);
  const cache = require("../utils/recentMessageCache.esm.js");
  return cache.getMessageFromRecent(msg.key);
}

function rosterHelpers() {
  return dep("groupMetadataCache", () => require("../utils/groupMetadataCache.cjs"));
}

async function runAiReply(runtime, job = {}) {
  const messageId = job?.messageId;
  const entry = messageId ? pending.get(messageId) : null;
  if (!entry) return { sent: false };
  pending.delete(messageId);

  const instructions = job.instructions == null ? "" : String(job.instructions);
  if (instructions.length > MAX_INSTRUCTIONS) return { sent: false };
  const quote = job.quote === true;
  const { sock, msg, event, epoch, generation } = entry;
  const chatJid = event.chatJid;
  const isGroup = event.isGroup;
  const started = nowMs();
  if (!admit(chatJid, started)) return { sent: false };
  if (typeof runtime.isActive === "function" && !runtime.isActive()) return { sent: false };
  if (typeof runtime.generation === "function" && runtime.generation() !== generation) {
    return { sent: false };
  }
  if (accountEpochNow() !== epoch) return { sent: false };

  beginTurn(chatJid, started);
  const jobAbort = new AbortController();
  inflightAbort.add(jobAbort);
  const timeoutMs = Math.max(
    1,
    Math.min(
      AI_TIMEOUT_CAP_MS,
      Number(
        dep(
          "settingsGet",
          () => (key) => require("../config/settings.cjs").get(key),
        )("ai_tool_timeout_ms"),
      ) || 30_000,
    ),
  );
  const timeoutAbort = new AbortController();
  const timer = setTimeout(() => timeoutAbort.abort(), timeoutMs);
  const combined = anySignal([liveSignal(runtime), jobAbort.signal, timeoutAbort.signal]);

  try {
    if (combined.signal.aborted) return { sent: false };

    const cache = rosterHelpers();
    let groupMetadata = null;
    let rosterVersion;
    if (isGroup) {
      groupMetadata = await cache.resolveGroupMetadata(sock, chatJid, { fresh: true });
      rosterVersion = cache.getRosterVersion(chatJid);
    }

    const resolveCaller = dep(
      "resolveCaller",
      () => require("../services/aiToolAuth.cjs").resolveCaller,
    );
    const caller = await resolveCaller({
      msg,
      sock,
      groupMetadata,
      accountEpoch: epoch,
      rosterVersion,
      text: event.text,
    });

    const runAgent = dep("runAgent", () => require("../services/aiAgent.cjs").runAgent);
    const parts = [{ text: event.text }];
    if (instructions) parts.push({ text: instructions });
    const includeGlobalMemory = Boolean(caller.isOwner && !caller.isGroup);
    const result = await runAgent({
      parts,
      history: [],
      status: null,
      signal: combined.signal,
      context: {
        caller,
        sock,
        chatId: chatJid,
        senderId: caller.senderId,
        senderName: caller.senderName,
        isOwner: caller.isOwner,
        isAdmin: caller.isOwner || caller.isBotAdmin,
        isGroup: caller.isGroup,
        chatName: caller.chatName,
        includeGlobalMemory,
      },
    });

    let text = String(result?.text || "").trim();
    if (!text) return { sent: false };
    if (result?.sources?.length) {
      try {
        const { formatSources } = require("../services/aiAgent.cjs");
        text = `${text}${formatSources(result.sources)}`;
      } catch {}
    }
    try {
      const { formatMarkdownForWhatsApp } = require("../utils/markdownParser.cjs");
      text = formatMarkdownForWhatsApp(text);
    } catch {}

    const sendBotMessage = dep(
      "sendBotMessage",
      () => require("../utils/sendBotMessage.cjs").sendBotMessage,
    );
    const deliveryGuard = {
      async refresh() {
        if (!isGroup) return;
        await rosterHelpers().resolveGroupMetadata(sock, chatJid, { fresh: true });
      },
      assert() {
        combined.signal.throwIfAborted?.();
        if (combined.signal.aborted) throw new Error("aborted");
        if (accountEpochNow() !== epoch) throw new Error("epoch");
        if (typeof runtime.generation === "function" && runtime.generation() !== generation) {
          throw new Error("generation");
        }
        if (typeof runtime.isActive === "function" && !runtime.isActive())
          throw new Error("inactive");
        if (isGroup && rosterHelpers().isRosterStale(chatJid)) throw new Error("roster");
      },
    };

    await sendBotMessage(
      sock,
      chatJid,
      { text },
      {
        replyTo: msg,
        quote,
        typing: false,
        delayMs: 0,
        signal: combined.signal,
        deliveryGuard,
      },
    );
    return { sent: true };
  } catch {
    return { sent: false };
  } finally {
    clearTimeout(timer);
    inflightAbort.delete(jobAbort);
    endTurn(chatJid);
  }
}

async function dispatch(runtime, sock, msg, epoch) {
  if (!runtime || typeof runtime.isActive !== "function" || !runtime.isActive()) return;
  if (typeof runtime.consider !== "function") return;
  if (msg?.key?.fromMe !== false) return;
  const chatJid = msg.key.remoteJid;
  if (!chatJid || chatJid.endsWith("@broadcast") || chatJid.endsWith("@newsletter")) return;
  if (accountEpochNow() !== epoch) return;

  try {
    if (await ownRecent(msg)) return;
  } catch {
    return;
  }

  if (hasBotMetadata(msg)) return;

  const identity =
    typeof injected.linkedIdentity === "function" ? injected.linkedIdentity() : linkedIdentity();
  const selfCheck =
    typeof injected.isLinkedSelf === "function" ? injected.isLinkedSelf : isLinkedSelf;
  const candidates = getSenderCandidates(msg, sock) || [];
  if (candidates.some((id) => selfCheck(id, identity))) return;

  const scope = typeof runtime.getScope === "function" ? runtime.getScope() : null;
  if (!inScope(chatJid, scope)) return;

  const text = String(visibleText(msg.message) || "").trim();
  if (!text || text.length > MAX_TEXT) return;

  const messageId = msg.key.id;
  if (typeof messageId !== "string" || !messageId) return;

  const ctxInfo = contextInfoOf(msg);
  const mentioned = Array.isArray(ctxInfo?.mentionedJid) ? ctxInfo.mentionedJid : [];
  const mentionsMe = mentioned.some((jid) => selfCheck(jid, identity));
  const quotesMe = Boolean(ctxInfo?.participant && selfCheck(ctxInfo.participant, identity));

  const event = Object.freeze({
    chatJid,
    isGroup: chatJid.endsWith("@g.us"),
    sender: Object.freeze({
      primary: candidates[0] || null,
      candidates: Object.freeze([...candidates]),
    }),
    text,
    messageId,
    timestamp: Number(msg.messageTimestamp) || nowMs(),
    mentionsMe,
    quotesMe,
  });

  const generation = typeof runtime.generation === "function" ? runtime.generation() : 0;
  const t = nowMs();
  prunePending(t);
  pending.set(messageId, {
    sock,
    msg,
    event,
    epoch,
    generation,
    expiresAt: t + PENDING_TTL_MS,
  });
  prunePending(t);

  let decision;
  try {
    const timeout =
      typeof runtime.considerTimeoutMs === "function" ? runtime.considerTimeoutMs() : 2000;
    decision = await withDeadline(
      runtime.consider(event, { signal: liveSignal(runtime) }),
      timeout,
    );
  } catch (error) {
    pending.delete(messageId);
    try {
      runtime.recordFailure?.(error);
    } catch {}
    return;
  }

  if (decision?.reply !== true) {
    pending.delete(messageId);
    return;
  }
  if (decision.instructions != null && String(decision.instructions).length > MAX_INSTRUCTIONS) {
    pending.delete(messageId);
    return;
  }

  await runAiReply(runtime, {
    messageId,
    instructions: decision.instructions,
    quote: decision.quote === true,
  });
}

module.exports = {
  dispatch,
  runAiReply,
  abortAccountJobs,
  setAutoReplyDeps,
  resetAutoReplyDeps,
};
