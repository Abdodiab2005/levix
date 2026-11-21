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
const status = require("./status.cjs");
const { planDelivery, canonicalJid } = require("../messaging/router.cjs");
const { linkedIdentity } = require("../messaging/identity.cjs");
const { validateDefinition, normalizeDefinition, originalType } = require("./rules.cjs");
const { classify } = require("./commandEligibility.cjs");
const { readLiveGroupMetadata } = require("../utils/groupMetadataCache.cjs");
const logger = require("../utils/logger.cjs");
const { candidateLimit } = require("./limits.cjs");
const hash = (...values) => createHash("sha256").update(JSON.stringify(values)).digest("hex");
const fail = (code) => {
  throw new Error(code);
};
const same = (a, b) => a === b || verifiedIdentityAliases(a).includes(canonicalJid(b));
const actorOf = (key) => key.author || key.participant || key.remoteJid;
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
  "REACTION_COMMAND_DENIED",
  "REACTION_COMMAND_UNSUPPORTED",
  "REACTION_COMMAND_FAILED",
  "DUPLICATE",
  "EVENT_MISSING",
  "RATE_LIMIT",
  "CAPACITY",
]);

export const REACTION_ACTION_LIMITS = Object.freeze({
  perReactor: 3,
  perChat: 10,
  perRule: 5,
  globalJobs: 2,
  windowMs: 60_000,
  // Per-event work bound (store query LIMIT candidateLimit + 1); not a rule-count cap.
  candidateLimit,
});

// Read-only checks shared with management; authorization still belongs to the job.
export function reactionActionReadiness(action, { checkKey = true } = {}) {
  const statuses = [];
  const name = typeof action === "string" && action.startsWith("group:") ? action.slice(6) : action;
  if (!name || runtime.isDisabled(name) || runtime.isDisabled(action))
    statuses.push("ACTION_DISABLED");
  if (name === "stt") {
    if (!settings.get("ai_stt_enabled")) statuses.push("STT_DISABLED");
    if (checkKey) {
      const stt = require("../commands/stt.cjs");
      if (!settings.get(`${stt.resolveSttProvider()}_api_key`)) statuses.push("STT_KEY_MISSING");
    }
  }
  return statuses;
}

function commandKeyOf(definition) {
  return definition?.command?.name || definition?.action || "";
}

function senderMatches(definition, sender) {
  const { role, ids } = definition.senders;
  if (ids.length && !ids.some((id) => same(sender.senderId, id))) return false;
  return (
    role === "any" ||
    (role === "owner" && sender.isOwner) ||
    (role === "bot_admin" && (sender.isOwner || sender.isBotAdmin)) ||
    (role === "group_admin" && sender.isGroupAdmin) ||
    (role === "owner_group_admin" && (sender.isOwner || sender.isGroupAdmin)) ||
    (role === "member" && !sender.isOwner && !sender.isBotAdmin && !sender.isGroupAdmin)
  );
}

