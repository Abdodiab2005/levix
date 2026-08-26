// file: /commands/clearwarns.js
const { clearUserWarnings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "clearwarns",
  description: "Clears all warnings for a specific user.",
  usage: "clearwarns @عضو",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    try {
      const groupId = msg.key.remoteJid;
      const mentionedJid =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: "يجب عمل منشن للعضو الذي تريد مسح تحذيراته.",
        });
      }

      // Call the new function from storage.js to delete the record from the database
      clearUserWarnings(groupId, mentionedJid);

      const replyText = `✅ تم مسح جميع تحذيرات العضو @${
        mentionedJid.split("@")[0]
      } بنجاح.`;
      await sock.sendMessage(groupId, {
        text: replyText,
        mentions: [mentionedJid],
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !clearwarns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: "حدث خطأ أثناء مسح التحذيرات.",
      });
    }
  },
};
