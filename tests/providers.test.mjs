// The openai and anthropic providers, on the real wire.
//
// Same discipline as genai.test.mjs: nothing mocks Levix's code. runAgent()
// dispatches on the ai_provider setting, builds its request, and `fetch` sends
// it to a local server standing in for the provider endpoint (see
// fixtures/provider-server.mjs). The assertions are about what actually went
// out and what came back: the tools on the wire, the system prompt, the
// tool-result round trip, and the canonical history that reaches storage.

import {
  useTempDataDir,
  require as harnessRequire,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";
import {
  startProviderServer,
  openaiText,
  openaiToolCall,
  anthropicText,
  anthropicToolCall,
  providerError,
  OPENAI_PATH,
  ANTHROPIC_PATH,
} from "./fixtures/provider-server.mjs";

useTempDataDir("levix-providers");

const settings = harnessRequire("./src/config/settings.cjs");
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");

const chatContext = { chatId: "1@s.whatsapp.net" };

function useFake(fake, provider) {
  const key = `key-${Math.random().toString(36).slice(2)}`;
  settings.set("ai_provider", provider);
  settings.set(`${provider}_api_key`, key);
  settings.set(`${provider}_base_url`, fake.baseUrl);
}

// ---------------------------------------------------------------------------

section("the provider selector");

{
  const described = settings.describe();
  const selector = described.find((entry) => entry.key === "ai_provider");
  equal("the selector is a string setting", selector.type, "string");
  equal(
    "with exactly the three providers as choices",
    JSON.stringify(selector.choices),
    JSON.stringify(["gemini", "openai", "anthropic"])
  );
  equal("and gemini is the default", selector.default, "gemini");
  equal("…which is what a fresh install runs", settings.get("ai_provider"), "gemini");

  // The provider has its own key/model/base-URL settings, all panel-visible.
  for (const key of [
    "openai_api_key",
    "openai_base_url",
    "openai_model",
    "anthropic_api_key",
    "anthropic_base_url",
    "anthropic_model",
  ]) {
    ok(`${key} is a setting`, described.some((entry) => entry.key === key));
  }
  const openaiBase = described.find((entry) => entry.key === "openai_base_url");
  equal("the openai base URL defaults to OpenAI itself", openaiBase.default, "https://api.openai.com/v1");
}

section("the agent is gated on the ACTIVE provider's key");

{
  settings.set("gemini_api_key", "gemini-key-exists");
  settings.set("ai_provider", "openai");
  settings.set("openai_api_key", "");
  ok("a gemini key does not open the openai path", !aiAgent.isAgentEnabled());
  settings.set("openai_api_key", "openai-key");
  ok("…the openai key does", aiAgent.isAgentEnabled());

  settings.set("ai_provider", "anthropic");
  ok("and anthropic is gated on its own key", !aiAgent.isAgentEnabled());
  settings.set("anthropic_api_key", "anthropic-key");
  ok("…which is honoured the moment it lands", aiAgent.isAgentEnabled());

  settings.set("ai_provider", "gemini");
  settings.set("gemini_api_key", "");
  settings.set("openai_api_key", "");
  settings.set("anthropic_api_key", "");
}

section("openai: the request that goes out");

await useOpenAI([], async (fake) => {
  settings.set("openai_model", "test-model-openai");
  await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [], context: chatContext });

  const body = fake.body(OPENAI_PATH, 0);
  ok("a request reached /chat/completions", !!body);
  equal("…for the configured model", body.model, "test-model-openai");
  equal("…at the configured path", fake.requests[0].url, OPENAI_PATH);

  ok("the system prompt leads the messages", body.messages[0].role === "system");
  ok("…carrying the runtime context", body.messages[0].content.includes("Current context"));
  equal("and the user turn closes it", body.messages.at(-1).content, "hi");

  const tools = body.tools || [];
  ok(`Levix's own tools travel (${tools.length})`, tools.length > 3);
  ok(
    "every one in chat-completions shape with lowercase schema types",
    tools.every(
      (tool) =>
        tool.type === "function" &&
        tool.function.name &&
        tool.function.parameters?.type === "object" &&
        // No uppercase Gemini `Type` value survived the translation.
        !/"type":"[A-Z]/.test(JSON.stringify(tool.function.parameters))
    )
  );
  const search = tools.find((tool) => tool.function.name === "web_search");
  equal(
    "the schema really was translated (query: string)",
    search?.function?.parameters?.properties?.query?.type,
    "string"
  );
  ok("…and never a Gemini built-in", !JSON.stringify(tools).includes("googleSearch"));
  equal("tool_choice is auto", body.tool_choice, "auto");

  // The key authenticates the Bearer way, and never anywhere else.
  ok("the api key is a Bearer token", /^Bearer key-/.test(fake.requests[0].headers.authorization || ""));
});

