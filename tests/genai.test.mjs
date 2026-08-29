// The Gemini integration, on @google/genai.
//
// These tests run the REAL SDK against a local HTTP server standing in for the
// Gemini endpoint (tests/fixtures/genai-server.mjs), reached through the SDK's
// own base-URL override. Nothing is mocked: Levix builds a request, the SDK
// serialises it, and the assertions are about the bytes that came out and the
// response the SDK parsed back.
//
// That is deliberate. Asserting on a mock of the SDK would keep passing if the
// SDK changed how it serialises tools or reads grounding metadata, which is
// exactly the class of breakage a migration introduces.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  useTempDataDir,
  require as harnessRequire,
  ROOT,
  section,
  ok,
  equal,
  finish,
} from "./harness.mjs";
import {
  startGenaiServer,
  textReply,
  functionCallReply,
  groundedReply,
  errorReply,
} from "./fixtures/genai-server.mjs";

useTempDataDir("levix-genai");

const settings = harnessRequire("./src/config/settings.cjs");

// The SDK resolves its base URL at CLIENT CONSTRUCTION, in this order:
// httpOptions.baseUrl, then setDefaultBaseUrls(), then $GOOGLE_GEMINI_BASE_URL.
// The env var is the one to use here: aiAgent loads the SDK through CJS and
// this file through ESM, which are two module instances with two sets of
// module-level state, so setDefaultBaseUrls() in one is invisible to the other.
// The environment is shared by both.
settings.set("gemini_api_key", "test-key-not-real");
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");

/** Point the agent at a fresh set of scripted replies. */
async function withReplies(replies, run) {
  const fake = await startGenaiServer(replies);
  process.env.GOOGLE_GEMINI_BASE_URL = fake.baseUrl;
  // The client is cached per API key; a new key forces it to be rebuilt, and
  // the rebuild is what picks up the base URL above.
  settings.set("gemini_api_key", `key-${Math.random().toString(36).slice(2)}`);
  try {
    return await run(fake);
  } finally {
    await fake.stop();
  }
}

const toolNames = (tools) => (tools || []).flatMap((tool) => Object.keys(tool));

// ---------------------------------------------------------------------------

section("the deprecated SDK is gone");

{
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  ok("@google/genai is a dependency", !!deps["@google/genai"]);
  ok("@google/generative-ai is not", !deps["@google/generative-ai"]);

  // Not installed either — a stale transitive copy would let a forgotten
  // require keep working and hide the migration being incomplete.
  let installed = true;
  try {
    harnessRequire.resolve("@google/generative-ai");
  } catch {
    installed = false;
  }
  ok("…and it is not installed at all", !installed);

  // And nothing imports it.
  const sources = [
    "src/services/aiAgent.cjs",
    "src/services/aiTools.cjs",
    "src/commands/gemini.cjs",
    "src/commands/stt.cjs",
  ];
  for (const file of sources) {
    const source = readFileSync(join(ROOT, file), "utf8");
    ok(
      `${file} does not require the old SDK`,
      !/require\(\s*["']@google\/generative-ai/.test(source)
    );
    ok(`${file} uses @google/genai`, /@google\/genai/.test(source));
  }
}

section("the default models");

{
  // Flash across the product: a WhatsApp reply is judged on how fast it lands,
  // and every message is a paid request on the operator's own key. Image
  // generation is the exception, because returning image bytes is a different
  // capability from answering chat.
  const defaults = {
    gemini_model: "gemini-3.7-flash",
    gemini_stt_model: "gemini-3.7-flash",
    gemini_image_model: "gemini-3.1-flash-image",
  };

  const described = settings.describe();
  for (const [key, expected] of Object.entries(defaults)) {
    equal(`a fresh install uses ${expected} for ${key}`, described.find((e) => e.key === key)?.default, expected);
    equal(`…and ${key} reads back that way with nothing saved`, settings.get(key), expected);
  }

  // Still settings, not constants.
  for (const [key, expected] of Object.entries(defaults)) {
    settings.set(key, "some-other-model");
    equal(`the operator can change ${key}`, settings.get(key), "some-other-model");
    settings.set(key, "");
    equal(`and clearing ${key} restores the default`, settings.get(key), expected);
  }

  // The chat model and the transcription model happen to share a default, but
  // they are separate keys: moving one must not move the other.
  settings.set("gemini_model", "gemini-3.1-pro-preview");
  equal("moving the chat model leaves !stt on Flash", settings.get("gemini_stt_model"), "gemini-3.7-flash");
  settings.set("gemini_model", "");
}

section("Google Search and Levix's own tools travel in the same request");

await withReplies([textReply("hello")], async (fake) => {
  settings.set("ai_google_search", true);
  settings.set("gemini_model", "gemini-3.7-flash");

  await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [] });

  const body = fake.body(0);
  ok("a request was actually sent", !!body);
  equal(
    "…to the configured model",
    fake.requests[0].url,
    "/v1beta/models/gemini-3.7-flash:generateContent"
  );

  const names = toolNames(body.tools);
  ok(`both tool kinds are on the wire (${names.join(", ")})`, names.includes("googleSearch"));
  ok("…including Levix's own functions", names.includes("functionDeclarations"));

  const declared = body.tools.find((tool) => tool.functionDeclarations)?.functionDeclarations || [];
  ok(`every custom tool survived (${declared.length})`, declared.length >= 9);
  ok(
    "and none of them is a hand-rolled google_search",
    !declared.some((declaration) => /google_?search/i.test(declaration.name))
  );

  // Gemini 3 calls this tool context circulation, and refuses the combination
  // without the flag. VALIDATED goes with it — AUTO is not accepted alongside.
  equal(
    "server-side tool invocations are requested",
    body.toolConfig?.includeServerSideToolInvocations,
    true
  );
  equal(
    "…and function calling is VALIDATED, as that combination requires",
    body.toolConfig?.functionCallingConfig?.mode,
    "VALIDATED"
  );

  ok("the system instruction went too", !!body.systemInstruction);
});

