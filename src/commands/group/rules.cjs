// file: /commands/group/rules.js
const { getGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "rules",
  description: "Displays the group rules.",
  usage: "rules",
  chat: "group",

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    try {
      const settings = getGroupSettings(groupId);
      const rules = settings.rules;

      if (rules) {
        const reply = `*📜 قواعد جروب ${msg.pushName}:*\n\n${rules}`;
        await sock.sendMessage(groupId, { text: reply });
      } else {
        await sock.sendMessage(groupId, {
          text: "لم يتم تعيين أي قواعد لهذا الجروب حتى الآن. يمكن للمشرفين تعيينها باستخدام `!setrules`.",
        });
      }
    } catch (error) {
      logger.error(error, "[Error] in !rules command:");
      await sock.sendMessage(groupId, { text: "حدث خطأ أثناء جلب القواعد." });
    }
  },
};
