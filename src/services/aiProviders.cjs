// The openai and anthropic providers: the same agent aiAgent.cjs runs on
// Gemini, walked over two plain HTTP APIs.
//
// Why hand-rolled and not an SDK: the OpenAI side has to be OPENAI-COMPATIBLE,
// not OpenAI — the whole point of the provider is that the operator points
// `openai_base_url` at whichever server they have (OpenAI, OpenRouter, Groq,
// Ollama, LM Studio), and every SDK along that path hides or hard-codes the
// base URL in its own way. Two `fetch` calls with no dependencies between them
// are easier to keep honest than a dependency that fights the feature.
//
// What is deliberately NOT here:
//   * Google Search grounding — that is a Gemini built-in tool; these APIs
//     have no such concept. (Levix's own web_search tool still travels, so the
//     model can still look things up.)
//   * Media. There is no Files API to upload to on this path, so a message's
//     media parts become a one-line note and the text is what gets answered.
//     `!stt` and `!generate` stay on Gemini for the same reason.
//
// Storage does not change: chat history stays in the Gemini parts format on
// disk (single canonical shape, so the operator can switch providers in the
// panel without invalidating a single conversation), and each adapter here
// translates on the way out and back. Tool calls follow the same round trip:
// a provider's native tool_call / tool_use id is echoed into the canonical
// functionCall/functionResponse pair, so a conversation survives being moved
// from one provider to another mid-flight.
//
// The loop, narration, budget and history trimming are the aiAgent.cjs ones —
// runAgent() dispatches here and hands over the already-built system
// instruction and already-trimmed history.

const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const { toolDeclarations, describeCall, runTool } = require("./aiTools.cjs");

// Shown in place of a media part, on the wire and in the canonical history.
const MEDIA_NOTE = "[تم إرفاق ملف/وسائط في الرسالة]";

const API_TIMEOUT_MS = 120000;

// ===========================================================================
// adapters: everything that differs between the two wire formats
// ===========================================================================

const ADAPTERS = {
  openai: {
    label: "OpenAI-compatible",
    keySetting: "openai_api_key",
    modelSetting: "openai_model",
    baseUrlSetting: "openai_base_url",
    defaultBaseUrl: "https://api.openai.com/v1",
    tools: openaiTools,
    systemMessage: (systemInstruction) => [
      { role: "system", content: systemInstruction },
    ],
    userMessage: (text) => ({ role: "user", content: text }),
    /** Canonical history -> chat-completions messages. */
    historyToMessages: historyToOpenAI,
    /** Raw parsed response body -> { text, calls, assistantMessage }. */
    parseResponse: parseOpenAIResponse,
    /** One tool result as a message the API pairs with the call by id. */
    toolResultMessages: (calls, results) =>
      calls.map((call, i) => ({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(results[i] ?? {}),
      })),
  },

  anthropic: {
    label: "Anthropic",
    keySetting: "anthropic_api_key",
    modelSetting: "anthropic_model",
    baseUrlSetting: "anthropic_base_url",
    defaultBaseUrl: "https://api.anthropic.com",
    tools: anthropicTools,
    // Anthropic takes the system prompt as a top-level field, not a message.
    systemMessage: () => [],
    userMessage: (text) => ({
      role: "user",
      content: [{ type: "text", text }],
    }),
    historyToMessages: historyToAnthropic,
    parseResponse: parseAnthropicResponse,
    // Tool results ride in a user message as tool_result blocks, which is why
    // this also has to say which role carries them.
    toolResultRole: "user",
    toolResultMessages: (calls, results) => [
      {
        role: "user",
        content: calls.map((call, i) => ({
          type: "tool_result",
          tool_use_id: call.id,
          content: JSON.stringify(results[i] ?? {}),
        })),
      },
    ],
  },
};

function adapterFor(provider) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`مزود غير معروف: ${provider}`);
  return adapter;
}

/** The settings key holding the API key of whichever provider is active. */
function activeProviderKeySetting(provider = settings.get("ai_provider")) {
  return adapterFor(provider).keySetting;
}

// ===========================================================================
// schema translation — Gemini Schema (uppercase `Type`) -> JSON Schema
// ===========================================================================

// aiTools.cjs declares its parameters in Gemini's dialect because that is what
// the Gemini path consumes natively. Both other formats take ordinary JSON
// Schema, whose only real difference is lowercase type names and a few fields
// Gemini invented that other servers reject.
const TYPE_MAP = {
  string: "string",
  number: "number",
  integer: "integer",
  boolean: "boolean",
  array: "array",
  object: "object",
};

function toJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toJsonSchema);
  if (!schema || typeof schema !== "object") return schema;

  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "type") {
      const name = String(value).toLowerCase();
      out.type = TYPE_MAP[name] || name;
    } else if (key === "properties" && value && typeof value === "object") {
      out.properties = {};
      for (const [name, sub] of Object.entries(value)) {
        out.properties[name] = toJsonSchema(sub);
      }
    } else if (key === "items") {
      out.items = toJsonSchema(value);
    } else if (key === "anyOf") {
      out.anyOf = toJsonSchema(value);
    } else if (
      [
        "description",
        "enum",
        "required",
        "format",
        "minimum",
        "maximum",
        "default",
      ].includes(key)
    ) {
      out[key] = value;
    }
    // Everything else (nullable, ...) is Gemini-specific and dropped rather
    // than sent to a server that might 400 on an unknown field.
  }
  return out;
}

/** Levix's tool declarations in chat-completions `tools` shape. */
function openaiTools() {
  return toolDeclarations()[0].functionDeclarations.map((declaration) => ({
    type: "function",
    function: {
      name: declaration.name,
      description: declaration.description,
      parameters: toJsonSchema(declaration.parameters),
    },
  }));
}

/** Levix's tool declarations in Messages-API `tools` shape. */
function anthropicTools() {
  return toolDeclarations()[0].functionDeclarations.map((declaration) => ({
    name: declaration.name,
    description: declaration.description,
    input_schema: toJsonSchema(declaration.parameters),
  }));
}

// ===========================================================================
// history translation — canonical Gemini parts -> provider messages
// ===========================================================================

