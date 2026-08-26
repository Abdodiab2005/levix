// file: /commands/deletenote.js
const { deleteNote } = require("../../utils/storage.cjs");

module.exports = {
  name: "deletenote",
  description: "Deletes a saved note.",
  usage: "deletenote #الكلمة-المفتاحية",
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const keywordArg = args[0];

    if (!keywordArg || !keywordArg.startsWith("#")) {
      return await sock.sendMessage(groupId, {
        text: "صيغة غير صحيحة. استخدم: `!deletenote #keyword`",
      });
    }

    const keyword = keywordArg.slice(1).toLowerCase();

    if (deleteNote(groupId, keyword)) {
      await sock.sendMessage(groupId, {
        text: `☑️ تم حذف الملاحظة \`#${keyword}\` بنجاح.`,
      });
    } else {
      await sock.sendMessage(groupId, {
        text: `⚠️ لم يتم العثور على ملاحظة بالكلمة المفتاحية: \`${keywordArg}\``,
      });
    }
  },
};
