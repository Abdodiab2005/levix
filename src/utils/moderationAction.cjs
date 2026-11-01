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
  commitModerationDecision,
  markModerationNotice,
  markModerationKicked,
  getPnForLid,
  getLidForPn,
  getLidsForPn,
} = require("./storage.cjs");
const normalizeJid = require("./normalizeJid.cjs");
const { isLidJid } = normalizeJid;
const {
  getSenderCandidatesSync,
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  isBotAdminInGroupSync,
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
  const ids = [];
  const add = (value) => {
    const norm = normalizeJid(value);
    if (norm && !ids.includes(norm)) ids.push(norm);
  };
  add(jid);
  const norm = ids[0];
  if (!norm) return ids;
  const phones = [];
  const addPhone = (value) => {
    const phone = normalizeJid(value);
    if (!phone || isLidJid(phone) || phones.includes(phone)) return;
    phones.push(phone);
  };
  if (isLidJid(norm)) addPhone(getPnForLid(norm));
  else addPhone(norm);
  for (const phone of phones) {
    add(phone);
    add(getLidForPn(phone));
    for (const lid of getLidsForPn(phone) || []) add(lid);
  }
  return ids;
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
      isOwnerJidSync(candidate) ||
      hasBotPrivilegesSync(candidate) ||
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

function dismissMemberFlag(groupId, userId) {
  clearModerationFlag(groupId, userId);
}

/**
 * Remove a member on WhatsApp and drop their warnings + flag.
 * Used by !kick and the panel.
 */
async function kickGroupMember(sock, opts) {
  await primePermissions();
  const groupId = opts.groupId;
  if (!groupId?.endsWith("@g.us")) return { kicked: false, error: "not-group" };
  const meta = opts.groupMetadata || (await resolveGroupMetadata(sock, groupId));
  const candidates = (opts.targetCandidates || []).filter(Boolean);
  if (!candidates.length) return { kicked: false, error: "no-target" };
  if (isProtectedMember(sock, meta, candidates)) return { kicked: false, error: "protected" };
  if (!isBotAdminInGroupSync(meta, sock)) return { kicked: false, error: "bot-not-admin" };
  const kickJid = rosterJidForSync(meta, candidates) || candidates[0];
  const updated = await sock.groupParticipantsUpdate(groupId, [kickJid], "remove");
  if (!removalSucceeded(updated)) return { kicked: false, error: "rejected", kickJid };
  clearMemberModeration(groupId, candidates[0]);
  logger.info({ group: groupId, user: kickJid }, "moderation kicked member");
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
  try {
    const result = await kickGroupMember(sock, {
      groupId: ctx.groupId,
      groupMetadata: ctx.meta,
      targetCandidates: ctx.candidates,
    });
    if (result.kicked) {
      markModerationKicked(ctx.groupId, ctx.messageId);
      return true;
    }
    logger.warn(
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
    logger.error(
      { err, group: ctx.groupId, user: ctx.mentionJid, rule: ctx.rule },
      "moderation kick failed",
    );
    flagMemberForReview(ctx.groupId, ctx.mentionJid, {
      warnCount: ctx.effective,
      lastRule: ctx.rule,
      reasons: ctx.reasons,
      repeatPoints: ctx.repeatPoints,
    });
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
      markModerationNotice(groupId, messageId, committed.mentionJid, {
        flagNotice: announceFlag,
        at: now,
      });
    } catch (err) {
      logger.error({ err, group: groupId, rule: committed.rule }, "moderation notice failed");
    }
  }
  if (converted) {
    logger.warn(
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
