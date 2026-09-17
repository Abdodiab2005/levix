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
let cache = { key: null, baseUrl: null, genAI: null };

function geminiStt() {
  const key = settings.get("gemini_api_key");
  if (!key) return null;
  const baseUrl = String(settings.get("gemini_base_url")).replace(/\/+$/, "");
  if (cache.key !== key || cache.baseUrl !== baseUrl) {
    cache = {
      key,
      baseUrl,
      genAI: new GoogleGenAI({ apiKey: key, httpOptions: { baseUrl } }),
    };
  }
  return cache;
}

// Transcription is a cheap, high-volume job, so it keeps its own setting even
// though it defaults to the same Flash model the chat agent uses: an operator
// who moves the chat model to Pro should not drag transcription along with it.
function sttModel() {
  return settings.get("gemini_stt_model");
}

function resolveSttProvider() {
  const chosen = settings.get("ai_stt_provider");
  if (chosen === "openai") return "openai";
  if (chosen === "gemini") return "gemini";
  const active = settings.get("ai_provider");
  if (active === "openai" && settings.get("openai_api_key")) {
    return "openai";
  }
  return settings.get("gemini_api_key") ? "gemini" : (settings.get("openai_api_key") ? "openai" : "gemini");
}

async function transcribeWithOpenAi(audioBuffer, mimetype) {
  const apiKey = settings.get("openai_api_key");
  if (!apiKey) throw new Error("مفتاح OpenAI / Groq غير مضبوط في الإعدادات");
  const baseUrl = String(settings.get("openai_base_url") || "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = settings.get("openai_stt_model") || "whisper-large-v3";

  const formData = new FormData();
  const mime = mimetype || "audio/ogg";
  const ext = mime.includes("mp4") ? "m4a" : mime.includes("mp3") ? "mp3" : mime.includes("wav") ? "wav" : "ogg";
  const blob = new Blob([audioBuffer], { type: mime });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`STT API (${res.status}): ${err}`);
    }
    const data = await res.json();
    return String(data?.text || "").trim();
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  name: "stt",
  aliases: ["totext", "transcribe"],
  description: "Convert speech/audio to text (supports Gemini & Groq/OpenAI Whisper)",
  usage: "stt   (قم بالرد على رسالة صوتية أو إرسالها مع الأمر)",
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
        text: "📢 الاستخدام:\nأرسل رسالة صوتية أو قم بالرد على رسالة صوتية بالأمر !stt\n\n✨ يدعم تفريغ الصوت عبر Gemini و Groq/OpenAI Whisper\n🌍 يدعم العربية والإنجليزية وكافة اللغات",
      });
    }

    const provider = resolveSttProvider();
    const hasGemini = !!geminiStt();
    const hasOpenAi = !!settings.get("openai_api_key");

    if (!hasGemini && !hasOpenAi) {
      return await sock.sendMessage(chatId, {
        text: "⚠️ مفتاح الذكاء الاصطناعي (Gemini أو OpenAI/Groq) غير مضبوط. يرجى إضافته من لوحة التحكم (Settings).",
      });
    }

    let tempAudioPath = null;

    // One message, edited from "transcribing" into the transcript itself.
    const status = await createStatus(
      sock,
      chatId,
      "🎧 جاري تحويل الصوت إلى نص...",
      { replyTo: msg },
    );

    try {
      // Download audio content
      const audioBuffer = await downloadContentFromMessage(
        audioMessage,
        "audio"
      );

      let transcription = "";
      if (provider === "openai" && hasOpenAi) {
        logger.info("[STT] Transcribing via OpenAI/Groq Whisper API");
        transcription = await transcribeWithOpenAi(audioBuffer, audioMessage.mimetype);
      } else if (hasGemini) {
        // Save audio to temporary file
        tempAudioPath = path.join(__dirname, `stt_audio_${Date.now()}.ogg`);
        await fs.writeFile(tempAudioPath, audioBuffer);

        logger.info(`[STT] Saved audio to temporary file: ${tempAudioPath}`);

        // Upload audio to Gemini. ai.files.upload returns the File directly
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

        transcription = (response.text ?? "").trim();
      } else if (hasOpenAi) {
        logger.info("[STT] Fallback transcribing via OpenAI/Groq Whisper API");
        transcription = await transcribeWithOpenAi(audioBuffer, audioMessage.mimetype);
      }

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
