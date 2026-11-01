const { listModerationFlags } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "flagged",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;
    try {
      const flags = listModerationFlags(groupId);
      if (!flags.length) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.flagged.noMembersAreWaitingFor"),
        });
      }
      const mentions = flags.map((row) => row.user_id);
      const lines = [
        t("bot.moderation.flagged.flaggedMembers", { count: flags.length }),
      ];
      for (const row of flags) {
        const tag = `@${String(row.user_id).split("@")[0]}`;
        const when = row.flagged_at ? new Date(row.flagged_at).toISOString() : "";
        lines.push(
          t("bot.moderation.flagged.line", {
            tag,
            count: row.warn_count,
            rule: row.last_rule || "—",
            when: when ? t("bot.moderation.flagged.when", { when }) : "",
          }),
        );
      }
      await sock.sendMessage(groupId, { text: lines.join("\n"), mentions });
    } catch (error) {
      logger.error({ err: error }, "Error in !flagged command");
      await sock.sendMessage(groupId, {
        text: t("bot.moderation.flagged.somethingWentWrongWhileListing"),
      });
    }
  },
};
