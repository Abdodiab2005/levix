// file: src/commands/sticker.cjs
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const logger = require("../utils/logger.cjs");
const { ffmpegPath } = require("../utils/thumbnail.cjs");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const bin = ffmpegPath();
    const child = spawn(bin, ["-hide_banner", "-nostdin", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg conversion timed out"));
    }, 30000);

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve({ ok: true, stderr });
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-300)}`));
    });
  });
}

async function streamToBuffer(stream) {
  let buffer = Buffer.from([]);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
  }
  return buffer;
}

module.exports = {
  name: "sticker",
  aliases: ["s", "ملصق", "toimg", "tosticker"],
  description: "Convert images/videos to stickers, or convert stickers to images/videos",
  usage: "sticker (reply to image/video/sticker) or toimg (reply to sticker)",
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata, { invokedName } = {}) {
    const chatId = msg.key.remoteJid;
    const isToImg = invokedName === "toimg";

    const m = msg.message || {};
    const quoted = m.extendedTextMessage?.contextInfo?.quotedMessage;

    // Resolve media source (either attached directly or quoted)
    const targetMsg = quoted || m;

    const isSticker = Boolean(targetMsg.stickerMessage);
    const isImage = Boolean(targetMsg.imageMessage);
    const isVideo = Boolean(targetMsg.videoMessage);
    const isDocument = Boolean(
      targetMsg.documentMessage &&
        (targetMsg.documentMessage.mimetype?.startsWith("image/") ||
          targetMsg.documentMessage.mimetype?.startsWith("video/")),
    );

    if (!isSticker && !isImage && !isVideo && !isDocument) {
      await sock.sendMessage(
        chatId,
        {
          text: `🎨 *محول الملصقات والوسائط / Sticker Converter*\n\n• *صورة/فيديو ➔ ملصق:* أرسل أو رد على صورة أو فيديو بـ \`!sticker\` أو \`!s\`\n• *ملصق ➔ صورة/فيديو:* رد على أي ملصق بـ \`!toimg\` أو \`!sticker\``,
        },
        { quoted: msg },
      );
      return;
    }

    const tempDir = os.tmpdir();
    const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const tempFiles = [];

    try {
      if (isSticker || isToImg) {
        // --- Convert Sticker to Image / Video ---
        const stickerMsg = targetMsg.stickerMessage;
        if (!stickerMsg) {
          await sock.sendMessage(
            chatId,
            { text: "يرجى الرد على ملصق لتحويله إلى صورة أو فيديو." },
            { quoted: msg },
          );
          return;
        }

        const isAnimated = Boolean(stickerMsg.isAnimated);
        const stream = await downloadContentFromMessage(stickerMsg, "sticker");
        const stickerBuffer = await streamToBuffer(stream);

        const inWebp = path.join(tempDir, `stk_in_${stamp}.webp`);
        await fs.promises.writeFile(inWebp, stickerBuffer);
        tempFiles.push(inWebp);

        if (isAnimated) {
          // Convert animated sticker to MP4 video
          const outMp4 = path.join(tempDir, `stk_out_${stamp}.mp4`);
          tempFiles.push(outMp4);

          await runFfmpeg([
            "-i",
            inWebp,
            "-pix_fmt",
            "yuv420p",
            "-c:v",
            "libx264",
            "-movflags",
            "+faststart",
            "-y",
            outMp4,
          ]);

          const videoBuffer = await fs.promises.readFile(outMp4);
          await sock.sendMessage(
            chatId,
            { video: videoBuffer, gifPlayback: true, caption: "✅ تم تحويل الملصق إلى فيديو/GIF" },
            { quoted: msg },
          );
        } else {
          // Convert static sticker to JPEG image
          const outJpg = path.join(tempDir, `stk_out_${stamp}.jpg`);
          tempFiles.push(outJpg);

          await runFfmpeg(["-i", inWebp, "-vframes", "1", "-q:v", "2", "-y", outJpg]);

          const imageBuffer = await fs.promises.readFile(outJpg);
          await sock.sendMessage(
            chatId,
            { image: imageBuffer, caption: "✅ تم تحويل الملصق إلى صورة" },
            { quoted: msg },
          );
        }
      } else {
        // --- Convert Image / Video to Sticker ---
        const mediaSource =
          targetMsg.imageMessage || targetMsg.videoMessage || targetMsg.documentMessage;
        const mediaType = targetMsg.imageMessage
          ? "image"
          : targetMsg.videoMessage
            ? "video"
            : "document";

        const stream = await downloadContentFromMessage(mediaSource, mediaType);
        const mediaBuffer = await streamToBuffer(stream);

        const inExt = mediaType === "video" || isVideo ? ".mp4" : ".png";
        const inFile = path.join(tempDir, `media_in_${stamp}${inExt}`);
        const outWebp = path.join(tempDir, `media_out_${stamp}.webp`);
        await fs.promises.writeFile(inFile, mediaBuffer);
        tempFiles.push(inFile, outWebp);

        if (isVideo || mediaType === "video") {
          // Convert video/gif to animated WebP sticker
          await runFfmpeg([
            "-i",
            inFile,
            "-vcodec",
            "libwebp",
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease,fps=12,pad=512:512:-1:-1:color=white@0.0",
            "-loop",
            "0",
            "-ss",
            "00:00:00",
            "-t",
            "00:00:06",
            "-an",
            "-vsync",
            "0",
            "-y",
            outWebp,
          ]);
        } else {
          // Convert static image to WebP sticker
          await runFfmpeg([
            "-i",
            inFile,
            "-vcodec",
            "libwebp",
            "-vf",
            "scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:-1:-1:color=white@0.0",
            "-y",
            outWebp,
          ]);
        }

        const stickerBuffer = await fs.promises.readFile(outWebp);
        await sock.sendMessage(chatId, { sticker: stickerBuffer }, { quoted: msg });
      }
    } catch (err) {
      logger.error({ err: err?.message }, "[Sticker] Conversion failed");
      await sock.sendMessage(
        chatId,
        { text: `❌ فشل تحويل الوسائط: ${err?.message || "خطأ غير متوقع"}` },
        { quoted: msg },
      );
    } finally {
      for (const file of tempFiles) {
        try {
          if (fs.existsSync(file)) await fs.promises.unlink(file);
        } catch {
          // ignore cleanup errors
        }
      }
    }
  },
};
