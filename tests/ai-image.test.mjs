// Dedicated Gemini image generation. The local genai stand-in is the only
// endpoint. Nothing here calls Google.

import { startGenaiServer, textReply } from "./fixtures/genai-server.mjs";
import {
  equal,
  finish,
  ok,
  require as harnessRequire,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-ai-image");

const settings = harnessRequire("./src/config/settings.cjs");
const storage = harnessRequire("./src/utils/storage.cjs");
const { generateImage } = harnessRequire("./src/services/aiImage.cjs");

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const PNG = Buffer.from(PNG_B64, "base64");

function imagePart(data, mimeType) {
  return {
    candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType, data } }] } }],
  };
}

async function grab(run) {
  try {
    return { value: await run() };
  } catch (err) {
    return { err };
  }
}

async function withFake(replies, run) {
  const fake = await startGenaiServer(replies);
  settings.set("gemini_api_key", "test-image-key");
  settings.set("gemini_base_url", fake.baseUrl);
  settings.set("gemini_image_model", "gemini-image-test");
  settings.set("ai_provider", "openai");
  settings.set("openai_api_key", "sk-chat-only");
  settings.set("gemini_model", "chat-model-not-image");
  try {
    return await run(fake);
  } finally {
    for (const key of [
      "gemini_api_key",
      "gemini_base_url",
      "gemini_image_model",
      "ai_provider",
      "openai_api_key",
      "gemini_model",
    ]) {
      settings.set(key, "");
    }
    await fake.stop();
  }
}

section("valid png on the image model");

{
  const got = await withFake([imagePart(PNG.toString("base64"), "image/png")], async (fake) => {
    const result = await generateImage("a red square");
    return { result, url: fake.requests[0]?.url, body: fake.body(0) };
  });
  equal("provider is gemini", got.result.provider, "gemini");
  equal("model is the image setting", got.result.model, "gemini-image-test");
  equal("mime follows the png header", got.result.mimetype, "image/png");
  ok("bytes are the png", got.result.image.equals(PNG));
  ok("request uses the image model", got.url.includes("/models/gemini-image-test:"));
  ok("chat model is not the image request", !got.url.includes("chat-model-not-image"));
  equal(
    "image modality was requested",
    got.body?.generationConfig?.responseModalities?.[0],
    "IMAGE",
  );
}

section("rejected output and quota");

{
  const textOnly = await withFake([textReply("I cannot draw that")], () =>
    grab(() => generateImage("a cat")),
  );
  equal("text-only is invalid output", textOnly.err?.code, "IMAGE_OUTPUT_INVALID");

  const badHeader = await withFake(
    [imagePart(Buffer.from("hello").toString("base64"), "image/png")],
    () => grab(() => generateImage("a cat")),
  );
  equal("non-image bytes are invalid", badHeader.err?.code, "IMAGE_OUTPUT_INVALID");

  const wrongMime = await withFake([imagePart(PNG.toString("base64"), "image/jpeg")], () =>
    grab(() => generateImage("a cat")),
  );
  equal("png bytes labeled jpeg are invalid", wrongMime.err?.code, "IMAGE_OUTPUT_INVALID");

  const junk = await withFake([imagePart("@@@@", "image/png")], () =>
    grab(() => generateImage("a cat")),
  );
  equal("non-canonical base64 is invalid", junk.err?.code, "IMAGE_OUTPUT_INVALID");

  const quota = await withFake(
    [
      {
        __status: 429,
        body: { error: { status: "RESOURCE_EXHAUSTED", message: "key sk-secret prompt leak" } },
      },
    ],
    () => grab(() => generateImage("a cat")),
  );
  equal("quota is a fixed code", quota.err?.code, "IMAGE_QUOTA");
  ok(
    "quota text hides the provider body",
    !/sk-secret|prompt leak/i.test(String(quota.err?.message)),
  );
}

section("missing key, unsafe endpoint, abort");

{
  settings.set("gemini_api_key", "");
  const missing = await grab(() => generateImage("a cat"));
  equal("missing key", missing.err?.code, "IMAGE_KEY_REQUIRED");

  settings.set("gemini_api_key", "test-image-key");
  storage.saveBotSetting("setting:gemini_base_url", "http://10.1.2.3/gemini");
  const unsafe = await grab(() => generateImage("a cat"));
  equal("private endpoint is refused", unsafe.err?.code, "IMAGE_FAILED");
  ok("refusal does not echo the endpoint", !String(unsafe.err?.message).includes("10.1.2.3"));
  settings.set("gemini_api_key", "");
  settings.set("gemini_base_url", "");

  const fake = await startGenaiServer([imagePart(PNG.toString("base64"), "image/png")]);
  settings.set("gemini_api_key", "test-image-key");
  settings.set("gemini_base_url", fake.baseUrl);
  const aborted = await grab(() => generateImage("a cat", { signal: AbortSignal.abort() }));
  ok("abort is not a successful image", aborted.err?.name === "AbortError" && !aborted.value);
  equal("aborted call does not use a completed image request", fake.requests.length, 0);
  settings.set("gemini_api_key", "");
  settings.set("gemini_base_url", "");
  await fake.stop();
}

finish();
