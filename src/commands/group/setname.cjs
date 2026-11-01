// file: /commands/group/setname.js
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setname",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const newName = args.join(" ");

    if (!newName) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.setname.noName"),
      });
    }

    // WhatsApp has a limit of 25 characters for the subject
    if (newName.length > 25) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.setname.tooLong"),
      });
    }

    try {
      await sock.groupUpdateSubject(groupId, newName);
      await sock.sendMessage(groupId, {
        text: t("bot.group.setname.done", { name: newName }),
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !group setname command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.setname.failed"),
      });
    }
  },
};
