// Free Core reaction actions. One winner, no waiting queue, no automatic retry.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { attachReactionIntake, REACTION_LIMITS } from "./reactions.js";
import {
  resolveVerifiedSender,
  verifiedIdentityAliases,
  verifiedParticipant,
} from "../middleware/permissions.middleware.js";

const require = createRequire(import.meta.url);
const store = require("../db/store.cjs");
const runtime = require("../config/runtime-config.cjs");
const settings = require("../config/settings.cjs");
const { evaluatePermissionLevel } = require("../utils/permissionLevel.cjs");
const { planDelivery, canonicalJid } = require("../messaging/router.cjs");
const { linkedIdentity } = require("../messaging/identity.cjs");
const { validateDefinition, originalType } = require("./rules.cjs");
const { assertWhatsAppAudio, assertAudio, MAX_MEDIA_BYTES } = require("../services/aiMedia.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const { withLang, langForCommand, t } = require("../utils/i18n.cjs");
const logger = require("../utils/logger.cjs");
const hash = (...values) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) => a === b || verifiedIdentityAliases(a).includes(canonicalJid(b));
const actorOf = (key) => key.participant || key.remoteJid;
// Across socket generations too: an ignored cancellation must not free a slot.
const inFlight = new Set();
const OUTCOMES = new Set([
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
]);

function senderMatches(definition, sender) {
  const { role, ids } = definition.senders;
  if (ids.length && !ids.some((id) => same(sender.senderId, id))) return false;
  return (
    role === "any" ||
    (role === "owner" && sender.isOwner) ||
    (role === "bot_admin" && (sender.isOwner || sender.isBotAdmin)) ||
    (role === "group_admin" && sender.isGroupAdmin) ||
    (role === "member" && !sender.isOwner && !sender.isBotAdmin && !sender.isGroupAdmin)
  );
}

