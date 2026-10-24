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
} = require("./storage.cjs");
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
const { mediaLabel, warnConfigOf } = require("./moderationSummary.cjs");
const logger = require("./logger.cjs");
const { tr } = require("./i18n.cjs");

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

function targetFromCommand(msg) {
  const ctx = commandContextInfo(msg);
  const mentioned = (ctx.mentionedJid || []).filter(Boolean);
  if (mentioned.length) {
    return { jid: mentioned[0], candidates: mentioned };
  }
  const quoted = [ctx.participant, ctx.participantAlt, ctx.participantPn].filter(Boolean);
  if (ctx.quotedMessage || quoted.length) {
    return { jid: quoted[0], candidates: quoted };
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
      tr(
        `✅ ${mentionTag} has been warned.\n*Reason:* ${detail || ""}`,
        `✅ تم توجيه تحذير إلى ${mentionTag}.\n*السبب:* ${detail || ""}`,
      ),
    );
  } else {
    lines.push(mentionTag);
    if (rule === "link") {
      lines.push(
        tr("Links are not allowed in this group.", "الروابط غير مسموحة في هذه المجموعة."),
      );
    } else if (rule === "spam") {
      lines.push(tr("Spam is not allowed in this group.", "الإزعاج غير مسموح في هذه المجموعة."));
    } else if (rule === "media") {
      const label = mediaLabel(detail);
      lines.push(
        tr(
          `${label} are not allowed in this group.`,
          `يُمنع إرسال ${label} في هذه المجموعة.`,
        ),
      );
    } else if (rule === "forbidden") {
      lines.push(
        tr(
          "Forbidden words are not allowed in this group.",
          "الكلمات الممنوعة غير مسموحة في هذه المجموعة.",
        ),
      );
    }
  }
  if (count && limit) {
    lines.push(tr(`Warnings: ${count}/${limit}`, `الإنذارات: ${count}/${limit}`));
  }
  if (announceKick) {
    lines.push(tr("The member will be removed.", "سيتم حذف العضو."));
  }
  if (announceNeedAdmin) {
    lines.push(
      tr(
        "I am not a group admin, so an admin must act.",
        "لست مشرفًا في المجموعة، لذلك يجب أن يتصرف أحد المشرفين.",
      ),
    );
  }
  if (announceFlag) {
    lines.push(
      tr(
        "The member reached the warning limit. Admins have been notified.",
        "بلغ العضو حد الإنذارات. تم إشعار المشرفين.",
      ),
    );
  }
  if (adminTags) lines.push(adminTags);
  return lines.join("\n");
}

function systemActor(sock) {
  return sock?.user?.id || sock?.user?.lid || "system";
}

function flagMemberForReview(groupId, userId, { warnCount, lastRule, reasons }) {
  return upsertModerationFlag(groupId, userId, {
    warnCount,
    lastRule,
    reasons,
    flaggedAt: Date.now(),
  });
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
  await sock.groupParticipantsUpdate(groupId, [kickJid], "remove");
  clearMemberModeration(groupId, candidates[0]);
  logger.info({ group: groupId, user: kickJid }, "moderation kicked member");
  return { kicked: true, kickJid };
}

/**
 * Count a warning (optional), delete the message (optional), then either kick
 * at the group's warn limit / immediately, or FLAG for admin review.
 * Returns { acted, count, kicked, flagged }.
 */
