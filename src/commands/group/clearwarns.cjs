// file: /commands/clearwarns.js
const logger = require("../../utils/logger.cjs");
const { clearMemberModeration, targetFromCommand } = require("../../utils/moderationAction.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "clearwarns",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    try {
      const groupId = msg.key.remoteJid;
      const target = targetFromCommand(msg);
      const mentionedJid = target?.jid;

      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.clearwarns.mentionTheMemberWhoseWarnings"),
        });
      }

      clearMemberModeration(groupId, mentionedJid);

      const replyText = t("bot.moderation.clearwarns.clearedEveryWarningFor", { member: mentionedJid.split("@")[0] });
      await sock.sendMessage(groupId, {
        text: replyText,
        mentions: [mentionedJid],
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !clearwarns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.moderation.clearwarns.somethingWentWrongWhileClearing"),
      });
    }
  },
};