export function createReactionAutomation(sock, { now = Date.now } = {}) {
  const active = new Set();
  let closed = false;
  let lastCode = null;
  let completed = 0;
  const outcome = (code) => {
    lastCode = code;
    completed++;
    logger.debug({ code }, "[Reactions] action outcome");
  };
  const cancel = (predicate = () => true) => {
    for (const job of active)
      if (predicate(job)) job.controller.abort(new Error("REACTION_CANCELLED"));
  };
  const intake = attachReactionIntake(sock, {
    now,
    onTransition: submit,
    onInvalidate: (chat, id) =>
      cancel(
        (job) =>
          !chat ||
          (same(job.event.original.key.remoteJid, chat) &&
            (!id || job.event.original.key.id === id)),
      ),
    onClose: () => close(),
  });
  const unsubscribe = store.subscribeReactionChanges((change) => {
    cancel();
    if (change.type === "rule" || change.key === "reaction:enabled") intake.resetLookup();
  });
  function close() {
    if (closed) return;
    closed = true;
    cancel();
    unsubscribe();
    intake.close();
  }
  function available(job) {
    job.controller.signal.throwIfAborted();
    if (
      closed ||
      store.getBotSetting("reaction:enabled", false) !== true ||
      job.event.configurationRevision !== store.getBotSetting("reaction:revision", "") ||
      !intake.resolveTransition(job.token)
    )
      fail("REACTION_CANCELLED");
    const time = now();
    if (
      job.event.timestampMs <= time - REACTION_LIMITS.ttlMs ||
      job.event.original.messageTimestamp * 1000 <= time - REACTION_LIMITS.ttlMs
    )
      fail("REACTION_STALE");
    if (job.rule) {
      const current = store.getReactionRule(job.rule.id);
      if (
        !current?.enabled ||
        current.revision !== job.rule.revision ||
        current.definition !== job.rule.definition ||
        current.chat_jid !== job.rule.chat_jid ||
        current.enabled_at !== job.rule.enabled_at
      )
        fail("REACTION_CANCELLED");
    }
  }
  async function refresh(job) {
    available(job);
    const chat = job.event.original.key.remoteJid;
    if (chat.endsWith("@g.us")) {
      const metadata = await sock.groupMetadata(chat);
      available(job);
      if (
        canonicalJid(metadata?.id) !== chat ||
        !Array.isArray(metadata.participants) ||
        metadata.participants.length > 5000
      )
        fail("REACTION_INACCESSIBLE");
      job.metadata = metadata;
    }
  }
  function sender(job) {
    available(job);
    const event = job.event;
    const subject = resolveVerifiedSender({ key: event.actorKey }, job.metadata, sock);
    if (subject.isGroup) {
      if (
        !verifiedParticipant(job.metadata, subject.senderId) ||
        !verifiedParticipant(job.metadata, actorOf(event.original.key)) ||
        ![sock?.user?.id, sock?.user?.lid].some((id) => verifiedParticipant(job.metadata, id))
      )
        fail("REACTION_INACCESSIBLE");
      const blacklist = store.getGroupSettings(event.original.key.remoteJid).blacklist || [];
      if (
        !Array.isArray(blacklist) ||
        (blacklist.some((id) => same(subject.senderId, id)) && !subject.isGroupAdmin)
      )
        fail("REACTION_FORBIDDEN");
    }
    return subject;
  }
  function authorize(job) {
    const subject = sender(job);
    if (
      !senderMatches(job.definition, subject) ||
      runtime.isDisabled(job.definition.action) ||
      !evaluatePermissionLevel(runtime.getPermission(job.definition.action), subject).hasPermission
    )
      fail("REACTION_FORBIDDEN");
    if (job.definition.action === "stt" && !settings.get("ai_stt_enabled"))
      fail("REACTION_STT_DISABLED");
    return subject;
  }
  function delivery(job) {
    authorize(job);
    const source = job.event.original.key.remoteJid;
    const mode = job.definition.destination.mode;
    const result = planDelivery({
      sourceJid: source,
      requestedJid: source,
      senderJid: actorOf(job.event.actorKey),
      commandName: job.definition.action,
      routeMode: mode,
      sensitivity: "source",
      identity: mode === "same_chat" ? { selfJids: [] } : linkedIdentity(),
    });
    if (!result.allow || !result.destination) fail("REACTION_DELIVERY_REFUSED");
    return result;
  }
  async function send(job, content) {
    await refresh(job);
    const planned = delivery(job);
    const guard = {
      refresh: () => refresh(job),
      assert: () => {
        const final = delivery(job);
        if (final.destination !== planned.destination || final.quote !== planned.quote)
          fail("REACTION_DELIVERY_REFUSED");
      },
    };
    const result = await sendBotMessage(sock, planned.destination, content, {
      signal: job.controller.signal,
      deliveryGuard: guard,
      replyTo: planned.quote ? job.event.original : null,
      quote: planned.quote,
    });
    if (!result?.key || result.refused) fail("REACTION_DELIVERY_REFUSED");
  }
  function candidatesFor(event) {
    const candidates = [];
    const rows = store.reactionRulesForChats(
      store.reactionIdentityAliases(event.original.key.remoteJid),
      {
        emoji: event.type === "remove" ? event.previousEmoji : event.emoji,
        type: event.type,
        originalType: originalType(event.original),
      },
    );
    if (rows.length > 100) fail("REACTION_CAPACITY");
    for (const row of rows) {
      let definition;
      try {
        definition = validateDefinition(JSON.parse(row.definition));
      } catch {
        continue;
      }
      if (
        event.configurationRevision !== store.getBotSetting("reaction:revision", "") ||
        !Number.isSafeInteger(row.enabled_at) ||
        event.receivedAt <= row.enabled_at ||
        event.original.messageTimestamp * 1000 <= Math.max(row.enabled_at, event.connectionAt) ||
        event.original.messageTimestamp * 1000 > event.receivedAt ||
        event.timestampMs <= row.enabled_at ||
        !definition.transitions.includes(event.type) ||
        definition.emoji !== (event.type === "remove" ? event.previousEmoji : event.emoji) ||
        !definition.originalTypes.includes(originalType(event.original))
      )
        continue;
      candidates.push({ row, definition });
    }
    return candidates;
  }
  async function execute(job) {
    await refresh(job);
    const subject = sender(job);
    const event = job.event;
    for (const candidate of job.candidates) {
      if (!senderMatches(candidate.definition, subject)) continue;
      job.rule = candidate.row;
      job.definition = candidate.definition;
      break;
    }
    if (!job.rule) return "NO_MATCH";
    authorize(job);
    delivery(job);
    const budgets = [{ key: hash("rule", job.rule.id), limit: 5 }];
    const claimed = store.claimReactionExecution(
      {
        eventKey: event.eventKey,
        ruleKey: hash(event.eventKey, job.rule.id, job.rule.revision),
        actionKey: hash(event.eventKey, job.definition.action, job.definition.destination),
        expiresAt: event.timestampMs + REACTION_LIMITS.ttlMs + REACTION_LIMITS.futureSkewMs,
        budgets,
      },
      now(),
    );
    if (claimed !== "CLAIMED") return claimed;
    // No await separates the live authorization check and action invocation.
    authorize(job);
    const command =
      job.definition.action === "ping"
        ? require("../commands/ping.cjs")
        : require("../commands/stt.cjs");
    return withLang(langForCommand(command), async () => {
      if (job.definition.action === "ping") {
        await require("../commands/ping.cjs").execute(
          { sendMessage: (_jid, content) => send(job, content) },
          event.original,
        );
      } else {
        const audio = event.original.message.audioMessage;
        assertWhatsAppAudio(audio);
        if (audio.ptt !== true) fail("REACTION_VOICE_REQUIRED");
        const stt = require("../commands/stt.cjs");
        if (!settings.get(`${stt.resolveSttProvider()}_api_key`)) fail("STT_KEY_REQUIRED");
        const bytes = await require("../utils/geminiMedia.cjs").downloadMedia(
          require("@whiskeysockets/baileys").downloadContentFromMessage,
          audio,
          "audio",
          { maxBytes: MAX_MEDIA_BYTES, signal: job.controller.signal },
        );
        await refresh(job);
        authorize(job);
        assertAudio(bytes, audio.mimetype, true);
        const text = await stt.transcribe(bytes, audio.mimetype, { signal: job.controller.signal });
        authorize(job);
        if (typeof text !== "string" || !text.trim() || text.length > 12000)
          fail("STT_OUTPUT_INVALID");
        await send(job, { text: t("bot.ai.stt.transcript", { transcription: text }) });
      }
      return "DELIVERED";
    });
  }
  function submit(token) {
    const event = intake.resolveTransition(token);
    if (!event || closed || store.getBotSetting("reaction:enabled", false) !== true) return;
    let candidates;
    try {
      candidates = candidatesFor(event);
    } catch {
      outcome("REACTION_CAPACITY");
      return;
    }
    if (!candidates.length) {
      outcome("NO_MATCH");
      return;
    }
    if (
      inFlight.size >= 2 ||
      [...inFlight].some((job) => same(actorOf(job.event.actorKey), actorOf(event.actorKey)))
    ) {
      outcome("BUSY");
      return;
    }
    const actor = verifiedIdentityAliases(actorOf(event.actorKey));
    const budgets = [
      ...actor.map((id) => ({ key: hash("actor", id), limit: 3 })),
      ...store
        .reactionIdentityAliases(event.original.key.remoteJid)
        .map((id) => ({ key: hash("chat", id), limit: 10 })),
    ];
    const admission = store.admitReactionAttempt(budgets, now());
    if (admission !== "ADMITTED") {
      outcome(admission);
      return;
    }
    const job = { token, event, candidates, controller: new AbortController(), rule: null };
    active.add(job);
    inFlight.add(job);
    const timeout = Math.max(
      1,
      Math.min(120_000, Number(settings.get("ai_tool_timeout_ms")) || 30_000),
    );
    const timer = setTimeout(() => job.controller.abort(new Error("REACTION_TIMEOUT")), timeout);
    job.work = execute(job)
      .then(outcome, (error) => {
        const message = String(job.controller.signal.reason?.message || error?.message || "");
        const code = OUTCOMES.has(message) ? message : "ACTION_FAILED";
        outcome(code);
      })
      .finally(() => {
        clearTimeout(timer);
        active.delete(job);
        inFlight.delete(job);
      });
  }
  return {
    intake,
    close,
    cancelChat(chat) {
      cancel((job) => same(job.event.original.key.remoteJid, chat));
    },
    stats() {
      return { active: active.size, completed, lastCode };
    },
    settled() {
      return Promise.all([...active].map((job) => job.work));
    },
  };
}
