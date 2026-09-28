// file: /commands/notes.js
const { getAllNotes } = require("../utils/storage.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "notes",
  description: {
    en: "Lists all saved note keywords for the group.",
    ar: "يعرض الكلمات المفتاحية لكل الملاحظات المحفوظة في المجموعة.",
  },
  usage: {
    en: "notes",
    ar: "notes",
  },
  chat: "all",

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;
    const notes = getAllNotes(groupId);
    const groupNotes = notes[groupId] || {};
    const keywords = Object.keys(groupNotes);

    if (keywords.length === 0) {
      return await sock.sendMessage(groupId, {
        text: tr("This group has no saved notes.", "لا توجد ملاحظات محفوظة في هذا الجروب."),
      });
    }

    let reply = tr("*🔑 Saved note keywords:*\n\n", "*🔑 الكلمات المفتاحية للملاحظات المحفوظة:*\n\n");
    reply += keywords.map((kw) => `\`#${kw}\``).join("\n");
    reply += tr(
      "\n\nTo get a note, use: `!note #keyword`",
      "\n\nللحصول على ملاحظة، استخدم: `!note #keyword`",
    );

    await sock.sendMessage(groupId, { text: reply });
  },
};
