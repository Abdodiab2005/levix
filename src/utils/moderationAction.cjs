// Shared group-moderation enforcement: identity-stable warnings, roster JID
// for kicks, FLAG records for admin review, bot-admin gating, and the
// bilingual "rule broken" notice.
//
// Warn is counted before delete/kick so a failed delete cannot skip the limit.

const {
  getGroupSettings,
  getUserWarnings,
  saveUserWarnings,
  clearUserWarnings,
  upsertModerationFlag,
  clearModerationFlag,
  listModerationFlags,
  getModerationFlag,
  accountEpoch,
  commitModerationDecision,
  markModerationNotice,
  markModerationKicked,
} = require("./storage.cjs");
const { roleIdentityAliases } = require("../db/store.cjs");
const {
  getSenderCandidatesSync,
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  isBotAdminInGroupSync,
  isBotAdminUserSync,
  isOwnerJidSync,
  primePermissions,
  rosterJidForSync,
  sameUserSync,
} = require("./permissions.cjs");
const { resolveGroupMetadata } = require("./groupMetadataCache.cjs");
const { unwrapMessage } = require("./messageContent.cjs");
const { mediaLabel } = require("./moderationSummary.cjs");
const { resolveModerationPolicy, effectivePoints } = require("../services/moderationPolicy.cjs");
const logger = require("./logger.cjs");
const { t } = require("./i18n.cjs");

const MAX_POINTS_PER_MESSAGE = 50;
const RULE_FEATURE = {
  forbidden: "forbidden",
  link: "antilink",
  media: "media",
  spam: "antispam",
  warn: "manual",
};
const ACTION_RANK = { DELETE: 1, WARN: 2, KICK: 3 };

function commandContextInfo(msg) {
  const inner = unwrapMessage(msg?.message) || {};
  return (
    inner.extendedTextMessage?.contextInfo ||
    inner.imageMessage?.contextInfo ||
    inner.videoMessage?.contextInfo ||
    inner.documentMessage?.contextInfo ||
    inner.contextInfo ||
    {}
  );
}

function identityAliases(jid) {
  return roleIdentityAliases(jid);
}

function targetFromCommand(msg) {
  const ctx = commandContextInfo(msg);
  const mentioned = (ctx.mentionedJid || []).filter((jid) => typeof jid === "string" && jid);
  if (mentioned.length) {
    const jid = mentioned[0];
    return { jid, candidates: identityAliases(jid) };
  }
  const quoted = [ctx.participant, ctx.participantAlt, ctx.participantPn].filter(
    (jid) => typeof jid === "string" && jid,
  );
  if (ctx.quotedMessage || quoted.length) {
    const jid = quoted[0];
    if (!jid) return null;
    const candidates = [];
    for (const value of quoted) {
      for (const alias of identityAliases(value)) {
        if (!candidates.includes(alias)) candidates.push(alias);
      }
    }
    return { jid, candidates };
  }
  return null;
}

function senderCandidates(msg, sock) {
  return getSenderCandidatesSync(msg, sock);
}

function isProtectedMember(sock, groupMetadata, candidates) {
  const botIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean);
  return (candidates || []).some(
    (candidate) =>
      isOwnerJidSync(candidate, groupMetadata) ||
      hasBotPrivilegesSync(candidate, groupMetadata) ||
      isAdminInGroupSync(groupMetadata, candidate) ||
      botIds.some((botId) => sameUserSync(candidate, botId)),
  );
}

function groupAdminJids(meta, sock) {
  const botIds = [sock?.user?.id, sock?.user?.lid].filter(Boolean);
  const jids = [];
  for (const participant of meta?.participants || []) {
    if (participant.admin !== "admin" && participant.admin !== "superadmin") continue;
    if (!participant.id) continue;
    if (botIds.some((botId) => sameUserSync(participant.id, botId))) continue;
    if (!jids.includes(participant.id)) jids.push(participant.id);
  }
  return jids;
}