section("openai: a tool call runs and its result goes back");

await useOpenAI(
  [openaiToolCall([{ name: "get_datetime", args: {}, id: "call_abc" }]), openaiText("it is late")],
  async (fake) => {
    const result = await aiAgent.runAgent({
      parts: [{ text: "what time is it" }],
      history: [],
      context: chatContext,
    });

    equal("the tool was executed", result.toolCalls.length, 1);
    equal("…the one the model asked for", result.toolCalls[0].name, "get_datetime");
    equal("one tool round", result.steps, 1);
    equal("and the final answer came back", result.text, "it is late");
    equal("no sources: grounding is Gemini-only", result.sources.length, 0);

    // The follow-up request pairs the result with the call by id, exactly as
    // the API requires.
    const second = fake.body(OPENAI_PATH, 1);
    const assistant = second.messages.find((message) => message.tool_calls);
    ok("the assistant's call was echoed", !!assistant);
    equal("…with its id", assistant.tool_calls[0].id, "call_abc");

    const toolMessage = second.messages.find((message) => message.role === "tool");
    ok("a tool message followed", !!toolMessage);
    equal("…paired by tool_call_id", toolMessage.tool_call_id, "call_abc");
    ok("…carrying the tool's output as JSON", JSON.parse(toolMessage.content).iso);
  }
);

section("openai: the budget still stops the loop");

{
  const previous = settings.get("ai_max_tool_steps");
  settings.set("ai_max_tool_steps", 2);

  await useOpenAI(
    [
      openaiToolCall([{ name: "get_datetime", args: {} }]),
      openaiToolCall([{ name: "get_datetime", args: {} }]),
      openaiToolCall([{ name: "get_datetime", args: {} }]),
      openaiToolCall([{ name: "get_datetime", args: {} }]),
    ],
    async () => {
      const result = await aiAgent.runAgent({
        parts: [{ text: "loop" }],
        history: [],
        context: chatContext,
      });
      equal("it stopped at the budget", result.steps, 2);
      ok("and said something rather than nothing", result.text.length > 0);
    }
  );

  settings.set("ai_max_tool_steps", previous);
}

section("anthropic: the request that goes out");

await useAnthropic([], async (fake) => {
  settings.set("anthropic_model", "test-model-anthropic");
  await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [], context: chatContext });

  const request = fake.requests[0];
  equal("a request reached /v1/messages", request.url, ANTHROPIC_PATH);
  ok("auth is the x-api-key header", request.headers["x-api-key"] === settings.get("anthropic_api_key"));
  ok("…with a version pinned", !!request.headers["anthropic-version"]);

  const body = fake.body(ANTHROPIC_PATH, 0);
  equal("…for the configured model", body.model, "test-model-anthropic");
  ok("max_tokens is required and sent", body.max_tokens > 0);
  ok("the system prompt rides in the system field", body.system.includes("Current context"));
  equal("the user turn opens the messages", body.messages[0].role, "user");
  equal("…with the text in a block", body.messages[0].content[0].text, "hi");

  const tools = body.tools || [];
  ok(`Levix's own tools travel (${tools.length})`, tools.length > 3);
  ok(
    "every one in Messages-API shape with an input_schema",
    tools.every((tool) => tool.name && tool.input_schema?.type === "object")
  );
  ok("…and never a Gemini built-in", !JSON.stringify(tools).includes("googleSearch"));
  equal("tool_choice is auto", JSON.stringify(body.tool_choice), JSON.stringify({ type: "auto" }));
});

section("anthropic: a tool call runs and its result goes back");

await useAnthropic(
  [anthropicToolCall([{ name: "get_datetime", args: {}, id: "toolu_1" }]), anthropicText("it is late")],
  async (fake) => {
    const result = await aiAgent.runAgent({
      parts: [{ text: "what time is it" }],
      history: [],
      context: chatContext,
    });

    equal("the tool was executed", result.toolCalls.length, 1);
    equal("one tool round", result.steps, 1);
    equal("and the answer came back", result.text, "it is late");

    const second = fake.body(ANTHROPIC_PATH, 1);
    const assistant = second.messages.find(
      (message) => message.role === "assistant" && (message.content || []).some((b) => b.type === "tool_use")
    );
    ok("the tool_use block was echoed", !!assistant);
    equal("…with its id", assistant.content.find((b) => b.type === "tool_use").id, "toolu_1");

    const toolResult = second.messages
      .flatMap((message) => message.content || [])
      .find((block) => block.type === "tool_result");
    ok("a tool_result block followed", !!toolResult);
    equal("…paired by tool_use_id", toolResult.tool_use_id, "toolu_1");
    ok("…carrying the tool's output", JSON.parse(toolResult.content).iso);
  }
);

