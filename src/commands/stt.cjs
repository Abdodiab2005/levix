// Speech-to-Text Command using FREE Gemini API
const { GoogleGenAI } = require("@google/genai");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

const settings = require("../config/settings.cjs");

// Built on first use from whatever key is in force, and
// rebuilt if that key changes — the operator can paste one without a restart.
//
// One @google/genai client covers both halves: `ai.files` replaced the separate
// GoogleAIFileManager, and the model is named per request.
let cache = { key: null, genAI: null };

function geminiStt() {
  const key = settings.get("gemini_api_key");
  if (!key) return null;
  if (cache.key !== key) {
    cache = { key, genAI: new GoogleGenAI({ apiKey: key }) };
  }
  return cache;
}

// Transcription is a cheap, high-volume job and does not need the model that
// answers chat, so it stays on its own fast setting.
function sttModel() {
  return settings.get("gemini_stt_model");
}

module.exports = {
  name: "stt",
  aliases: ["totext", "transcribe"],
  description: "Convert speech/audio to text (FREE - uses Gemini API)",
  usage: "stt   (رد على رسالة صوتية أو ابعتها بالأمر)",
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata) {
    const chatId = msg.key.remoteJid;

    // Check if message has audio or if it's a reply to an audio message
    const audioMessage =
      msg.message?.audioMessage ||
      msg.message?.extendedTextMessage?.contextInfo?.quotedMessage
        ?.audioMessage;

    if (!audioMessage) {
      return await sock.sendMessage(chatId, {
        text: "📢 الاستخدام:\nأرسل رسالة صوتية أو رد على رسالة صوتية بالأمر !stt\n\n✨ مجاني تماماً - يستخدم Gemini API\n🌍 يدعم العربية والإنجليزية وجميع اللغات",
      });
    }

    const gemini = geminiStt();
    if (!gemini) {
      return await sock.sendMessage(chatId, {
        text: "⚠️ مفتاح Gemini مش متظبط. ضيفه من الداشبورد (Settings).",
      });
    }

    let tempAudioPath = null;

    // One message, edited from "transcribing" into the transcript itself.
    const status = await createStatus(
      sock,
      chatId,
      "🎧 بحوّل الصوت لنص...",
      { replyTo: msg },
    );

    try {
      // Download audio content
      const audioBuffer = await downloadContentFromMessage(
        audioMessage,
        "audio"
      );

      // Save audio to temporary file
      tempAudioPath = path.join(__dirname, `stt_audio_${Date.now()}.ogg`);
      await fs.writeFile(tempAudioPath, audioBuffer);

      logger.info(`[STT] Saved audio to temporary file: ${tempAudioPath}`);

      // Upload audio to Gemini. ai.files.upload returns the File directly,
      // where the old fileManager wrapped it in { file }.
      const uploaded = await gemini.genAI.files.upload({
        file: tempAudioPath,
        config: {
          mimeType: audioMessage.mimetype || "audio/ogg; codecs=opus",
          displayName: `audio-${Date.now()}`,
        },
      });

      logger.info(`[STT] Uploaded audio to Gemini: ${uploaded.uri}`);

      // Generate transcription using Gemini
      const response = await gemini.genAI.models.generateContent({
        model: sttModel(),
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  mimeType: uploaded.mimeType,
                  fileUri: uploaded.uri,
                },
              },
              {
                text: "Please transcribe this audio message accurately. Return ONLY the transcription text without any additional commentary, explanations, or formatting. Just the raw transcribed text.",
              },
            ],
          },
        ],
      });

      // `text` is a getter on the new response, and undefined rather than a
      // throw when the model returned nothing usable.
      const transcription = (response.text ?? "").trim();

      if (!transcription || transcription === "") {
        await status.finish(
          "⚠️ لم أتمكن من استخراج أي نص من الرسالة الصوتية. تأكد من أن الصوت واضح.",
        );
        return;
      }

      // The status line becomes the transcript.
      await status.finish(`📝 النص المستخرج:\n\n${transcription}`);

      logger.info("[STT] Successfully transcribed audio to text (FREE - Gemini)");
    } catch (error) {
      logger.error({ err: error }, "[STT] Error transcribing audio");

      let errorMessage = "❌ حدث خطأ أثناء تحويل الصوت إلى نص.";

      // Provide more specific error messages
      if (error.message?.includes("quota")) {
        errorMessage +=
          "\n\nتم تجاوز الحد المجاني. حاول مرة أخرى لاحقاً.";
      } else if (error.message?.includes("API key")) {
        errorMessage +=
          "\n\nخطأ في مفتاح API. تواصل مع المطور.";
      } else if (error.message?.includes("upload")) {
        errorMessage +=
          "\n\nفشل رفع الملف الصوتي. حاول مرة أخرى.";
      }

      await status.finish(errorMessage);
    } finally {
      // Clean up temporary file
      if (tempAudioPath) {
        try {
          await fs.unlink(tempAudioPath);
          logger.info(`[STT] Deleted temporary file: ${tempAudioPath}`);
        } catch (cleanupErr) {
          logger.warn(
            { err: cleanupErr },
            `[STT] Failed to delete temporary file: ${tempAudioPath}`
          );
        }
      }
    }
  },
};