function partsText(parts) {
  return (parts || [])
    .map((part) => {
      if (part?.text) return part.text;
      // Media on this path is a note, never bytes: there is no upload API to
      // send it through (see the header comment).
      if (part?.fileData || part?.inlineData) return MEDIA_NOTE;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function safeJsonArgs(raw) {
  if (raw == null) return {};
  if (typeof raw === "object") return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Canonical -> chat-completions.
 *
 * `callIds` closes the loop for history written by the GEMINI path: Gemini
 * function calls carry no id, but a `tool` message is required to name the
 * `tool_call_id` it answers, so the assistant turn mints one and the map hands
 * the same value to the matching functionResponse.
 */
function historyToOpenAI(history) {
  const messages = [];
  const callIds = new Map();

  (history || []).forEach((turn, turnIndex) => {
    if (!turn || !Array.isArray(turn.parts)) return;
    const role = turn.role === "model" ? "assistant" : "user";
    const calls = turn.parts
      .filter((part) => part?.functionCall)
      .map((part) => part.functionCall);
    const responses = turn.parts
      .filter((part) => part?.functionResponse)
      .map((part) => part.functionResponse);
    const text = partsText(turn.parts);

    if (calls.length) {
      const toolCalls = calls.map((call, i) => {
        const id = call.id || `call_${turnIndex}_${i}`;
        if (call.name) callIds.set(call.name, id);
        return {
          id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args || {}) },
        };
      });
      messages.push({
        role: "assistant",
        content: text || null,
        tool_calls: toolCalls,
      });
      return;
    }

    if (responses.length) {
      for (const response of responses) {
        messages.push({
          role: "tool",
          tool_call_id: response.id || callIds.get(response.name) || `call_${turnIndex}`,
          content: JSON.stringify(response.response ?? {}),
        });
      }
      if (text) messages.push({ role: "user", content: text });
      return;
    }

    if (text) messages.push({ role, content: text });
  });

  return messages;
}

/**
 * Canonical -> Messages API. Content is always a block array, consecutive
 * same-role turns are merged (the API requires strict alternation), and a
 * tool_result block must land in a user turn — which is exactly where the
 * canonical format already keeps functionResponse parts.
 */
function historyToAnthropic(history) {
  const messages = [];
  const callIds = new Map();

  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  (history || []).forEach((turn, turnIndex) => {
    if (!turn || !Array.isArray(turn.parts)) return;
    const role = turn.role === "model" ? "assistant" : "user";
    const blocks = [];

    for (const part of turn.parts) {
      if (part?.text) {
        blocks.push({ type: "text", text: part.text });
      } else if (part?.functionCall) {
        const id = part.functionCall.id || `call_${turnIndex}_${blocks.length}`;
        if (part.functionCall.name) callIds.set(part.functionCall.name, id);
        blocks.push({
          type: "tool_use",
          id,
          name: part.functionCall.name,
          input: part.functionCall.args || {},
        });
      } else if (part?.functionResponse) {
        blocks.push({
          type: "tool_result",
          tool_use_id:
            part.functionResponse.id ||
            callIds.get(part.functionResponse.name) ||
            `call_${turnIndex}`,
          content: JSON.stringify(part.functionResponse.response ?? {}),
        });
      } else if (part?.fileData || part?.inlineData) {
        blocks.push({ type: "text", text: MEDIA_NOTE });
      }
    }

    push(role, blocks);
  });

  // The API refuses a conversation that opens on an assistant turn.
  while (messages.length && messages[0].role !== "user") messages.shift();
  return messages;
}

// ===========================================================================
// response parsing
// ===========================================================================

function parseOpenAIResponse(payload) {
  const message = payload?.choices?.[0]?.message || {};

  const content = Array.isArray(message.content)
    ? message.content.map((block) => block?.text || "").join("\n")
    : typeof message.content === "string"
    ? message.content
    : "";

  const calls = (message.tool_calls || [])
    .map((toolCall, i) => ({
      id: toolCall.id || `call_${i}`,
      name: toolCall.function?.name,
      args: safeJsonArgs(toolCall.function?.arguments),
    }))
    .filter((call) => call.name);

  return {
    text: content.trim(),
    calls,
    // Echoed verbatim so the tool messages can pair on the same ids.
    assistantMessage: {
      role: "assistant",
      content: message.content ?? null,
      ...(calls.length ? { tool_calls: message.tool_calls } : {}),
    },
  };
}

function parseAnthropicResponse(payload) {
  const blocks = (payload?.content || []).filter(
    (block) => block?.type === "text" || block?.type === "tool_use"
  );

  const calls = blocks
    .filter((block) => block.type === "tool_use")
    .map((block) => ({
      id: block.id || `call_${blocks.indexOf(block)}`,
      name: block.name,
      args: block.input && typeof block.input === "object" ? block.input : {},
    }));

  return {
    text: blocks
      .filter((block) => block.type === "text")
      .map((block) => block.text || "")
      .join("\n")
      .trim(),
    calls,
    // tool_use blocks must be echoed with their ids for the tool_result
    // pairing; text goes back too, exactly as the API expects.
    assistantMessage: { role: "assistant", content: blocks },
  };
}

// ===========================================================================
// the wire
// ===========================================================================

async function callApi({ url, headers, body, label }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(
      err?.name === "AbortError"
        ? `${label} API request timed out after ${API_TIMEOUT_MS / 1000}s`
        : `${label} API request failed: ${err?.message || err}`
    );
  } finally {
    clearTimeout(timer);
  }

  let payload = {};
  try {
    payload = await response.json();
  } catch {
    // A non-JSON body (a proxy error page, say) still gets the status below.
  }

  if (!response.ok) {
    const message =
      payload?.error?.message || payload?.error || response.statusText || "unknown error";
    const error = new Error(`${label} API request failed (${response.status}): ${message}`);
    error.status = response.status;
    throw error;
  }

  return payload;
}

function requestFor(adapter, provider, { baseUrl, apiKey, model, systemInstruction, messages, tools }) {
  if (provider === "anthropic") {
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: {
        model,
        max_tokens: 2048,
        ...(systemInstruction ? { system: systemInstruction } : {}),
        messages,
        ...(tools.length ? { tools, tool_choice: { type: "auto" } } : {}),
      },
    };
  }

  return {
    url: `${baseUrl}/chat/completions`,
    headers: { Authorization: `Bearer ${apiKey}` },
    body: {
      model,
      messages: [...adapter.systemMessage(systemInstruction), ...messages],
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: 0.7,
    },
  };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} تأخرت أكتر من ${Math.round(ms / 1000)} ثانية`)),
        ms
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// ===========================================================================
// the loop — same shape as aiAgent.runAgent, different wire format
// ===========================================================================

/**
 * Run one agent turn on a non-Gemini provider.
 *
 * @param {string}  provider                - "openai" | "anthropic"
 * @param {object}  options
 * @param {Array}   options.parts           - the current message (text parts; media arrives as notes)
 * @param {string}  options.systemInstruction - built by aiAgent.buildSystemInstruction
 * @param {Array}   [options.history]       - canonical history, already trimmed
 * @param {object}  [options.status]        - live status message for narration
 * @param {object}  [options.context]       - handed to the tools
 * @param {boolean} [options.useTools=true]
 * @returns {Promise<{text: string, history: Array, toolCalls: Array, steps: number, sources: Array, searchOffered: boolean}>}
 */
async function runProviderAgent(provider, {
  parts,
  systemInstruction,
  history = [],
  status = null,
  context = {},
  useTools = true,
  maxSteps = null,
} = {}) {
  const adapter = adapterFor(provider);

  const apiKey = settings.get(adapter.keySetting);
  if (!apiKey) throw new Error(`${adapter.label} API key is not configured`);

  const stepBudget = maxSteps ?? settings.get("ai_max_tool_steps");
  const model = settings.get(adapter.modelSetting);
  const baseUrl = String(
    settings.get(adapter.baseUrlSetting) || adapter.defaultBaseUrl
  ).replace(/\/+$/, "");

  const turnText = partsText(parts);

  // The provider-native conversation, and the canonical one that comes back
  // for storage. Both start from the trimmed history, then gain the current
  // user turn — exactly what the Gemini path's Chat class does internally.
  const messages = adapter.historyToMessages(history);
  messages.push(adapter.userMessage(turnText));

  const canonical = [...(Array.isArray(history) ? history : [])];
  canonical.push({
    role: "user",
    parts: (parts || []).filter((part) => part?.text || part?.fileData || part?.inlineData),
  });

  const tools = useTools ? adapter.tools() : [];
  const toolCalls = [];
  let steps = 0;

  const send = () => {
    const request = requestFor(adapter, provider, {
      baseUrl,
      apiKey,
      model,
      systemInstruction,
      messages,
      tools,
    });
    return callApi({ ...request, label: adapter.label });
  };

  let response = await send();
  while (true) {
    const parsed = adapter.parseResponse(response);

    if (parsed.text || parsed.calls.length) {
      canonical.push({
        role: "model",
        parts: [
          ...(parsed.text ? [{ text: parsed.text }] : []),
          ...parsed.calls.map((call) => ({
            functionCall: {
              // The provider's own id, so a mid-conversation provider switch
              // keeps tool call/result pairs intact.
              ...(call.id ? { id: call.id } : {}),
              name: call.name,
              args: call.args,
            },
          })),
        ],
      });
    }
    messages.push(parsed.assistantMessage);

    if (!parsed.calls.length) {
      return finish({ text: parsed.text, canonical, toolCalls, steps });
    }
    if (steps >= stepBudget) {
      // Same contract as the Gemini loop: the budget answer, not a lie.
      return finish({
        text:
          parsed.text ||
          "شغّلت الأدوات المتاحة بس مقدرتش أوصل لإجابة نهائية. جرّب تسأل بصيغة أوضح.",
        canonical,
        toolCalls,
        steps,
      });
    }

    steps += 1;

    if (status) {
      const line = parsed.calls
        .map((call) => describeCall(call.name, call.args))
        .join("\n");
      await status.update(line);
    }

    const results = [];
    for (const call of parsed.calls) {
      toolCalls.push({ name: call.name, args: call.args });
      logger.info({ tool: call.name, chatId: context.chatId }, "[aiAgent] tool call");

      let toolResult;
      try {
        toolResult = await withTimeout(
          runTool(call.name, call.args, context),
          settings.get("ai_tool_timeout_ms"),
          call.name
        );
      } catch (err) {
        toolResult = { error: err?.message || String(err) };
      }
      results.push(toolResult);
    }

    const resultMessages = adapter.toolResultMessages(parsed.calls, results);
    messages.push(...resultMessages);
    // The canonical shape keeps one user turn carrying every functionResponse,
    // which is also what adapterFor("openai") expects to translate back.
    canonical.push({
      role: "user",
      parts: parsed.calls.map((call, i) => ({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: results[i],
        },
      })),
    });

    if (status) await status.update("🤖 بجهّز الرد...");
    response = await send();
  }
}

function finish({ text, canonical, toolCalls, steps }) {
  return {
    text,
    history: canonical,
    toolCalls,
    steps,
    // Grounding is a Gemini feature; these providers never have sources.
    sources: [],
    searchOffered: false,
  };
}

module.exports = {
  runProviderAgent,
  activeProviderKeySetting,
  toJsonSchema,
  openaiTools,
  anthropicTools,
  historyToOpenAI,
  historyToAnthropic,
  parseOpenAIResponse,
  parseAnthropicResponse,
  ADAPTERS,
};