export function createReactionAutomation(sock, { now = Date.now, dispatch } = {}) {
  const active = new Set();
  let closed = false;
  let lastCode = null;
  let completed = 0;
  const outcome = (code, job = null) => {
    lastCode = code;
    completed++;
    const ruleId =
      job?.rule && store.getReactionRule(job.rule.id)?.revision === job.rule.revision
        ? job.rule.id
        : null;
    // Account clearing disables rows without rotating their revisions.
    status.record(ruleId, code, now(), job?.statusEpoch ?? status.epoch());
    logger.debug({ code }, "[Reactions] action outcome");
  };
  const cancel = (predicate = () => true) => {
    for (const job of active)
      if (predicate(job)) job.controller.abort(new Error("REACTION_CANCELLED"));
  };
  // rc14 sends participant objects ({ id, phoneNumber, lid }). Older sockets
  // send the bare JID. A removal is "only the kick target" when every listed
  // person matches an identity the kick claimed, and nobody else is included.
  function participantIds(participant) {
    if (typeof participant === "string") return [participant];
    if (!participant || typeof participant !== "object") return [];
    const ids = [];
    for (const field of ["id", "lid", "phoneNumber", "jid", "pn"]) {
      const value = participant[field];
      if (typeof value === "string" && value && !ids.includes(value)) ids.push(value);
    }
    return ids;
  }
  function expectedRemoval(job, update) {
    const removal = job.removal;
    if (!removal?.ids?.length || !update || typeof update !== "object") return false;
    if (update.action !== "remove" && update.action !== "leave") return false;
    const people = Array.isArray(update.participants) ? update.participants : null;
    if (!people?.length) return false;
    return people.every((person) => {
      const ids = participantIds(person);
      return ids.length > 0 && ids.some((id) => removal.ids.some((target) => same(target, id)));
    });
  }
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
      const metadata = await readLiveGroupMetadata(sock, chat);
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
  function subjectFor(key, metadata) {
    if (key?.fromMe === true) {
      const isGroup = Boolean(key.remoteJid?.endsWith("@g.us"));
      const senderId = canonicalJid(
        key.author || key.participant || linkedIdentity().phone || sock?.user?.id,
      );
      const candidates = verifiedIdentityAliases(senderId);
      if (!candidates.length) fail("REACTION_IDENTITY_INVALID");
      const isGroupAdmin =
        isGroup && ["admin", "superadmin"].includes(verifiedParticipant(metadata, senderId)?.admin);
      return {
        isGroup,
        senderId,
        candidates,
        isOwner: true,
        isBotAdmin: false,
        isGroupAdmin,
        isSenderAdmin: isGroupAdmin,
      };
    }
    return resolveVerifiedSender({ key }, metadata, sock);
  }
  function sender(job, { requireOriginalAuthor = true } = {}) {
    available(job);
    const event = job.event;
    const subject = subjectFor(event.actorKey, job.metadata);
    if (subject.isGroup) {
      // A confirmed kick receipt must not require the removed member. Every
      // earlier guard still requires the original author to be present.
      const authorPresent =
        !requireOriginalAuthor || verifiedParticipant(job.metadata, actorOf(event.original.key));
      if (
        !verifiedParticipant(job.metadata, subject.senderId) ||
        !authorPresent ||
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
    if (!senderMatches(job.definition, subject)) fail("REACTION_FORBIDDEN");
    return subject;
  }
  function authorizeReceipt(job) {
    const subject = sender(job, { requireOriginalAuthor: false });
    if (!senderMatches(job.definition, subject)) fail("REACTION_FORBIDDEN");
    return subject;
  }
  function superseded(job) {
    // Events minted before slot keys existed are not stale: failing them closed
    // would reject every reaction the intake did not stamp.
    const keys = job.event.slotKeys;
    if (!Array.isArray(keys) || !keys.length) return false;
    const latest = store.latestReactionSlot(keys);
    if (!latest) return true;
    const expected = job.event.type === "remove" ? "" : job.event.emoji;
    if (latest.emoji !== expected) return true;
    // Same emoji after remove + re-add is a new version. The timestamp, not
    // the emoji alone, is what retires the earlier job.
    return latest.timestampMs !== job.event.timestampMs;
  }
  function linkedEvent(key) {
    if (key?.fromMe === true) return true;
    const id = canonicalJid(actorOf(key));
    if (!id) return false;
    let linked = {};
    try {
      linked = linkedIdentity();
    } catch {
      linked = {};
    }
    const ids = [
      linked.phone,
      linked.lid,
      ...(linked.selfJids || []),
      sock?.user?.id,
      sock?.user?.lid,
    ];
    return ids.some((item) => item && same(id, canonicalJid(item) || item));
  }
  function admitsLinkedOriginal(definition, event) {
    if (definition.allowOthersOnLinkedMessages === true) return true;
    if (!linkedEvent(event.original.key)) return true;
    return linkedEvent(event.actorKey);
  }
  function requesterOf(event) {
    const raw = actorOf(event.actorKey);
    const jid = canonicalJid(raw) || raw;
    const candidates = verifiedIdentityAliases(jid);
    return {
      jid,
      candidates: candidates.length ? candidates : [jid],
      isLinked: linkedEvent(event.actorKey),
    };
  }
  function routeModeFor(definition) {
    if (classify(commandKeyOf(definition)).destructive) return "same_chat";
    return definition.destination.mode;
  }
  function canonicalTarget(event) {
    const key = event.original?.key || {};
    const author =
      key.author ||
      key.participant ||
      (String(key.remoteJid || "").endsWith("@g.us") ? "" : key.remoteJid);
    return typeof author === "string" ? author : "";
  }
  function accountStamp() {
    const linked = linkedIdentity();
    return (
      linked.phone ||
      linked.lid ||
      canonicalJid(sock?.user?.id) ||
      canonicalJid(sock?.user?.lid) ||
      ""
    );
  }
  let commandModule = null;
  async function commands() {
    if (!commandModule) commandModule = await import("../handlers/command.handler.js");
    return commandModule;
  }
  function loadCommand(key, api) {
    if (!/^(?:group:)?[a-z][a-z0-9]*$/.test(key)) fail("REACTION_COMMAND_UNSUPPORTED");
    const spec = classify(key);
    if (spec.mode === "unsupported") {
      const error = new Error("REACTION_COMMAND_UNSUPPORTED");
      error.reason = spec.reason;
      throw error;
    }
    const name = key.startsWith("group:") ? key.slice(6) : key;
    const group = key.startsWith("group:");
    const loaded = api?.getLoadedCommands?.().get(name);
    if (loaded && (group ? loaded.__category === "group" : loaded.__category !== "group"))
      return loaded;
    const command = group
      ? require(`../commands/group/${name}.cjs`)
      : require(`../commands/${key}.cjs`);
    if (group && command.__category !== "group") command.__category = "group";
    return command;
  }
  function plannedRoute(job) {
    const source = job.event.original.key.remoteJid;
    const mode = routeModeFor(job.definition);
    const requester = requesterOf(job.event);
    const result = planDelivery({
      sourceJid: source,
      requestedJid: source,
      senderJid: requester.jid,
      commandName: commandKeyOf(job.definition),
      routeMode: mode,
      overrides: { commands: {}, categories: {} },
      sensitivity: "source",
      identity: mode === "same_chat" ? { selfJids: [] } : linkedIdentity(),
    });
    if (!result.allow || !result.destination) fail("REACTION_DELIVERY_REFUSED");
    return result;
  }
  function delivery(job) {
    authorize(job);
    return plannedRoute(job);
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
    if (rows.length > REACTION_ACTION_LIMITS.candidateLimit) fail("REACTION_CAPACITY");
    for (const row of rows) {
      let definition;
      try {
        definition = normalizeDefinition(validateDefinition(JSON.parse(row.definition)));
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
  function commandText(name, args) {
    const prefix = runtime.getPrefix();
    const remainder = args.join(" ");
    return remainder ? `${prefix}${name} ${remainder}` : `${prefix}${name}`;
  }
  function invocationFor(job, command, api) {
    const event = job.event;
    const keyName = commandKeyOf(job.definition);
    const args = Array.isArray(job.definition.command?.args) ? job.definition.command.args : [];
    const isGroup = event.original.key.remoteJid.endsWith("@g.us");
    const requester = requesterOf(event);
    const reactor = requester.jid;
    const author =
      event.original.key.author ||
      event.original.key.participant ||
      (isGroup ? "" : event.original.key.remoteJid);
    const synthetic = {
      key: {
        remoteJid: event.original.key.remoteJid,
        id: event.actorKey.id,
        fromMe: event.actorKey.fromMe === true,
        ...(isGroup ? { participant: reactor } : {}),
      },
      message: {
        extendedTextMessage: {
          text: commandText(command.name, args),
          contextInfo: {
            stanzaId: event.original.key.id,
            ...(author ? { participant: author } : {}),
            quotedMessage: event.original.message,
          },
        },
      },
      ...(typeof event.pushName === "string" ? { pushName: event.pushName } : {}),
    };
    const mode = routeModeFor(job.definition);
    const planned = planDelivery({
      sourceJid: event.original.key.remoteJid,
      requestedJid: event.original.key.remoteJid,
      senderJid: requester.jid,
      commandName: command.name,
      routeMode: mode,
      overrides: { commands: {}, categories: {} },
      sensitivity: "source",
      identity: mode === "same_chat" ? { selfJids: [] } : linkedIdentity(),
    });
    const guard = {
      refresh: () => refresh(job),
      assert: () => {
        available(job);
        if (superseded(job)) fail("REACTION_STALE");
        authorize(job);
        const gate = api.evaluateCommandGates(
          sock,
          {
            command,
            msg: synthetic,
            isGroup,
            accountEpoch: job.accountEpoch,
            options: { routeMode: mode, senderJid: requester.jid, requester },
          },
          job.metadata,
        );
        if (gate.status === "denied" || gate.status === "disabled") fail("REACTION_COMMAND_DENIED");
        if (gate.status === "stale") fail("REACTION_STALE");
        if (gate.status === "failed") fail(gate.reason || "REACTION_DELIVERY_REFUSED");
        const final = delivery(job);
        if (final.destination !== planned.destination || final.quote !== planned.quote)
          fail("REACTION_DELIVERY_REFUSED");
      },
    };
    // Posted only after WhatsApp has already removed the member. The live
    // roster is read again first. The linked account, the requester's rule
    // and command permission, and the group all have to still match. The
    // removed member does not have to still be in the group.
    const receiptGuard = {
      refresh: () => refresh(job),
      assert: () => {
        if (accountStamp() !== job.linkedAccount) fail("REACTION_STALE");
        const chat = job.event.original.key.remoteJid;
        if (!job.metadata || canonicalJid(job.metadata.id) !== chat) fail("REACTION_INACCESSIBLE");
        authorizeReceipt(job);
        const gate = api.evaluateCommandGates(
          sock,
          {
            command,
            msg: synthetic,
            isGroup,
            accountEpoch: job.accountEpoch,
            options: { routeMode: mode, senderJid: requester.jid, requester },
          },
          job.metadata,
        );
        if (gate.status === "denied" || gate.status === "disabled") fail("REACTION_COMMAND_DENIED");
        if (gate.status === "stale") fail("REACTION_STALE");
        if (gate.status === "failed") fail(gate.reason || "REACTION_DELIVERY_REFUSED");
        const final = plannedRoute(job);
        if (final.destination !== planned.destination || final.quote !== planned.quote)
          fail("REACTION_DELIVERY_REFUSED");
      },
    };
    return {
      command,
      invokedName: command.name,
      args,
      body: commandText(command.name, args),
      msg: synthetic,
      isGroup,
      rawRemainder: args.join(" "),
      accountEpoch: job.accountEpoch,
      authMetadata: isGroup ? job.metadata : null,
      options: {
        source: "reaction",
        editInPlace: false,
        replyAnchor: event.original,
        protectedKeys: [event.original.key],
        silentDenials: true,
        neutralFailure: true,
        routeMode: mode,
        senderJid: requester.jid,
        requester,
        signal: job.controller.signal,
        deliveryGuard: guard,
        receiptGuard,
        rosterReady: true,
        beforeEffect: async () => {
          await refresh(job);
          guard.assert();
        },
      },
    };
  }
  function mapOutcome(result) {
    if (!result) return "ACTION_FAILED";
    if (result.status === "executed" || result.status === "ready") return "DELIVERED";
    if (result.status === "stale") return "REACTION_STALE";
    if (result.status === "failed") return result.reason || "REACTION_COMMAND_FAILED";
    if (result.status === "denied" || result.status === "disabled")
      return "REACTION_COMMAND_DENIED";
    return "ACTION_FAILED";
  }
  function coded(code) {
    const error = new Error(code);
    error.code = code;
    return error;
  }
  function destructiveGuard(job, canonical, api, invocation) {
    return ({ meta, kickJid, candidates }) => {
      const ids = [canonical, kickJid, ...(candidates || [])].filter(Boolean);
      if (!ids.some((id) => verifiedParticipant(meta, id))) throw coded("REACTION_STALE");
      job.metadata = meta;
      try {
        available(job);
        if (superseded(job)) throw coded("REACTION_STALE");
        authorize(job);
      } catch (error) {
        if (!error.code) error.code = error.message;
        throw error;
      }
      const command = invocation.command;
      const requester = invocation.options?.requester;
      const gate = api.evaluateCommandGates(
        sock,
        {
          command,
          msg: invocation.msg,
          isGroup: invocation.isGroup,
          accountEpoch: job.accountEpoch,
          options: {
            routeMode: invocation.options?.routeMode,
            senderJid: requester?.jid,
            requester,
          },
        },
        meta,
      );
      if (gate.status === "denied" || gate.status === "disabled")
        throw coded("REACTION_COMMAND_DENIED");
      if (gate.status === "stale") throw coded("REACTION_STALE");
      if (gate.status !== "ready") throw coded(gate.reason || "REACTION_DELIVERY_REFUSED");
      const event = job.event;
      const verdict = store.claimDestructiveReaction(
        {
          accountEpoch: job.accountEpoch,
          ruleId: job.rule.id,
          revision: job.rule.revision,
          slotKeys: event.slotKeys,
          expectedEmoji: event.type === "remove" ? "" : event.emoji,
          timestampMs: event.timestampMs,
          eventKey: event.eventKey,
          ruleKey: hash(event.eventKey, job.rule.id, job.rule.revision),
          // The stanza id is the operation. A later PN redelivery of the same
          // id must not open a second claim under the other author form.
          actionKey: hash(
            "destructive",
            accountStamp(),
            event.original.key.remoteJid,
            event.original.key.id,
            commandKeyOf(job.definition),
          ),
          expiresAt: event.timestampMs + REACTION_LIMITS.ttlMs + REACTION_LIMITS.futureSkewMs,
          budgets: [{ key: hash("rule", job.rule.id), limit: REACTION_ACTION_LIMITS.perRule }],
        },
        now(),
      );
      if (verdict !== "CLAIMED") throw coded(verdict);
      // The remove call is the next statement in kickGroupMember, still in
      // this turn. A later participants update that only removes this target
      // is the effect of that call and must not abort the receipt.
      if (invocation.command?.name === "kick") job.removal = { ids };
    };
  }
  async function execute(job) {
    job.accountEpoch = store.accountEpoch();
    job.linkedAccount = accountStamp();
    await refresh(job);
    const subject = sender(job);
    const event = job.event;
    for (const candidate of job.candidates) {
      const key = commandKeyOf(candidate.definition);
      const spec = classify(key);
      if (spec.mode === "unsupported") continue;
      if (spec.destructive && event.type !== "add") continue;
      if (!senderMatches(candidate.definition, subject)) continue;
      if (!admitsLinkedOriginal(candidate.definition, event)) continue;
      job.rule = candidate.row;
      job.definition = candidate.definition;
      break;
    }
    if (!job.rule) return "NO_MATCH";
    authorize(job);
    const key = commandKeyOf(job.definition);
    const spec = classify(key);
    if (spec.mode === "unsupported") return "REACTION_COMMAND_UNSUPPORTED";
    if (spec.destructive && event.type !== "add") return "REACTION_COMMAND_UNSUPPORTED";
    const canonical = spec.destructive ? canonicalTarget(event) : "";
    if (spec.destructive && !canonical) return "REACTION_IDENTITY_INVALID";
    const api = await commands();
    const command = loadCommand(key, api);
    const invocation = invocationFor(job, command, api);
    if (spec.destructive)
      invocation.options.effectGuard = destructiveGuard(job, canonical, api, invocation);
    const run =
      dispatch || ((sockTarget, payload) => api.executeCommandInvocation(sockTarget, payload));
    const preview = await run(sock, {
      ...invocation,
      options: { ...invocation.options, preflight: true, effectGuard: undefined },
    });
    if (preview?.status && preview.status !== "ready") return mapOutcome(preview);
    if (superseded(job)) return "REACTION_STALE";
    if (command.name === "stt" || key === "stt") {
      const readiness = reactionActionReadiness("stt");
      if (readiness.includes("STT_DISABLED")) fail("REACTION_STT_DISABLED");
      if (readiness.includes("STT_KEY_MISSING")) fail("STT_KEY_REQUIRED");
    }
    if (!spec.destructive) {
      const budgets = [{ key: hash("rule", job.rule.id), limit: REACTION_ACTION_LIMITS.perRule }];
      const claimed = store.claimReactionExecution(
        {
          eventKey: event.eventKey,
          ruleKey: hash(event.eventKey, job.rule.id, job.rule.revision),
          actionKey: hash(event.eventKey, key, job.definition.destination),
          expiresAt: event.timestampMs + REACTION_LIMITS.ttlMs + REACTION_LIMITS.futureSkewMs,
          budgets,
        },
        now(),
      );
      if (claimed !== "CLAIMED") return claimed;
      if (superseded(job)) return "REACTION_STALE";
    }
    authorize(job);
    const result = await run(sock, invocation);
    return mapOutcome(result);
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
      inFlight.size >= REACTION_ACTION_LIMITS.globalJobs ||
      [...inFlight].some((job) => same(actorOf(job.event.actorKey), actorOf(event.actorKey)))
    ) {
      outcome("BUSY");
      return;
    }
    const actor = verifiedIdentityAliases(actorOf(event.actorKey));
    const budgets = [
      ...actor.map((id) => ({ key: hash("actor", id), limit: REACTION_ACTION_LIMITS.perReactor })),
      ...store
        .reactionIdentityAliases(event.original.key.remoteJid)
        .map((id) => ({ key: hash("chat", id), limit: REACTION_ACTION_LIMITS.perChat })),
    ];
    const admission = store.admitReactionAttempt(budgets, now());
    if (admission !== "ADMITTED") {
      outcome(admission);
      return;
    }
    const job = {
      token,
      event,
      candidates,
      controller: new AbortController(),
      rule: null,
      statusEpoch: status.epoch(),
    };
    active.add(job);
    inFlight.add(job);
    const timeout = Math.max(
      1,
      Math.min(120_000, Number(settings.get("ai_tool_timeout_ms")) || 30_000),
    );
    const timer = setTimeout(() => job.controller.abort(new Error("REACTION_TIMEOUT")), timeout);
    job.work = execute(job)
      .then(
        (code) => outcome(code, job),
        (error) => {
          const message = String(job.controller.signal.reason?.message || error?.message || "");
          const code = OUTCOMES.has(message) ? message : "ACTION_FAILED";
          outcome(code, job);
        },
      )
      .finally(() => {
        clearTimeout(timer);
        active.delete(job);
        inFlight.delete(job);
      });
  }
  return {
    intake,
    close,
    cancelChat(chat, update) {
      cancel(
        (job) => same(job.event.original.key.remoteJid, chat) && !expectedRemoval(job, update),
      );
    },
    stats() {
      return { active: active.size, completed, lastCode };
    },
    settled() {
      return Promise.all([...active].map((job) => job.work));
    },
  };
}