function ruleNotice({
  rule,
  detail,
  mentionTag,
  count,
  limit,
  announceKick,
  announceFlag,
  announceNeedAdmin,
  adminTags,
}) {
  const lines = [];
  if (rule === "warn") {
    lines.push(
      t("bot.moderation.moderationAction.hasBeenWarnedReason", { mentionTag, detail: detail || "" }),
    );
  } else {
    lines.push(mentionTag);
    if (rule === "link") {
      lines.push(
        t("bot.moderation.moderationAction.linksAreNotAllowedIn"),
      );
    } else if (rule === "spam") {
      lines.push(t("bot.moderation.moderationAction.spamIsNotAllowedIn"));
    } else if (rule === "media") {
      const label = mediaLabel(detail);
      lines.push(
        t("bot.moderation.moderationAction.mediaNotAllowed", { label }),
      );
    } else if (rule === "forbidden") {
      lines.push(
        t("bot.moderation.moderationAction.forbiddenWordsAreNotAllowed"),
      );
    }
  }
  if (count && limit) {
    lines.push(t("bot.moderation.moderationAction.warnings", { count, limit }));
  }
  if (announceKick) {
    lines.push(t("bot.moderation.moderationAction.theMemberWillBeRemoved"));
  }
  if (announceNeedAdmin) {
    lines.push(
      t("bot.moderation.moderationAction.iAmNotAGroup"),
    );
  }
  if (announceFlag) {
    lines.push(
      t("bot.moderation.moderationAction.theMemberReachedTheWarning"),
    );
  }
  if (adminTags) lines.push(adminTags);
  return lines.join("\n");
}

function systemActor(sock) {
  return sock?.user?.id || sock?.user?.lid || "system";
}

function flagMemberForReview(groupId, userId, fields) {
  const payload = {
    warnCount: fields.warnCount,
    lastRule: fields.lastRule,
    reasons: fields.reasons,
    flaggedAt: fields.flaggedAt || Date.now(),
  };
  if (fields.repeatPoints != null) payload.repeatPoints = fields.repeatPoints;
  if ("lastNotifiedAt" in fields) payload.lastNotifiedAt = fields.lastNotifiedAt;
  return upsertModerationFlag(groupId, userId, payload);
}

function clearMemberModeration(groupId, userId) {
  clearUserWarnings(groupId, userId);
  clearModerationFlag(groupId, userId);
}

function accountEpochMoved(epoch) {
  if (epoch === accountEpoch()) return false;
  logger.debug("[Moderation] skipped account write after account change");
  return true;
}

function dismissMemberFlag(groupId, userId) {
  clearModerationFlag(groupId, userId);
}

/**
 * The `userAdminRequired` rule of the gate that admitted this invocation, on a
 * roster the caller picks.
 *
 * "direct" (default): the dispatcher's rule (resolveSender in
 * middleware/permissions.middleware.js). A bot admin who is not an owner, or an
 * admin of this group. `fromMe` makes the sender an owner there, which is why
 * an owner needs the group role.
 *
 * "nested": the `!group <sub-command>` gate (commands/group.cjs): the same, or
 * an owner (`fromMe` or the owner roster).
 */
function requesterStillAdmin(meta, candidates, fromMe, rule = "direct") {
  const isOwner = Boolean(fromMe) || candidates.some((candidate) => isOwnerJidSync(candidate, meta));
  const isBotAdmin = !isOwner && candidates.some((candidate) => isBotAdminUserSync(candidate, meta));
  const isGroupAdmin = candidates.some((candidate) => isAdminInGroupSync(meta, candidate));
  return isBotAdmin || isGroupAdmin || (rule === "nested" && isOwner);
}

/**
 * Remove a member on WhatsApp and drop their warnings + flag.
 * Used by !kick, the panel and automatic enforcement.
 *
 * The roster is re-read fresh right before the checks and the remove call, never
 * taken from the caller's earlier snapshot: a member promoted since then stays,
 * and a requester demoted since then cannot kick. No fresh roster, no kick.
 * `opts.requesterCandidates` (manual !kick only) re-checks the requester on that
 * same roster; `opts.requesterFromMe` carries the command's `key.fromMe`.
 * `opts.requesterRule` is the gate that admitted the command: "direct" (the
 * dispatcher, the default) or "nested" (`!group kick`, which also admits an
 * owner). Anything else is treated as "direct".
 */
