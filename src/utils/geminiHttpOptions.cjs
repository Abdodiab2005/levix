const { fetch: undiciFetch, getGlobalDispatcher } = require("undici");
const { t } = require("./i18n.cjs");

// Custom Gemini gateways use a 20 MiB JSON body limit and a 15 MiB
// aggregate decoded-media limit. Google keeps the SDK's own transport.
const JSON_LIMIT = 20 * 1024 * 1024;

function tooLarge() {
  const error = new Error(t("bot.ai.gemini.requestTooLarge"));
  error.code = "GEMINI_REQUEST_TOO_LARGE";
  return error;
}

function assertGeminiRequestBudget(body) {
  // The SDK has already serialized the complete wire payload: count it as-is,
  // including UTF-8, escaping, tools, system instruction and every history turn.
  // This also enforces the gateway's aggregate 15 MiB decoded-media limit:
  // valid Base64 needs 4 bytes per 3 decoded bytes (plus padding), so 15 MiB
  // already fills all 20 MiB before the JSON envelope. Summing across parts or
  // history cannot evade that bound. No parsing, decoding, copying or second
  // serialization of large media strings is necessary. Invalid Base64 remains
  // the endpoint's validation responsibility, as before.
  if (Buffer.byteLength(body, "utf8") > JSON_LIMIT) throw tooLarge();
}

// A custom fetch disables the SDK's no-timeout dispatcher. Preserve that
// behavior while leaving its AbortSignal/request timeout in charge.
const dispatcher = {
  dispatch(options, handler) {
    return getGlobalDispatcher().dispatch(
      { ...options, headersTimeout: 0, bodyTimeout: 0 },
      handler,
    );
  },
};

async function budgetedFetch(url, init) {
  const path = new URL(url).pathname;
  if (init?.method === "POST" && /:(?:generateContent|streamGenerateContent)$/.test(path)) {
    assertGeminiRequestBudget(init.body);
  }
  // Uploads, polling and downloads keep their existing behavior, including the
  // missing Files API response that triggers geminiMediaPart's inline fallback.
  // Node's built-in fetch uses a different dispatcher handler protocol.
  // Keep fetch and dispatcher on the same installed Undici version.
  return undiciFetch(url, { ...init, dispatcher });
}

function geminiHttpOptions(baseUrl) {
  if (!baseUrl || new URL(baseUrl).hostname === "generativelanguage.googleapis.com") {
    return { baseUrl };
  }
  return { baseUrl, fetch: budgetedFetch };
}

module.exports = { geminiHttpOptions, assertGeminiRequestBudget };
