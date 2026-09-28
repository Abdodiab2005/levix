// file: /commands/tagadmins.js
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "tagadmins",
  description: {
    en: "Mentions every admin in the group.",
    ar: "يذكر (منشن) جميع مشرفي المجموعة.",
  },
  usage: {
    en: "tagadmins [message]",
    ar: "tagadmins [رسالة]",
  },
  chat: "group",

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;

    try {
      // Filter the participants to get only admins and superadmins
      const admins = groupMetadata.participants.filter(
        (p) => p.admin === "admin" || p.admin === "superadmin",
      );

      if (admins.length === 0) {
        return await sock.sendMessage(groupId, {
          text: tr("This group has no admins.", "لا يوجد مشرفون في هذا الجروب."),
        });
      }

      // Get the custom message provided by the user, or use a default one
      const customMessage = args.join(" ") || tr("Admins, please come here", "يرجى حضور المشرفين");

      // Get an array of JIDs for the mentions property
      const mentions = admins.map((a) => a.id);

      let text = tr(
        `*🚨 Calling the admins 🚨*\n\n*Message:* ${customMessage}\n\n`,
        `*🚨 تنبيه للمشرفين 🚨*\n\n*الرسالة:* ${customMessage}\n\n`,
      );

      // Add a tag for each admin
      for (const admin of admins) {
        text += `» @${admin.id.split("@")[0]}\n`;
      }

      await sock.sendMessage(groupId, {
        text: text,
        mentions: mentions,
      });
    } catch (error) {
      logger.error({ err: error, command: "tagadmins" }, "Error in !tagadmins command");
      await sock.sendMessage(groupId, { text: tr("Something went wrong.", "حدث خطأ.") });
    }
  },
};
