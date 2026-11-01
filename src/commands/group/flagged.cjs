const { listModerationFlags } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

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
          text: tr("No members are waiting for review.", "لا يوجد أعضاء بانتظار المراجعة."),
        });
      }
      const mentions = flags.map((row) => row.user_id);
      const lines = [
        tr(
          `*Flagged members* (${flags.length})`,
          `*الأعضاء المعلَّمون للمراجعة* (${flags.length})`,
        ),
      ];
      for (const row of flags) {
        const tag = `@${String(row.user_id).split("@")[0]}`;
        const when = row.flagged_at ? new Date(row.flagged_at).toISOString() : "";
        lines.push(
          tr(
            `• ${tag} — warnings ${row.warn_count}, last: ${row.last_rule || "—"}${when ? `, ${when}` : ""}`,
            `• ${tag} — الإنذارات ${row.warn_count}، آخر مخالفة: ${row.last_rule || "—"}${when ? `، ${when}` : ""}`,
          ),
        );
      }
      await sock.sendMessage(groupId, { text: lines.join("\n"), mentions });
    } catch (error) {
      logger.error({ err: error }, "Error in !flagged command");
      await sock.sendMessage(groupId, {
        text: tr("Something went wrong while listing flagged members.", "حدث خطأ أثناء عرض الأعضاء المعلَّمين."),
      });
    }
  },
};