section("turning search off keeps everything else");

await withReplies([textReply("hello")], async (fake) => {
  settings.set("ai_google_search", false);

  await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [] });

  const body = fake.body(0);
  const names = toolNames(body.tools);
  ok("search is gone", !names.includes("googleSearch"));
  ok("Levix's own tools remain", names.includes("functionDeclarations"));
  equal(
    "the custom tools are all still there",
    body.tools.find((tool) => tool.functionDeclarations).functionDeclarations.length >= 9,
    true
  );
  // Nothing to combine, so the ordinary AUTO behaviour is left alone.
  equal("no tool-combination config is sent", body.toolConfig, undefined);

  settings.set("ai_google_search", true);
});

section("a custom tool call runs and its result goes back");

await withReplies(
  [
    functionCallReply([{ name: "get_datetime", args: {} }]),
    textReply("it is late"),
  ],
  async (fake) => {
    const result = await aiAgent.runAgent({
      parts: [{ text: "what time is it" }],
      history: [],
      context: { chatId: "1@s.whatsapp.net" },
    });

    equal("the tool was executed", result.toolCalls.length, 1);
    equal("…the one the model asked for", result.toolCalls[0].name, "get_datetime");
    equal("one tool round", result.steps, 1);
    equal("and the final answer came back", result.text, "it is late");

    // The second request carries the result in the shape the API expects.
    const second = fake.body(1);
    const parts = second.contents.at(-1).parts;
    const answer = parts.find((part) => part.functionResponse);
    ok("a functionResponse part was sent", !!answer);
    equal("named for the tool", answer.functionResponse.name, "get_datetime");
    ok("carrying the tool's output", !!answer.functionResponse.response);

    // Gemini 3 rejects a turn whose function call lost its thought signature.
    const modelTurn = second.contents.find((content) =>
      (content.parts || []).some((part) => part.functionCall)
    );
    ok("the model's call was echoed back", !!modelTurn);
    equal(
      "…with its thought signature intact",
      modelTurn.parts[0].thoughtSignature,
      "sig-abc123"
    );
  }
);

section("parallel calls each get their result, matched by id");

await withReplies(
  [
    functionCallReply([
      { name: "get_datetime", args: {}, id: "call-1" },
      { name: "list_roles", args: {}, id: "call-2" },
    ]),
    textReply("done"),
  ],
  async (fake) => {
    const result = await aiAgent.runAgent({
      parts: [{ text: "two things" }],
      history: [],
      context: { chatId: "1@s.whatsapp.net" },
    });

    equal("both tools ran", result.toolCalls.length, 2);

    const parts = fake.body(1).contents.at(-1).parts;
    const responses = parts.filter((part) => part.functionResponse);
    equal("both results were returned", responses.length, 2);
    equal("the first keeps its id", responses[0].functionResponse.id, "call-1");
    equal("and so does the second", responses[1].functionResponse.id, "call-2");
  }
);

section("multi-step tool use keeps going");

