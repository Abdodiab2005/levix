// file: /commands/warns.js
const { getUserWarnings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "warns",
  description: {
    en: "Shows a member's warnings.",
    ar: "يعرض تحذيرات عضو معيّن.",
  },
  usage: {
    en: "warns @member",
    ar: "warns @عضو",
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
            "Mention the member whose warnings you want to see.",
            "يجب عمل منشن للعضو الذي تريد عرض تحذيراته.",
          ),
        });
      }

      // Fetch warnings directly from the database
      const userWarnings = getUserWarnings(groupId, mentionedJid);

      if (userWarnings.length === 0) {
        return await sock.sendMessage(groupId, {
          text: tr(
            `✅ @${mentionedJid.split("@")[0]} has no warnings.`,
            `✅ لا توجد أي تحذيرات للعضو @${mentionedJid.split("@")[0]}.`,
          ),
          mentions: [mentionedJid],
        });
      }

      const who = mentionedJid.split("@")[0];
      let reply = tr(
        `*Warnings for @${who}:*\n*Total: ${userWarnings.length}*\n\n`,
        `*سجل تحذيرات @${who}:*\n*إجمالي التحذيرات: ${userWarnings.length}*\n\n`,
      );

      const mentionedAdmins = [];
      userWarnings.forEach((warning, index) => {
        const adminJid = warning.by;
        mentionedAdmins.push(adminJid);
        const warningDate = new Date(warning.date).toLocaleString(tr("en-GB", "ar-EG"), {
          timeZone: "Africa/Cairo",
        });

        reply += tr(
          `*${index + 1}. Warning:*\n` +
            `*Reason:* ${warning.reason}\n` +
            `*By:* @${adminJid.split("@")[0]}\n` +
            `*Date:* ${warningDate}\n\n`,
          `*${index + 1}. التحذير:*\n` +
            `*السبب:* ${warning.reason}\n` +
            `*بواسطة المشرف:* @${adminJid.split("@")[0]}\n` +
            `*التاريخ:* ${warningDate}\n\n`,
        );
      });

      const mentions = [mentionedJid, ...mentionedAdmins];

      await sock.sendMessage(groupId, {
        text: reply,
        mentions: mentions,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !warns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: tr("Something went wrong while listing the warnings.", "حدث خطأ أثناء عرض التحذيرات."),
      });
    }
  },
};
