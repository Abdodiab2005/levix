const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setrules",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const rulesText = args.join(" ");

    if (!rulesText) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.setrules.usageHint"),
      });
    }

    try {
      // 1. Get the settings object. It will be {} if the group is new.
      const settings = getGroupSettings(groupId);

      // 2. Add or update the 'rules' property on the object.
      settings.rules = rulesText;

      // 3. Save the entire updated settings object back to the database.
      saveGroupSettings(groupId, settings);

      await sock.sendMessage(groupId, {
        text: t("bot.group.setrules.saved"),
      });
    } catch (error) {
      // Improved logging for better debugging
      logger.error({ err: error, groupId: groupId }, "Error in !setrules command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.setrules.failed"),
      });
    }
  },
};
