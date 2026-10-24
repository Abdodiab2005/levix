// !translate: argument parsing, auto direction, prompt fill, Google parsing,
// official-API path selection, and AI-only option fallback.
//
// fetch and the AI provider are swapped in. Nothing leaves the machine.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-translate");

const settings = require("./src/config/settings.cjs");
settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);
settings.set("bot_language", "en");
settings.set("ai_provider", "gemini");
settings.set("gemini_api_key", "");
settings.set("openai_api_key", "");
settings.set("anthropic_api_key", "");
settings.set("google_translate_api_key", "");
settings.set("translate_engine", "ai");

const translate = require("./src/commands/translate.cjs");
const {
  parseTranslateArgs,
  inferTargetLanguage,
  fillTranslatePrompt,
  stripPromptNote,
  loadTranslatePrompt,
  parseFreeGoogleResponse,
  selectGoogleRequest,
  MAX_INPUT_CHARS,
  TRANSLATE_PROMPT_FILE,
  http,
  ai,
} = translate;

const CHAT = "201111111111@s.whatsapp.net";
const TEMPLATE = join(ROOT, "src", "config", "translate-prompt.md");

function jsonResponse(data, status = 200) {
  const body = typeof data === "string" ? data : JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return typeof data === "string" ? JSON.parse(data) : data;
    },
    async text() {
      return body;
    },
  };
}

function buildMsg(args, quoted) {
  const text = ["!translate", ...(args || [])].join(" ").trim();
  if (quoted) {
    return {
      key: { remoteJid: CHAT, fromMe: true, id: "in" },
      message: { extendedTextMessage: { text, contextInfo: { quotedMessage: quoted } } },
    };
  }
  return {
    key: { remoteJid: CHAT, fromMe: true, id: "in" },
    message: { conversation: text },
  };
}

