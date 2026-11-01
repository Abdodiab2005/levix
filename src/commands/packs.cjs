const { tr, t } = require("../utils/i18n.cjs");
const { isolate } = require("../utils/bidi.cjs");
const ownerModule = require("../stickers/owner.cjs");
const library = require("../stickers/library.cjs");
const { commandHint, countLabel, errorText } = require("../utils/stickerBot.cjs");

module.exports = {
  name: "packs",
  aliases: ["حزم"],
  chat: "all",
  async execute(sock, msg) {
    const jid = msg.key.remoteJid;
    const who = await ownerModule.forMessage(msg, sock);
    if (!who.key)
      return sock.sendMessage(jid, {
        text: t("bot.stickers.packs.senderUnknown"),
      });
    try {
      const packs = library.listPacks(who);
      const total = library.listStickers(who, { limit: 1 }).total;
      if (!packs.length)
        return sock.sendMessage(jid, {
          text: tr(
            `No packs yet. Reply to media with ${commandHint("pack", "<name>")} to start one. Library: ${countLabel(total)}.`,
            `لا توجد حزم بعد. رد على وسائط بالأمر ${commandHint("pack", "<الاسم>")} لإنشاء حزمة. المكتبة: ${countLabel(total)}.`,
          ),
        });
      const lines = packs
        .slice(0, 30)
        .map((pack) => `${isolate(pack.name)} — ${countLabel(pack.count)}`);
      if (packs.length > 30)
        lines.push(t("bot.stickers.packs.more", { count: countLabel(packs.length - 30, "pack") }));
      await sock.sendMessage(jid, {
        text: `${t("bot.stickers.packs.header")} ${countLabel(total)}\n${lines.join("\n")}`,
      });
    } catch (error) {
      await sock.sendMessage(jid, { text: errorText(error) });
    }
  },
};
