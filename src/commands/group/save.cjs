// file: /commands/save.js
const { saveNote } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "save",
  description: {
    en: "Saves a new note for the group.",
    ar: "يحفظ ملاحظة جديدة للمجموعة.",
  },
  usage: {
    en: "save #keyword <note text>",
    ar: "save #الكلمة-المفتاحية <نص الملاحظة>",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const keywordArg = args[0];
    const noteText = args.slice(1).join(" ");

    if (!keywordArg || !keywordArg.startsWith("#") || !noteText) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.save.usageHint"),
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();

    try {
      // Simply call the new storage function
      saveNote(groupId, keyword, noteText);
      await sock.sendMessage(groupId, {
        text: t("bot.group.save.saved", { keyword }),
      });
    } catch (error) {
      logger.error({ err: error, command: "save" }, "Error in !save command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.save.failed"),
      });
    }
  },
};
