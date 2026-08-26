// file: /commands/group/media.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const {
  isOwnerJidSync,
  isAdminInGroupSync,
} = require("../../utils/permissions.cjs");

const VALID_TYPES = ["image", "video", "sticker", "audio"];

// --- The Main Command Logic ---
const command = {
  name: "media",
  description: "Controls which message types are allowed in the group.",
  usage: "media [status]\nmedia <on|off>\nmedia <block|unblock> <image|video|sticker|audio>",
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
          text: "✅ تم تفعيل نظام مراقبة الوسائط.",
        });
        break;
      case "off":
        mediaConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: "☑️ تم تعطيل نظام مراقبة الوسائط.",
        });
        break;
      case "block":
        const typeToBlock = args[1] ? args[1].toLowerCase() : "";
        if (!VALID_TYPES.includes(typeToBlock))
          return await sock.sendMessage(groupId, {
            text: `نوع غير صالح. الأنواع المتاحة: ${VALID_TYPES.join(", ")}`,
          });
        if (!mediaConfig.blocked_types.includes(typeToBlock)) {
          mediaConfig.blocked_types.push(typeToBlock);
        }
        await sock.sendMessage(groupId, {
          text: `✅ تم إضافة '${typeToBlock}' للأنواع الممنوعة.`,
        });
        break;
      case "unblock":
        const typeToUnblock = args[1] ? args[1].toLowerCase() : "";
        if (!typeToUnblock)
          return await sock.sendMessage(groupId, {
            text: "يرجى تحديد نوع لإلغاء حظره.",
          });
        mediaConfig.blocked_types = mediaConfig.blocked_types.filter(
          (t) => t !== typeToUnblock
        );
        await sock.sendMessage(groupId, {
          text: `☑️ تم إزالة '${typeToUnblock}' من الأنواع الممنوعة.`,
        });
        break;
      default: // 'status'
        let statusReply = `*حالة نظام مراقبة الوسائط:*\n\n`;
        statusReply += `الحالة: ${
          mediaConfig.enabled ? "مفعل ✅" : "معطل ☑️"
        }\n`;
        statusReply += `الأنواع الممنوعة: ${
          mediaConfig.blocked_types.join(", ") || "لا يوجد"
        }`;
        await sock.sendMessage(groupId, { text: statusReply });
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

  const groupMetadata = await sock.groupMetadata(groupId);
  const isOwner = isOwnerJidSync(senderId);
  const isSenderAdmin = isAdminInGroupSync(groupMetadata, senderId);

  if (isOwner || isSenderAdmin) return false;

  const messageType = Object.keys(msg.message)[0]
    .replace("Message", "")
    .toLowerCase();

  if (mediaConfig.blocked_types.includes(messageType)) {
    logger.info(
      `[Media Control] Deleting ${messageType} from ${senderId} in ${groupId}.`
    );
    await sock.sendMessage(groupId, { delete: msg.key });
    await sock.sendMessage(groupId, {
      text: `يا @${senderId.split("@")[0]}، إرسال *${messageType}* ممنوع هنا.`,
      mentions: [senderId],
    });
    return true; // Action was taken
  }
  return false; // No action was taken
}

// Export both the command and the handler
module.exports = { ...command, handleMediaControl };
