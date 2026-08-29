// Text-to-Speech Command using Google TTS and ffmpeg-static.
//
// Google TTS produces MP3. WhatsApp voice notes are OGG/Opus, so the command:
//   1. Generates one or more MP3 chunks with @sefinek/google-tts-api.
//   2. Concatenates the MP3 frames into one temporary file.
//   3. Invokes the ffmpeg-static binary directly to create OGG/Opus.
//
// Calling ffmpeg directly keeps the dependency surface small and avoids the
// deprecated fluent-ffmpeg wrapper. If ffmpeg is unavailable or transcoding
// fails, the raw MP3 is still sent as a normal audio attachment.

const googleTTS = require("@sefinek/google-tts-api");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const os = require("os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

const execFileAsync = promisify(execFile);

let ffmpegStatic = null;
try {
  ffmpegStatic = require("ffmpeg-static");
} catch (err) {
  logger.warn(
    { err: err?.message },
    "[TTS] ffmpeg unavailable — will fall back to raw MP3"
  );
}

function tmpPath(ext) {
  return path.join(
    os.tmpdir(),
    `wa-bot-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`
  );
}

async function synthesizeMp3(text, mp3Path) {
  const parts = await googleTTS.getAllAudioBase64(text, {
    lang: "ar",
    slow: false,
    timeout: 15_000,
    splitPunct: "،,.!?؟؛;:\n",
  });

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Google TTS returned no audio");
  }

  const buffers = parts.map((part) => Buffer.from(part.base64, "base64"));
  await fsp.writeFile(mp3Path, Buffer.concat(buffers));
}

async function transcodeToOpus(mp3Path) {
  if (!ffmpegStatic) return null;

  const oggPath = tmpPath("ogg");
  await execFileAsync(
    ffmpegStatic,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mp3Path,
      "-vn",
      "-c:a",
      "libopus",
      "-ac",
      "1",
      "-ar",
      "48000",
      "-b:a",
      "48k",
      "-application",
      "voip",
      "-f",
      "ogg",
      oggPath,
    ],
    { windowsHide: true, timeout: 30_000 },
  );

  return oggPath;
}

module.exports = {
  name: "tts",
  aliases: ["tovoice", "speak"],
  description: "Convert text to speech (FREE - no API costs)",
  usage: "tts <النص>   (أو رد على رسالة نصية)",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    let textToConvert = args.join(" ");
    const quotedMsg =
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
        ?.conversation ||
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
        ?.extendedTextMessage?.text;

    if (!textToConvert && quotedMsg) textToConvert = quotedMsg;

    if (!textToConvert) {
      return sendBotMessage(
        sock,
        chatId,
        {
          text:
            "📢 الاستخدام:\n!tts <النص>\n\nأو رد على رسالة نصية بالأمر !tts\n\n✨ مجاني تماماً - بدون تكاليف!",
        },
        { replyTo: msg }
      );
    }

    let mp3Path = null;
    let oggPath = null;

    // One status line: it disappears once the voice note is on its way.
    const status = await createStatus(sock, chatId, "🎙️ بحوّل النص لصوت...", {
      replyTo: msg,
    });

    try {
      mp3Path = tmpPath("mp3");
      await synthesizeMp3(textToConvert, mp3Path);

      // Try to transcode to Opus for proper PTT delivery.
      try {
        oggPath = await transcodeToOpus(mp3Path);
      } catch (err) {
        logger.warn(
          { err: err?.message },
          "[TTS] Opus transcode failed, will fall back to MP3"
        );
        oggPath = null;
      }

      if (oggPath && fs.existsSync(oggPath)) {
        const audioBuffer = await fsp.readFile(oggPath);
        await sendBotMessage(
          sock,
          chatId,
          {
            audio: audioBuffer,
            mimetype: "audio/ogg; codecs=opus",
            ptt: true,
          },
          { replyTo: msg, typing: false }
        );
      } else {
        // Fallback: send the raw MP3 with the correct mimetype. Cannot be
        // PTT — WhatsApp requires Opus for that — but at least it plays.
        const audioBuffer = await fsp.readFile(mp3Path);
        await sendBotMessage(
          sock,
          chatId,
          {
            audio: audioBuffer,
            mimetype: "audio/mpeg",
            ptt: false,
          },
          { replyTo: msg, typing: false }
        );
      }

      // The voice note IS the answer — drop the status line instead of
      // leaving a dangling "converting..." above it.
      await status.remove();
      logger.info("[TTS] Successfully delivered TTS audio");
    } catch (error) {
      logger.error({ err: error }, "[TTS] Error converting text to speech");
      await status.fail(error, "حصلت مشكلة وأنا بحوّل النص لصوت");
    } finally {
      for (const p of [mp3Path, oggPath]) {
        if (!p) continue;
        try {
          await fsp.unlink(p);
        } catch {}
      }
    }
  },
};
