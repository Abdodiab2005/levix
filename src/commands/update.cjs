// !update reports official metadata. The dispatcher owns permissions and routing.
const { t } = require("../utils/i18n.cjs");
const updates = require("../services/updateCheck.cjs");

module.exports = {
  name: "update",
  chat: "all",
  neutralArgs: true,
  async execute(sock, msg) {
    const update = await updates.checkForUpdates();
    await sock.sendMessage(
      msg.key.remoteJid,
      {
        text: t(`bot.core.update.${update.status}`, {
          currentVersion: update.currentVersion,
          latestVersion: update.latestVersion || "",
          url: update.url,
        }),
      },
      { levix: { category: "system" } },
    );
  },
};
