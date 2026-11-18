// file: /commands/removeall.js
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "removeall",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  // Removing every member at once is disabled. The old confirmation flow had no
  // consumer, so the command only says so and removes nobody.
  async execute(sock, msg) {
    await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.group.removeall.unavailable"),
    });
  },
};
