// file: /commands/group/approveall.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs"); // Note the path is ../../
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "approveall",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true, // The bot must be an admin to approve requests

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const option = args[0]?.toLowerCase();

    try {
      const settings = getGroupSettings(groupId);
      if (!settings.join_requests) {
        settings.join_requests = { auto_approve_enabled: false };
      }

      if (option === "on") {
        settings.join_requests.auto_approve_enabled = true;
        saveGroupSettings(groupId, settings);
        return await sock.sendMessage(groupId, {
          text: t("bot.group.approveall.enabled"),
        });
      } else if (option === "off") {
        settings.join_requests.auto_approve_enabled = false;
        saveGroupSettings(groupId, settings);
        return await sock.sendMessage(groupId, {
          text: t("bot.group.approveall.disabled"),
        });
      } else {
        const status = settings.join_requests.auto_approve_enabled
          ? t("bot.group.approveall.stateOn")
          : t("bot.group.approveall.stateOff");
        return await sock.sendMessage(groupId, {
          text: t("bot.group.approveall.status", { status }),
        });
      }
    } catch (error) {
      logger.error({ err: error, command: "approveall" }, "Error in !group approveall command");
      await sock.sendMessage(groupId, { text: t("bot.group.approveall.failed") });
    }
  },
};