async function kickGroupMember(sock, opts) {
  const epoch = Number.isInteger(opts.accountEpoch)
    ? opts.accountEpoch
    : Number.isInteger(opts.epoch)
      ? opts.epoch
      : accountEpoch();
  await primePermissions();
  const groupId = opts.groupId;
  if (!groupId?.endsWith("@g.us")) return { kicked: false, error: "not-group" };
  const candidates = (opts.targetCandidates || []).filter(Boolean);
  if (!candidates.length) return { kicked: false, error: "no-target" };
  const meta = await resolveGroupMetadata(sock, groupId, { fresh: true });
  if (!meta) return { kicked: false, error: "metadata-unavailable" };
  if (opts.requesterCandidates) {
    const requester = opts.requesterCandidates.filter(Boolean);
    const rule = opts.requesterRule === "nested" ? "nested" : "direct";
    // `!group` admits its own account (fromMe) with no identity to match.
    const ownAccount = rule === "nested" && Boolean(opts.requesterFromMe);
    if (
      !ownAccount &&
      (!requester.length || !requesterStillAdmin(meta, requester, opts.requesterFromMe, rule))
    ) {
      return { kicked: false, error: "requester-not-admin" };
    }
  }
  if (isProtectedMember(sock, meta, candidates)) return { kicked: false, error: "protected" };
  if (!isBotAdminInGroupSync(meta, sock)) return { kicked: false, error: "bot-not-admin" };
  const kickJid = rosterJidForSync(meta, candidates) || candidates[0];
  if (accountEpoch() !== epoch) return { kicked: false, error: "stale" };
  const updated = await sock.groupParticipantsUpdate(groupId, [kickJid], "remove");
  if (!removalSucceeded(updated)) return { kicked: false, error: "rejected", kickJid };
  if (accountEpochMoved(epoch)) return { kicked: true, kickJid };
  clearMemberModeration(groupId, candidates[0]);
  logger.info("moderation kicked member");
  logger.debugOnly.info({ group: groupId, user: kickJid }, "moderation kicked member");
  return { kicked: true, kickJid };
}

function removalSucceeded(result) {
  if (result == null) return true;
  const items = Array.isArray(result) ? result : [result];
  if (!items.length) return false;
  return items.every((item) => item && typeof item === "object" && String(item.status) === "200");
}

function idleResult() {
  return {
    acted: false,
    duplicate: false,
    points: 0,
    effective: 0,
    decision: "none",
    kicked: false,
    flagged: false,
    count: 0,
    willKick: false,
  };
}

function assignHitActions(hits, policy) {
  return hits.map((hit) => {
    const next = { ...hit };
    if (!next.action) {
      if (next.rule === "warn") next.action = "WARN";
      else next.action = policy.features[RULE_FEATURE[next.rule]] || "WARN";
    } else next.action = String(next.action).toUpperCase();
    if (!next.reason) next.reason = next.detail || next.rule || "moderation";
    return next;
  });
}

function strongestHit(hits) {
  let best = hits[0];
  for (const hit of hits.slice(1)) {
    if ((ACTION_RANK[hit.action] || 0) > (ACTION_RANK[best.action] || 0)) best = hit;
  }
  return best;
}

function pointsForHits(hits, policy) {
  const primary = strongestHit(hits);
  const counting = hits.filter((hit) => hit.action === "WARN" || hit.action === "KICK");
  if (primary.action === "DELETE" || counting.length === 0) return { points: 0, primary };
  if (policy.mode !== "severity") return { points: 1, primary };
  const weights = counting.map((hit) => policy.weights[RULE_FEATURE[hit.rule]] || 1);
  if (policy.hitMerge === "sum") {
    return {
      points: Math.min(MAX_POINTS_PER_MESSAGE, weights.reduce((total, weight) => total + weight, 0)),
      primary,
    };
  }
  return { points: Math.max(...weights), primary };
}

