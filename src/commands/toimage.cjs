const { tr } = require("../utils/i18n.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { targetOf, downloadTarget, errorText } = require("../utils/stickerBot.cjs");
const media = require("../stickers/media.cjs");
const jobs = require("../stickers/jobs.cjs");

module.exports = {
  name: "toimage",
  aliases: ["toimg", "صورة"],
  description: {
    en: "Turn a replied sticker into a PNG or animated video.",
    ar: "يحوّل الملصق المردود عليه إلى صورة PNG أو فيديو متحرك.",
  },
  usage: { en: "toimage [doc|gif] (reply to a sticker)", ar: "toimage [ملف|متحرك] (رد على ملصق)" },
  keywords: ["doc", "ملف", "gif", "متحرك"],
  chat: "all",
  async execute(sock, msg, args = []) {
    const jid = msg.key.remoteJid;
    const target = targetOf(msg, { quotedOnly: true });
    if (target?.type !== "sticker") {
      return sock.sendMessage(jid, {
        text: tr(
          "Reply to a sticker with !toimage [doc|gif].",
          "رد على ملصق بالأمر !toimage [ملف|متحرك].",
        ),
      });
    }
    let status;
    try {
      const buffer = await downloadTarget(target);
      const mode = args.some((arg) => ["gif", "متحرك"].includes(String(arg).toLowerCase()))
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
      if (mode === "gif") {
        await sock.sendMessage(jid, { video: result, mimetype: "video/mp4", gifPlayback: true });
      } else if (mode === "doc") {
        await sock.sendMessage(jid, {
          document: result.buffer,
          mimetype: "image/png",
          fileName: "sticker.png",
          caption: result.animated
            ? tr(
                "First frame of an animated sticker. Use !toimage gif for the animation.",
                "الإطار الأول من ملصق متحرك. استخدم !toimage متحرك للحصول على الحركة.",
              )
            : undefined,
        });
      } else {
        await sock.sendMessage(jid, {
          image: result.buffer,
          mimetype: "image/png",
          caption: result.animated
            ? tr(
                "First frame of an animated sticker. Use !toimage gif for the animation.",
                "الإطار الأول من ملصق متحرك. استخدم !toimage متحرك للحصول على الحركة.",
              )
            : undefined,
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
