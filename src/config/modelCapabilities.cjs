// Official capability metadata for known model IDs, dated 2026-09-18.
//
// This is fallback metadata only. It is never proof that a user's API key can
// access the model. Live availability always comes from the provider API.
//
// Unknown / newly discovered IDs must NOT be inferred from name substrings.

const FULL_MULTIMODAL = Object.freeze({
  textInput: true,
  textOutput: true,
  vision: true,
  audioInput: true,
  stt: true,
  videoInput: true,
  pdfInput: true,
});

const VISION_TEXT = Object.freeze({
  textInput: true,
  textOutput: true,
  vision: true,
  audioInput: false,
  stt: false,
  videoInput: false,
  pdfInput: true,
});

const TEXT_VISION_ONLY = Object.freeze({
  textInput: true,
  textOutput: true,
  vision: true,
  audioInput: false,
  stt: false,
  videoInput: false,
  pdfInput: false,
});

// Exact IDs from the 2026-09-18 seed catalog + official docs. No prefix matching.
const GEMINI_OFFICIAL = Object.freeze({
  "gemini-2.5-flash": FULL_MULTIMODAL,
  "gemini-2.5-pro": FULL_MULTIMODAL,
  "gemini-2.5-flash-lite": FULL_MULTIMODAL,
  "gemini-flash-latest": FULL_MULTIMODAL,
  "gemini-flash-lite-latest": FULL_MULTIMODAL,
  "gemini-pro-latest": FULL_MULTIMODAL,
  "gemini-3-flash-preview": FULL_MULTIMODAL,
  "gemini-3.1-pro-preview": FULL_MULTIMODAL,
  "gemini-3.1-pro-preview-customtools": FULL_MULTIMODAL,
  "gemini-3.1-flash-lite-preview": FULL_MULTIMODAL,
  "gemini-3.1-flash-lite": FULL_MULTIMODAL,
  "gemini-3.5-flash": FULL_MULTIMODAL,
  "gemini-3.5-flash-lite": FULL_MULTIMODAL,
  "gemini-3.6-flash": FULL_MULTIMODAL,
  "gemini-3.7-flash": FULL_MULTIMODAL,
  "gemini-3.8-flash": FULL_MULTIMODAL,
  "gemini-omni-flash-preview": FULL_MULTIMODAL,
  "gemini-omni-1.1-flash": FULL_MULTIMODAL,
  "gemma-4-26b-a4b-it": TEXT_VISION_ONLY,
  "gemma-4-31b-it": TEXT_VISION_ONLY,
  "gemini-1.5-flash": FULL_MULTIMODAL,
});

const GEMINI_RECOMMENDED = new Set([
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.5-flash",
  "gemini-3.1-pro-preview",
  "gemini-3.5-flash-lite",
]);

function officialCapabilities(provider, modelId) {
  const id = String(modelId || "")
    .trim()
    .replace(/^models\//, "");
  if (!id) return null;
  if (provider === "gemini") return GEMINI_OFFICIAL[id] || null;
  return null;
}

function isGeminiRecommended(modelId) {
  const id = String(modelId || "")
    .trim()
    .replace(/^models\//, "");
  return GEMINI_RECOMMENDED.has(id);
}

/**
 * Conversational-LLM filter for the main model selector.
 * Non-chat families (embeddings, image-gen, TTS, video, live/realtime) are out.
 */
function isConversationalLlm(provider, modelId, meta = {}) {
  const id = String(modelId || "")
    .toLowerCase()
    .replace(/^models\//, "");
  if (!id) return false;

  const methods = Array.isArray(meta.methods)
    ? meta.methods.map((m) => String(m))
    : Array.isArray(meta.supportedGenerationMethods)
      ? meta.supportedGenerationMethods.map((m) => String(m))
      : Array.isArray(meta.supportedActions)
        ? meta.supportedActions.map((m) => String(m))
        : [];

  if (provider === "openai") return isOpenAiChatModel(id);
  if (provider === "anthropic") {
    if (meta.type && String(meta.type).toLowerCase() !== "model") return false;
    return true;
  }
  if (provider === "gemini") return isGeminiChatModel(id, methods);
  return true;
}

function isOpenAiChatModel(id) {
  if (id.includes("embedding") || id.includes("embed-")) return false;
  if (id.includes("moderation")) return false;
  if (id.startsWith("dall-e") || id.includes("dall-e")) return false;
  if (id.startsWith("gpt-image") || id.startsWith("chatgpt-image")) return false;
  if (id.startsWith("tts-") || id.includes("-tts")) return false;
  if (id.startsWith("whisper-")) return false;
  if (id.startsWith("sora")) return false;
  if (id.includes("davinci") || id.includes("babbage") || id.includes("curie")) return false;
  if (id.startsWith("ada-") || id.includes("text-similarity")) return false;
  if (id.includes("canary")) return false;
  return true;
}

function isGeminiChatModel(id, methods) {
  if (id.includes("embedding") || id.includes("vector")) return false;
  if (id === "aqa" || id.startsWith("aqa-")) return false;
  if (id.startsWith("imagen") || id.includes("-image") || id.includes("nano-banana")) return false;
  if (id.includes("-tts") || id.endsWith("tts")) return false;
  if (id.startsWith("veo") || id.includes("lyria")) return false;
  if (id.includes("transcribe")) return false;
  if (id.includes("native-audio") || id.includes("realtime")) return false;
  if (id.includes("-live") || /(^|-)live($|-)/.test(id)) return false;
  if (
    id.includes("robotics") ||
    id.includes("computer-use") ||
    id.includes("antigravity") ||
    id.includes("deep-research")
  ) {
    return false;
  }

  if (methods.includes("embedContent") && !methods.includes("generateContent")) return false;
  if (methods.includes("bidiGenerateContent") && !methods.includes("generateContent")) return false;
  if (
    methods.includes("bidiGenerateMusic") ||
    methods.includes("predictLongRunning") ||
    methods.includes("generateAnswer")
  ) {
    return false;
  }
  if (
    methods.length &&
    !methods.includes("generateContent") &&
    !methods.includes("generateContentStream")
  ) {
    return false;
  }
  return true;
}

module.exports = {
  FULL_MULTIMODAL,
  VISION_TEXT,
  TEXT_VISION_ONLY,
  officialCapabilities,
  isGeminiRecommended,
  isConversationalLlm,
};
