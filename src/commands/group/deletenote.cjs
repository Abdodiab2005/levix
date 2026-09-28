// file: /commands/deletenote.js
const { deleteNote } = require("../../utils/storage.cjs");
const { tr } = require("../../utils/i18n.cjs");

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
        text: tr(
          "Wrong format. Use: `!deletenote #keyword`",
          "صيغة غير صحيحة. استخدم: `!deletenote #keyword`",
        ),
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();

    if (deleteNote(groupId, keyword)) {
      await sock.sendMessage(groupId, {
        text: tr(`☑️ Deleted the note \`#${keyword}\`.`, `☑️ تم حذف الملاحظة \`#${keyword}\` بنجاح.`),
      });
    } else {
      await sock.sendMessage(groupId, {
        text: tr(
          `⚠️ No note has the keyword \`${keywordArg}\``,
          `⚠️ لم يتم العثور على ملاحظة بالكلمة المفتاحية: \`${keywordArg}\``,
        ),
      });
    }
  },
};
