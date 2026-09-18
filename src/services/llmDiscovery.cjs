// LLM provider model discovery.
//
// Live account availability comes only from each provider's authenticated
// models API. The seed catalog is recommendations / capability fallback.

const logger = require("../utils/logger.cjs");
const { assertProviderBaseUrl, safeProviderFetch } = require("../utils/providerUrl.cjs");
const {
  getSeedModels,
  resolveCapabilities,
  getCachedDiscovery,
  setCachedDiscovery,
  isConversationalLlm,
  cleanModelId,
} = require("./modelRegistry.cjs");

const REQUEST_TIMEOUT_MS = 20000;

class DiscoveryError extends Error {
  constructor(message, { code = 500, type = "server_error" } = {}) {
    super(message);
    this.name = "DiscoveryError";
    this.code = code;
    this.type = type;
  }
}

class BaseDiscoveryAdapter {
  constructor(providerId) {
    this.providerId = providerId;
  }

  validateCredentials(apiKey) {
    if (!apiKey || typeof apiKey !== "string" || !apiKey.trim()) {
      throw new DiscoveryError(`API key is required for live ${this.providerId} model discovery.`, {
        code: 400,
        type: "missing_credentials",
      });
    }
    return apiKey.trim();
  }

  async discover(_options) {
    throw new Error("discover() must be implemented by subclass");
  }
}

