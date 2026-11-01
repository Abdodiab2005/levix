// file: /commands/notes.js
const { getAllNotes } = require("../utils/storage.cjs");
const { t } = require("../utils/i18n.cjs");

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
        text: t("bot.core.notes.empty"),
      });
    }

    let reply = t("bot.core.notes.heading");
    reply += keywords.map((kw) => `\`#${kw}\``).join("\n");
    reply += t("bot.core.notes.footer");

    await sock.sendMessage(groupId, { text: reply });
  },
};
