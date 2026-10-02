const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const brand = require("../config/brand.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { downloadMedia } = require("./geminiMedia.cjs");
const { pickMedia, quotedOf } = require("./messageContent.cjs");
const media = require("../stickers/media.cjs");
const library = require("../stickers/library.cjs");
const { StickerError, isStickerError, userMessage } = require("../stickers/errors.cjs");
const { WHATSAPP_MEDIA_MAX_BYTES } = require("../stickers/limits.cjs");
const { tr } = require("./i18n.cjs");

function targetOf(msg, { quotedOnly = false } = {}) {
  const quoted = quotedOf(msg);
  return quotedOnly
    ? quoted
      ? pickMedia(quoted)
      : null
    : pickMedia(msg.message) || (quoted ? pickMedia(quoted) : null);
}

async function downloadTarget(target) {
  if (!target) throw new StickerError("NO_MEDIA");
  const size = Number(target.media?.fileLength?.toString?.() ?? target.media?.fileLength);
  if (Number.isFinite(size) && size > WHATSAPP_MEDIA_MAX_BYTES) {
    throw new StickerError("TOO_LARGE", { limitBytes: WHATSAPP_MEDIA_MAX_BYTES });
  }
  const buffer = await downloadMedia(downloadContentFromMessage, target.media, target.type);
  if (buffer.length > WHATSAPP_MEDIA_MAX_BYTES) {
    throw new StickerError("TOO_LARGE", { limitBytes: WHATSAPP_MEDIA_MAX_BYTES });
  }
  return buffer;
}

function firstPackName(owner, sticker) {
  if (!sticker?.packIds?.length) return brand.name;
  return library.getPack(owner, sticker.packIds[0]).pack.name;
}

function packedSticker(buffer, name = brand.name) {
  return media.withStickerMetadata(buffer, { packName: name, publisher: brand.name });
}

async function sendLibrarySticker(sock, jid, owner, sticker) {
  const buffer = library.readStickerFile(owner, sticker.id);
  await sock.sendMessage(jid, { sticker: packedSticker(buffer, firstPackName(owner, sticker)) });
  library.touch(owner, [sticker.id]);
}

function commandHint(name, args = "") {
  return `${runtimeConfig.getPrefix()}${name}${args ? ` ${args}` : ""}`;
}

function countLabel(count, kind = "sticker") {
  const n = Number(count);
  const singular = kind === "pack" ? "pack" : "sticker";
  const english = `${n} ${singular}${n === 1 ? "" : "s"}`;
  if (kind === "pack") {
    return tr(
      english,
      n === 1 ? "حزمة واحدة" : n === 2 ? "حزمتان" : n <= 10 ? `${n} حزم` : `${n} حزمة`,
    );
  }
  return tr(
    english,
    n === 1 ? "ملصق واحد" : n === 2 ? "ملصقان" : n <= 10 ? `${n} ملصقات` : `${n} ملصقًا`,
  );
}

function errorText(error) {
  return isStickerError(error)
    ? userMessage(error)
    : tr("Something went wrong with the sticker.", "حدث خطأ في الملصق.");
}

module.exports = {
  targetOf,
  downloadTarget,
  packedSticker,
  firstPackName,
  sendLibrarySticker,
  commandHint,
  countLabel,
  errorText,
};
