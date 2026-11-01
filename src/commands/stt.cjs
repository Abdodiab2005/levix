// Speech-to-Text Command using FREE Gemini API
const { GoogleGenAI } = require("@google/genai");
const { downloadContentFromMessage } = require("@whiskeysockets/baileys");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { unwrapMessage } = require("../utils/messageContent.cjs");
const {
  INLINE_MEDIA_LIMIT,
  baseMimeType,
  downloadMedia,
  uploadToGemini,
} = require("../utils/geminiMedia.cjs");

const settings = require("../config/settings.cjs");
const {
  assertProviderBaseUrl,
  assertProviderRequestUrl,
  safeProviderFetch,
} = require("../utils/providerUrl.cjs");
const { t } = require("../utils/i18n.cjs");

// Built on first use from whatever key is in force, and
// rebuilt if that key changes — the operator can paste one without a restart.
//
// One @google/genai client covers both halves: `ai.files` replaced the separate
// GoogleAIFileManager, and the model is named per request.
let cache = { key: null, baseUrl: null, genAI: null };

function geminiStt() {
  const key = settings.get("gemini_api_key");
  if (!key) return null;
  const baseUrl = assertProviderBaseUrl(settings.get("gemini_base_url"), {
    allowLoopback: true,
  });
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
  return settings.get("gemini_api_key")
    ? "gemini"
    : settings.get("openai_api_key")
      ? "openai"
      : "gemini";
}

const TRANSCRIBE_PROMPT =
  "Please transcribe this audio message accurately. Return ONLY the transcription text without any additional commentary, explanations, or formatting. Just the raw transcribed text.";

// A voice note is a few hundred KB, so it rides inline in the request: one
// round trip, instead of an upload, a finalize and then the request. Past
// INLINE_MEDIA_LIMIT (Gemini caps a whole inline request at 20 MB) it goes
// through the Files API instead.

async function transcribeWithGemini(audioBuffer, mimetype) {
  const gemini = geminiStt();
  if (!gemini)
    throw new Error(t("bot.ai.stt.noGeminiKey"));
  await assertProviderRequestUrl(settings.get("gemini_base_url"), {
    allowLoopback: true,
  });

  // WhatsApp labels voice notes `audio/ogg; codecs=opus`; Gemini's type is
  // `audio/ogg`, and the codec parameter is not part of it.
  const mimeType = baseMimeType(mimetype, "audio");
  let audioPart;
  if (audioBuffer.length <= INLINE_MEDIA_LIMIT) {
    audioPart = { inlineData: { mimeType, data: audioBuffer.toString("base64") } };
  } else {
    const file = await uploadToGemini(gemini.genAI, audioBuffer, mimeType, {
      displayName: `audio-${Date.now()}`,
    });
    audioPart = { fileData: { mimeType: file.mimeType || mimeType, fileUri: file.uri } };
  }

  const response = await gemini.genAI.models.generateContent({
    model: sttModel(),
    contents: [{ role: "user", parts: [audioPart, { text: TRANSCRIBE_PROMPT }] }],
  });
  return (response.text ?? "").trim();
}

async function transcribeWithOpenAi(audioBuffer, mimetype) {
  const apiKey = settings.get("openai_api_key");
  if (!apiKey) {
    throw new Error(t("bot.ai.stt.noOpenAiKey"));
  }
  const baseUrl = assertProviderBaseUrl(
    settings.get("openai_base_url") || "https://api.openai.com/v1",
    { allowLoopback: true },
  );
  const model = settings.get("openai_stt_model") || "whisper-large-v3";

  const formData = new FormData();
  const mime = baseMimeType(mimetype, "audio");
  const ext = mime.includes("mp4")
    ? "m4a"
    : mime.includes("mp3") || mime.includes("mpeg")
      ? "mp3"
      : mime.includes("wav")
        ? "wav"
        : "ogg";
  const blob = new Blob([audioBuffer], { type: mime });
  formData.append("file", blob, `audio.${ext}`);
  formData.append("model", model);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const res = await safeProviderFetch(
      `${baseUrl}/audio/transcriptions`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
        body: formData,
        signal: controller.signal,
      },
      { allowLoopback: true },
    );
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

