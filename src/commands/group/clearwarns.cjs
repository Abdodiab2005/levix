// file: /commands/clearwarns.js
const { clearUserWarnings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "clearwarns",
  description: {
    en: "Clears all of a member's warnings.",
    ar: "يمسح كل تحذيرات عضو معيّن.",
  },
  usage: {
    en: "clearwarns @member",
    ar: "clearwarns @عضو",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    try {
      const groupId = msg.key.remoteJid;
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: tr(
            "Mention the member whose warnings you want to clear.",
            "يجب عمل منشن للعضو الذي تريد مسح تحذيراته.",
          ),
        });
      }

      // Call the new function from storage.js to delete the record from the database
      clearUserWarnings(groupId, mentionedJid);

      const replyText = tr(
        `✅ Cleared every warning for @${mentionedJid.split("@")[0]}.`,
        `✅ تم مسح جميع تحذيرات العضو @${mentionedJid.split("@")[0]} بنجاح.`,
      );
      await sock.sendMessage(groupId, {
        text: replyText,
        mentions: [mentionedJid],
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !clearwarns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: tr("Something went wrong while clearing the warnings.", "حدث خطأ أثناء مسح التحذيرات."),
      });
    }
  },
};
