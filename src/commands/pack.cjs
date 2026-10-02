const { tr } = require("../utils/i18n.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const {
  targetOf,
  downloadTarget,
  packedSticker,
  firstPackName,
  errorText,
} = require("../utils/stickerBot.cjs");
const { StickerError } = require("../stickers/errors.cjs");
const { BOT_VIDEO_MAX_SECONDS, PACK_SUBCOMMANDS } = require("../stickers/limits.cjs");
const ownerModule = require("../stickers/owner.cjs");
const library = require("../stickers/library.cjs");
const studio = require("../stickers/studio.cjs");

const keywords = Object.values(PACK_SUBCOMMANDS).flat();

function parse(args) {
  const [first, ...rest] = args;
  const action =
    Object.entries(PACK_SUBCOMMANDS).find(([, words]) => words.includes(first))?.[0] || "auto";
  if (action === "rename") {
    const text = rest.join(" ").trim();
    const names = text.includes("|")
      ? text.split("|").map((s) => s.trim())
      : rest.length === 2
        ? rest
        : [];
    return {
      action,
      oldName: names[0] || "",
      newName: names[1] || "",
      valid: names.length === 2 && names.every(Boolean),
    };
  }
  return { action, name: (action === "auto" ? args : rest).join(" ").trim() };
}

function requirePack(who, name) {
  const pack = library.findPackByName(who, name);
  if (!pack) throw new StickerError("PACK_NOT_FOUND", { name });
  return pack;
}

function findQuotedSticker(who, packId, buffer) {
  for (const sticker of library.getPack(who, packId).items) {
    const raw = library.readStickerFile(who, sticker.id);
    if (raw.equals(buffer) || packedSticker(raw, firstPackName(who, sticker)).equals(buffer)) {
      return sticker;
    }
  }
  throw new StickerError("NOT_FOUND");
}

module.exports = {
  name: "pack",
  aliases: ["حزمة"],
  description: {
    en: "Create, fill and manage your sticker packs.",
    ar: "ينشئ حزم الملصقات ويديرها ويضيف إليها.",
  },
  usage: {
    en: "pack <name> (reply to media to add); pack create|add|remove|show|delete <name>; pack rename <old> | <new>",
    ar: "pack <الاسم> (رد على وسائط للإضافة)؛ pack إنشاء|إضافة|إزالة|عرض|حذف <الاسم>؛ pack تسمية <القديم> | <الجديد>",
  },
  keywords,
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const who = ownerModule.forMessage(msg);
    if (!who.key)
      return sock.sendMessage(jid, {
        text: tr("I couldn't identify the sender.", "تعذّر تحديد هوية المرسل."),
      });
    const parsed = parse(args);
    let status;
    try {
      let line;
      if (parsed.action === "rename") {
        if (!parsed.valid) throw new StickerError("INVALID_NAME");
        const pack = requirePack(who, parsed.oldName);
        const renamed = library.updatePack(who, pack.id, parsed.newName);
        line = tr(`Renamed pack to ${renamed.name}.`, `أُعيدت تسمية الحزمة إلى ${renamed.name}.`);
      } else if (!parsed.name) {
        line = tr(
          "Use !pack <name> while replying to media, or !pack create <name>.",
          "استخدم !pack <الاسم> عند الرد على وسائط، أو !pack إنشاء <الاسم>.",
        );
      } else if (parsed.action === "create") {
        const pack = library.createPack(who, parsed.name);
        line = tr(`Created pack ${pack.name}.`, `أُنشئت الحزمة ${pack.name}.`);
      } else if (parsed.action === "delete") {
        const pack = requirePack(who, parsed.name);
        library.deletePack(who, pack.id);
        line = tr(
          `Deleted pack ${pack.name}. Its stickers remain in your library.`,
          `حُذفت الحزمة ${pack.name}. بقيت ملصقاتها في مكتبتك.`,
        );
      } else if (parsed.action === "remove") {
        const pack = requirePack(who, parsed.name);
        const target = targetOf(msg, { quotedOnly: true });
        if (target?.type !== "sticker") throw new StickerError("NO_MEDIA");
        const buffer = await downloadTarget(target);
        const sticker = findQuotedSticker(who, pack.id, buffer);
        const removed = library.removeFromPack(who, pack.id, [sticker.id]);
        if (!removed.affected) throw new StickerError("NOT_FOUND");
        line = tr(
          `Removed the sticker from ${pack.name}. It remains in your library.`,
          `أُزيل الملصق من ${pack.name}. بقي في مكتبتك.`,
        );
      } else {
        const target = targetOf(msg, { quotedOnly: true });
        if (parsed.action === "show" || (parsed.action === "auto" && !target)) {
          const pack = requirePack(who, parsed.name);
          line = tr(
            `${pack.name} — ${pack.count} stickers. Use !stickers pack ${pack.name} to see them.`,
            `${pack.name} — ${pack.count} ملصق. استخدم !stickers حزمة ${pack.name} لعرضها.`,
          );
        } else {
          if (!target) throw new StickerError("NO_MEDIA");
          let pack = library.findPackByName(who, parsed.name);
          if (!pack) pack = library.createPack(who, parsed.name);
          const buffer = await downloadTarget(target);
          status = await createStatus(
            sock,
            jid,
            tr("🎨 Saving sticker...", "🎨 جارٍ حفظ الملصق..."),
            { replyTo: msg },
          );
          const { promise } = studio.createFromBuffer({
            owner: who,
            buffer,
            source: target.type === "sticker" ? "WHATSAPP_STICKER" : "BOT_COMMAND",
            packId: pack.id,
            maxSourceSeconds: BOT_VIDEO_MAX_SECONDS,
          });
          const result = await promise;
          line = result.created
            ? tr(`Saved sticker to ${pack.name}.`, `حُفظ الملصق في ${pack.name}.`)
            : tr(
                `Already in your library; added to ${pack.name}.`,
                `الملصق موجود في مكتبتك بالفعل؛ أُضيف إلى ${pack.name}.`,
              );
        }
      }
      if (status) await status.finish(line);
      else await sock.sendMessage(jid, { text: line });
    } catch (error) {
      const line = errorText(error);
      if (status) await status.finish(line);
      else await sock.sendMessage(jid, { text: line });
    }
  },
};
