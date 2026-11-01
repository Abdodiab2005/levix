// file: /commands/tagadmins.js
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "tagadmins",
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
          text: t("bot.group.tagadmins.noAdmins"),
        });
      }

      // Get the custom message provided by the user, or use a default one
      const customMessage = args.join(" ") || t("bot.group.tagadmins.defaultMessage");

      // Get an array of JIDs for the mentions property
      const mentions = admins.map((a) => a.id);

      let text = t("bot.group.tagadmins.header", { message: customMessage });

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
      await sock.sendMessage(groupId, { text: t("bot.group.tagadmins.failed") });
    }
  },
};
