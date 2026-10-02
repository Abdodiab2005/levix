const { tr } = require("../utils/i18n.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const {
  targetOf,
  downloadTarget,
  packedSticker,
  sendLibrarySticker,
  errorText,
} = require("../utils/stickerBot.cjs");
const { quotedOf, pickMedia } = require("../utils/messageContent.cjs");
const { StickerError } = require("../stickers/errors.cjs");
const { BOT_VIDEO_MAX_SECONDS } = require("../stickers/limits.cjs");
const ownerModule = require("../stickers/owner.cjs");
const media = require("../stickers/media.cjs");
const library = require("../stickers/library.cjs");
const studio = require("../stickers/studio.cjs");
const toimage = require("./toimage.cjs");

module.exports = {
  name: "sticker",
  aliases: ["s", "ملصق", "tosticker"],
  description: {
    en: "Create a sticker from an image, GIF or video.",
    ar: "ينشئ ملصقًا من صورة أو صورة متحركة أو فيديو.",
  },
  usage: {
    en: "sticker [crop] [nobg] (attach an image, GIF or video)\nsticker [crop] [nobg] (reply to media)\nsticker (reply to a sticker for PNG)",
    ar: "sticker [قص] [بدون-خلفية] (أرفق صورة أو صورة متحركة أو فيديو)\nsticker [قص] [بدون-خلفية] (رد على وسائط)\nsticker (رد على ملصق لصورة PNG)",
  },
  keywords: ["crop", "قص", "nobg", "بدون-خلفية"],
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const quoted = quotedOf(msg);
    if (quoted && pickMedia(quoted)?.type === "sticker") {
      return toimage.execute(sock, msg, []);
    }
    const who = await ownerModule.forMessage(msg, sock);
    if (!who.key) {
      return sock.sendMessage(jid, {
        text: tr("I couldn't identify the sender.", "تعذّر تحديد هوية المرسل."),
      });
    }
    const target = targetOf(msg);
    if (!target) return sock.sendMessage(jid, { text: errorText(new StickerError("NO_MEDIA")) });
    let status;
    try {
      if (
        target.type === "audio" ||
        (target.type === "document" && !/^(image|video)\//i.test(target.media?.mimetype || ""))
      )
        throw new StickerError("UNSUPPORTED_TYPE");
      const words = new Set(args.map((arg) => String(arg).toLowerCase()));
      const options = {};
      if (words.has("crop") || words.has("قص")) options.fit = "cover";
      if (words.has("nobg") || words.has("بدون-خلفية")) {
        const cap = await media.capabilities();
        if (!cap.backgroundRemoval.includes("plain")) throw new StickerError("ENCODER_MISSING");
        options.removeBackground = { mode: "plain" };
      }
      const buffer = await downloadTarget(target);
      if (!media.sniff(buffer)) throw new StickerError("UNSUPPORTED_TYPE");
      status = await createStatus(
        sock,
        jid,
        tr("🎨 Creating sticker...", "🎨 جارٍ إنشاء الملصق..."),
        { replyTo: msg },
      );
      if (library.hasRoom(who)) {
        const { promise } = studio.createFromBuffer({
          owner: who,
          buffer,
          options,
          source: "BOT_COMMAND",
          maxSourceSeconds: BOT_VIDEO_MAX_SECONDS,
        });
        const { sticker } = await promise;
        await sendLibrarySticker(sock, jid, who, sticker);
      } else {
        const converted = await studio.convertBuffer({
          buffer,
          options,
          maxSourceSeconds: BOT_VIDEO_MAX_SECONDS,
        });
        await sock.sendMessage(jid, { sticker: packedSticker(converted) });
      }
      await status.remove();
    } catch (error) {
      const line = errorText(error);
      if (status) await status.finish(line);
      else await sock.sendMessage(jid, { text: line });
    }
  },
};
