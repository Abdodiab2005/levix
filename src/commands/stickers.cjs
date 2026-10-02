const { tr } = require("../utils/i18n.cjs");
const { BOT_PAGE_SIZE } = require("../stickers/limits.cjs");
const { StickerError } = require("../stickers/errors.cjs");
const ownerModule = require("../stickers/owner.cjs");
const library = require("../stickers/library.cjs");
const { sendLibrarySticker, errorText } = require("../utils/stickerBot.cjs");

function parse(args) {
  const parts = [...args];
  let page = 1;
  if (/^[1-9]\d*$/.test(parts.at(-1) || "")) page = Number(parts.pop());
  if (!Number.isSafeInteger(page) || page > 1_000_000) throw new StickerError("INVALID_OPTIONS");
  const first = parts.shift()?.toLowerCase();
  if (!first || first === "recent" || first === "الأحدث") {
    if (parts.length) throw new StickerError("INVALID_OPTIONS");
    return { mode: "recent", page };
  }
  if (first === "favorites" || first === "المفضلة") {
    if (parts.length) throw new StickerError("INVALID_OPTIONS");
    return { mode: "favorites", page };
  }
  if (first === "pack" || first === "حزمة") {
    const name = parts.join(" ").trim();
    if (!name) throw new StickerError("INVALID_NAME");
    return { mode: "pack", name, page };
  }
  throw new StickerError("INVALID_OPTIONS");
}

module.exports = {
  name: "stickers",
  aliases: ["ملصقاتي"],
  description: {
    en: "Browse your recent, favorite or packed stickers.",
    ar: "يعرض ملصقاتك الحديثة أو المفضلة أو الموجودة في حزمة.",
  },
  usage: {
    en: "stickers [recent|favorites|pack <name>] [page]",
    ar: "stickers [الأحدث|المفضلة|حزمة <الاسم>] [الصفحة]",
  },
  keywords: ["recent", "الأحدث", "favorites", "المفضلة", "pack", "حزمة"],
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const who = ownerModule.forMessage(msg);
    if (!who.key)
      return sock.sendMessage(jid, {
        text: tr("I couldn't identify the sender.", "تعذّر تحديد هوية المرسل."),
      });
    try {
      const selected = parse(args);
      const query = { limit: BOT_PAGE_SIZE, offset: (selected.page - 1) * BOT_PAGE_SIZE };
      let label = tr("Recent stickers", "الملصقات الحديثة");
      if (selected.mode === "favorites") {
        query.filter = "favorites";
        label = tr("Favorite stickers", "الملصقات المفضلة");
      } else if (selected.mode === "pack") {
        const pack = library.findPackByName(who, selected.name);
        if (!pack) throw new StickerError("PACK_NOT_FOUND", { name: selected.name });
        query.pack = pack.id;
        label = pack.name;
      } else {
        query.filter = "recent";
        query.sort = "recent";
      }
      const { items, total } = library.listStickers(who, query);
      if (!total)
        return sock.sendMessage(jid, {
          text: tr(
            "No stickers here yet. Reply to media with !sticker or !pack <name> to save one.",
            "لا توجد ملصقات هنا بعد. رد على وسائط بالأمر !sticker أو !pack <الاسم> لحفظ ملصق.",
          ),
        });
      const pages = Math.ceil(total / BOT_PAGE_SIZE);
      if (selected.page > pages) throw new StickerError("INVALID_OPTIONS");
      const next =
        selected.mode === "pack"
          ? `!stickers pack ${selected.name} ${selected.page + 1}`
          : selected.mode === "favorites"
            ? `!stickers favorites ${selected.page + 1}`
            : `!stickers ${selected.page + 1}`;
      await sock.sendMessage(jid, {
        text: tr(
          `${label} — page ${selected.page}/${pages} · ${next} for more`,
          `${label} — الصفحة ${selected.page}/${pages} · ${next} للمزيد`,
        ),
      });
      for (const sticker of items) await sendLibrarySticker(sock, jid, who, sticker);
    } catch (error) {
      await sock.sendMessage(jid, { text: errorText(error) });
    }
  },
};