async function requestJson(url, { headers, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await safeProviderFetch(url, {
      method: "GET",
      headers: { Accept: "application/json", ...headers },
      signal: controller.signal,
    }, { allowLoopback: true });
    return resp;
  } catch (err) {
    if (err && err.name === "AbortError") {
      throw new DiscoveryError("The models request timed out.", {
        code: 504,
        type: "network_error",
      });
    }
    throw new DiscoveryError("Network error reaching the provider models endpoint.", {
      code: 0,
      type: "network_error",
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readJsonBody(resp) {
  try {
    return await resp.json();
  } catch {
    throw new DiscoveryError("Invalid JSON response from the provider models endpoint.", {
      code: 502,
      type: "server_error",
    });
  }
}

function httpError(providerLabel, status, { invalidHint, permissionHint } = {}) {
  if (status === 401) {
    throw new DiscoveryError(
      invalidHint ||
        `Invalid or expired ${providerLabel} API credential. Please verify and re-enter your key.`,
      { code: 401, type: "invalid_credentials" },
    );
  }
  if (status === 403) {
    throw new DiscoveryError(
      permissionHint || `Your ${providerLabel} credential does not have permission to list models.`,
      { code: 403, type: "permission_denied" },
    );
  }
  if (status === 429) {
    throw new DiscoveryError(
      `${providerLabel} rate limit or account quota exceeded. This does not mean the API key is invalid.`,
      { code: 429, type: "rate_limited" },
    );
  }
  if (status >= 500) {
    throw new DiscoveryError(
      `${providerLabel} is temporarily unavailable. Please try again later.`,
      { code: status, type: "server_error" },
    );
  }
  throw new DiscoveryError(`${providerLabel} API returned status ${status}.`, {
    code: status,
    type: "server_error",
  });
}

function enrichDiscoveredModel({ id, displayName, provider, providerCaps, status }) {
  const resolved = resolveCapabilities(provider, id, providerCaps);
  return {
    id,
    displayName: resolved.displayName || displayName || id,
    provider,
    recommended: resolved.recommended,
    capabilities: resolved.capabilities,
    capabilitySource: resolved.capabilitySource,
    status: status || resolved.status || "active",
    live: true,
  };
}

// ---------------------------------------------------------------------------
// OpenAI (and OpenAI-compatible) adapter
// ---------------------------------------------------------------------------
class OpenAIDiscoveryAdapter extends BaseDiscoveryAdapter {
  constructor() {
    super("openai");
  }

  async discover({ apiKey, baseUrl = "https://api.openai.com/v1" }) {
    const key = this.validateCredentials(apiKey);
    const rootUrl = assertProviderBaseUrl(baseUrl || "https://api.openai.com/v1", {
      allowLoopback: true,
    });
    const resp = await requestJson(`${rootUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
    });

    if (!resp.ok) {
      httpError("OpenAI", resp.status);
    }

    const data = await readJsonBody(resp);
    const rawList = Array.isArray(data?.data) ? data.data : [];

    return rawList
      .map((m) => ({ id: cleanModelId(m.id), raw: m }))
      .filter((m) => isConversationalLlm("openai", m.id))
      .map((m) =>
        enrichDiscoveredModel({
          id: m.id,
          displayName: m.id,
          provider: "openai",
        }),
      );
  }
}

// ---------------------------------------------------------------------------
// Anthropic adapter
// ---------------------------------------------------------------------------
class AnthropicDiscoveryAdapter extends BaseDiscoveryAdapter {
  constructor() {
    super("anthropic");
  }

  extractProviderCaps(raw) {
    const providerCaps = raw.capabilities || raw.features;
    const hasExplicit =
      (providerCaps && typeof providerCaps === "object") ||
      raw.supports_vision !== undefined ||
      raw.supports_audio !== undefined ||
      Array.isArray(raw.input_modalities);

    if (!hasExplicit) return null;

    const modalities = Array.isArray(raw.input_modalities) ? raw.input_modalities : [];
    const pick = (...vals) => {
      for (const v of vals) {
        if (v !== undefined && v !== null) return Boolean(v);
      }
      return undefined;
    };

    const vision = pick(
      raw.supports_vision,
      modalities.length ? modalities.includes("image") : undefined,
      providerCaps?.image_input,
      providerCaps?.vision,
    );
    const audioInput = pick(
      raw.supports_audio,
      modalities.length ? modalities.includes("audio") : undefined,
      providerCaps?.audio_input,
    );
    const pdfInput = pick(providerCaps?.document_input, providerCaps?.pdf_input);
    const videoInput = pick(providerCaps?.video_input);
    const stt = pick(providerCaps?.stt);

    const caps = { textInput: true, textOutput: true };
    if (vision !== undefined) caps.vision = vision;
    if (audioInput !== undefined) caps.audioInput = audioInput;
    if (pdfInput !== undefined) caps.pdfInput = pdfInput;
    if (videoInput !== undefined) caps.videoInput = videoInput;
    if (stt !== undefined) caps.stt = stt;
    return caps;
  }

  async discover({ apiKey, baseUrl = "https://api.anthropic.com" }) {
    const key = this.validateCredentials(apiKey);
    const rootUrl = assertProviderBaseUrl(baseUrl || "https://api.anthropic.com", {
      allowLoopback: true,
    });

    const allModels = [];
    let hasMore = true;
    let afterId = null;
    let pageCount = 0;
    const maxPages = 8;

    while (hasMore && pageCount < maxPages) {
      pageCount += 1;
      const queryParams = new URLSearchParams({ limit: "100" });
      if (afterId) queryParams.set("after_id", afterId);

      const resp = await requestJson(`${rootUrl}/v1/models?${queryParams.toString()}`, {
        headers: {
          "x-api-key": key,
          "anthropic-version": "2023-06-01",
        },
      });

      if (!resp.ok) {
        httpError("Anthropic", resp.status);
      }

      const data = await readJsonBody(resp);
      const rawList = Array.isArray(data?.data) ? data.data : [];
      for (const item of rawList) {
        const id = cleanModelId(item.id);
        if (!isConversationalLlm("anthropic", id, { type: item.type })) continue;
        allModels.push(
          enrichDiscoveredModel({
            id,
            displayName: item.display_name || id,
            provider: "anthropic",
            providerCaps: this.extractProviderCaps(item),
          }),
        );
      }

      hasMore = Boolean(data?.has_more);
      afterId = data?.last_id || (rawList.length ? rawList[rawList.length - 1].id : null);
      if (!afterId) hasMore = false;
    }

    return allModels;
  }
}

// ---------------------------------------------------------------------------
// Google Gemini adapter
// Official REST: GET /v1beta/models with x-goog-api-key (same auth the SDK uses,
// covering both legacy API keys and newer authorization keys).
// ---------------------------------------------------------------------------
class GeminiDiscoveryAdapter extends BaseDiscoveryAdapter {
  constructor() {
    super("gemini");
  }

  handleGeminiHttpError(status, errBody) {
    const reason = String(errBody?.error?.status || errBody?.error?.message || "");
    if (
      status === 401 ||
      reason.includes("API_KEY_INVALID") ||
      reason.includes("UNAUTHENTICATED")
    ) {
      throw new DiscoveryError(
        "Invalid or expired Google Gemini API credential. Please verify your key at Google AI Studio.",
        { code: 401, type: "invalid_credentials" },
      );
    }
    if (status === 403 || reason.includes("PERMISSION_DENIED")) {
      throw new DiscoveryError(
        "Your Google Gemini credential does not have permission to list models.",
        { code: 403, type: "permission_denied" },
      );
    }
    if (status === 400 && reason.includes("API_KEY_INVALID")) {
      throw new DiscoveryError(
        "Invalid or expired Google Gemini API credential. Please verify your key at Google AI Studio.",
        { code: 401, type: "invalid_credentials" },
      );
    }
    httpError("Google Gemini", status === 400 ? 400 : status);
  }

  async discover({ apiKey, baseUrl = "https://generativelanguage.googleapis.com" }) {
    const key = this.validateCredentials(apiKey);
    const rootUrl = assertProviderBaseUrl(
      baseUrl || "https://generativelanguage.googleapis.com",
      { allowLoopback: true },
    );

    const rawList = [];
    let pageToken = "";
    let pageCount = 0;
    const maxPages = 8;

    while (pageCount < maxPages) {
      pageCount += 1;
      const query = new URLSearchParams({ pageSize: "100" });
      if (pageToken) query.set("pageToken", pageToken);

      const resp = await requestJson(`${rootUrl}/v1beta/models?${query.toString()}`, {
        headers: { "x-goog-api-key": key },
      });

      if (!resp.ok) {
        let errBody = null;
        try {
          errBody = await resp.json();
        } catch {
          // ignore parse error
        }
        this.handleGeminiHttpError(resp.status, errBody);
      }

      const data = await readJsonBody(resp);
      const page = Array.isArray(data?.models) ? data.models : [];
      rawList.push(...page);
      pageToken = data?.nextPageToken || "";
      if (!pageToken) break;
    }

    return rawList
      .map((m) => {
        const id = cleanModelId(m.name || m.id);
        const methods = m.supportedGenerationMethods || m.supportedActions || [];
        return { id, methods, raw: m };
      })
      .filter((m) => isConversationalLlm("gemini", m.id, { methods: m.methods }))
      .map((m) =>
        enrichDiscoveredModel({
          id: m.id,
          displayName: m.raw.displayName || m.id,
          provider: "gemini",
          status: "active",
        }),
      );
  }
}

const ADAPTERS = {
  openai: new OpenAIDiscoveryAdapter(),
  anthropic: new AnthropicDiscoveryAdapter(),
  gemini: new GeminiDiscoveryAdapter(),
};

function seedOnlyResult(provKey, message) {
  return {
    success: true,
    live: false,
    requiresApiKey: true,
    fallback: true,
    provider: provKey,
    models: getSeedModels(provKey),
    message,
  };
}

async function discoverProviderModels(optionsOrProvider = "gemini", maybeOptions = {}) {
  let options = {};
  if (typeof optionsOrProvider === "string") {
    options = { provider: optionsOrProvider, ...maybeOptions };
  } else if (optionsOrProvider && typeof optionsOrProvider === "object") {
    options = optionsOrProvider;
  }

  const { provider = "gemini", apiKey = "", baseUrl = "", refresh = false } = options;
  const provKey = String(provider || "gemini").toLowerCase();
  const adapter = ADAPTERS[provKey];

  if (!adapter) {
    return {
      success: false,
      live: false,
      requiresApiKey: false,
      fallback: false,
      provider: provKey,
      error: {
        code: 400,
        type: "unsupported_provider",
        message: `Unsupported LLM provider: ${provider}`,
      },
      models: [],
    };
  }

  if (!apiKey || !String(apiKey).trim()) {
    return seedOnlyResult(
      provKey,
      `Please connect your ${provKey} API key to discover models available to your account.`,
    );
  }

  const cleanKey = String(apiKey).trim();

  if (!refresh) {
    const cached = getCachedDiscovery(provKey, cleanKey, baseUrl);
    if (cached) {
      return {
        success: true,
        live: true,
        requiresApiKey: false,
        fallback: false,
        provider: provKey,
        models: cached,
        cached: true,
      };
    }
  }

  try {
    const liveModels = await adapter.discover({
      apiKey: cleanKey,
      baseUrl,
    });

    setCachedDiscovery(provKey, cleanKey, baseUrl, liveModels);

    return {
      success: true,
      live: true,
      requiresApiKey: false,
      fallback: false,
      provider: provKey,
      models: liveModels,
      cached: false,
    };
  } catch (err) {
    const code = typeof err.code === "number" ? err.code : 500;
    const type = err.type || "server_error";
    const message = err.message || `Failed to fetch models from ${provKey}`;

    logger.warn(
      { provider: provKey, code, type },
      `[LLM Discovery] Live model fetch failed: ${message}`,
    );

    // Fallback seeds are labelled as recommendations, never as account-available.
    return {
      success: false,
      live: false,
      requiresApiKey: false,
      fallback: true,
      provider: provKey,
      error: { code, type, message },
      models: getSeedModels(provKey),
    };
  }
}

module.exports = {
  DiscoveryError,
  BaseDiscoveryAdapter,
  OpenAIDiscoveryAdapter,
  AnthropicDiscoveryAdapter,
  GeminiDiscoveryAdapter,
  discoverProviderModels,
  ADAPTERS,
};
