// Centralized LLM provider model registry and seed catalog.
//
// Source of truth rule:
// - The seeded catalog is ONLY for recommended models, display names,
//   capability fallback, and the empty-key UI.
// - Seed models are NEVER presented as "available for your account" unless
//   the provider's authenticated models endpoint returned that id.

const crypto = require("node:crypto");
const {
  officialCapabilities,
  isGeminiRecommended,
  isConversationalLlm,
} = require("../config/modelCapabilities.cjs");

const DEFAULT_CAPABILITIES = Object.freeze({
  textInput: true,
  textOutput: true,
  vision: false,
  audioInput: false,
  stt: false,
  videoInput: false,
  pdfInput: false,
});

function normalizeCapabilities(caps) {
  const c = caps || {};
  return {
    textInput: Boolean(c.textInput ?? DEFAULT_CAPABILITIES.textInput),
    textOutput: Boolean(c.textOutput ?? DEFAULT_CAPABILITIES.textOutput),
    vision: Boolean(c.vision ?? DEFAULT_CAPABILITIES.vision),
    audioInput: Boolean(c.audioInput ?? DEFAULT_CAPABILITIES.audioInput),
    stt: Boolean(c.stt ?? DEFAULT_CAPABILITIES.stt),
    videoInput: Boolean(c.videoInput ?? DEFAULT_CAPABILITIES.videoInput),
    pdfInput: Boolean(c.pdfInput ?? DEFAULT_CAPABILITIES.pdfInput),
  };
}

