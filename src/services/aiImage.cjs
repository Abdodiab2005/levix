// Dedicated Gemini image generation shared by !generate.
// Chat stays on ai_provider. This path always uses the image key, base URL,
// and gemini_image_model. Failures are fixed codes: no credentials, no
// provider body, and no image URL.

const { GoogleGenAI } = require("@google/genai");

const settings = require("../config/settings.cjs");
const { assertProviderBaseUrl, assertProviderRequestUrl } = require("../utils/providerUrl.cjs");

const MAX_PROMPT = 3000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 60000;

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff]);

let cache = { key: null, baseUrl: null, client: null };

function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

function aborted() {
  const err = new Error("aborted");
  err.name = "AbortError";
  err.code = "ABORT";
  return err;
}

function isAbort(err, signal) {
  return Boolean(signal?.aborted || err?.name === "AbortError" || err?.code === "ABORT");
}

function isQuota(err) {
  const status = Number(err?.status || err?.statusCode);
  if (status === 429 || err?.code === "IMAGE_QUOTA") return true;
  return /quota|RESOURCE_EXHAUSTED/i.test(String(err?.message || ""));
}

function declaredMime(mime) {
  const bare = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (bare === "image/png") return "image/png";
  if (bare === "image/jpeg" || bare === "image/jpg") return "image/jpeg";
  if (bare === "image/webp") return "image/webp";
  return null;
}

function headerMime(buf) {
  if (
    buf.length >= 45 &&
    buf.subarray(0, PNG.length).equals(PNG) &&
    buf.readUInt32BE(8) === 13 &&
    buf.toString("ascii", 12, 16) === "IHDR" &&
    buf.toString("ascii", buf.length - 8, buf.length - 4) === "IEND" &&
    buf.readUInt32BE(16) > 0 &&
    buf.readUInt32BE(20) > 0 &&
    buf.readUInt32BE(16) * buf.readUInt32BE(20) <= 64_000_000
  )
    return "image/png";
  if (
    buf.length >= 16 &&
    buf.subarray(0, JPEG.length).equals(JPEG) &&
    buf.subarray(-2).equals(Buffer.from([255, 217]))
  )
    return "image/jpeg";
  if (
    buf.length >= 12 &&
    buf.toString("latin1", 0, 4) === "RIFF" &&
    buf.toString("latin1", 8, 12) === "WEBP" &&
    buf.readUInt32LE(4) + 8 === buf.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(buf.toString("latin1", 12, 16))
  ) {
    return "image/webp";
  }
  return null;
}

function decodeImage(data, mime) {
  if (
    typeof data !== "string" ||
    !data ||
    data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    data.length % 4 !== 0
  )
    return null;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  const image = Buffer.from(data, "base64");
  if (!image.length || image.length > MAX_IMAGE_BYTES) return null;
  if (image.toString("base64") !== data) return null;
  const declared = declaredMime(mime);
  const header = headerMime(image);
  if (!declared || !header || declared !== header) return null;
  return { image, mimetype: header };
}

function imageFromResponse(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  for (const part of parts) {
    const inline = part?.inlineData;
    if (!inline || typeof inline.data !== "string") continue;
    const decoded = decodeImage(inline.data, inline.mimeType);
    if (decoded) return decoded;
  }
  return null;
}

function clientFor(baseUrl, key) {
  if (cache.key !== key || cache.baseUrl !== baseUrl) {
    cache = {
      key,
      baseUrl,
      client: new GoogleGenAI({ apiKey: key, httpOptions: { baseUrl } }),
    };
  }
  return cache.client;
}

/**
 * Generate one raster image on the configured Gemini image model.
 * @param {string} prompt
 * @param {{signal?: AbortSignal}} [options]
 * @returns {Promise<{image: Buffer, mimetype: string, provider: "gemini", model: string}>}
 */
async function generateImage(prompt, { signal } = {}) {
  if (typeof prompt !== "string" || !prompt.trim() || prompt.trim().length > MAX_PROMPT) {
    throw fail("IMAGE_FAILED");
  }
  if (signal?.aborted) throw aborted();

  const key = settings.get("gemini_api_key");
  if (!key) throw fail("IMAGE_KEY_REQUIRED");

  let baseUrl;
  try {
    baseUrl = assertProviderBaseUrl(settings.get("gemini_base_url"), { allowLoopback: true });
    await assertProviderRequestUrl(baseUrl, { allowLoopback: true });
  } catch {
    throw fail("IMAGE_FAILED");
  }
  if (signal?.aborted) throw aborted();

  const model = settings.get("gemini_image_model");
  let response;
  try {
    response = await clientFor(baseUrl, key).models.generateContent({
      model,
      contents: `Generate an image using this prompt: ${prompt.trim()}`,
      config: {
        responseModalities: ["IMAGE"],
        abortSignal: signal,
        // baseUrl is repeated so this request stays on the configured endpoint.
        httpOptions: { timeout: REQUEST_TIMEOUT_MS, baseUrl },
      },
    });
  } catch (err) {
    if (isAbort(err, signal)) throw aborted();
    if (isQuota(err)) throw fail("IMAGE_QUOTA");
    throw fail("IMAGE_FAILED");
  }

  // A late abort must not become a successful image.
  if (signal?.aborted) throw aborted();

  const decoded = imageFromResponse(response);
  if (!decoded) throw fail("IMAGE_OUTPUT_INVALID");
  if (signal?.aborted) throw aborted();

  return {
    image: decoded.image,
    mimetype: decoded.mimetype,
    provider: "gemini",
    model,
  };
}

module.exports = { generateImage };
