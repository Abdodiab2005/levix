// Gemini's built-in Google Search.
//
// The point of this feature is that Levix does NOT implement search: it hands
// Gemini the native `{ googleSearch: {} }` tool and lets the model decide when
// the web is needed, run the search inside its own request, and hand back the
// sources it actually used. So the things worth pinning are:
//
//   * the native tool is what goes out, and no google_search FUNCTION is ever
//     declared,
//   * Levix's own tools survive alongside it,
//   * the setting turns it off without touching anything else,
//   * a Sources block appears only when real grounding metadata came back.
//
// No network and no API key: buildTools/extractSources/formatSources are pure,
// and the response shapes below are the ones the installed SDK declares
// (GroundingMetadata / GroundingChunk in
// node_modules/@google/generative-ai/dist/generative-ai.d.ts).

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

useTempDataDir("levix-google-search");

const settings = harnessRequire("./src/config/settings.cjs");
const aiAgent = harnessRequire("./src/services/aiAgent.cjs");
const aiTools = harnessRequire("./src/services/aiTools.cjs");
const aiProviders = harnessRequire("./src/services/aiProviders.cjs");

const toolNames = (tools) => tools.flatMap((tool) => Object.keys(tool));

// ---------------------------------------------------------------------------

section("the native tool, not a function we wrote");

{
  equal(
    "the tool is Gemini's own googleSearch",
    JSON.stringify(aiAgent.GOOGLE_SEARCH_TOOL),
    JSON.stringify({ googleSearch: {} })
  );

  const declared = aiTools
    .toolDeclarations()
    .flatMap((tool) => tool.functionDeclarations || [])
    .map((declaration) => declaration.name);

  ok(`Levix declares its own tools (${declared.length})`, declared.length > 3);
  ok(
    "and none of them is a hand-rolled google_search",
    !declared.some((name) => /google_?search/i.test(name)),
    declared.join(", ")
  );

  // A custom search function would have to be executable. Nothing answers to
  // that name, which is the proof there isn't one.
  const answered = await aiTools.runTool("google_search", { query: "x" }, {});
  ok("…and calling one is an unknown tool", /unknown tool/i.test(answered.error || ""));
}

section("the tools array");

{
  settings.set("ai_google_search", true);

  const both = aiAgent.buildTools({ useTools: true });
  ok("search is offered", toolNames(both).includes("googleSearch"));
  ok("…alongside Levix's own functions", toolNames(both).includes("functionDeclarations"));
  equal("and nothing else", both.length, 2);

  const functionsOnly = aiAgent.buildTools({ useTools: true, search: false });
  equal("with search off there is one entry", functionsOnly.length, 1);
  ok("…and it is the custom functions", toolNames(functionsOnly).includes("functionDeclarations"));
  ok("…with the custom tools intact", functionsOnly[0].functionDeclarations.length > 3);

  const searchOnly = aiAgent.buildTools({ useTools: false, search: true });
  equal("a tools-off turn can still ground", searchOnly.length, 1);
  ok("…on search alone", toolNames(searchOnly).includes("googleSearch"));

  equal("and both off means no tools at all", aiAgent.buildTools({ useTools: false, search: false }).length, 0);
}

section("the setting");

{
  settings.set("ai_google_search", true);
  ok("on by default for Gemini", aiAgent.googleSearchEnabled());
  ok("…so the tool goes out", toolNames(aiAgent.buildTools({})).includes("googleSearch"));

  settings.set("ai_google_search", false);
  ok("turning it off is respected", !aiAgent.googleSearchEnabled());
  ok("…and the tool is withheld", !toolNames(aiAgent.buildTools({})).includes("googleSearch"));
  ok(
    "…while Levix's own tools stay",
    toolNames(aiAgent.buildTools({})).includes("functionDeclarations")
  );

  settings.set("ai_google_search", true);

  const described = settings.describe().find((entry) => entry.key === "ai_google_search");
  equal("it is a normal boolean setting", described.type, "bool");
  equal("in the AI group", described.group, "ai");
  equal("defaulting to on", described.default, true);
}

section("other providers are untouched");

{
  // The openai/anthropic loop lives in src/services/aiProviders.cjs. It is
  // plain chat-completions / messages calls: Levix's own function tools are
  // the only tools that travel, and certainly not a Gemini built-in one.
  const providerSource = readFileSync(join(ROOT, "src", "services", "aiProviders.cjs"), "utf8");
  ok("…and no googleSearch anywhere on the provider path", !providerSource.includes("googleSearch"));

  // Groq is gone — not disabled, gone: no settings, no call path, no comment.
  const geminiCommand = readFileSync(join(ROOT, "src", "commands", "gemini.cjs"), "utf8");
  ok("groq is fully removed from the command", !/groq/i.test(geminiCommand));
  const settingsSource = readFileSync(join(ROOT, "src", "config", "settings.cjs"), "utf8");
  ok("…and from the settings", !/groq/i.test(settingsSource));

  // What lets Levix's tools reach the other providers is the schema
  // translation: Gemini's uppercase `Type` dialect becomes JSON Schema.
  const translated = aiProviders.toJsonSchema({
    type: "OBJECT",
    properties: {
      query: { type: "STRING", description: "The search query." },
      limit: { type: "INTEGER" },
    },
    required: ["query"],
    nullable: true,
  });
  equal(
    "gemini schema becomes JSON schema",
    JSON.stringify(translated),
    JSON.stringify({
      type: "object",
      properties: {
        query: { type: "string", description: "The search query." },
        limit: { type: "integer" },
      },
      required: ["query"],
    })
  );

  const openai = aiProviders.openaiTools();
  ok(
    `openai tools wrap the declarations (${openai.length})`,
    openai.length > 3 &&
      openai.every(
        (tool) =>
          tool.type === "function" &&
          tool.function.name &&
          tool.function.parameters?.type === "object"
      )
  );
  const anthropic = aiProviders.anthropicTools();
  ok(
    `anthropic tools carry input_schema (${anthropic.length})`,
    anthropic.length > 3 &&
      anthropic.every((tool) => tool.name && tool.input_schema?.type === "object")
  );

  ok(
    "googleSearch appears only in the Gemini agent",
    !readFileSync(join(ROOT, "src", "services", "aiTools.cjs"), "utf8").includes("googleSearch")
  );
}

