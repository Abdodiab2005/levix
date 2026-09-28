// file: /commands/group/media.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../../utils/permissions.cjs");
const { mediaType } = require("../../utils/messageContent.cjs");
const { resolveGroupMetadata } = require("../../utils/groupMetadataCache.cjs");
const { tr } = require("../../utils/i18n.cjs");

const VALID_TYPES = ["image", "video", "sticker", "audio"];

// --- The Main Command Logic ---
const command = {
  name: "media",
  description: {
    en: "Controls which message types are allowed in the group.",
    ar: "يتحكم في أنواع الرسائل المسموح بها في المجموعة.",
  },
  usage: {
    en: "media [status]\nmedia <on|off>\nmedia <block|unblock> <image|video|sticker|audio>",
    ar: "media [status]\nmedia <on|off>\nmedia <block|unblock> <image|video|sticker|audio>",
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
        const statusReply = tr(
          `*Media control:*\n\nState: ${state}\nBlocked types: ${blocked}`,
          `*حالة نظام مراقبة الوسائط:*\n\nالحالة: ${state}\nالأنواع الممنوعة: ${blocked}`,
        );
        await sock.sendMessage(groupId, { text: statusReply });
      }
    }
    saveGroupSettings(groupId, settings);
  },
};

// --- The Message Handler Logic ---
async function handleMediaControl(sock, msg, _legacyConfig, _normalizeJid) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  if (!isGroup) return false;

  const groupId = msg.key.remoteJid;
  const settings = getGroupSettings(groupId);
  const mediaConfig = settings.media_control;

  if (!mediaConfig || !mediaConfig.enabled) return false;

  const senderId = msg.key.participant || msg.key.remoteJid;

  // Cache-first: this runs on every group message while media control is on.
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  const senderIds = [senderId, msg.key.participantAlt, msg.key.participantPn].filter(Boolean);
  const isOwner = msg.key.fromMe || senderIds.some(isOwnerJidSync);
  const isSenderAdmin = senderIds.some((id) => isAdminInGroupSync(groupMetadata, id));

  if (isOwner || isSenderAdmin) return false;

  const messageType = mediaType(msg.message);

  if (mediaConfig.blocked_types.includes(messageType)) {
    logger.info(`[Media Control] Deleting ${messageType} from ${senderId} in ${groupId}.`);
    await sock.sendMessage(groupId, { delete: msg.key });
    await sock.sendMessage(groupId, {
      text: tr(
        `@${senderId.split("@")[0]}, *${messageType}* isn't allowed here.`,
        `يا @${senderId.split("@")[0]}، إرسال *${messageType}* ممنوع هنا.`,
      ),
      mentions: [senderId],
    });
    return true; // Action was taken
  }
  return false; // No action was taken
}

// Export both the command and the handler
module.exports = { ...command, handleMediaControl };
