// file: /commands/deletenote.js
const { deleteNote } = require("../../utils/storage.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "deletenote",
  description: {
    en: "Deletes a saved note.",
    ar: "يحذف ملاحظة محفوظة.",
  },
  usage: {
    en: "deletenote #keyword",
    ar: "deletenote #الكلمة-المفتاحية",
  },
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const keywordArg = args[0];

    if (!keywordArg || !keywordArg.startsWith("#")) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.deletenote.usageHint"),
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();

    if (deleteNote(groupId, keyword)) {
      await sock.sendMessage(groupId, {
        text: t("bot.group.deletenote.deleted", { keyword }),
      });
    } else {
      await sock.sendMessage(groupId, {
        text: t("bot.group.deletenote.notFound", { keyword: keywordArg }),
      });
    }
  },
};
