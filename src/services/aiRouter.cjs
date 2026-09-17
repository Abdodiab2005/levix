// file: src/services/aiRouter.cjs
// Modular AI Provider Registry and Router.
//
// Instead of hardcoding conditionals for each provider across command handlers
// and service loops, providers register an adapter implementing the BaseAIProvider
// interface. The router dispatches based on the active `ai_provider` setting.

const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");

class BaseAIProvider {
  constructor({
    id,
    label,
    keySetting,
    modelSetting,
    baseUrlSetting,
    defaultBaseUrl = "",
    supportsFiles = false,
  }) {
    this.id = id;
    this.label = label;
    this.keySetting = keySetting;
    this.modelSetting = modelSetting;
    this.baseUrlSetting = baseUrlSetting;
    this.defaultBaseUrl = defaultBaseUrl;
    this.supportsFiles = supportsFiles;
  }

  isConfigured() {
    return Boolean(this.getKey());
  }

  getKey() {
    return settings.get(this.keySetting) || "";
  }

  getModel() {
    return settings.get(this.modelSetting) || "";
  }

  getBaseUrl() {
    if (!this.baseUrlSetting) return this.defaultBaseUrl;
    return settings.get(this.baseUrlSetting) || this.defaultBaseUrl;
  }

  supportsMedia(mime = "") {
    if (this.supportsFiles) return true;
    return (
      Boolean(settings.get("ai_vision_enabled")) &&
      typeof mime === "string" &&
      mime.startsWith("image/")
    );
  }

  async prepareMedia(parts, mediaMessage, mimeOverride, _context = {}) {
    const mime = mimeOverride || mediaMessage?.mimetype || "ملف";
    parts.push({
      text: `[تم إرفاق وسائط (${mime}) — المزود الحالي لا يدعم هذا النوع من الوسائط]`,
    });
    return null;
  }

  async runTurn(_options) {
    throw new Error(`runTurn() not implemented for provider: ${this.id}`);
  }
}

const REGISTRY = new Map();

function registerProvider(id, providerInstance) {
  if (!id || typeof id !== "string") {
    throw new Error("Provider id must be a non-empty string");
  }
  REGISTRY.set(id.toLowerCase(), providerInstance);
}

function getProvider(id = settings.get("ai_provider")) {
  const key = String(id || "gemini").toLowerCase();
  const provider = REGISTRY.get(key);
  if (!provider) {
    throw new Error(`مزود غير معروف: ${id}`);
  }
  return provider;
}

function hasProvider(id) {
  return REGISTRY.has(String(id || "").toLowerCase());
}

function listProviders() {
  return Array.from(REGISTRY.values());
}

function activeProviderKeySetting(provider = settings.get("ai_provider")) {
  const p = getProvider(provider);
  return p.keySetting;
}

function detectModelCapabilities(
  provider = settings.get("ai_provider"),
  model = null
) {
  const p = provider || "gemini";
  const m = String(
    model ||
      (p === "gemini"
        ? settings.get("gemini_model")
        : p === "openai"
        ? settings.get("openai_model")
        : settings.get("anthropic_model")) ||
      ""
  ).toLowerCase();

  const isGemini = p === "gemini";
  const isAnthropic = p === "anthropic";
  const supportsVision =
    isGemini ||
    isAnthropic ||
    m.includes("vision") ||
    m.includes("vl") ||
    m.includes("llava") ||
    m.includes("4o") ||
    m.includes("pixtral") ||
    m.includes("qwen") ||
    m.includes("minicpm") ||
    m.includes("claude-3") ||
    m.includes("gemini") ||
    m.includes("llama-3.2-11b") ||
    m.includes("llama-3.2-90b");

  const supportsAudioStt = isGemini || p === "openai" || m.includes("whisper") || m.includes("audio");

  return {
    provider: p,
    model: m,
    supportsVision,
    supportsAudioStt,
    visionRecommended: supportsVision && !settings.get("ai_vision_enabled"),
  };
}

module.exports = {
  BaseAIProvider,
  registerProvider,
  getProvider,
  hasProvider,
  listProviders,
  activeProviderKeySetting,
  detectModelCapabilities,
};
