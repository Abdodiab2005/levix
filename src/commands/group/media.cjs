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
const { tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

const VALID_TYPES = ["image", "video", "sticker", "audio"];

// --- The Main Command Logic ---
const command = {
  name: "media",
  description: {
    en: "Controls which message types are allowed in the group.",
    ar: "يتحكم في أنواع الرسائل المسموح بها في المجموعة.",
  },
  usage: {
    en: "media [status]\nmedia <on|off>\nmedia action <DELETE|WARN|KICK>\nmedia <block|unblock> <image|video|sticker|audio>",
    ar: "media [status]\nmedia <on|off>\nmedia action <DELETE|WARN|KICK>\nmedia <block|unblock> <image|video|sticker|audio>",
  },
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
          text: tr("✅ Media control is on.", "✅ تم تفعيل نظام مراقبة الوسائط."),
        });
        break;
      case "off":
        mediaConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: tr("☑️ Media control is off.", "☑️ تم تعطيل نظام مراقبة الوسائط."),
        });
        break;
      case "action": {
        const action = normalizeFeatureAction(args[1]);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Invalid action. Available: `DELETE`, `WARN`, `KICK`",
              "الإجراء غير صالح. الإجراءات المتاحة: `DELETE`, `WARN`, `KICK`",
            ),
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
          text: tr(`✅ Media action is now ${action}.`, `✅ تم تعيين إجراء الوسائط إلى ${action}.`),
        });
        return;
      }
      case "block": {
        const typeToBlock = args[1] ? args[1].toLowerCase() : "";
        if (!VALID_TYPES.includes(typeToBlock))
          return await sock.sendMessage(groupId, {
            text: tr(
              `Invalid type. Available types: ${VALID_TYPES.join(", ")}`,
              `نوع غير صالح. الأنواع المتاحة: ${VALID_TYPES.join(", ")}`,
            ),
          });
        if (!mediaConfig.blocked_types.includes(typeToBlock)) {
          mediaConfig.blocked_types.push(typeToBlock);
        }
        await sock.sendMessage(groupId, {
          text: tr(`✅ '${typeToBlock}' is now blocked.`, `✅ تم إضافة '${typeToBlock}' للأنواع الممنوعة.`),
        });
        break;
      }
      case "unblock": {
        const typeToUnblock = args[1] ? args[1].toLowerCase() : "";
        if (!typeToUnblock)
          return await sock.sendMessage(groupId, {
            text: tr("Say which type to unblock.", "يرجى تحديد نوع لإلغاء حظره."),
          });
        mediaConfig.blocked_types = mediaConfig.blocked_types.filter((t) => t !== typeToUnblock);
        await sock.sendMessage(groupId, {
          text: tr(
            `☑️ '${typeToUnblock}' is no longer blocked.`,
            `☑️ تم إزالة '${typeToUnblock}' من الأنواع الممنوعة.`,
          ),
        });
        break;
      }
      default: {
        // 'status'
        const state = mediaConfig.enabled ? tr("on ✅", "مفعل ✅") : tr("off ☑️", "معطل ☑️");
        const blocked = mediaConfig.blocked_types.join(", ") || tr("none", "لا يوجد");
        const action = featureActionOf(settings, "media");
        const statusReply = tr(
          `*Media control:*\n\nState: ${state}\nAction: ${action}\nBlocked types: ${blocked}`,
          `*حالة نظام مراقبة الوسائط:*\n\nالحالة: ${state}\nالإجراء: ${action}\nالأنواع الممنوعة: ${blocked}`,
        );
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
