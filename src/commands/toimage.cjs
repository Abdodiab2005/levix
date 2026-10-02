const { tr } = require("../utils/i18n.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { targetOf, downloadTarget, commandHint, errorText } = require("../utils/stickerBot.cjs");
const media = require("../stickers/media.cjs");
const jobs = require("../stickers/jobs.cjs");

module.exports = {
  name: "toimage",
  aliases: ["toimg", "صورة"],
  description: {
    en: "Turn a replied sticker into a PNG or animated video.",
    ar: "يحوّل الملصق المردود عليه إلى صورة PNG أو فيديو متحرك.",
  },
  usage: {
    en: "toimage (reply to a sticker)\ntoimage doc (reply to a sticker)\ntoimage gif (reply to an animated sticker)",
    ar: "toimage (رد على ملصق)\ntoimage ملف (رد على ملصق)\ntoimage متحرك (رد على ملصق متحرك)",
  },
  keywords: ["doc", "ملف", "gif", "متحرك"],
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const target = targetOf(msg, { quotedOnly: true });
    if (target?.type !== "sticker") {
      return sock.sendMessage(jid, {
        text: tr(
          `Reply to a sticker with ${commandHint("toimage", "[doc|gif]")}.`,
          `رد على ملصق بالأمر ${commandHint("toimage", "[ملف|متحرك]")}.`,
        ),
      });
    }
    let status;
    try {
      const buffer = await downloadTarget(target);
      const wantsGif = args.some((arg) => ["gif", "متحرك"].includes(String(arg).toLowerCase()));
      const staticGif = wantsGif && !media.describeWebp(buffer).animated;
      const mode =
        wantsGif && !staticGif
          ? "gif"
          : args.some((arg) => ["doc", "ملف"].includes(String(arg).toLowerCase()))
            ? "doc"
            : "png";
      status = await createStatus(
        sock,
        jid,
        tr("🎨 Converting sticker...", "🎨 جارٍ تحويل الملصق..."),
        { replyTo: msg },
      );
      const job = jobs.submit(
        ({ signal }) =>
          mode === "gif" ? media.toMp4(buffer, { signal }) : media.toPng(buffer, { signal }),
        { kind: "export" },
      );
      const result = await job.promise;
      const caption = staticGif
        ? tr(
            "This sticker is not animated, so I sent a PNG.",
            "هذا الملصق غير متحرك، لذا أرسلت صورة PNG.",
          )
        : result.animated
          ? tr(
              `First frame of an animated sticker. Use ${commandHint("toimage", "gif")} for the animation.`,
              `الإطار الأول من ملصق متحرك. استخدم ${commandHint("toimage", "متحرك")} للحصول على الحركة.`,
            )
          : undefined;
      if (mode === "gif") {
        await sock.sendMessage(jid, { video: result, mimetype: "video/mp4", gifPlayback: true });
      } else if (mode === "doc") {
        await sock.sendMessage(jid, {
          document: result.buffer,
          mimetype: "image/png",
          fileName: "sticker.png",
          caption,
        });
      } else {
        await sock.sendMessage(jid, {
          image: result.buffer,
          mimetype: "image/png",
          caption,
        });
      }
      await status.remove();
    } catch (error) {
      const line = errorText(error);
      if (status) await status.finish(line);
      else await sock.sendMessage(jid, { text: line });
    }
  },
};