function decideOutcome({ policy, immediate, effective, flagWasOpen, repeatPoints }) {
  if (immediate === "KICK") return "kick";
  if (policy.mode !== "severity") {
    if (effective >= policy.limit && policy.limitAction === "KICK") return "kick";
    if (
      flagWasOpen &&
      policy.flag.whileFlagged === "escalate" &&
      repeatPoints >= policy.flag.escalateAfter
    ) {
      return "kick";
    }
    if (effective >= policy.limit && policy.limitAction === "FLAG") return "flag";
    return immediate === "DELETE" ? "delete" : "warn";
  }
  if (effective >= policy.kickAt) return "kick";
  if (effective >= policy.flagAt) return "flag";
  return immediate === "DELETE" ? "delete" : "warn";
}

async function performKick(sock, ctx) {
  const epoch = Number.isInteger(ctx.accountEpoch)
    ? ctx.accountEpoch
    : Number.isInteger(ctx.epoch)
      ? ctx.epoch
      : accountEpoch();
  try {
    const result = await kickGroupMember(sock, {
      groupId: ctx.groupId,
      groupMetadata: ctx.meta,
      targetCandidates: ctx.candidates,
      epoch,
      accountEpoch: epoch,
    });
    if (accountEpochMoved(epoch)) return Boolean(result.kicked);
    if (result.kicked) {
      markModerationKicked(ctx.groupId, ctx.messageId);
      return true;
    }
    logger.warn({ rule: ctx.rule, error: result.error }, "moderation kick skipped");
    logger.debugOnly.warn(
      { group: ctx.groupId, user: ctx.mentionJid, rule: ctx.rule, error: result.error },
      "moderation kick skipped",
    );
    flagMemberForReview(ctx.groupId, ctx.mentionJid, {
      warnCount: ctx.effective,
      lastRule: ctx.rule,
      reasons: ctx.reasons,
      repeatPoints: ctx.repeatPoints,
    });
    return false;
  } catch (err) {
    logger.error({ err, rule: ctx.rule }, "moderation kick failed");
    logger.debugOnly.error(
      { err, group: ctx.groupId, user: ctx.mentionJid, rule: ctx.rule },
      "moderation kick failed",
    );
    if (!accountEpochMoved(epoch)) {
      flagMemberForReview(ctx.groupId, ctx.mentionJid, {
        warnCount: ctx.effective,
        lastRule: ctx.rule,
        reasons: ctx.reasons,
        repeatPoints: ctx.repeatPoints,
      });
    }
    try {
      await sock.sendMessage(ctx.groupId, {
        text: t("bot.moderation.moderationAction.iTriedToRemoveThe"),
      });
    } catch (noticeErr) {
      logger.error({ err: noticeErr, group: ctx.groupId }, "moderation kick-failure notice failed");
    }
    return false;
  }
}

/**
 * Apply every hit from one message in a single transaction.
 * Returns { acted, duplicate, points, effective, decision, kicked, flagged }.
 */