await withReplies(
  [
    functionCallReply([{ name: "get_datetime", args: {} }], { thoughtSignature: "sig-1" }),
    functionCallReply([{ name: "list_roles", args: {} }], { thoughtSignature: "sig-2" }),
    textReply("finished"),
  ],
  async (fake) => {
    const result = await aiAgent.runAgent({
      parts: [{ text: "go" }],
      history: [],
      context: { chatId: "1@s.whatsapp.net" },
    });

    equal("two rounds of tools", result.steps, 2);
    equal("both were executed", result.toolCalls.length, 2);
    equal("and it ended with an answer", result.text, "finished");

    // Every step's signature has to come back, not just the first.
    const signatures = (fake.body(2).contents || [])
      .flatMap((content) => content.parts || [])
      .map((part) => part.thoughtSignature)
      .filter(Boolean);
    ok(`both signatures were circulated (${signatures.join(", ")})`, signatures.includes("sig-1"));
    ok("…including the second step's", signatures.includes("sig-2"));
  }
);

section("the tool budget still stops the loop");

{
  const previous = settings.get("ai_max_tool_steps");
  settings.set("ai_max_tool_steps", 2);

  await withReplies(
    [
      functionCallReply([{ name: "get_datetime", args: {} }]),
      functionCallReply([{ name: "get_datetime", args: {} }]),
      functionCallReply([{ name: "get_datetime", args: {} }]),
      functionCallReply([{ name: "get_datetime", args: {} }]),
    ],
    async () => {
      const result = await aiAgent.runAgent({
        parts: [{ text: "loop" }],
        history: [],
        context: { chatId: "1@s.whatsapp.net" },
      });
      equal("it stopped at the budget", result.steps, 2);
      ok("and said something rather than nothing", result.text.length > 0);
    }
  );

  settings.set("ai_max_tool_steps", previous);
}

section("history round-trips through what Levix persists");

await withReplies([textReply("first"), textReply("second")], async (fake) => {
  const first = await aiAgent.runAgent({ parts: [{ text: "one" }], history: [] });
  ok("history came back", Array.isArray(first.history) && first.history.length >= 2);
  ok("it starts on a user turn", first.history[0].role === "user");

  // Exactly what storage-hub does: JSON in, JSON out.
  const persisted = JSON.parse(JSON.stringify(first.history));
  await aiAgent.runAgent({ parts: [{ text: "two" }], history: persisted });

  const sent = fake.body(1).contents;
  ok("the stored turns were replayed", sent.length > 1);
  equal("…in order, starting with the first message", sent[0].parts[0].text, "one");
});

section("grounding citations come from the response, not from us");

await withReplies(
  [
    groundedReply("the answer", [
      { uri: "https://example.com/a", title: "Example" },
      { uri: "https://docs.example.org/b", title: "Docs" },
      { uri: "https://example.com/a", title: "Duplicate" },
    ]),
  ],
  async () => {
    const result = await aiAgent.runAgent({ parts: [{ text: "current news" }], history: [] });

    equal("the sources were read off the SDK's parsed response", result.sources.length, 3);
    const block = aiAgent.formatSources(result.sources);
    ok("a Sources block is produced", block.includes("Sources"));
    equal("duplicates collapse", (block.match(/example\.com\/a/g) || []).length, 1);
    ok("both distinct sources appear", block.includes("docs.example.org/b"));
    ok("no Markdown link syntax", !block.includes("]("));
  }
);

section("no grounding, no Sources block");

await withReplies([textReply("just an answer")], async () => {
  const result = await aiAgent.runAgent({ parts: [{ text: "2+2" }], history: [] });
  equal("nothing was grounded", result.sources.length, 0);
  equal("so nothing is appended", aiAgent.formatSources(result.sources), "");
});

section("an API error is not swallowed");

await withReplies([errorReply(400, "something went wrong")], async () => {
  let threw = null;
  try {
    await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [] });
  } catch (error) {
    threw = error;
  }
  ok("the error propagates to the command layer", threw !== null);
  ok(
    `…carrying its status (${threw?.status})`,
    threw?.status === 400 || /400/.test(String(threw?.message))
  );
});

section("the search fallback is defensive only");

await withReplies(
  [
    errorReply(400, "Tool use with function calling is unsupported for this model"),
    textReply("recovered"),
  ],
  async (fake) => {
    settings.set("ai_google_search", true);
    const result = await aiAgent.runAgent({ parts: [{ text: "hi" }], history: [] });

    equal("it recovered", result.text, "recovered");
    equal("…and reports that search was withdrawn", result.searchOffered, false);

    // What matters: the retry kept Levix's tools and dropped only search.
    const retry = fake.body(1);
    const names = toolNames(retry.tools);
    ok("search is gone from the retry", !names.includes("googleSearch"));
    ok("but the custom functions are not", names.includes("functionDeclarations"));
  }
);

finish();