function makeSock() {
  const sent = [];
  return {
    sent,
    async sendMessage(jid, content, options) {
      sent.push({ jid, content, options });
      return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
  };
}

async function run({ args = [], quoted = null } = {}) {
  const sock = makeSock();
  await translate.execute(sock, buildMsg(args, quoted), args);
  return sock.sent;
}

const lastText = (sent) => {
  for (let i = sent.length - 1; i >= 0; i--) {
    const text = sent[i]?.content?.text;
    if (text) return text;
  }
  return "";
};

function restoreSeams() {
  http.fetch = (...args) => fetch(...args);
}

// ---------------------------------------------------------------------------

section("argument parsing");

{
  const bare = parseTranslateArgs(["hello", "world"]);
  equal("bare text is the remainder", bare.text, "hello world");
  equal("bare engine is unset", bare.engine, null);
  equal("bare language is unset", bare.language, null);
  equal("bare mode is translate", bare.mode, "translate");
  equal("bare tone is neutral", bare.tone, "neutral");

  const lang = parseTranslateArgs(["fr", "bonjour"]);
  equal("ISO code is the target", lang.language, "fr");
  equal("text follows the language", lang.text, "bonjour");

  const english = parseTranslateArgs(["english", "مرحبا"]);
  equal("english name is en", english.language, "en");
  equal("arabic text is kept", english.text, "مرحبا");

  const arabicName = parseTranslateArgs(["فرنسي", "hello"]);
  equal("Arabic language name is fr", arabicName.language, "fr");

  const google = parseTranslateArgs(["google", "hi"]);
  equal("google engine", google.engine, "google");
  equal("google text", google.text, "hi");
  equal("google hi is not Hindi", google.language, null);

  const quotedIt = parseTranslateArgs(["it"], { hasQuoted: true });
  equal("quoted it is Italian", quotedIt.language, "it");
  equal("quoted it leaves text empty", quotedIt.text, "");

  const bareIt = parseTranslateArgs(["it"]);
  equal("bare it is the text", bareIt.text, "it");
  equal("bare it is not a language", bareIt.language, null);

  const aiEngine = parseTranslateArgs(["ai", "hi"]);
  equal("ai engine", aiEngine.engine, "ai");

  const summary = parseTranslateArgs(["summary", "hello"]);
  equal("summary mode", summary.mode, "summary");

  const explain = parseTranslateArgs(["اشرح", "hello"]);
  equal("Arabic explain mode", explain.mode, "explain");

  const detect = parseTranslateArgs(["detect"]);
  equal("detect mode", detect.mode, "detect");
  equal("detect with no text", detect.text, "");

  const formal = parseTranslateArgs(["formal", "hello"]);
  equal("formal tone", formal.tone, "formal");

  const casual = parseTranslateArgs(["عامي", "hello"]);
  equal("Arabic casual tone", casual.tone, "casual");

  const mixed = parseTranslateArgs(["google", "fr", "summary", "Hello"]);
  equal("mixed engine", mixed.engine, "google");
  equal("mixed language", mixed.language, "fr");
  equal("mixed mode", mixed.mode, "summary");
  equal("mixed text", mixed.text, "Hello");

  const reordered = parseTranslateArgs(["fr", "google", "formal", "Hello"]);
  equal("reordered engine", reordered.engine, "google");
  equal("reordered language", reordered.language, "fr");
  equal("reordered tone", reordered.tone, "formal");
  equal("reordered text", reordered.text, "Hello");

  const turkish = parseTranslateArgs(["tr", "hello"]);
  equal("tr is Turkish, not the alias", turkish.language, "tr");
  equal("tr text", turkish.text, "hello");
}

section("direction auto pair");

equal("Arabic input targets English", inferTargetLanguage("مرحبا كيف حالك"), "en");
equal("Latin input targets Arabic", inferTargetLanguage("hello there"), "ar");
equal("digits-only targets Arabic", inferTargetLanguage("123"), "ar");
equal("explicit language wins over Arabic", inferTargetLanguage("مرحبا", "fr"), "fr");
equal("explicit language wins over English", inferTargetLanguage("hello", "de"), "de");

section("prompt template: --- stripping and variable fill");

{
  const template = readFileSync(TEMPLATE, "utf8");
  ok("the template has a note/prompt separator", template.includes("\n---\n"));
  const body = stripPromptNote(template);
  ok("the human note is stripped", !body.startsWith("# Levix"));
  ok("the prompt body remains", body.includes("You are a translator"));
  ok("target_language is in the template", body.includes("{{target_language}}"));
  ok("source_language is in the template", body.includes("{{source_language}}"));
  ok("mode is in the template", body.includes("{{mode}}"));
  ok("tone is in the template", body.includes("{{tone}}"));

  const filled = fillTranslatePrompt(body, {
    target_language: "French",
    source_language: "auto-detect",
    mode: "summary",
    tone: "formal",
  });
  ok("fills target_language", filled.includes("French"));
  ok("fills source_language", filled.includes("auto-detect"));
  ok("fills mode", filled.includes("summary"));
  ok("fills tone", filled.includes("formal"));
  ok("no leftover target placeholder", !filled.includes("{{target_language}}"));
  ok("no leftover source placeholder", !filled.includes("{{source_language}}"));
  ok("no leftover mode placeholder", !filled.includes("{{mode}}"));
  ok("no leftover tone placeholder", !filled.includes("{{tone}}"));

  writeFileSync(
    TRANSLATE_PROMPT_FILE,
    "note to the human\n---\nTranslate into {{target_language}}.\n",
    "utf8",
  );
  const loaded = loadTranslatePrompt();
  ok("live file strips the note", loaded.includes("Translate into {{target_language}}"));
  ok("live file drops the human note", !loaded.includes("note to the human"));
  writeFileSync(TRANSLATE_PROMPT_FILE, template, "utf8");
}

section("free-endpoint response parsing");

{
  const one = parseFreeGoogleResponse([[["Hello", "مرحبا", null, null, 10]], null, "ar"]);
  equal("joins a single segment", one.text, "Hello");
  equal("reads detected language at [2]", one.detected, "ar");

  const many = parseFreeGoogleResponse([
    [
      ["Hello ", "مرحبا", null, null, 10],
      ["world", "عالم", null, null, 10],
    ],
    null,
    "ar",
  ]);
  equal("joins several segments", many.text, "Hello world");

  const asString = parseFreeGoogleResponse(
    JSON.stringify([[["Bonjour", "hello", null, null, 1]], null, "en"]),
  );
  equal("parses a JSON string", asString.text, "Bonjour");
  equal("parses detected from a JSON string", asString.detected, "en");

  const garbage = parseFreeGoogleResponse("not-json");
  equal("garbage text is empty", garbage.text, "");
  equal("garbage detected is empty", garbage.detected, "");

  const object = parseFreeGoogleResponse({ data: {} });
  equal("a non-array is empty", object.text, "");
}

section("official-API path selection when the key is set");

{
  const official = selectGoogleRequest({
    text: "hello",
    target: "ar",
    apiKey: "AIza-test",
  });
  ok("official flag", official.official === true);
  ok(
    "official translate URL",
    official.url.startsWith("https://translation.googleapis.com/language/translate/v2?"),
  );
  ok("official URL carries the key", official.url.includes("key=AIza-test"));
  equal("official method is POST", official.method, "POST");
  ok("official body has the text", official.body.includes("hello"));
  ok("official body has the target", official.body.includes("ar"));

  const detect = selectGoogleRequest({
    text: "hello",
    target: "ar",
    detect: true,
    apiKey: "AIza-test",
  });
  ok(
    "official detect URL",
    detect.url.startsWith("https://translation.googleapis.com/language/translate/v2/detect?"),
  );

  const free = selectGoogleRequest({ text: "hello", target: "ar", apiKey: "" });
  ok("free flag", free.official === false);
  ok(
    "free URL",
    free.url.startsWith("https://translate.googleapis.com/translate_a/single?"),
  );
  ok("free URL has client=gtx", free.url.includes("client=gtx"));
  ok("free URL has sl=auto", free.url.includes("sl=auto"));
  ok("free URL has tl=ar", free.url.includes("tl=ar"));
  equal("free method is GET", free.method, "GET");
}

section("execute: reply input, google free, official key, AI-only fallback");

{
  settings.set("translate_engine", "google");
  settings.set("google_translate_api_key", "");
  settings.set("gemini_api_key", "");

  let fetched = [];
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse([[["Hello", "مرحبا", null, null, 10]], null, "ar"]);
  };

  const quoted = await run({
    args: [],
    quoted: { conversation: "مرحبا" },
  });
  ok("quoted text is translated", lastText(quoted).includes("Hello"));
  ok("quoted used the free endpoint", fetched[0]?.url.includes("translate.googleapis.com/translate_a/single"));

  fetched = [];
  const captioned = await run({
    args: [],
    quoted: { imageMessage: { caption: "مرحبا" } },
  });
  ok("quoted caption is translated", lastText(captioned).includes("Hello"));

  fetched = [];
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse([[["ciao", "hello", null, null, 10]], null, "en"]);
  };
  const itReply = await run({
    args: ["it"],
    quoted: { conversation: "hello" },
  });
  ok("reply with it targets Italian", fetched[0]?.url.includes("tl=it"));
  ok("reply with it translates the quoted text", fetched[0]?.url.includes("q=hello"));
  ok("reply with it shows the result", lastText(itReply).includes("ciao"));

  fetched = [];
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse([[["مرحبا", "hi", null, null, 10]], null, "en"]);
  };
  const googleHi = await run({ args: ["google", "hi"] });
  ok("google hi sends the word hi", fetched[0]?.url.includes("q=hi"));
  ok("google hi is not Hindi", !fetched[0]?.url.includes("tl=hi"));
  ok("google hi shows the result", lastText(googleHi).includes("مرحبا"));

  fetched = [];
  settings.set("google_translate_api_key", "AIza-official");
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse({
      data: { translations: [{ translatedText: "Bonjour", detectedSourceLanguage: "en" }] },
    });
  };
  const officialRun = await run({ args: ["hello"] });
  ok(
    "key selects the official host",
    fetched[0]?.url.startsWith("https://translation.googleapis.com/language/translate/v2"),
  );
  equal("official method is POST", fetched[0]?.method, "POST");
  ok("official result is shown", lastText(officialRun).includes("Bonjour"));
  settings.set("google_translate_api_key", "");

  fetched = [];
  let aiCalls = 0;
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse([[["should-not-run"]], null, "en"]);
  };
  ai.runTurn = async (opts) => {
    aiCalls += 1;
    ok("AI turn has no tools", opts.useTools === false);
    ok("AI turn has no search", opts.search === false);
    equal("AI turn maxSteps is 1", opts.maxSteps, 1);
    const instruction = String(opts.systemInstruction || "");
    ok("AI prompt filled the target", instruction.includes("Arabic"));
    ok("AI prompt filled the mode", instruction.includes("summary"));
    ok("AI prompt is not the chat persona", !instruction.includes("personal WhatsApp assistant"));
    return { text: "ملخص مترجم" };
  };

  const noKey = await run({ args: ["summary", "A long paragraph about cats."] });
  ok(
    "AI-only option without a key errors",
    lastText(noKey).includes("needs an AI key") || lastText(noKey).includes("مفتاح"),
  );
  equal("AI-only without a key does not fetch Google", fetched.length, 0);
  equal("AI-only without a key does not call the provider", aiCalls, 0);

  settings.set("gemini_api_key", "gemini-test-key");
  settings.set("ai_provider", "gemini");
  settings.set("ai_agent", true);
  fetched = [];
  aiCalls = 0;
  const switched = await run({ args: ["google", "summary", "A long paragraph about cats."] });
  equal("AI-only with google switches to AI", aiCalls, 1);
  equal("switched call does not hit Google", fetched.length, 0);
  ok("switched call shows the model output", lastText(switched).includes("ملخص مترجم"));

  fetched = [];
  aiCalls = 0;
  http.fetch = async (url, opts) => {
    fetched.push({ url: String(url), method: opts?.method || "GET" });
    return jsonResponse({
      data: { detections: [[{ language: "fr", confidence: 0.9 }]] },
    });
  };
  settings.set("google_translate_api_key", "AIza-official");
  const detected = await run({ args: ["google", "detect", "Bonjour"] });
  ok(
    "detect with a key uses the official detect path",
    fetched[0]?.url.includes("/language/translate/v2/detect"),
  );
  ok("detect names the language", lastText(detected).toLowerCase().includes("french"));
  settings.set("google_translate_api_key", "");

  const tooLong = await run({ args: ["a".repeat(MAX_INPUT_CHARS + 1)] });
  ok("5000-character cap", lastText(tooLong).includes("too long") || lastText(tooLong).includes("طويل"));

  restoreSeams();
}

section("command metadata");

equal("name", translate.name, "translate");
ok("tr alias", translate.aliases.includes("tr"));
ok("ترجم alias", translate.aliases.includes("ترجم"));
ok("ترجمة alias", translate.aliases.includes("ترجمة"));
equal("chat is all", translate.chat, "all");
equal("neutralArgs", translate.neutralArgs, true);
ok("keywords is an array", Array.isArray(translate.keywords));
ok("description.en", Boolean(translate.description?.en));
ok("description.ar", Boolean(translate.description?.ar));
ok("usage.en has variants", translate.usage.en.includes("\n"));
ok("usage.ar has variants", translate.usage.ar.includes("\n"));

finish();