/** Audio bytes -> text, on whichever engine the settings pick. */
async function transcribe(audioBuffer, mimetype) {
  const provider = resolveSttProvider();
  const hasOpenAi = !!settings.get("openai_api_key");
  if (provider === "openai" && hasOpenAi) {
    logger.info("[STT] Transcribing via OpenAI/Groq Whisper API");
    return transcribeWithOpenAi(audioBuffer, mimetype);
  }
  if (geminiStt()) {
    logger.info("[STT] Transcribing via Gemini");
    return transcribeWithGemini(audioBuffer, mimetype);
  }
  if (hasOpenAi) {
    logger.info("[STT] Fallback transcribing via OpenAI/Groq Whisper API");
    return transcribeWithOpenAi(audioBuffer, mimetype);
  }
  throw new Error(t("bot.ai.stt.noAiKey"));
}

function sttErrorHint(error) {
  const message = String(error?.message || "");
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(message)) {
    return t("bot.ai.stt.quota");
  }
  if (/API key|API_KEY|401|403/i.test(message)) {
    return t("bot.ai.stt.apiKeyHint");
  }
  if (/upload/i.test(message)) {
    return t("bot.ai.stt.uploadFailed");
  }
  return "";
}

module.exports = {
  name: "stt",
  aliases: ["totext", "transcribe"],
  description: {
    en: "Converts speech/audio to text (Gemini or Groq/OpenAI Whisper).",
    ar: "يحوّل الكلام/الصوت إلى نص (عبر Gemini أو Groq/OpenAI Whisper).",
  },
  usage: {
    en: "stt   (reply to a voice note, or send one with the command)",
    ar: "stt   (رد على رسالة صوتية أو أرسلها مع الأمر)",
  },
  chat: "all",

  async execute(sock, msg, args, body, groupMetadata) {
    const chatId = msg.key.remoteJid;

    // Check if message has audio or if it's a reply to an audio message
    const own = unwrapMessage(msg.message);
    const audioMessage =
      own.audioMessage ||
      unwrapMessage(own.extendedTextMessage?.contextInfo?.quotedMessage).audioMessage;

    if (!audioMessage) {
      return await sock.sendMessage(chatId, {
        text: t("bot.ai.stt.usage"),
      });
    }

    const hasGemini = !!geminiStt();
    const hasOpenAi = !!settings.get("openai_api_key");

    if (!hasGemini && !hasOpenAi) {
      return await sock.sendMessage(chatId, {
        text: t("bot.ai.stt.noKeySet"),
      });
    }

    // One message, edited from "transcribing" into the transcript itself.
    const status = await createStatus(
      sock,
      chatId,
      t("bot.ai.stt.transcribing"),
      {
        replyTo: msg,
      },
    );

    try {
      // A real Buffer, not the download stream: the Whisper path wraps it in
      // a Blob, and a stream in a Blob is the string "[object Object]".
      const audioBuffer = await downloadMedia(downloadContentFromMessage, audioMessage, "audio");
      const transcription = await transcribe(audioBuffer, audioMessage.mimetype);

      if (!transcription) {
        await status.finish(
          t("bot.ai.stt.emptyTranscript"),
        );
        return;
      }

      // The status line becomes the transcript.
      await status.finish(
        t("bot.ai.stt.transcript", { transcription }),
      );

      logger.info("[STT] Successfully transcribed audio to text");
    } catch (error) {
      logger.error({ err: error }, "[STT] Error transcribing audio");

      // The real reason goes in the card — a bare "an error happened" left
      // nothing to act on.
      const details = String(error?.message || error || t("bot.ai.stt.unknown")).slice(0, 800);
      const hint = sttErrorHint(error);
      await status.finish(
        t("bot.ai.stt.failed", {
          details,
          hintBlock: hint ? `\n\n${hint}` : "",
        }),
      );
    }
  },
};

module.exports.transcribe = transcribe;
