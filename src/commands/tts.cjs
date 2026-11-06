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
const { randomUUID } = require("node:crypto");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");

const execFileAsync = promisify(execFile);

const { ffmpegPath } = require("../utils/thumbnail.cjs");
const { t } = require("../utils/i18n.cjs");
const { assertAudio, MAX_MEDIA_BYTES } = require("../services/aiMedia.cjs");

function tmpPath(ext) {
  return path.join(os.tmpdir(), `wa-bot-tts-${randomUUID()}.${ext}`);
}

async function synthesizeMp3(text, mp3Path, lang = "ar", signal) {
  const parts = await googleTTS.getAllAudioBase64(text, {
    lang,
    slow: false,
    timeout: 15_000,
    splitPunct: "،,.!?؟؛;:\n",
  });

  if (!Array.isArray(parts) || parts.length === 0) {
    throw new Error("Google TTS returned no audio");
  }

  signal?.throwIfAborted();
  const buffers = [];
  let size = 0;
  for (const part of parts) {
    if (typeof part.base64 !== "string" || part.base64.length > Math.ceil(MAX_MEDIA_BYTES / 3) * 4)
      throw new Error("MEDIA_AUDIO_INVALID");
    const buffer = Buffer.from(part.base64, "base64");
    size += buffer.length;
    if (!buffer.length || buffer.toString("base64") !== part.base64 || size > MAX_MEDIA_BYTES)
      throw new Error("MEDIA_AUDIO_INVALID");
    buffers.push(buffer);
  }
  const buffer = Buffer.concat(buffers);
  assertAudio(buffer, "audio/mpeg");
  await fsp.writeFile(mp3Path, buffer, { mode: 0o600, flag: "wx" });
}

async function transcodeWithEncoder(bin, encoder, mp3Path, oggPath, signal) {
  return execFileAsync(
    bin,
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      mp3Path,
      "-vn",
      "-c:a",
      encoder,
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
      "-fs",
      String(MAX_MEDIA_BYTES + 1),
      oggPath,
    ],
    { windowsHide: true, timeout: 30_000, signal },
  );
}

async function transcodeToOpus(mp3Path, signal) {
  const bin = ffmpegPath();
  if (!bin) return null;

  const oggPath = tmpPath("ogg");
  await (await fsp.open(oggPath, "wx", 0o600)).close();
  const encoders = ["libopus", "opus"];
  let lastError = null;

  for (const encoder of encoders) {
    try {
      await transcodeWithEncoder(bin, encoder, mp3Path, oggPath, signal);
      return oggPath;
    } catch (err) {
      lastError = err;
      const msg = `${err?.message || ""} ${err?.stderr || ""}`;
      if (msg.includes("Unknown encoder")) {
        continue;
      }
      break;
    }
  }

  await fsp.unlink(oggPath).catch(() => {});
  signal?.throwIfAborted();
  logger.warn(
    { err: lastError?.message, bin },
    "[TTS] ffmpeg transcode failed — will fall back to raw MP3",
  );
  return null;
}

/**
 * Text -> sendable voice payload, shared by the !tts command and the AI
 * agent's `speak` tool. Resolves to { audio, mimetype, ptt }: Opus/OGG for a
 * proper push-to-talk note when ffmpeg can transcode, raw MP3 otherwise.
 * Temp files are cleaned up here either way.
 */
async function synthesizeVoice(text, lang = "ar", { signal } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 3000)
    throw new Error(t("bot.ai.tts.failed"));
  signal?.throwIfAborted();
  const mp3Path = tmpPath("mp3");
  let oggPath;
  try {
    await synthesizeMp3(text, mp3Path, lang, signal);
    signal?.throwIfAborted();

    oggPath = await transcodeToOpus(mp3Path, signal);
    if (oggPath && fs.existsSync(oggPath)) {
      if ((await fsp.stat(oggPath)).size > MAX_MEDIA_BYTES) throw new Error("MEDIA_AUDIO_INVALID");
      const audio = await fsp.readFile(oggPath);
      signal?.throwIfAborted();
      assertAudio(audio, "audio/ogg", true);
      return { audio, mimetype: "audio/ogg; codecs=opus", ptt: true };
    }

    const audio = await fsp.readFile(mp3Path);
    return { audio, mimetype: "audio/mpeg", ptt: false };
  } finally {
    await fsp.unlink(mp3Path).catch(() => {});
    if (oggPath) await fsp.unlink(oggPath).catch(() => {});
  }
}

module.exports = {
  name: "tts",
  aliases: ["tovoice", "speak"],
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    let textToConvert = args.join(" ");
    const quotedMsg =
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.conversation ||
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.extendedTextMessage?.text;

    if (!textToConvert && quotedMsg) textToConvert = quotedMsg;

    if (!textToConvert) {
      return sendBotMessage(
        sock,
        chatId,
        {
          text: t("bot.ai.tts.usage"),
        },
        { replyTo: msg },
      );
    }

    // One status line: it disappears once the voice note is on its way.
    const status = await createStatus(sock, chatId, t("bot.ai.tts.working"), {
      replyTo: msg,
    });

    try {
      const voice = await synthesizeVoice(textToConvert);

      if (voice.ptt) {
        await sendBotMessage(
          sock,
          chatId,
          {
            audio: voice.audio,
            mimetype: voice.mimetype,
            ptt: true,
          },
          { replyTo: msg, typing: false },
        );
      } else {
        // Fallback: send the raw MP3 with the correct mimetype. Cannot be
        // PTT — WhatsApp requires Opus for that — but at least it plays.
        await sendBotMessage(
          sock,
          chatId,
          {
            audio: voice.audio,
            mimetype: voice.mimetype,
            ptt: false,
          },
          { replyTo: msg, typing: false },
        );
      }

      // The voice note IS the answer — drop the status line instead of
      // leaving a dangling "converting..." above it.
      await status.remove();
      logger.info("[TTS] Successfully delivered TTS audio");
    } catch (error) {
      logger.error({ err: error }, "[TTS] Error converting text to speech");
      await status.fail(error, t("bot.ai.tts.failed"));
    }
  },

  // exported for the AI agent's `speak` tool — one synthesizer, two doors
  _synthesizeVoice: synthesizeVoice,
};
