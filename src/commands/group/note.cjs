// file: /commands/note.js
const { getAllNotes, getNote } = require("../../utils/storage.cjs");
const { tr } = require("../../utils/i18n.cjs");

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
        text: tr("Wrong format. Use: `!note #keyword`", "صيغة غير صحيحة. استخدم: `!note #keyword`"),
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();
    const notes = getAllNotes(groupId);
    const noteText = getNote(groupId, keyword);

    if (noteText) {
      await sock.sendMessage(groupId, { text: noteText });
    } else {
      await sock.sendMessage(groupId, {
        text: tr(
          `⚠️ No note has the keyword \`${keywordArg}\`\n\nTo see every note, use: \`!notes\``,
          `⚠️ لم يتم العثور على ملاحظة بالكلمة المفتاحية: \`${keywordArg}\`\n\nلعرض كل الملاحظات، استخدم: \`!notes\``,
        ),
      });
    }
  },
};
