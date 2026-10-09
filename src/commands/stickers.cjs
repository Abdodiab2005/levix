const { tr } = require("../utils/i18n.cjs");
const { isolate } = require("../utils/bidi.cjs");
const { BOT_PAGE_SIZE } = require("../stickers/limits.cjs");
const { StickerError } = require("../stickers/errors.cjs");
const ownerModule = require("../stickers/owner.cjs");
const library = require("../stickers/library.cjs");
const {
  sendLibrarySticker,
  commandHint,
  countLabel,
  errorText,
} = require("../utils/stickerBot.cjs");

function parse(args) {
  const parts = [...args];
  let page = 1;
  let pageExplicit = false;
  if (/^[1-9]\d*$/.test(parts.at(-1) || "")) {
    page = Number(parts.pop());
    pageExplicit = true;
  }
  if (!Number.isSafeInteger(page) || page > 1_000_000) throw new StickerError("INVALID_OPTIONS");
  const first = parts.shift()?.toLowerCase();
  if (!first || first === "recent" || first === "الأحدث") {
    if (parts.length) throw new StickerError("INVALID_OPTIONS");
    return { mode: "recent", page, pageExplicit };
  }
  if (first === "favorites" || first === "المفضلة") {
    if (parts.length) throw new StickerError("INVALID_OPTIONS");
    return { mode: "favorites", page, pageExplicit };
  }
  if (first === "pack" || first === "حزمة") {
    const name = parts.join(" ").trim();
    if (!name) throw new StickerError("INVALID_NAME");
    const fullName = pageExplicit ? `${name} ${page}` : name;
    return { mode: "pack", name, fullName, page, pageExplicit };
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
    en: "stickers [page]\nstickers recent [page]\nstickers favorites [page]\nstickers pack <name> [page]",
    ar: "stickers [الصفحة]\nstickers الأحدث [الصفحة]\nstickers المفضلة [الصفحة]\nstickers حزمة <الاسم> [الصفحة]",
  },
  keywords: ["recent", "الأحدث", "favorites", "المفضلة", "pack", "حزمة"],
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const who = await ownerModule.forMessage(msg, sock);
    if (!who.key)
      return sock.sendMessage(jid, {
        text: tr("I couldn't identify the sender.", "تعذّر تحديد هوية المرسل."),
      });
    try {
      const selected = parse(args);
      const query = { limit: BOT_PAGE_SIZE };
      let label = tr("Recent stickers", "الملصقات الحديثة");
      if (selected.mode === "favorites") {
        query.filter = "favorites";
        label = tr("Favorite stickers", "الملصقات المفضلة");
      } else if (selected.mode === "pack") {
        // A trailing number is a page unless the whole text names an existing
        // pack (a pack can itself end in a number: "عيد 2").
        let name = selected.name;
        if (selected.pageExplicit) {
          const asName = library.findPackByName(who, selected.fullName);
          if (asName) {
            name = selected.fullName;
            selected.page = 1;
          }
        }
        const pack = library.findPackByName(who, name);
        if (!pack) throw new StickerError("PACK_NOT_FOUND", { name });
        query.pack = pack.id;
        selected.name = pack.name;
        label = isolate(pack.name);
      } else {
        query.filter = "all";
        query.sort = "recent";
      }
      query.offset = (selected.page - 1) * BOT_PAGE_SIZE;
      const { items, total } = library.listStickers(who, query);
      if (!total)
        return sock.sendMessage(jid, {
          text: tr(
            `No stickers here yet. Reply to media with ${commandHint("sticker")} or ${commandHint("pack", "<name>")} to save one.`,
            `لا توجد ملصقات هنا بعد. رد على وسائط بالأمر ${commandHint("sticker")} أو ${commandHint("pack", "<الاسم>")} لحفظ ملصق.`,
          ),
        });
      const pages = Math.ceil(total / BOT_PAGE_SIZE);
      if (selected.page > pages) throw new StickerError("INVALID_OPTIONS");
      const next =
        selected.page < pages
          ? selected.mode === "pack"
            ? commandHint("stickers", `pack ${selected.name} ${selected.page + 1}`)
            : selected.mode === "favorites"
              ? commandHint("stickers", `favorites ${selected.page + 1}`)
              : commandHint("stickers", String(selected.page + 1))
          : null;
      await sock.sendMessage(jid, {
        text: tr(
          `${label} — ${countLabel(total)} · page ${selected.page}/${pages}${next ? ` · ${next} for more` : ""}`,
          `${label} — ${countLabel(total)} · الصفحة ${selected.page}/${pages}${next ? ` · ${next} للمزيد` : ""}`,
        ),
      });
      for (const sticker of items) await sendLibrarySticker(sock, jid, who, sticker);
    } catch (error) {
      await sock.sendMessage(jid, { text: errorText(error) });
    }
  },
};
