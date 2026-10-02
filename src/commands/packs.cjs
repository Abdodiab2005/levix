const { tr } = require("../utils/i18n.cjs");
const ownerModule = require("../stickers/owner.cjs");
const library = require("../stickers/library.cjs");
const { errorText } = require("../utils/stickerBot.cjs");

module.exports = {
  name: "packs",
  aliases: ["حزم"],
  description: {
    en: "List your sticker packs and library total.",
    ar: "يعرض حزم ملصقاتك وإجمالي المكتبة.",
  },
  usage: { en: "packs", ar: "packs" },
  chat: "all",
  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    const who = ownerModule.forMessage(msg);
    if (!who.key)
      return sock.sendMessage(jid, {
        text: tr("I couldn't identify the sender.", "تعذّر تحديد هوية المرسل."),
      });
    try {
      const packs = library.listPacks(who);
      const total = library.listStickers(who, { limit: 1 }).total;
      if (!packs.length)
        return sock.sendMessage(jid, {
          text: tr(
            `No packs yet. Reply to media with !pack <name> to start one. Library: ${total} stickers.`,
            `لا توجد حزم بعد. رد على وسائط بالأمر !pack <الاسم> لإنشاء حزمة. المكتبة: ${total} ملصق.`,
          ),
        });
      const lines = packs.slice(0, 30).map((pack) => `${pack.name} — ${pack.count}`);
      if (packs.length > 30)
        lines.push(tr(`and ${packs.length - 30} more`, `و${packs.length - 30} حزمة أخرى`));
      await sock.sendMessage(jid, {
        text: `${tr(`Your packs · Library: ${total} stickers`, `حزمك · المكتبة: ${total} ملصق`)}\n${lines.join("\n")}`,
      });
    } catch (error) {
      await sock.sendMessage(jid, { text: errorText(error) });
    }
  },
};
