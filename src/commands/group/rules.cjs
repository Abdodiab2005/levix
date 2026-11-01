// file: /commands/group/rules.js
const { getGroupSettings } = require("../../utils/storage.cjs");
const { buildModerationSummary } = require("../../utils/moderationSummary.cjs");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "rules",
  chat: "group",

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    try {
      const settings = getGroupSettings(groupId);
      const rules = settings.rules;
      const summary = buildModerationSummary(settings);

      if (rules) {
        const reply = t("bot.group.rules.header", { name: msg.pushName, rules, summary });
        await sock.sendMessage(groupId, { text: reply });
      } else {
        await sock.sendMessage(groupId, {
          text: t("bot.group.rules.none") + `\n\n${summary}`,
        });
      }
    } catch (error) {
      logger.error(error, "[Error] in !rules command:");
      await sock.sendMessage(groupId, {
        text: t("bot.group.rules.failed"),
      });
    }
  },
};
