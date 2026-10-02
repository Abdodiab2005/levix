const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const brand = require("../config/brand.cjs");
const { ensureDataDir } = require("../config/paths.cjs");
const { downloadMedia } = require("./geminiMedia.cjs");
const { pickMedia, quotedOf } = require("./messageContent.cjs");
const media = require("../stickers/media.cjs");
const jobs = require("../stickers/jobs.cjs");
const library = require("../stickers/library.cjs");
const { StickerError, isStickerError, userMessage } = require("../stickers/errors.cjs");
const { BOT_VIDEO_MAX_SECONDS, WHATSAPP_MEDIA_MAX_BYTES } = require("../stickers/limits.cjs");
const { normalizeOptions } = require("../stickers/options.cjs");
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

// A full library cannot hand converted bytes back from studio.createFromBuffer.
// Keep the same converter and queue for a send that is intentionally not saved.
async function convertForSend(buffer, options) {
  const sniffed = media.sniff(buffer);
  if (!sniffed) throw new StickerError("UNSUPPORTED_TYPE");
  const file = path.join(ensureDataDir("tmp", "stickers"), `bot-${randomUUID()}.${sniffed.ext}`);
  try {
    fs.writeFileSync(file, buffer);
    const job = jobs.submit(
      ({ signal, progress }) =>
        media.createSticker({
          inputPath: file,
          sniffed,
          options: normalizeOptions(options),
          maxSourceSeconds: BOT_VIDEO_MAX_SECONDS,
          signal,
          onProgress: progress,
        }),
      { kind: "create" },
    );
    return (await job.promise).buffer;
  } finally {
    fs.rmSync(file, { force: true });
  }
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
  convertForSend,
  errorText,
};
