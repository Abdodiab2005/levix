// file: /commands/note.js
const { getAllNotes, getNote } = require("../../utils/storage.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "note",
  description: {
    en: "Shows a saved note.",
    ar: "يعرض ملاحظة محفوظة.",
  },
  usage: {
    en: "note #keyword",
    ar: "note #الكلمة-المفتاحية",
  },
  chat: "all",

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const keywordArg = args[0];

    if (!keywordArg || !keywordArg.startsWith("#")) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.note.usageHint"),
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();
    const notes = getAllNotes(groupId);
    const noteText = getNote(groupId, keyword);

    if (noteText) {
      await sock.sendMessage(groupId, { text: noteText });
    } else {
      await sock.sendMessage(groupId, {
        text: t("bot.group.note.notFound", { keyword: keywordArg }),
      });
    }
  },
};