async function enforceGroupRule(sock, opts) {
  const msg = opts.msg;
  const groupId = opts.groupId || msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return { acted: false };

  const meta = opts.groupMetadata || (await resolveGroupMetadata(sock, groupId));
  const candidates = (opts.targetCandidates?.length
    ? opts.targetCandidates
    : senderCandidates(msg, sock)
  ).filter(Boolean);
  if (!candidates.length) return { acted: false };

  if (isProtectedMember(sock, meta, candidates)) return { acted: false };

  const mentionJid = candidates[0];
  const mentionTag = `@${String(mentionJid).split("@")[0]}`;
  const botAdmin = isBotAdminInGroupSync(meta, sock);
  const settings = getGroupSettings(groupId) || {};
  const warnCfg = warnConfigOf(settings);
  const recordWarning = opts.recordWarning !== false;
  const deleteMessage = Boolean(opts.deleteMessage);
  const kickImmediately = Boolean(opts.kickImmediately);

  let count = 0;
  let warnings = getUserWarnings(groupId, mentionJid);
  if (recordWarning) {
    warnings = warnings.slice();
    warnings.push({
      reason: opts.warningReason || opts.detail || opts.rule || "moderation",
      by: opts.actorJid || systemActor(sock),
      date: new Date().toISOString(),
    });
    saveUserWarnings(groupId, mentionJid, warnings);
    count = warnings.length;
  } else {
    count = warnings.length;
  }

  const hitLimit = recordWarning && count >= warnCfg.max_warnings;
  const wantKick = kickImmediately || (hitLimit && warnCfg.action === "KICK");
  const willKick = wantKick && botAdmin;
  // Feature-KICK (or warn-limit KICK) that the bot can perform must not also
  // FLAG: a successful kick clears the record, and the notice would contradict
  // itself. FLAG only when we are not kicking: warn-limit FLAG, or any kick
  // the bot cannot perform.
  const willFlag =
    !willKick && ((hitLimit && warnCfg.action === "FLAG") || (wantKick && !botAdmin));

  if (deleteMessage) {
    if (!botAdmin) {
      logger.warn({ group: groupId, rule: opts.rule }, "moderation delete skipped: bot is not a group admin");
    } else {
      try {
        await sock.sendMessage(groupId, { delete: msg.key });
      } catch (err) {
        logger.error({ err, group: groupId, rule: opts.rule }, "moderation delete failed");
      }
    }
  }

  if (willFlag) {
    flagMemberForReview(groupId, mentionJid, {
      warnCount: count,
      lastRule: opts.rule || "moderation",
      reasons: warnings.map((item) => item?.reason).filter(Boolean),
    });
  }

  const adminJids = willFlag ? groupAdminJids(meta, sock) : [];
  const adminTags = adminJids.map((jid) => `@${String(jid).split("@")[0]}`).join(" ");
  const showCount = recordWarning || kickImmediately;
  const text = ruleNotice({
    rule: opts.rule,
    detail: opts.detail,
    mentionTag,
    count: showCount ? count : 0,
    limit: warnCfg.max_warnings,
    announceKick: willKick,
    announceFlag: willFlag && hitLimit,
    announceNeedAdmin: wantKick && !botAdmin,
    adminTags,
  });
  const mentions = [mentionJid, ...adminJids];
  try {
    await sock.sendMessage(groupId, { text, mentions });
  } catch (err) {
    logger.error({ err, group: groupId, rule: opts.rule }, "moderation notice failed");
  }

  let kicked = false;
  let flagged = willFlag;
  if (willKick) {
    try {
      const result = await kickGroupMember(sock, {
        groupId,
        groupMetadata: meta,
        targetCandidates: candidates,
      });
      kicked = Boolean(result.kicked);
      if (!result.kicked) {
        logger.warn(
          { group: groupId, user: mentionJid, rule: opts.rule, error: result.error },
          "moderation kick skipped",
        );
        flagMemberForReview(groupId, mentionJid, {
          warnCount: count,
          lastRule: opts.rule || "moderation",
          reasons: warnings.map((item) => item?.reason).filter(Boolean),
        });
        flagged = true;
      }
    } catch (err) {
      logger.error(
        { err, group: groupId, user: mentionJid, rule: opts.rule },
        "moderation kick failed",
      );
      flagMemberForReview(groupId, mentionJid, {
        warnCount: count,
        lastRule: opts.rule || "moderation",
        reasons: warnings.map((item) => item?.reason).filter(Boolean),
      });
      flagged = true;
      try {
        await sock.sendMessage(groupId, {
          text: tr(
            "I tried to remove the member, but I don't have enough permissions.",
            "حاولت حذف العضو ولكني لا أملك صلاحية كافية لذلك.",
          ),
        });
      } catch (noticeErr) {
        logger.error({ err: noticeErr, group: groupId }, "moderation kick-failure notice failed");
      }
    }
  } else if (wantKick && !botAdmin) {
    logger.warn(
      { group: groupId, user: mentionJid, rule: opts.rule },
      "moderation kick skipped: bot is not a group admin; flagged instead",
    );
  }

  return { acted: true, count, kicked, flagged: Boolean(flagged && !kicked), willKick: wantKick };
}

module.exports = {
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
