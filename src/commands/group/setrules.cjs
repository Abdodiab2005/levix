const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setrules",
  description: {
    en: "Sets the rules for this group.",
    ar: "يضبط قواعد هذه المجموعة.",
  },
  usage: {
    en: "setrules <rules>",
    ar: "setrules <القواعد>",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const rulesText = args.join(" ");

    if (!rulesText) {
      return await sock.sendMessage(groupId, {
        text: tr(
          "Write the rules after the command.\n*Example:*\n`!setrules 1. Respect the members.\n2. No spam.`",
          "يرجى كتابة القواعد بعد الأمر.\n*مثال:*\n`!setrules 1. احترام الأعضاء.\n2. ممنوع السبام.`",
        ),
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
        text: tr("✅ The group's rules were saved.", "✅ تم حفظ قواعد الجروب بنجاح في قاعدة البيانات."),
      });
    } catch (error) {
      // Improved logging for better debugging
      logger.error({ err: error, groupId: groupId }, "Error in !setrules command");
      await sock.sendMessage(groupId, {
        text: tr("Something went wrong while saving the rules.", "حدث خطأ أثناء حفظ القواعد."),
      });
    }
  },
};