section("media becomes a note, not bytes, off the Gemini path");

await useOpenAI([openaiText("sure")], async (fake) => {
  await aiAgent.runAgent({
    parts: [
      { inlineData: { mimeType: "image/png", data: "aGk=" } },
      { text: "what is in this picture" },
    ],
    history: [],
    context: chatContext,
  });

  const sent = fake.body(OPENAI_PATH, 0).messages.at(-1).content;
  ok("the model is told media was attached", sent.includes("تم إرفاق"));
  ok("…alongside the user's actual question", sent.includes("what is in this picture"));
  ok("and the raw bytes never leave the machine", !sent.includes("aGk="));
});

section("history stays canonical on disk and moves BETWEEN providers");

await useOpenAI([openaiText("first")], async (fake) => {
  const first = await aiAgent.runAgent({
    parts: [{ text: "one" }],
    history: [],
    context: chatContext,
  });

  ok("history came back", Array.isArray(first.history) && first.history.length >= 2);
  equal("…in the canonical format (a user turn opens it)", first.history[0].role, "user");
  ok("…with Gemini-style parts", typeof first.history[0].parts[0].text === "string");

  // Exactly what storage-hub does: JSON in, JSON out — then hand the SAME
  // conversation to a different provider.
  const persisted = JSON.parse(JSON.stringify(first.history));

  await useAnthropic([anthropicText("second")], async (anthropicFake) => {
    await aiAgent.runAgent({ parts: [{ text: "two" }], history: persisted, context: chatContext });

    const messages = anthropicFake.body(ANTHROPIC_PATH, 0).messages;
    ok("the stored turns were replayed", messages.length > 1);
    equal("…starting with the first user message", messages[0].content[0].text, "one");
    ok("roles alternate", messages.every((message, i) => message.role === (i % 2 ? "assistant" : "user")));
  });
});

section("an anthropic turn with a tool call survives a switch to openai");

await useAnthropic(
  [anthropicToolCall([{ name: "get_datetime", args: {}, id: "toolu_9" }]), anthropicText("done")],
  async () => {
    const { history } = await aiAgent.runAgent({
      parts: [{ text: "time please" }],
      history: [],
      context: chatContext,
    });

    await useOpenAI([openaiText("carried over")], async (fake) => {
      await aiAgent.runAgent({ parts: [{ text: "go on" }], history, context: chatContext });

      const messages = fake.body(OPENAI_PATH, 0).messages;
      const echoed = messages.find((message) => message.tool_calls);
      ok("the anthropic tool call became a chat-completions tool_call", !!echoed);
      const toolMessage = messages.find((message) => message.role === "tool");
      ok("…and its result a tool message", !!toolMessage);
      equal(
        "…still paired with the call it answers",
        toolMessage.tool_call_id,
        echoed.tool_calls[0].id
      );
    });
  }
);

section("an API error is not swallowed");

{
  settings.set("ai_provider", "openai");
  settings.set("openai_api_key", "key-error-case");
  settings.set("openai_base_url", "http://127.0.0.1:1"); // nothing listens there

  let threw = null;
  try {
    await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [], context: chatContext });
  } catch (error) {
    threw = error;
  }
  ok("a connection failure propagates to the command layer", threw !== null);
}

await useOpenAI([providerError(401, "bad key")], async () => {
  let threw = null;
  try {
    await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [], context: chatContext });
  } catch (error) {
    threw = error;
  }
  ok("an HTTP error propagates too", threw !== null);
  ok(`…carrying its status (${threw?.status})`, threw?.status === 401 || /401/.test(String(threw?.message)));
});

section("a provider without a key fails loudly, in Arabic, like gemini does");

{
  settings.set("ai_provider", "anthropic");
  settings.set("anthropic_api_key", "");
  let threw = null;
  try {
    await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [], context: chatContext });
  } catch (error) {
    threw = error;
  }
  ok("it throws instead of hanging", threw !== null);
  ok("…naming the provider", /anthropic/i.test(threw?.message || ""));
}

finish();

// --- helpers ---------------------------------------------------------------

async function useOpenAI(replies, run) {
  const fake = await startProviderServer({ [OPENAI_PATH]: replies });
  useFake(fake, "openai");
  try {
    return await run(fake);
  } finally {
    await fake.stop();
  }
}

async function useAnthropic(replies, run) {
  const fake = await startProviderServer({ [ANTHROPIC_PATH]: replies });
  useFake(fake, "anthropic");
  try {
    return await run(fake);
  } finally {
    await fake.stop();
  }
}
