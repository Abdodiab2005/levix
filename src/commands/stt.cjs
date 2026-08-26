// Speech-to-Text Command using FREE Gemini API
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GoogleAIFileManager } = require("@google/generative-ai/server");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const fs = require("fs").promises;
const path = require("path");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

const settings = require("../config/settings.cjs");

// Built on first use from whatever key is in force, and
// rebuilt if that key changes — the operator can paste one without a restart.
let cache = { key: null, model: null, fileManager: null };

function geminiStt() {
  const key = settings.get("gemini_api_key");
  if (!key) return null;
  if (cache.key !== key) {
    const genAI = new GoogleGenerativeAI(key);
    cache = {
      key,
      // Free tier with generous limits
      model: genAI.getGenerativeModel({ model: "gemini-2.5-flash" }),
      fileManager: new GoogleAIFileManager(key),
    };
  }
  return cache;
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

      // Upload audio to Gemini
      const uploadResponse = await gemini.fileManager.uploadFile(tempAudioPath, {
        mimeType: audioMessage.mimetype || "audio/ogg; codecs=opus",
        displayName: `audio-${Date.now()}`,
      });

      logger.info(`[STT] Uploaded audio to Gemini: ${uploadResponse.file.uri}`);

      // Generate transcription using Gemini
      const result = await gemini.model.generateContent([
        {
          fileData: {
            mimeType: uploadResponse.file.mimeType,
            fileUri: uploadResponse.file.uri,
          },
        },
        {
          text: "Please transcribe this audio message accurately. Return ONLY the transcription text without any additional commentary, explanations, or formatting. Just the raw transcribed text.",
        },
      ]);

      const transcription = result.response.text().trim();

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
