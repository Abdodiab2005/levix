// file: /commands/removeall.js
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "removeall",
  description: {
    en: "Removes every non-admin member from the group, after confirmation.",
    ar: "يطرد كل الأعضاء غير المشرفين من المجموعة بعد التأكيد.",
  },
  usage: {
    en: "removeall",
    ar: "removeall",
  },
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata, confirmationSessions) {
    // This command's only job is to start the confirmation process.
    // The main logic is in index.js

    const senderId = msg.key.participant || msg.key.remoteJid;
    const groupId = msg.key.remoteJid;

    // Ask for confirmation
    await sock.sendMessage(groupId, {
      text: "⚠️ هل أنت متأكد من أنك تريد حذف جميع الأعضاء غير المشرفين؟\n\nأرسل `yes` للتأكيد خلال 30 ثانية.",
    });

    // Store the confirmation request
    confirmationSessions.set(senderId, {
      command: "removeall",
      groupId: groupId,
      timestamp: Date.now(),
    });

    // Set a timeout to delete the confirmation request after 30 seconds
    setTimeout(() => {
      if (confirmationSessions.has(senderId)) {
        confirmationSessions.delete(senderId);
        logger.info(`[Confirmation] Timed out for ${senderId} on command removeall.`);
      }
    }, 30000); // 30 seconds
  },
};