section("citations come from real grounding metadata and nowhere else");

{
  // The shape the SDK declares: candidates[].groundingMetadata.groundingChunks[].web
  const grounded = {
    candidates: [
      {
        groundingMetadata: {
          webSearchQueries: ["levix whatsapp bot"],
          groundingChunks: [
            { web: { uri: "https://example.com/a", title: "Example" } },
            { web: { uri: "https://docs.example.org/b", title: "Docs" } },
            { web: { uri: "https://example.com/a", title: "Example again" } },
            { web: {} },
            {},
          ],
        },
      },
    ],
  };

  const sources = aiAgent.extractSources(grounded);
  equal("every web chunk with a uri is taken", sources.length, 3);
  ok("chunks with no uri are skipped", sources.every((source) => !!source.uri));

  const block = aiAgent.formatSources(sources);
  ok("there is a Sources block", block.includes("Sources"));
  equal("duplicates are collapsed", (block.match(/example\.com\/a/g) || []).length, 1);
  ok("both distinct sources are listed", block.includes("docs.example.org/b"));
  ok("titles are used", block.includes("Example") && block.includes("Docs"));
  ok("it is WhatsApp formatting, not Markdown links", !block.includes("]("));

  // A chunk with no title falls back to the host rather than inventing one.
  const untitled = aiAgent.formatSources([{ uri: "https://www.reuters.com/x" }]);
  ok(`an untitled source uses its host (${untitled.trim()})`, untitled.includes("reuters.com"));

  // Cap: a long list must not turn a WhatsApp reply into a link dump.
  const many = Array.from({ length: 12 }, (_, i) => ({
    uri: `https://site${i}.example/x`,
    title: `S${i}`,
  }));
  const capped = aiAgent.formatSources(many);
  ok("a long list is capped", capped.split("\n").filter((line) => line.startsWith("•")).length <= 5);
}

section("no grounding means no Sources section");

{
  equal("nothing at all", aiAgent.formatSources([]), "");
  equal("undefined", aiAgent.formatSources(undefined), "");

  // A perfectly ordinary answer, with no groundingMetadata anywhere.
  const ungrounded = { candidates: [{ content: { parts: [{ text: "42" }] } }] };
  equal("an ungrounded response yields no sources", aiAgent.extractSources(ungrounded).length, 0);
  equal(
    "…and therefore no block",
    aiAgent.formatSources(aiAgent.extractSources(ungrounded)),
    ""
  );

  // Grounding metadata that came back empty is still not a reason to invent one.
  const empty = { candidates: [{ groundingMetadata: { webSearchQueries: [] } }] };
  equal("empty grounding metadata yields nothing", aiAgent.extractSources(empty).length, 0);

  // Malformed shapes must not throw into the message pipeline.
  for (const bad of [null, undefined, {}, { candidates: null }, { candidates: [null] }]) {
    let threw = null;
    try {
      aiAgent.extractSources(bad);
    } catch (error) {
      threw = error;
    }
    ok(`a malformed response (${JSON.stringify(bad)}) does not throw`, threw === null);
  }
}

section("a model that refuses the combination keeps Levix's tools");

{
  // Some model/API combinations reject search + functions in one request. That
  // is detected explicitly so the retry drops SEARCH and keeps the functions
  // commands depend on — never silently the other way round.
  const refusals = [
    Object.assign(new Error("Tool use with function calling is unsupported"), { status: 400 }),
    Object.assign(new Error("Multiple tools are not supported"), { status: 400 }),
    Object.assign(new Error("at most one tool is allowed"), { status: 400 }),
  ];
  for (const error of refusals) {
    ok(`recognised: "${error.message}"`, aiAgent.isToolCombinationError(error));
  }

  const unrelated = [
    Object.assign(new Error("429 Too Many Requests"), { status: 429 }),
    Object.assign(new Error("API key not valid"), { status: 400 }),
    Object.assign(new Error("candidate was blocked"), { status: 400 }),
    new Error("socket hang up"),
  ];
  for (const error of unrelated) {
    ok(`not mistaken for a tool problem: "${error.message}"`, !aiAgent.isToolCombinationError(error));
  }
}

section("no secret reaches a log line");

{
  // The agent logs tool calls and errors. Neither the API key nor the grounding
  // payload should ever be part of that.
  const agentSource = readFileSync(join(ROOT, "src", "services", "aiAgent.cjs"), "utf8");

  ok(
    "the api key is never logged",
    !/logger\.[a-z]+\([^)]*gemini_api_key/.test(agentSource)
  );
  ok(
    "grounding chunks are never dumped into a log",
    !/logger\.[a-z]+\([^)]*groundingChunks/.test(agentSource)
  );
  ok(
    "…nor the sources array",
    !/logger\.[a-z]+\([^)]*\bsources\b/.test(agentSource)
  );

  // The tool-combination warning names the model, which is a setting, not a
  // secret — and nothing else.
  const warning = agentSource.slice(
    agentSource.indexOf("refuses Google Search together") - 400,
    agentSource.indexOf("refuses Google Search together") + 120
  );
  ok("the fallback warning logs only the message and the model", !warning.includes("api_key"));
}

finish();
