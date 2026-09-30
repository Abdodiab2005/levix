// file: /commands/group/rules.js
const { getGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "rules",
  description: {
    en: "Shows the group rules.",
    ar: "يعرض قواعد المجموعة.",
  },
  usage: {
    en: "rules",
    ar: "rules",
  },
  chat: "group",

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    try {
      const settings = getGroupSettings(groupId);
      const rules = settings.rules;

      if (rules) {
        const reply = tr(
          `*📜 Rules of ${msg.pushName}'s group:*\n\n${rules}`,
          `*📜 قواعد جروب ${msg.pushName}:*\n\n${rules}`,
        );
        await sock.sendMessage(groupId, { text: reply });
      } else {
        await sock.sendMessage(groupId, {
          text: tr(
            "This group has no rules yet. Admins can set them with `!setrules`.",
            "لم يتم تعيين أي قواعد لهذه المجموعة حتى الآن. يمكن للمشرفين تعيينها باستخدام `!setrules`.",
          ),
        });
      }
    } catch (error) {
      logger.error(error, "[Error] in !rules command:");
      await sock.sendMessage(groupId, {
        text: tr("Something went wrong while fetching the rules.", "حدث خطأ أثناء جلب القواعد."),
      });
    }
  },
};