async function enforceHits(sock, opts) {
  const epoch = Number.isInteger(opts.accountEpoch)
    ? opts.accountEpoch
    : Number.isInteger(opts.epoch)
      ? opts.epoch
      : accountEpoch();
  const msg = opts.msg;
  const groupId = opts.groupId || msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return idleResult();
  const incoming = (opts.hits || []).filter(Boolean);
  if (!incoming.length) return idleResult();

  const meta = opts.groupMetadata || (await resolveGroupMetadata(sock, groupId));
  const candidates = (opts.targetCandidates?.length
    ? opts.targetCandidates
    : senderCandidates(msg, sock)
  ).filter(Boolean);
  if (!candidates.length) return idleResult();
  // Detectors skip the linked account. A manual warn is an admin action, so
  // immunity is the target's (bot, owners, bot admins, group admins).
  const manualWarn = incoming.every((hit) => hit.rule === "warn");
  if ((!manualWarn && msg?.key?.fromMe) || isProtectedMember(sock, meta, candidates)) return idleResult();

  const settings = getGroupSettings(groupId) || {};
  const policy = resolveModerationPolicy(settings);
  const hits = assignHitActions(incoming, policy);
  const { points, primary } = pointsForHits(hits, policy);
  const messageId = msg?.key?.id || null;
  const now = Date.now();
  const mentionJid = candidates[0];
  const botAdmin = isBotAdminInGroupSync(meta, sock);
  const actor = opts.actorJid || systemActor(sock);
  const shouldDelete = hits.some(
    (hit) => hit.rule === "link" || hit.rule === "media" || hit.rule === "forbidden",
  );

  if (accountEpochMoved(epoch)) return idleResult();

  const committed = commitModerationDecision(groupId, messageId, () => {
    const existingEvents = getUserWarnings(groupId, mentionJid);
    const flag = getModerationFlag(groupId, mentionJid);
    const flagWasOpen = Boolean(flag);
    let added = points;
    if (flagWasOpen && policy.flag.whileFlagged === "hold" && primary.action !== "KICK") added = 0;
    if (messageId && existingEvents.some((event) => event.messageId === messageId)) added = 0;

    const events = existingEvents.slice();
    if (added > 0) {
      events.push({
        messageId,
        points: added,
        rules: hits.map((hit) => hit.rule),
        reason: primary.reason,
        by: actor,
        date: new Date(now).toISOString(),
      });
      saveUserWarnings(groupId, mentionJid, events);
    }

    let repeatPoints = flag?.repeat_points || 0;
    if (
      flagWasOpen &&
      (policy.flag.whileFlagged === "record" || policy.flag.whileFlagged === "escalate")
    ) {
      repeatPoints += added;
    }
    const effective = effectivePoints(events, policy, now);
    const decision = decideOutcome({
      policy,
      immediate: primary.action,
      effective,
      flagWasOpen,
      repeatPoints,
    });
    const wantKick = decision === "kick";
    const opening = !flagWasOpen && (decision === "flag" || (wantKick && !botAdmin));
    if (opening) repeatPoints = 0;
    const reasons = events.map((event) => event?.reason).filter(Boolean);
    if (decision === "flag" || (wantKick && !botAdmin) || (flagWasOpen && !wantKick)) {
      flagMemberForReview(groupId, mentionJid, {
        warnCount: effective,
        lastRule: primary.rule,
        reasons,
        repeatPoints,
        flaggedAt: flag?.flagged_at || now,
      });
    }
    const cooldownMs = (policy.flag.cooldownMinutes || 0) * 60 * 1000;
    const lastNotified = flag?.last_notified_at || 0;
    return {
      outcome: decision,
      points: added,
      effective,
      decision,
      lastRule: primary.rule,
      rule: primary.rule,
      detail: primary.detail,
      shouldDelete,
      wantKick,
      botAdmin,
      hitLimit: policy.mode !== "severity" && effective >= policy.limit,
      canFlagNotice:
        policy.flag.notify === "group" && (cooldownMs === 0 || now - lastNotified >= cooldownMs),
      mentionAdmins: policy.flag.mentionAdmins !== false,
      mentionJid,
      candidates,
      reasons,
      repeatPoints,
      limit: policy.mode === "severity" ? policy.kickAt : policy.limit,
    };
  });

  if (committed?.duplicate) {
    let kicked = Boolean(committed.kicked);
    if (!kicked && committed.outcome === "kick") {
      const flag = getModerationFlag(groupId, mentionJid);
      const events = getUserWarnings(groupId, mentionJid);
      kicked = await performKick(sock, {
        groupId,
        meta,
        candidates,
        mentionJid,
        rule: flag?.last_rule || "moderation",
        messageId,
        effective: flag?.warn_count || effectivePoints(events, policy, now),
        reasons: events.map((event) => event?.reason).filter(Boolean),
        repeatPoints: flag?.repeat_points || 0,
        epoch,
        accountEpoch: epoch,
      });
    }
    return {
      acted: true,
      duplicate: true,
      points: 0,
      effective: null,
      decision: committed.outcome,
      kicked,
      flagged: !kicked && (committed.outcome === "flag" || committed.outcome === "kick"),
      lastRule: null,
      count: null,
      willKick: committed.outcome === "kick",
    };
  }

  if (committed.shouldDelete) {
    if (!committed.botAdmin) {
      logger.warn(
        { group: groupId, rule: committed.rule },
        "moderation delete skipped: bot is not a group admin",
      );
    } else {
      try {
        await sock.sendMessage(groupId, { delete: msg.key });
      } catch (err) {
        logger.error({ err, group: groupId, rule: committed.rule }, "moderation delete failed");
      }
    }
  }

  const converted = committed.wantKick && !committed.botAdmin;
  const normalFlag = committed.decision === "flag";
  const announceFlag =
    committed.canFlagNotice && (normalFlag || (converted && committed.hitLimit));
  const sendNeedAdmin = converted;
  const sendRule =
    committed.decision === "warn" ||
    committed.decision === "delete" ||
    (committed.wantKick && committed.botAdmin) ||
    announceFlag ||
    sendNeedAdmin;
  if (sendRule) {
    const mentionAdmins =
      sendNeedAdmin || (announceFlag && committed.mentionAdmins && !sendNeedAdmin) || (announceFlag && committed.mentionAdmins);
    const adminJids = mentionAdmins ? groupAdminJids(meta, sock) : [];
    const text = ruleNotice({
      rule: committed.rule,
      detail: committed.detail,
      mentionTag: `@${String(committed.mentionJid).split("@")[0]}`,
      count: committed.decision === "delete" ? 0 : committed.effective,
      limit: committed.limit,
      announceKick: committed.wantKick && committed.botAdmin,
      announceFlag,
      announceNeedAdmin: sendNeedAdmin,
      adminTags: adminJids.map((jid) => `@${String(jid).split("@")[0]}`).join(" "),
    });
    try {
      await sock.sendMessage(groupId, { text, mentions: [committed.mentionJid, ...adminJids] });
      if (!accountEpochMoved(epoch)) {
        markModerationNotice(groupId, messageId, committed.mentionJid, {
          flagNotice: announceFlag,
          at: now,
        });
      }
    } catch (err) {
      logger.error({ err, group: groupId, rule: committed.rule }, "moderation notice failed");
    }
  }
  if (converted) {
    logger.warn(
      { rule: committed.rule },
      "moderation kick skipped: bot is not a group admin; flagged instead",
    );
    logger.debugOnly.warn(
      { group: groupId, user: mentionJid, rule: committed.rule },
      "moderation kick skipped: bot is not a group admin; flagged instead",
    );
  }

  let kicked = false;
  if (committed.wantKick && committed.botAdmin) {
    kicked = await performKick(sock, {
      groupId,
      meta,
      candidates,
      mentionJid,
      rule: committed.rule,
      messageId,
      effective: committed.effective,
      reasons: committed.reasons,
      repeatPoints: committed.repeatPoints,
      epoch,
      accountEpoch: epoch,
    });
  }

  return {
    acted: true,
    duplicate: false,
    points: committed.points,
    effective: committed.effective,
    decision: committed.decision,
    kicked,
    flagged: (committed.decision === "flag" || converted || (committed.wantKick && !kicked)) && !kicked,
    lastRule: committed.lastRule,
    count: committed.effective,
    willKick: committed.wantKick,
  };
}

async function enforceGroupRule(sock, opts) {
  const action = opts.kickImmediately ? "KICK" : opts.recordWarning === false ? "DELETE" : "WARN";
  return enforceHits(sock, {
    msg: opts.msg,
    groupId: opts.groupId,
    groupMetadata: opts.groupMetadata,
    hits: [
      {
        rule: opts.rule || "moderation",
        action,
        reason: opts.warningReason || opts.detail || opts.rule || "moderation",
        detail: opts.detail,
      },
    ],
    actorJid: opts.actorJid,
    targetCandidates: opts.targetCandidates,
  });
}

module.exports = {
  enforceHits,
  enforceGroupRule,
  kickGroupMember,
  clearMemberModeration,
  dismissMemberFlag,
  flagMemberForReview,
  listModerationFlags,
  targetFromCommand,
  senderCandidates,
  isProtectedMember,
  commandContextInfo,
  groupAdminJids,
};
