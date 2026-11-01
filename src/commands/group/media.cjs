// file: /commands/group/media.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../../utils/permissions.cjs");
const { mediaType } = require("../../utils/messageContent.cjs");
const { resolveGroupMetadata } = require("../../utils/groupMetadataCache.cjs");
const { enforceGroupRule, senderCandidates } = require("../../utils/moderationAction.cjs");
const {
  featureActionOf,
  normalizeFeatureAction,
  policyFromFeatureAction,
} = require("../../utils/moderationSummary.cjs");
const { t, tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

const VALID_TYPES = ["image", "video", "sticker", "audio"];

// --- The Main Command Logic ---
const command = {
  name: "media",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0] ? args[0].toLowerCase() : "status";
    const settings = getGroupSettings(groupId);

    if (!settings.media_control) {
      settings.media_control = { enabled: false, blocked_types: [] };
    }
    const mediaConfig = settings.media_control;

    switch (subCommand) {
      case "on":
        mediaConfig.enabled = true;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.media.mediaControlIsOn"),
        });
        break;
      case "off":
        mediaConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.media.mediaControlIsOff"),
        });
        break;
      case "action": {
        const action = normalizeFeatureAction(args[1]);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.media.invalidActionAvailableDeleteWarn"),
          });
        }
        try {
          applyModerationPolicy(groupId, { features: { media: action } });
        } catch (error) {
          return await sock.sendMessage(groupId, {
            text: tr(
              error.errors?.[0]?.message || "That action is not allowed.",
              "هذا الإجراء غير مسموح.",
            ),
          });
        }
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.media.mediaActionIsNow", { action }),
        });
        return;
      }
      case "block": {
        const typeToBlock = args[1] ? args[1].toLowerCase() : "";
        if (!VALID_TYPES.includes(typeToBlock))
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.media.invalidTypeAvailableTypes", { types: VALID_TYPES.join(", ") }),
          });
        if (!mediaConfig.blocked_types.includes(typeToBlock)) {
          mediaConfig.blocked_types.push(typeToBlock);
        }
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.media.isNowBlocked", { typeToBlock }),
        });
        break;
      }
      case "unblock": {
        const typeToUnblock = args[1] ? args[1].toLowerCase() : "";
        if (!typeToUnblock)
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.media.sayWhichTypeToUnblock"),
          });
        mediaConfig.blocked_types = mediaConfig.blocked_types.filter((t) => t !== typeToUnblock);
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.media.isNoLongerBlocked", { typeToUnblock }),
        });
        break;
      }
      default: {
        // 'status'
        const state = mediaConfig.enabled ? t("bot.moderation.media.on") : t("bot.moderation.media.off");
        const blocked = mediaConfig.blocked_types.join(", ") || t("bot.moderation.media.none");
        const action = featureActionOf(settings, "media");
        const statusReply = t("bot.moderation.media.mediaControlStateActionBlocked", { state, action, blocked });
        await sock.sendMessage(groupId, { text: statusReply });
      }
    }
    saveGroupSettings(groupId, settings);
  },
};

// --- The Message Handler Logic ---
function detectMedia(msg, settings) {
  const groupId = msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return null;
  const mediaConfig = settings?.media_control;
  if (!mediaConfig?.enabled) return null;
  const blocked = Array.isArray(mediaConfig.blocked_types) ? mediaConfig.blocked_types : [];
  const messageType = mediaType(msg.message);
  if (!messageType || !blocked.includes(messageType)) return null;
  return { rule: "media", reason: `media:${messageType}`, detail: messageType };
}

async function handleMediaControl(sock, msg, _legacyConfig, _normalizeJid) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  if (!isGroup) return false;

  const groupId = msg.key.remoteJid;
  const settings = getGroupSettings(groupId) || {};
  const senderId = msg.key.participant || msg.key.remoteJid;

  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  const senderIds = senderCandidates(msg, sock);
  const isOwner = msg.key.fromMe || senderIds.some(isOwnerJidSync);
  const isSenderAdmin = senderIds.some((id) => isAdminInGroupSync(groupMetadata, id));
  if (isOwner || isSenderAdmin) return false;

  const hit = detectMedia(msg, settings);
  if (!hit) return false;
  logger.info(`[Media Control] Deleting ${hit.detail} from ${senderId} in ${groupId}.`);
  const policy = policyFromFeatureAction(featureActionOf(settings, "media"));
  const result = await enforceGroupRule(sock, {
    msg,
    groupMetadata,
    rule: "media",
    detail: hit.detail,
    warningReason: hit.reason,
    ...policy,
    targetCandidates: senderIds,
  });
  return Boolean(result.acted);
}

module.exports = { ...command, handleMediaControl, detectMedia };