function cleanModelId(value) {
  return String(value || "")
    .trim()
    .replace(/^models\//, "");
}

function flattenRawModels(modelsList) {
  const result = [];
  if (!Array.isArray(modelsList)) return result;
  for (const item of modelsList) {
    if (!item) continue;
    if (Array.isArray(item.models)) {
      result.push(...flattenRawModels(item.models));
      continue;
    }
    result.push(item);
  }
  return result;
}

function normalizeSeedEntry(item, provider) {
  const rawId = cleanModelId(item.id || item.name);
  if (!rawId) return null;

  const methods = item.supportedGenerationMethods || item.supportedActions || [];
  if (!isConversationalLlm(provider, rawId, { methods, type: item.type })) {
    return null;
  }

  let caps = item.capabilities;
  let capabilitySource = item.capabilitySource || (caps ? "official-docs" : "unknown");
  if (!caps) {
    const official = officialCapabilities(provider, rawId);
    if (official) {
      caps = official;
      capabilitySource = "official-docs";
    } else {
      caps = DEFAULT_CAPABILITIES;
      capabilitySource = "unknown";
    }
  }

  const recommended =
    provider === "gemini"
      ? Boolean(item.recommended) || isGeminiRecommended(rawId)
      : Boolean(item.recommended);

  return {
    id: rawId,
    name: item.name || (provider === "gemini" ? `models/${rawId}` : rawId),
    displayName: item.displayName || rawId,
    recommended,
    status: item.status || (provider === "gemini" ? "stable" : "active"),
    aliases: Array.isArray(item.aliases) ? item.aliases : [],
    capabilitySource,
    capabilities: normalizeCapabilities(caps),
    supportedGenerationMethods: methods,
  };
}

function ensureBaselineModels(models, provider) {
  const existingIds = new Set(models.map((m) => m.id.toLowerCase()));
  const baselines = {
    openai: [
      {
        id: "gpt-4o",
        displayName: "GPT-4o",
        recommended: false,
        status: "active",
        aliases: ["chatgpt-4o-latest", "gpt-4o-2024-08-06", "gpt-4o-2024-05-13"],
        capabilitySource: "official-docs",
        capabilities: {
          textInput: true,
          textOutput: true,
          vision: true,
          audioInput: false,
          stt: false,
          videoInput: false,
          pdfInput: true,
        },
      },
      {
        id: "gpt-4o-mini",
        displayName: "GPT-4o Mini",
        recommended: false,
        status: "active",
        aliases: ["gpt-4o-mini-2024-07-18"],
        capabilitySource: "official-docs",
        capabilities: {
          textInput: true,
          textOutput: true,
          vision: true,
          audioInput: false,
          stt: false,
          videoInput: false,
          pdfInput: true,
        },
      },
    ],
    anthropic: [
      {
        id: "claude-3-5-sonnet",
        displayName: "Claude 3.5 Sonnet",
        recommended: false,
        status: "active",
        aliases: ["claude-3-5-sonnet-20241022", "claude-3-5-sonnet-latest", "claude-3-sonnet"],
        capabilitySource: "official-docs",
        capabilities: {
          textInput: true,
          textOutput: true,
          vision: true,
          audioInput: false,
          stt: false,
          videoInput: false,
          pdfInput: true,
        },
      },
      {
        id: "claude-3-5-haiku",
        displayName: "Claude 3.5 Haiku",
        recommended: false,
        status: "active",
        aliases: ["claude-3-5-haiku-20241022", "claude-3-haiku"],
        capabilitySource: "official-docs",
        capabilities: {
          textInput: true,
          textOutput: true,
          vision: true,
          audioInput: false,
          stt: false,
          videoInput: false,
          pdfInput: true,
        },
      },
    ],
    gemini: [
      {
        id: "gemini-3.7-flash",
        displayName: "Gemini 3.7 Flash",
        recommended: true,
        status: "stable",
        aliases: ["models/gemini-3.7-flash"],
        capabilitySource: "official-docs",
        capabilities: officialCapabilities("gemini", "gemini-3.7-flash"),
      },
      {
        id: "gemini-1.5-flash",
        displayName: "Gemini 1.5 Flash",
        recommended: false,
        status: "stable",
        aliases: ["models/gemini-1.5-flash"],
        capabilitySource: "official-docs",
        capabilities: officialCapabilities("gemini", "gemini-1.5-flash"),
      },
    ],
  };

  for (const b of baselines[provider] || []) {
    if (!existingIds.has(b.id.toLowerCase())) {
      models.push({
        ...b,
        capabilities: normalizeCapabilities(b.capabilities),
      });
      existingIds.add(b.id.toLowerCase());
    }
  }
}

function processCatalog(rawCatalog) {
  if (!rawCatalog || !rawCatalog.providers) return rawCatalog;
  for (const p of Object.keys(rawCatalog.providers)) {
    const provObj = rawCatalog.providers[p];
    if (!provObj || !Array.isArray(provObj.models)) continue;
    const flat = flattenRawModels(provObj.models)
      .map((item) => normalizeSeedEntry(item, p))
      .filter(Boolean);
    ensureBaselineModels(flat, p);
    provObj.models = flat;
  }
  return rawCatalog;
}

let cachedSeedData = null;

function loadRawCatalog() {
  try {
    return require("../config/available-models.json");
  } catch {
    return null;
  }
}

function loadSeedCatalog() {
  if (cachedSeedData) return cachedSeedData;
  const parsed = loadRawCatalog();
  if (parsed && parsed.providers) {
    cachedSeedData = processCatalog(parsed);
    return cachedSeedData;
  }

  cachedSeedData = processCatalog({
    schemaVersion: 1,
    updatedAt: "2026-09-18",
    providers: {
      openai: { requiresApiKey: true, models: [] },
      anthropic: { requiresApiKey: true, models: [] },
      gemini: { requiresApiKey: true, models: [] },
    },
  });
  return cachedSeedData;
}

function getSeedModels(provider) {
  const catalog = loadSeedCatalog();
  const provKey = String(provider || "").toLowerCase();
  const provData = catalog.providers?.[provKey];
  if (!provData || !Array.isArray(provData.models)) return [];

  return provData.models.map((m) => ({
    id: m.id,
    displayName: m.displayName || m.id,
    provider: provKey,
    recommended: Boolean(m.recommended),
    capabilities: normalizeCapabilities(m.capabilities),
    capabilitySource: "seed",
    status: m.status || "active",
    isRecommendedSeed: true,
    live: false,
  }));
}

function findSeedModel(provider, modelId) {
  if (!modelId) return null;
  const catalog = loadSeedCatalog();
  const provKey = String(provider || "").toLowerCase();
  const provData = catalog.providers?.[provKey];
  if (!provData || !Array.isArray(provData.models)) return null;

  const rawTarget = String(modelId).trim().toLowerCase();
  const cleanTarget = cleanModelId(rawTarget);

  for (const m of provData.models) {
    if (!m) continue;
    const mid = String(m.id || "").toLowerCase();
    const mname = cleanModelId(m.name || "").toLowerCase();
    if (mid === cleanTarget || mid === rawTarget || mname === cleanTarget || mname === rawTarget) {
      return m;
    }
    if (Array.isArray(m.aliases)) {
      const hit = m.aliases.some((alias) => {
        const a = String(alias).toLowerCase();
        return a === cleanTarget || a === rawTarget || cleanModelId(a) === cleanTarget;
      });
      if (hit) return m;
    }
  }
  return null;
}

function resolveCapabilities(provider, modelId, providerCaps = null) {
  const seed = findSeedModel(provider, modelId);
  if (providerCaps && typeof providerCaps === "object") {
    return {
      capabilities: normalizeCapabilities({
        ...(seed?.capabilities || DEFAULT_CAPABILITIES),
        ...providerCaps,
      }),
      capabilitySource: "provider",
      displayName: seed?.displayName || null,
      recommended: Boolean(seed?.recommended),
      status: seed?.status || "active",
    };
  }
  if (seed) {
    return {
      capabilities: normalizeCapabilities(seed.capabilities),
      capabilitySource: "seed",
      displayName: seed.displayName || null,
      recommended: Boolean(seed.recommended),
      status: seed.status || "active",
    };
  }
  return {
    capabilities: { ...DEFAULT_CAPABILITIES },
    capabilitySource: "unknown",
    displayName: null,
    recommended: false,
    status: "active",
  };
}

/**
 * Independent vision / STT guards. Unsupported features are forced off;
 * supported features keep the operator's existing choice.
 */
function applyCapabilityGuards({ visionEnabled, sttEnabled, capabilities }) {
  const caps = normalizeCapabilities(capabilities);
  return {
    visionEnabled: caps.vision ? Boolean(visionEnabled) : false,
    sttEnabled: caps.stt ? Boolean(sttEnabled) : false,
    visionLocked: !caps.vision,
    sttLocked: !caps.stt,
  };
}

// ---------------------------------------------------------------------------
// Discovery cache: provider + SHA-256 of the credential. Never stores the key.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 5 * 60 * 1000;
const discoveryCache = new Map();

function computeCacheKey(provider, apiKey, baseUrl = "") {
  const prov = String(provider || "").toLowerCase();
  const keyHash = crypto
    .createHash("sha256")
    .update(String(apiKey || ""))
    .digest("hex");
  const normalizedUrl = String(baseUrl || "").replace(/\/+$/, "");
  return `${prov}:${keyHash}:${normalizedUrl}`;
}

function getCachedDiscovery(provider, apiKey, baseUrl = "") {
  if (!apiKey) return null;
  const key = computeCacheKey(provider, apiKey, baseUrl);
  const entry = discoveryCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    discoveryCache.delete(key);
    return null;
  }
  return entry.models;
}

function setCachedDiscovery(provider, apiKey, baseUrl = "", models = []) {
  if (!apiKey) return;
  const key = computeCacheKey(provider, apiKey, baseUrl);
  discoveryCache.set(key, {
    timestamp: Date.now(),
    models: Object.freeze([...models]),
  });
}

function invalidateDiscoveryCache(provider = null) {
  if (!provider) {
    discoveryCache.clear();
    return;
  }
  const prefix = `${String(provider).toLowerCase()}:`;
  for (const k of discoveryCache.keys()) {
    if (k.startsWith(prefix)) discoveryCache.delete(k);
  }
}

function getDiscoveryCacheSize() {
  return discoveryCache.size;
}

module.exports = {
  DEFAULT_CAPABILITIES,
  loadSeedCatalog,
  getSeedModels,
  findSeedModel,
  normalizeCapabilities,
  resolveCapabilities,
  applyCapabilityGuards,
  isConversationalLlm,
  computeCacheKey,
  getCachedDiscovery,
  setCachedDiscovery,
  invalidateDiscoveryCache,
  getDiscoveryCacheSize,
  cleanModelId,
};
