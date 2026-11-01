// file: /commands/welcome.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "welcome",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0] ? args[0].toLowerCase() : "status"; // Default to showing status

    try {
      const settings = getGroupSettings(groupId);

      // Initialize the welcome system settings if they don't exist
      if (!settings.welcome_system) {
        settings.welcome_system = { enabled: false, messages: [] };
      }
      const welcomeConfig = settings.welcome_system;

      switch (subCommand) {
        case "on":
          welcomeConfig.enabled = true;
          await sock.sendMessage(groupId, {
            text: t("bot.group.welcome.enabled"),
          });
          break;

        case "off":
          welcomeConfig.enabled = false;
          await sock.sendMessage(groupId, {
            text: t("bot.group.welcome.disabled"),
          });
          break;

        case "add": {
          const messageToAdd = args.slice(1).join(" ");
          if (!messageToAdd || !messageToAdd.includes("${user}")) {
            return await sock.sendMessage(groupId, {
              text: t("bot.group.welcome.addUsage"),
            });
          }
          welcomeConfig.messages.push(messageToAdd);
          await sock.sendMessage(groupId, {
            text: t("bot.group.welcome.added"),
          });
          break;
        }

        case "list": {
          if (welcomeConfig.messages.length === 0) {
            return await sock.sendMessage(groupId, {
              text: t("bot.group.welcome.listEmpty"),
            });
          }
          let listReply = t("bot.group.welcome.listHeader");
          welcomeConfig.messages.forEach((message, index) => {
            listReply += `#${index + 1}: ${message}\n`;
          });
          await sock.sendMessage(groupId, { text: listReply });
          break;
        }

        case "delete": {
          const indexToDelete = parseInt(args[1]?.replace("#", ""), 10) - 1;
          if (
            isNaN(indexToDelete) ||
            indexToDelete < 0 ||
            indexToDelete >= welcomeConfig.messages.length
          ) {
            return await sock.sendMessage(groupId, {
              text: t("bot.group.welcome.deleteInvalid"),
            });
          }
          const deletedMessage = welcomeConfig.messages.splice(indexToDelete, 1);
          await sock.sendMessage(groupId, {
            text: t("bot.group.welcome.deleted", { message: deletedMessage[0] }),
          });
          break;
        }

        case "status":
        default: {
          const state = welcomeConfig.enabled
            ? t("bot.group.welcome.stateOn")
            : t("bot.group.welcome.stateOff");
          const statusReply = t("bot.group.welcome.status", {
            state,
            count: welcomeConfig.messages.length,
          });
          await sock.sendMessage(groupId, { text: statusReply });
          break;
        }
      }

      // Save the updated settings back to the database
      saveGroupSettings(groupId, settings);
    } catch (error) {
      logger.error({ err: error, command: "welcome" }, "Error in !welcome command");
      await sock.sendMessage(groupId, { text: t("bot.group.welcome.failed") });
    }
  },
};
