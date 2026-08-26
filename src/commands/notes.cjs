// file: /commands/notes.js
const { getAllNotes } = require("../utils/storage.cjs");

module.exports = {
  name: "notes",
  description: "Lists all saved note keywords for the group.",
  usage: "notes",
  chat: "all",

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;
    const notes = getAllNotes(groupId);
    const groupNotes = notes[groupId] || {};
    const keywords = Object.keys(groupNotes);

    if (keywords.length === 0) {
      return await sock.sendMessage(groupId, {
        text: "لا توجد ملاحظات محفوظة في هذا الجروب.",
      });
    }

    let reply = "*🔑 الكلمات المفتاحية للملاحظات المحفوظة:*\n\n";
    reply += keywords.map((kw) => `\`#${kw}\``).join("\n");
    reply += "\n\nللحصول على ملاحظة، استخدم: `!note #keyword`";

    await sock.sendMessage(groupId, { text: reply });
  },
};
