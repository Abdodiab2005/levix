const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const brand = require("../config/brand.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { downloadMedia } = require("./geminiMedia.cjs");
const { pickMedia, quotedOf } = require("./messageContent.cjs");
const media = require("../stickers/media.cjs");
const library = require("../stickers/library.cjs");
const { StickerError, isStickerError, userMessage } = require("../stickers/errors.cjs");
const { WHATSAPP_MEDIA_MAX_BYTES } = require("../stickers/limits.cjs");
const { t, currentLang } = require("./i18n.cjs");

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

// The old Arabic phrase uses one form through 10 and another after that.
// CLDR "few" also covers 103 and 203, so the count passed to t() is a number
// in the category that matches the old phrase. {n} is the number shown.
// Arabic for 1 and 2 has no digit. Every plural category still has to contain
// {n}, so those two pass an empty {n}.
function countPluralCount(n) {
  if (n === 1 || n === 2 || n === 0) return n;
  if (n <= 10) return 3;
  const mod = Math.abs(n % 100);
  if (mod >= 3 && mod <= 10) return 11;
  return n;
}

function countLabel(count, kind = "sticker") {
  const n = Number(count);
  const key = kind === "pack" ? "bot.stickers.count.pack" : "bot.stickers.count.sticker";
  const bare = currentLang() === "ar" && (n === 1 || n === 2);
  return t(key, { count: countPluralCount(n), n: bare ? "" : n });
}

function errorText(error) {
  return isStickerError(error) ? userMessage(error) : t("bot.stickers.errors.internal");
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
