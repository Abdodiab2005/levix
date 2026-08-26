// Text-to-Speech Command using FREE node-gtts library.
//
// Audit fix: previously we saved the file as `.mp3` but sent it with
// `mimetype: "audio/mp4"` and `ptt: true`. Some WhatsApp clients (Telegram-
// linked viewers, web clients on certain Androids) refuse to play that
// because the container declared in the mimetype doesn't match the actual
// MP3 data, hence the "This audio is not available because something is
// wrong with the audio file" pop-up.
//
// Proper voice messages on WhatsApp are OGG/Opus. We now:
//   1. Generate the speech as MP3 via node-gtts (its only supported format).
//   2. Re-encode it to OGG/Opus with ffmpeg-static.
//   3. Send with `mimetype: "audio/ogg; codecs=opus"` + `ptt: true`.
//
// If ffmpeg isn't available we fall back to sending the raw MP3 with the
// CORRECT mimetype (`audio/mpeg`) and `ptt: false`, so the user at least
// gets a playable audio attachment.

const gtts = require("node-gtts")("ar");
const fs = require("fs");
const fsp = require("fs").promises;
const path = require("path");
const os = require("os");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { sendBotMessage, sendBotError } = require("../utils/sendBotMessage.cjs");

let ffmpeg = null;
let ffmpegStatic = null;
try {
  ffmpeg = require("fluent-ffmpeg");
  ffmpegStatic = require("ffmpeg-static");
  if (ffmpegStatic) ffmpeg.setFfmpegPath(ffmpegStatic);
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
  return new Promise((resolve, reject) => {
    gtts.save(mp3Path, text, (err) => (err ? reject(err) : resolve()));
  });
}

async function transcodeToOpus(mp3Path) {
  if (!ffmpeg) return null;
  const oggPath = tmpPath("ogg");
  await new Promise((resolve, reject) => {
    ffmpeg(mp3Path)
      .audioCodec("libopus")
      .audioChannels(1)
      .audioFrequency(48000)
      .audioBitrate("48k")
      .format("ogg")
      .outputOptions(["-application voip"])
      .on("error", reject)
      .on("end", resolve)
      .save(oggPath);
  });
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
