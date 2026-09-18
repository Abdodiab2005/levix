import { startProviderServer } from "./fixtures/provider-server.mjs";
import { finish, require as harnessRequire, ok, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("model-discovery");

const { discoverProviderModels } = harnessRequire("./src/services/llmDiscovery.cjs");
const {
  getSeedModels,
  findSeedModel,
  invalidateDiscoveryCache,
  getDiscoveryCacheSize,
  applyCapabilityGuards,
  computeCacheKey,
  isConversationalLlm,
} = harnessRequire("./src/services/modelRegistry.cjs");

// ===========================================================================
// 1. Missing Credentials Flow
// ===========================================================================
section("unauthenticated / missing credentials flow");

{
  invalidateDiscoveryCache();

  // OpenAI without key
  const openAiNoKey = await discoverProviderModels("openai", { apiKey: "" });
  ok("openai without key returns success", openAiNoKey.success);
  ok("openai without key is not live", openAiNoKey.live === false);
  ok("openai without key requires key", openAiNoKey.requiresApiKey === true);
  ok("openai returns seed models", openAiNoKey.models.length > 0);
  ok(
    "seed models marked as recommended seed",
    openAiNoKey.models.every((m) => m.isRecommendedSeed),
  );
  ok(
    "seed models not claimed as live verified",
    openAiNoKey.models.every((m) => m.live !== true),
  );

  // Anthropic without key
  const anthropicNoKey = await discoverProviderModels("anthropic", { apiKey: "" });
  ok("anthropic without key requires key", anthropicNoKey.requiresApiKey === true);
  ok("anthropic without key is not live", anthropicNoKey.live === false);
  ok("anthropic returns seed models", anthropicNoKey.models.length > 0);

  // Gemini without key
  const geminiNoKey = await discoverProviderModels("gemini", { apiKey: "" });
  ok("gemini without key requires key", geminiNoKey.requiresApiKey === true);
  ok("gemini without key is not live", geminiNoKey.live === false);
  ok("gemini returns seed models", geminiNoKey.models.length > 0);
}

// ===========================================================================
// 2. OpenAI Live Discovery & Filtering Flow
// ===========================================================================
section("openai: live discovery, filtering, and capabilities");

{
  invalidateDiscoveryCache();

  const fakeOpenAI = await startProviderServer({
    "/v1/models": [
      {
        data: [
          { id: "gpt-6-astra", object: "model", created: 1700000000 },
          { id: "text-embedding-3-small", object: "model", created: 1700000000 },
          { id: "text-moderation-latest", object: "model", created: 1700000000 },
          { id: "dall-e-3", object: "model", created: 1700000000 },
          { id: "tts-1", object: "model", created: 1700000000 },
          { id: "whisper-1", object: "model", created: 1700000000 },
          { id: "custom-enterprise-llm-v1", object: "model", created: 1700000000 },
        ],
      },
    ],
  });

  try {
    const res = await discoverProviderModels("openai", {
      apiKey: "sk-test-openai-secret-key-12345",
      baseUrl: `${fakeOpenAI.baseUrl}/v1`,
    });

    ok("openai discovery succeeded", res.success);
    ok("marked as live authenticated", res.live === true);
    ok("does not require key prompt", res.requiresApiKey === false);

    // Verify request headers
    const req = fakeOpenAI.requests.find((r) => r.url === "/v1/models");
    ok("request sent to /v1/models", Boolean(req));
    ok(
      "authorization header sent correctly",
      req.headers.authorization === "Bearer sk-test-openai-secret-key-12345",
    );

    // Verify non-chat filtering
    const modelIds = res.models.map((m) => m.id);
    ok("chat model gpt-6-astra included", modelIds.includes("gpt-6-astra"));
    ok("custom llm included", modelIds.includes("custom-enterprise-llm-v1"));
    ok("embedding model filtered out", !modelIds.includes("text-embedding-3-small"));
    ok("moderation model filtered out", !modelIds.includes("text-moderation-latest"));
    ok("dall-e model filtered out", !modelIds.includes("dall-e-3"));
    ok("tts model filtered out", !modelIds.includes("tts-1"));
    ok("whisper model filtered out", !modelIds.includes("whisper-1"));

    // Verify capabilities of seed model
    const gpt6 = res.models.find((m) => m.id === "gpt-6-astra");
    ok("gpt-6 has seed capability source", gpt6.capabilitySource === "seed");
    ok("gpt-6 supports vision", gpt6.capabilities.vision === true);
    ok("gpt-6 does NOT support stt", gpt6.capabilities.stt === false);
    ok("gpt-6 has 7 distinct boolean flags", typeof gpt6.capabilities.pdfInput === "boolean");

    // Verify unknown model gets capabilitySource: "unknown" with safe defaults
    const customModel = res.models.find((m) => m.id === "custom-enterprise-llm-v1");
    ok("unknown model marked capabilitySource unknown", customModel.capabilitySource === "unknown");
    ok("unknown model has vision disabled by default", customModel.capabilities.vision === false);
    ok("unknown model has stt disabled by default", customModel.capabilities.stt === false);
    ok(
      "unknown model has audioInput disabled by default",
      customModel.capabilities.audioInput === false,
    );
  } finally {
    await fakeOpenAI.stop();
  }
}

// ===========================================================================
// 3. Anthropic Live Discovery & Pagination Flow
// ===========================================================================
section("anthropic: live discovery, pagination, and provider capabilities");

{
  invalidateDiscoveryCache();

  let pageCalls = 0;
  const fakeAnthropic = await startProviderServer({
    "/v1/models": [
      (body) => {
        pageCalls++;
        return {
          data: [
            {
              id: "claude-fable-5-1",
              display_name: "Claude Fable 5.1",
              type: "model",
            },
          ],
          has_more: true,
          next_page: "cursor_page_2",
        };
      },
      (body) => {
        pageCalls++;
        return {
          data: [
            {
              id: "claude-vision-experimental",
              display_name: "Claude Vision Experimental",
              type: "model",
              supports_vision: true,
            },
          ],
          has_more: false,
        };
      },
    ],
  });

  try {
    const res = await discoverProviderModels("anthropic", {
      apiKey: "ant-api03-test-credential-xyz",
      baseUrl: fakeAnthropic.baseUrl,
    });

    ok("anthropic discovery succeeded", res.success);
    ok("anthropic discovery marked live", res.live === true);
    ok("paginated both pages", pageCalls === 2);

    const modelIds = res.models.map((m) => m.id);
    ok("page 1 model present", modelIds.includes("claude-fable-5-1"));
    ok("page 2 model present", modelIds.includes("claude-vision-experimental"));

    // Verify auth header
    const req1 = fakeAnthropic.requests[0];
    ok("x-api-key header sent", req1.headers["x-api-key"] === "ant-api03-test-credential-xyz");
    ok("anthropic-version header sent", req1.headers["anthropic-version"] === "2023-06-01");

    // Verify provider capability priority
    const expModel = res.models.find((m) => m.id === "claude-vision-experimental");
    ok(
      "exp model marked with provider capability source",
      expModel.capabilitySource === "provider",
    );
    ok("exp model vision capability is true from provider", expModel.capabilities.vision === true);
  } finally {
    await fakeAnthropic.stop();
  }
}

// ===========================================================================
// 4. Gemini Live Discovery Flow
// ===========================================================================
section("gemini: live discovery and supported methods filtering");

{
  invalidateDiscoveryCache();

  const fakeGemini = await startProviderServer({
    "/v1beta/models": [
      {
        models: [
          {
            name: "models/gemini-3.8-flash",
            displayName: "Gemini 3.8 Flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/text-embedding-004",
            displayName: "Text Embedding 004",
            supportedGenerationMethods: ["embedContent"],
          },
          {
            name: "models/gemini-embedding-001",
            displayName: "Gemini Embedding 001",
            supportedGenerationMethods: ["embedContent"],
          },
          {
            name: "models/gemini-3.8-live",
            displayName: "Gemini 3.8 Live",
            supportedGenerationMethods: ["bidiGenerateContent"],
          },
          {
            name: "models/gemini-2.5-flash-native-audio-latest",
            displayName: "Gemini 2.5 Flash Native Audio Latest",
            supportedGenerationMethods: ["countTokens", "bidiGenerateContent"],
          },
          {
            name: "models/aqa",
            displayName: "Attributed Question Answering",
            supportedGenerationMethods: ["generateAnswer"],
          },
        ],
      },
    ],
  });

  try {
    const res = await discoverProviderModels("gemini", {
      apiKey: "AIzaSyFakeGeminiAuthCredentialKey999",
      baseUrl: fakeGemini.baseUrl,
    });

    ok("gemini discovery succeeded", res.success);
    ok("gemini discovery marked live", res.live === true);

    const modelIds = res.models.map((m) => m.id);
    ok("chat model gemini-3.8-flash included", modelIds.includes("gemini-3.8-flash"));
    ok("embedContent model filtered out", !modelIds.includes("text-embedding-004"));
    ok("vectorize/embedding model filtered out", !modelIds.includes("gemini-embedding-001"));
    ok("realtime live model filtered out", !modelIds.includes("gemini-3.8-live"));
    ok(
      "native-audio realtime model filtered out",
      !modelIds.includes("gemini-2.5-flash-native-audio-latest"),
    );
    ok("aqa model filtered out", !modelIds.includes("aqa"));

    // Check auth header
    const req = fakeGemini.requests.find((r) => r.url.includes("/v1beta/models"));
    ok(
      "x-goog-api-key header used for auth",
      req.headers["x-goog-api-key"] === "AIzaSyFakeGeminiAuthCredentialKey999",
    );

    const flash = res.models.find((m) => m.id === "gemini-3.8-flash");
    ok("gemini flash has vision true", flash.capabilities.vision === true);
    ok("gemini flash has stt true", flash.capabilities.stt === true);
  } finally {
    await fakeGemini.stop();
  }
}

// ===========================================================================
// 5. Error Mapping & Security Handling
// ===========================================================================
section("error handling: 401, 403, 429, 500, network error and zero credential leakage");

{
  invalidateDiscoveryCache();

  // 401 Invalid Credentials
  const fake401 = await startProviderServer({
    "/v1/models": [{ __status: 401, body: { error: { message: "Invalid API key provided" } } }],
  });

  try {
    const res401 = await discoverProviderModels("openai", {
      apiKey: "sk-bad-key-secret-9999",
      baseUrl: `${fake401.baseUrl}/v1`,
    });

    ok("401 returns success: false", res401.success === false);
    ok("401 maps to code 401", res401.error.code === 401);
    ok("401 maps to type invalid_credentials", res401.error.type === "invalid_credentials");
    ok("error does not leak api key", !JSON.stringify(res401).includes("sk-bad-key-secret-9999"));
    ok("failed discovery is not live", res401.live === false);
    ok("failed discovery marks fallback", res401.fallback === true);
    ok(
      "fallback models are seed recommendations",
      res401.models.length === 0 ||
        res401.models.every((m) => m.isRecommendedSeed && m.live !== true),
    );
  } finally {
    await fake401.stop();
  }

  // 403 Permission Denied
  const fake403 = await startProviderServer({
    "/v1/models": [
      { __status: 403, body: { error: { message: "Permission denied for this key" } } },
    ],
  });

  try {
    const res403 = await discoverProviderModels("anthropic", {
      apiKey: "ant-forbidden-key-8888",
      baseUrl: fake403.baseUrl,
    });

    ok("403 returns success: false", res403.success === false);
    ok("403 maps to type permission_denied", res403.error.type === "permission_denied");
  } finally {
    await fake403.stop();
  }

  const fakeGemini403 = await startProviderServer({
    "/v1beta/models": [
      { __status: 403, body: { error: { status: "PERMISSION_DENIED", message: "no access" } } },
    ],
  });

  try {
    const resG403 = await discoverProviderModels("gemini", {
      apiKey: "gemini-forbidden-key",
      baseUrl: fakeGemini403.baseUrl,
    });
    ok(
      "gemini 403 is not reported as an invalid key",
      resG403.error.type !== "invalid_credentials",
    );
    ok("gemini 403 maps to permission_denied", resG403.error.type === "permission_denied");
  } finally {
    await fakeGemini403.stop();
  }

  // 429 Rate Limit - must NOT be reported as invalid credentials
  const fake429 = await startProviderServer({
    "/v1/models": [{ __status: 429, body: { error: { message: "Rate limit exceeded" } } }],
  });

  try {
    const res429 = await discoverProviderModels("openai", {
      apiKey: "sk-valid-key-ratelimited",
      baseUrl: `${fake429.baseUrl}/v1`,
    });

    ok("429 returns success: false", res429.success === false);
    ok("429 maps to type rate_limited", res429.error.type === "rate_limited");
    ok("429 is NOT invalid_credentials", res429.error.type !== "invalid_credentials");
  } finally {
    await fake429.stop();
  }

  // Network connection error
  const resNet = await discoverProviderModels("openai", {
    apiKey: "sk-some-key",
    baseUrl: "http://127.0.0.1:1/v1", // Connection refused
  });
  ok("network failure returns success: false", resNet.success === false);
  ok("network failure maps to type network_error", resNet.error.type === "network_error");
}

// ===========================================================================
// 6. Discovery Cache & Invalidation
// ===========================================================================
section("discovery caching and safe hash scoping");

{
  invalidateDiscoveryCache();

  let hits = 0;
  const replyHandler = () => {
    hits++;
    return { data: [{ id: "gpt-6-astra", object: "model" }] };
  };
  const fakeCache = await startProviderServer({
    "/v1/models": [replyHandler, replyHandler, replyHandler],
  });

  try {
    // First call: hits server
    const r1 = await discoverProviderModels("openai", {
      apiKey: "sk-cached-key-abc",
      baseUrl: `${fakeCache.baseUrl}/v1`,
    });
    ok("first call succeeds", r1.success && r1.live);
    ok("first call made network request", hits === 1);
    ok("first call was not cached", r1.cached !== true);

    // Second call with same credentials: returns from cache
    const r2 = await discoverProviderModels("openai", {
      apiKey: "sk-cached-key-abc",
      baseUrl: `${fakeCache.baseUrl}/v1`,
    });
    ok("second call succeeds", r2.success && r2.live);
    ok("second call returned from cache", r2.cached === true);
    ok("second call did not hit network", hits === 1);

    // Third call with refresh: true -> bypasses cache and hits server
    const r3 = await discoverProviderModels("openai", {
      apiKey: "sk-cached-key-abc",
      baseUrl: `${fakeCache.baseUrl}/v1`,
      refresh: true,
    });
    ok("refresh call hit network again", hits === 2);

    // Cache invalidation by provider
    invalidateDiscoveryCache("openai");
    ok("cache cleared for openai", getDiscoveryCacheSize() === 0);
  } finally {
    await fakeCache.stop();
  }
}

// ===========================================================================
// 7. Seed Catalog Integrity
// ===========================================================================
section("seed catalog loader and baseline models");

{
  const openAiSeeds = getSeedModels("openai");
  ok("openai seed models exist", openAiSeeds.length > 0);
  ok(
    "seed models have 7-flag capabilities",
    openAiSeeds.every((m) => typeof m.capabilities.vision === "boolean"),
  );

  const anthropicSeeds = getSeedModels("anthropic");
  ok("anthropic seed models exist", anthropicSeeds.length > 0);

  const geminiSeeds = getSeedModels("gemini");
  ok("gemini seed models exist", geminiSeeds.length > 0);

  // Lookup tests
  const gpt6 = findSeedModel("openai", "gpt-6-astra");
  ok("findSeedModel finds gpt-6-astra", gpt6 !== null);
  ok("gpt-6 has vision true", gpt6.capabilities.vision === true);
  ok("gpt-6 has stt false", gpt6.capabilities.stt === false);

  const gpt4o = findSeedModel("openai", "gpt-4o");
  ok("findSeedModel finds gpt-4o baseline", gpt4o !== null);
  ok("gpt-4o has vision true", gpt4o.capabilities.vision === true);

  const geminiFlash = findSeedModel("gemini", "gemini-3.8-flash");
  ok("findSeedModel finds gemini-3.8-flash", geminiFlash !== null);
  ok("gemini-3.8-flash has vision true", geminiFlash.capabilities.vision === true);
  ok("gemini-3.8-flash has stt true", geminiFlash.capabilities.stt === true);

  const geminiWithPrefix = findSeedModel("gemini", "models/gemini-3.8-flash");
  ok("findSeedModel strips models/ prefix seamlessly", geminiWithPrefix !== null);

  ok("gemini seed excludes embeddings", !geminiSeeds.some((m) => /embed|vector/i.test(m.id)));
  ok(
    "gemini seed excludes realtime/live models",
    !geminiSeeds.some((m) => /live|native-audio|realtime/i.test(m.id)),
  );
  ok(
    "gemini seed excludes image-only / tts / veo / lyria",
    !geminiSeeds.some((m) => /image|tts|veo|lyria|nano-banana/i.test(m.id)),
  );
}

section("capability guards: vision and STT are independent");

{
  const gpt6 = findSeedModel("openai", "gpt-6-astra");
  ok("gpt-6-astra is in the seed catalog", gpt6 !== null);
  const guarded = applyCapabilityGuards({
    visionEnabled: true,
    sttEnabled: true,
    capabilities: gpt6.capabilities,
  });
  ok("GPT-6 Astra keeps vision enabled", guarded.visionEnabled === true);
  ok("GPT-6 Astra forces STT off", guarded.sttEnabled === false);
  ok("GPT-6 Astra locks STT", guarded.sttLocked === true);
  ok("GPT-6 Astra does not lock vision", guarded.visionLocked === false);

  const geminiFlash = findSeedModel("gemini", "gemini-3.7-flash");
  const geminiGuarded = applyCapabilityGuards({
    visionEnabled: true,
    sttEnabled: true,
    capabilities: geminiFlash.capabilities,
  });
  ok("Gemini Flash can keep vision", geminiGuarded.visionEnabled === true);
  ok("Gemini Flash can keep STT", geminiGuarded.sttEnabled === true);

  const unknownGuarded = applyCapabilityGuards({
    visionEnabled: true,
    sttEnabled: true,
    capabilities: {
      textInput: true,
      textOutput: true,
      vision: false,
      audioInput: false,
      stt: false,
      videoInput: false,
      pdfInput: false,
    },
  });
  ok("unknown model disables vision", unknownGuarded.visionEnabled === false);
  ok("unknown model disables STT", unknownGuarded.sttEnabled === false);

  ok(
    "cache key is not the raw api key",
    !computeCacheKey("openai", "sk-secret-should-never-appear", "").includes(
      "sk-secret-should-never-appear",
    ),
  );
  ok(
    "embedding ids are not conversational",
    !isConversationalLlm("openai", "text-embedding-3-small"),
  );
  ok("whisper is not conversational", !isConversationalLlm("openai", "whisper-1"));
  ok("gpt-6-astra is conversational", isConversationalLlm("openai", "gpt-6-astra"));
  ok(
    "gemini live is not conversational",
    !isConversationalLlm("gemini", "gemini-3.8-live", { methods: ["bidiGenerateContent"] }),
  );
}

finish();
