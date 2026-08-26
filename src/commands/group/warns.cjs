// file: /commands/warns.js
const { getUserWarnings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "warns",
  description: "Displays the warnings for a specific user.",
  usage: "warns @عضو",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    try {
      const groupId = msg.key.remoteJid;
      const mentionedJid =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: "يجب عمل منشن للعضو الذي تريد عرض تحذيراته.",
        });
      }

      // Fetch warnings directly from the database
      const userWarnings = getUserWarnings(groupId, mentionedJid);

      if (userWarnings.length === 0) {
        return await sock.sendMessage(groupId, {
          text: `✅ لا توجد أي تحذيرات للعضو @${mentionedJid.split("@")[0]}.`,
          mentions: [mentionedJid],
        });
      }

      let reply = `*سجل تحذيرات @${
        mentionedJid.split("@")[0]
      }:*\n*إجمالي التحذيرات: ${userWarnings.length}*\n\n`;

      const mentionedAdmins = [];
      userWarnings.forEach((warning, index) => {
        const adminJid = warning.by;
        mentionedAdmins.push(adminJid);
        const warningDate = new Date(warning.date).toLocaleString("ar-EG", {
          timeZone: "Africa/Cairo",
        });

        reply +=
          `*${index + 1}. التحذير:*\n` +
          `*السبب:* ${warning.reason}\n` +
          `*بواسطة المشرف:* @${adminJid.split("@")[0]}\n` +
          `*التاريخ:* ${warningDate}\n\n`;
      });

      const mentions = [mentionedJid, ...mentionedAdmins];

      await sock.sendMessage(groupId, {
        text: reply,
        mentions: mentions,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !warns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: "حدث خطأ أثناء عرض التحذيرات.",
      });
    }
  },
};
