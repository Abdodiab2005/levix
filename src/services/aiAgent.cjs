// The AI as an agent, not a single API call.
//
// Old flow:  prompt -> one generateContent -> send the text. Anything the model
//            didn't already know was a guess.
// New flow:  prompt -> model may call tools (search, open a url, save to
//            memory, hand out roles) -> we run them, feed the results back, and
//            let it decide again -> ... -> final answer.
//
// The whole run is narrated in ONE WhatsApp message that gets edited as the
// agent works ("🤖 بفكر..." -> "🔍 ببحث عن ..." -> the answer), which is what
// the operator asked for: no chain of throwaway status messages.
//
// System prompt: read from config/ai-persona.md (hot-reloaded), plus a small
// runtime block and whatever is in the long-term memory files.

const fs = require("fs");
const { GoogleGenAI, FunctionCallingConfigMode } = require("@google/genai");
const { geminiHttpOptions } = require("../utils/geminiHttpOptions.cjs");

const logger = require("../utils/logger.cjs");
const {
  mediaKind,
  baseMimeType,
  downloadMedia,
  geminiMediaPart,
} = require("../utils/geminiMedia.cjs");
const { t, currentLang } = require("../utils/i18n.cjs");
const aiIdentity = require("../config/ai-identity.cjs");
const settings = require("../config/settings.cjs");
const store = require("../db/store.cjs");
const memory = require("../utils/memory.cjs");
const { globalMemoryAccess } = require("./memoryPolicy.cjs");
const { assertProviderBaseUrl, assertProviderRequestUrl } = require("../utils/providerUrl.cjs");
const {
  toolDeclarations,
  describeCall,
  runToolWithDeadline,
  toolErrorForModel,
  markToolsRan,
} = require("./aiTools.cjs");
const { docSourcesFromTool } = require("./aiDocs.cjs");
const {
  BaseAIProvider,
  registerProvider,
  getProvider,
  detectModelCapabilities,
} = require("./aiRouter.cjs");
const {
  runProviderAgent,
  classifyProviderAutoReply,
  AUTO_REPLY_DECISION_TOOL,
  AUTO_REPLY_DECISION_DECLARATION,
  validateAutoReplyDecision,
  validateDecisionCalls,
  activeProviderKeySetting,
} = require("./aiProviders.cjs");

// Model, key, tool budget and history length all come from config/settings.cjs
// (what the dashboard saved, else the default) and are read per call, so changing
// any of them from the dashboard takes effect on the next message instead of
// after a restart.

// One client per key. The dashboard can set a key on a bot that started
// without one, so the client is built lazily and rebuilt when the key changes.
//
// @google/genai replaced the old `new GoogleGenerativeAI(key)` +
// `getGenerativeModel({model, tools, systemInstruction})` pair with a single
// client whose model and per-request configuration are passed at call time —
// which suits Levix, because the model and the tool set are settings that may
// change between one message and the next.
let clientCache = { key: null, baseUrl: null, client: null };

// One synchronous snapshot. Callers read it before the turn's first await and
// pass it through every request, including a later file-recovery retry.
function readGeminiProviderPin() {
  return {
    provider: String(settings.get("ai_provider") || "gemini").toLowerCase(),
    model: settings.get("gemini_model"),
    baseUrl: settings.get("gemini_base_url"),
    apiKey: settings.get("gemini_api_key"),
  };
}

function geminiClient(pin = readGeminiProviderPin()) {
  const resolved = pin || readGeminiProviderPin();
  const key = resolved.apiKey;
  if (!key) return null;
  const baseUrl = assertProviderBaseUrl(resolved.baseUrl, {
    allowLoopback: true,
  });
  if (clientCache.key !== key || clientCache.baseUrl !== baseUrl) {
    clientCache = {
      key,
      baseUrl,
      client: new GoogleGenAI({ apiKey: key, apiVersion: "v1beta", httpOptions: geminiHttpOptions(baseUrl) }),
    };
  }
  return clientCache.client;
}

// The persona is editable — from the dashboard, or in a text editor — so it
// lives in the data directory. The copy that ships with the bot is a template:
// it is copied over on first start and never written to again, which is what
// lets a global install or a read-only image still edit its own prompt.
const { dataPath, assetPath } = require("../config/paths.cjs");
const PERSONA_TEMPLATE = assetPath("src", "config", "ai-persona.md");
const PERSONA_FILE = dataPath("ai-persona.md");

try {
  if (!fs.existsSync(PERSONA_FILE) && fs.existsSync(PERSONA_TEMPLATE)) {
    fs.copyFileSync(PERSONA_TEMPLATE, PERSONA_FILE);
  }
} catch {
  // Not fatal: loadPersona() falls back to DEFAULT_PERSONA below.
}

// Fallback only, for the moment between "the file is missing" and "the template
// has been copied". The real persona is the operator's copy of ai-persona.md.
// No product identity in here: that comes from src/config/ai-identity.cjs and is
// prepended separately, so it survives any edit to the persona.
const DEFAULT_PERSONA = `You are a capable personal WhatsApp assistant.
Be concise and direct by default, reply in the language the user writes in, and
use your tools instead of guessing when something needs to be looked up.`;

// Sections the code owns now (OPERATING_RULES in src/config/ai-identity.cjs).
// A copy of ai-persona.md from before that split still carries them, and an
// operator can type one back in: both are dropped here, so the rules are stated
// once, from code, and no edit of the persona can weaken them.
const SEALED_HEADINGS = new Set([
  "tools",
  "levix help",
  "media",
  "memory",
  "chats and groups",
  "boundaries",
]);

function stripSealedSections(text) {
  const kept = [];
  let sealed = false;
  for (const line of String(text).split("\n")) {
    const heading = /^#{1,3}\s+(.+?)\s*$/.exec(line);
    if (heading) sealed = SEALED_HEADINGS.has(heading[1].toLowerCase());
    if (!sealed) kept.push(line);
  }
  return kept.join("\n").trim();
}

let personaCache = { text: null, stamp: null };

/**
 * The persona file, re-read whenever it changes on disk.
 *
 * Keyed on the nanosecond mtime AND the size, not `mtimeMs`: that is a
 * millisecond float, and two saves inside the same millisecond — the dashboard
 * writing twice, or a test — produced the same key, so the second edit was
 * served from the cache and the operator's change silently did not apply.
 */
function loadPersona() {
  try {
    const stat = fs.statSync(PERSONA_FILE, { bigint: true });
    const stamp = `${stat.mtimeNs}:${stat.size}`;
    if (personaCache.text && personaCache.stamp === stamp) {
      return personaCache.text;
    }
    const raw = fs.readFileSync(PERSONA_FILE, "utf8").trim();
    // Everything above the `---` separator is a note to the human editing the
    // file, not part of the prompt.
    const body = raw.includes("\n---")
      ? raw
          .split(/\n---\s*\n/)
          .slice(1)
          .join("\n---\n")
      : raw;
    personaCache = { text: stripSealedSections(body) || DEFAULT_PERSONA, stamp };
    return personaCache.text;
  } catch {
    return DEFAULT_PERSONA;
  }
}

function nowLabel() {
  try {
    return new Intl.DateTimeFormat("ar-EG", {
      timeZone: settings.get("bot_timezone"),
      dateStyle: "full",
      timeStyle: "short",
    }).format(new Date());
  } catch {
    return new Date().toISOString();
  }
}

function botLangDirective() {
  const aiLang = settings.get("ai_reply_language");
  const botLang = ["auto", "ar", "en", "pt-BR", "es-419"].includes(aiLang)
    ? aiLang
    : settings.get("bot_language") || "auto";
  // The dialect rule lives here on purpose, not in the persona: the operator
  // owns src/config/ai-persona.md and can rewrite every line of it, and this
  // one must survive every edit (Levix users worldwide; Levix is built in
  // Egypt, and Egyptian dialect in should mean Egyptian dialect out).
  if (botLang === "ar") {
    return "- Language instruction: Always reply in Arabic. Match the dialect the user writes in: Egyptian Arabic gets natural Egyptian Arabic back; formal Arabic or any other Arabic dialect gets clear, natural Arabic matching the user's.";
  }
  if (botLang === "en") {
    return "- Language instruction: Always reply in English, clear, professional, natural, and direct.";
  }
  if (botLang === "pt-BR") {
    return "- Language instruction: Always reply in Brazilian Portuguese, clear, natural, and direct.";
  }
  if (botLang === "es-419") {
    return "- Language instruction: Always reply in Latin American Spanish, clear, natural, and direct.";
  }
  return "- Language instruction: Reply in the language and dialect the user writes in. Egyptian Arabic gets natural Egyptian Arabic back; formal Arabic or other Arabic dialects get clear, natural Arabic matching the user; English gets English; any other language gets that language.";
}

/**
 * product identity + persona + who/where/when + long-term memory.
 *
 * The identity block goes FIRST and does not come from the persona file. The
 * operator owns the persona and can rewrite it from the dashboard; they do not
 * own what the product is called or who wrote it, so that part is code (see
 * src/config/ai-identity.cjs) and is never rendered by the panel.
 */
function buildSystemInstruction(context = {}) {
  const { chatId, senderName, senderId, isOwner, isAdmin, isGroup, chatName } = context;

  const runtime = [
    "# Current context",
    `- Speaking to you: ${senderName || "unknown"}${senderId ? ` (${senderId})` : ""}`,
    `- Their role: ${isOwner ? "bot owner" : isAdmin ? "bot admin" : "ordinary user"}`,
    `- Where: ${isGroup ? `a group chat${chatName ? ` called "${chatName}"` : ""}` : "a private one-to-one chat"}`,
    `- Local time now: ${nowLabel()}`,
    isGroup
      ? "- This is a group: every participant sees your reply. Say nothing here that belongs to one person."
      : "- This is a private chat: only this person sees your reply.",
    botLangDirective(),
  ].join("\n");

  const memoryBlock = memory.buildMemoryContext(chatId, {
    includeGlobal: globalMemoryAccess(context).read,
  });

  return [aiIdentity.systemBlock, loadPersona(), runtime, memoryBlock].filter(Boolean).join("\n\n");
}

const AUTO_REPLY_DECISION_DIRECTIVE = [
  "# Auto Reply decision",
  "You are deciding how Auto Reply responds to this incoming WhatsApp message. Call `auto_reply_decision` once and return no other output.",
  '- Choose `action: "react"` with a single reaction `emoji` (such as "❤️", "👍", "😂") for pure acknowledgement, thanks, agreement, or laughter that needs no text reply.',
  '- Choose `action: "silent"` when there is nothing to answer (a closing word, an ok/bye, a sticker-like message, or a message not addressed to the bot).',
  '- Choose `action: "reply"` with `text` when you can give a direct answer right now from your existing knowledge and the context above, in the required reply language. Never put only a single emoji in `text`.',
  '- Choose `action: "task"` when answering needs tools (web search, reminders, memory, documents, polls, voice notes, or images).',
  "- Never choose a chat, JID, message key, target, or destination; the backend owns delivery.",
].join("\n");

function buildAutoReplySystemInstruction(context = {}) {
  return [buildSystemInstruction(context), AUTO_REPLY_DECISION_DIRECTIVE]
    .filter(Boolean)
    .join("\n\n");
}

function ensureAutoReplyDirective(systemInstruction, context) {
  const base = systemInstruction || buildSystemInstruction(context);
  if (typeof base === "string" && base.includes("# Auto Reply decision")) return base;
  return [base, AUTO_REPLY_DECISION_DIRECTIVE].filter(Boolean).join("\n\n");
}

function historyTurns(history) {
  if (Array.isArray(history)) return history;
  if (history && typeof history === "object") {
    if (Array.isArray(history.history)) return history.history;
    if (Array.isArray(history.turns)) return history.turns;
    if (Array.isArray(history.entries)) return history.entries;
  }
  return [];
}

/** A turn the conversation can legally start from. */
function isOpeningTurn(entry) {
  if (entry?.role !== "user") return false;
  // A functionResponse whose matching functionCall was trimmed away is not a
  // valid opening — Gemini rejects the whole history for it.
  return !entry.parts?.some((part) => part?.functionResponse);
}

/**
 * Keep the stored history bounded, and make sure it still starts on a real
 * user turn: Gemini rejects a history that opens with a model or function
 * entry.
 */
function trimHistory(history) {
  const maxEntries = settings.get("ai_max_history");
  const out = [...historyTurns(history)];
  while (out.length > maxEntries) out.shift();
  while (out.length && !isOpeningTurn(out[0])) out.shift();
  // A budget-exhausted model call has no response. Drop the whole turn so
  // retained parts (including Gemini thought signatures) remain untouched.
  while (out.at(-1)?.role === "model" && out.at(-1).parts?.some((part) => part?.functionCall))
    out.pop();
  return out;
}

function errorText(error) {
  return [
    error?.message,
    error?.details,
    error?.statusText,
    error?.error?.message,
    error?.error?.status,
    typeof error?.status === "string" ? error.status : "",
    typeof error?.code === "string" ? error.code : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function fileIdsFromText(text) {
  return [...String(text || "").matchAll(/files\/([A-Za-z0-9_-]+)/gi)].map((match) =>
    match[1].toLowerCase(),
  );
}

// Only fileUri fields count as files this turn sent. Walking every string
// would treat a mention of "files/…" in ordinary text as an upload.
function collectSentFileIds(sent) {
  const ids = new Set();
  const visit = (value, seen) => {
    if (!value || typeof value !== "object") return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, seen);
      return;
    }
    if (typeof value.fileUri === "string") {
      for (const id of fileIdsFromText(value.fileUri)) ids.add(id);
    }
    for (const key of ["parts", "history", "fileData", "contents", "message", "turns", "entries"]) {
      if (value[key] != null) visit(value[key], seen);
    }
  };
  visit(sent, new Set());
  return ids;
}

function namesFileResource(text) {
  const lower = String(text || "").toLowerCase();
  if (!/\bfiles?\b|file_?uri|filedata|\/files\//.test(lower)) return false;
  // "invalid" is not expiry. "Invalid file format" names a file and still
  // must not discard stored media.
  return /not found|not_found|not exist|expired|not in an active|not active|permission to access|forbidden|permission_denied|failed_precondition|no longer|missing resource|resource not found/.test(
    lower,
  );
}

/**
 * A stale Files API reference. A bare 403/404/410 is not enough: the error
 * must name a file resource, or name a files/<id> URI this turn actually sent.
 */
function isFileReferenceError(error, sent) {
  if (!error) return false;
  const text = errorText(error);
  if (sent) {
    const sentIds = collectSentFileIds(sent);
    if (fileIdsFromText(text).some((id) => sentIds.has(id))) return true;
  }
  return namesFileResource(text);
}

/** Drop every uploaded-media part so a stale file URI can't poison the chat. */
function sanitizeHistoryForFiles(history) {
  const turns = historyTurns(history);
  if (!turns.length) return [];
  return turns
    .map((turn) => {
      if (!turn?.parts) return turn;
      const parts = turn.parts.filter((part) => !part?.fileData && !part?.inlineData);
      if (!parts.length) return null;
      return { ...turn, parts };
    })
    .filter(Boolean);
}

/**
 * Gemini rejected a thought signature. The field name alone is not a rejection:
 * a 400 that merely echoes "thoughtSignature" from a prompt must not match.
 */
function isThoughtSignatureError(error) {
  if (!error) return false;
  const numStatus = Number(
    error.status ??
      error.statusCode ??
      (typeof error.code === "number" ? error.code : undefined) ??
      error.response?.status ??
      error.error?.code ??
      0,
  );
  const text = errorText(error);
  if (numStatus && numStatus !== 400) return false;
  if (!numStatus && !/\b400\b|invalid_argument/i.test(text)) return false;
  return /invalid thought signature|thought signature is not valid|missing a thought_signature|missing thought signature|thought signature was issued by an unavailable route/i.test(
    text,
  );
}

/**
 * Sanitize prior history to plain user/model text turns: drop every prior-turn
 * functionCall/functionResponse entry and every thought part (and signatures).
 */
function sanitizeHistoryForThoughtSignatures(history) {
  const turns = historyTurns(history);
  const out = [];
  for (const entry of turns) {
    if (!entry || (entry.role !== "user" && entry.role !== "model") || !Array.isArray(entry.parts)) {
      continue;
    }
    if (entry.parts.some((part) => part?.functionCall || part?.functionResponse)) {
      continue;
    }
    const parts = [];
    for (const part of entry.parts) {
      if (part?.thought === true) continue;
      if (typeof part?.text === "string" && part.text.length > 0) {
        parts.push({ text: part.text });
      }
    }
    if (parts.length) {
      out.push({ role: entry.role, parts });
    }
  }
  return trimHistory(out);
}

/**
 * Classify an AI error into a fixed user-facing category so raw provider JSON
 * or SDK error messages never reach WhatsApp.
 */
function classifyAiError(error) {
  const numStatus = Number(
    error?.status ??
      error?.statusCode ??
      (typeof error?.code === "number" ? error.code : undefined) ??
      error?.response?.status ??
      error?.error?.code ??
      0,
  );
  const code = typeof error?.code === "string" ? error.code : "";
  const text = [
    error?.message,
    error?.details,
    error?.statusText,
    error?.error?.message,
    error?.error?.status,
    typeof error?.status === "string" ? error.status : "",
    code,
  ]
    .filter(Boolean)
    .join(" ");

  if (isThoughtSignatureError(error)) {
    return "signature";
  }
  if (
    /\bsafety\b|prohibited_content|recitation|content[\s_-]*filter|content_policy|harm_category|finish_reason[:\s"]*safety|blocked by safety|blocked due to safety/i.test(
      text,
    )
  ) {
    return "safety";
  }
  if (
    numStatus === 429 ||
    code === "IMAGE_QUOTA" ||
    /resource_exhausted|\bquota\b|rate[\s_-]*limit|too many requests|\b429\b|insufficient_quota/i.test(
      text,
    )
  ) {
    return "quota";
  }
  if (
    numStatus === 401 ||
    numStatus === 403 ||
    code === "IMAGE_KEY_REQUIRED" ||
    /api[\s_-]*key|invalid_api_key|api_key_invalid|unauthenticated|unauthorized|authentication|permission_denied|invalid.*key|key.*not.*configured|no.*api.*key|لم يُضبط مفتاح/i.test(
      text,
    )
  ) {
    return "apiKey";
  }
  if (
    (numStatus >= 500 && numStatus < 600) ||
    error?.name === "AbortError" ||
    /timed?\s*out|\btimeout\b|econnrefused|econnreset|enotfound|ehostunreach|enetunreach|eai_again|socket hang up|fetch failed|network|service[\s_-]*unavailable|unavailable|bad gateway|gateway timeout|overloaded|internal error|\b50[0234]\b/i.test(
      text,
    )
  ) {
    return "unavailable";
  }
  return "generic";
}

const AI_ERROR_KEYS = Object.freeze({
  signature: "bot.ai.gemini.errorThoughtSignature",
  quota: "bot.ai.gemini.errorQuota",
  apiKey: "bot.ai.gemini.errorApiKey",
  safety: "bot.ai.gemini.errorSafety",
  unavailable: "bot.ai.gemini.errorUnavailable",
  generic: "bot.ai.gemini.errorGeneric",
});

function describeAiError(error) {
  const kind = classifyAiError(error);
  const key = AI_ERROR_KEYS[kind] || AI_ERROR_KEYS.generic;
  const translated = t(key);
  if (translated && translated !== key) return translated;
  const shortKey = key.replace(/^bot\.ai\./, "");
  for (const locale of [currentLang(), "en"]) {
    try {
      const bundle = JSON.parse(
        fs.readFileSync(assetPath("i18n", locale, "bot", "ai.json"), "utf8"),
      );
      if (typeof bundle?.[shortKey] === "string" && bundle[shortKey]) {
        return bundle[shortKey];
      }
    } catch {}
  }
  return translated;
}

function isAgentEnabled() {
  // The key that matters is the active provider's: a panel switch from gemini
  // to openai must not keep the agent gated on (or running on) a Gemini key.
  return Boolean(settings.get(activeProviderKeySetting())) && settings.get("ai_agent");
}

// ===========================================================================
// Google Search — Gemini's own, not ours
// ===========================================================================
//
// `{ googleSearch: {} }` is a BUILT-IN tool: the model decides when a question
// needs the web, Google runs the search inside the same request, and the answer
// comes back already grounded with the sources it used. There is no
// google_search function declaration anywhere in Levix, nothing to execute in
// the tool loop, and no search API key — deliberately. A hand-rolled search
// tool would be a second, worse implementation of something the model already
// does better.
//
// The shape is the Gemini 2.x one. The older `googleSearchRetrieval` is what
// 1.5 models take; this SDK's TypeScript types only know that one, but the SDK
// passes `tools` through to the REST API untouched (dist/index.js:1377), so the
// 2.x shape reaches the model exactly as written.

const GOOGLE_SEARCH_TOOL = Object.freeze({ googleSearch: {} });

/** Gemini-only. The openai and anthropic providers are never offered it. */
function googleSearchEnabled() {
  return settings.get("ai_google_search") === true;
}

/**
 * The `tools` array for one request.
 *
 * Custom function declarations and the built-in search go in the same array;
 * Gemini 2.x accepts both together. When it does not (see runAgent), the search
 * half is dropped and Levix's own tools are kept — never the other way round.
 */
function buildTools({ useTools = true, search = googleSearchEnabled() } = {}) {
  const tools = [];
  if (useTools) tools.push(...toolDeclarations());
  if (search) tools.push(GOOGLE_SEARCH_TOOL);
  return tools;
}

/**
 * The tool configuration that lets a built-in tool and custom functions run in
 * the same request.
 *
 * Gemini 3 calls this "tool context circulation": the server runs Google Search
 * itself, and `includeServerSideToolInvocations` is what puts those server-side
 * calls into the conversation so the custom functions can see them. Without the
 * flag the combination is refused outright.
 *
 * Turning it on also constrains function calling to VALIDATED — AUTO is not
 * supported alongside it — so the two are set together or not at all.
 *
 * Returns undefined when there is nothing to combine, which leaves the ordinary
 * AUTO behaviour exactly as it was.
 */
function buildToolConfig({ useTools = true, search = googleSearchEnabled() } = {}) {
  if (!useTools || !search) return undefined;
  return {
    includeServerSideToolInvocations: true,
    functionCallingConfig: { mode: FunctionCallingConfigMode.VALIDATED },
  };
}

/**
 * Does this error mean "this model will not take search and functions at once"?
 *
 * Some model/API combinations refuse the mix with a 400. Rather than quietly
 * shipping fewer tools forever, runAgent() retries once without the built-in
 * search and says so in the log — Levix's own tools are the ones that must
 * survive, because commands depend on them.
 */
function isToolCombinationError(error) {
  const status = Number(error?.status ?? error?.statusCode ?? error?.error?.code ?? 0);
  const message = `${error?.message || ""} ${error?.statusText || ""}`.toLowerCase();
  if (status && status !== 400) return false;
  return (
    message.includes("tool") &&
    (message.includes("not supported") ||
      message.includes("unsupported") ||
      message.includes("only one tool") ||
      message.includes("cannot be used") ||
      message.includes("at most one"))
  );
}

/**
 * Pull the sources Gemini actually grounded on out of one response.
 *
 * Reads only real grounding metadata — `candidates[].groundingMetadata` — so a
 * turn where the model answered from its own knowledge yields nothing and no
 * Sources block is ever invented.
 */
function extractSources(response) {
  const out = [];
  // The path is unchanged from the old SDK: candidates[].groundingMetadata
  // .groundingChunks[].web.{uri,title}. Verified against @google/genai's
  // GroundingMetadata / GroundingChunkWeb, which also adds a Vertex-only
  // `domain` field that the Gemini Developer API does not populate.
  for (const candidate of response?.candidates || []) {
    const grounding = candidate?.groundingMetadata;
    for (const chunk of grounding?.groundingChunks || []) {
      const uri = chunk?.web?.uri;
      if (!uri) continue;
      out.push({ uri, title: chunk.web.title || hostOf(uri) || "source" });
    }
  }
  return out;
}

function hostOf(uri) {
  try {
    return new URL(uri).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** How many sources are worth putting under a WhatsApp answer. */
const MAX_SOURCES = 5;

/**
 * A compact Sources block, or "" when there is nothing to cite.
 *
 * Deduplicated by URL, capped, and written in the plain style the rest of the
 * bot uses — no Markdown links, which WhatsApp renders literally.
 */
function formatSources(sources) {
  const seen = new Set();
  const lines = [];
  const ordered = [
    ...(sources || []).filter((source) => source?.kind === "levix-doc"),
    ...(sources || []).filter((source) => source?.kind !== "levix-doc"),
  ];
  for (const source of ordered) {
    if (source?.kind === "levix-doc") {
      if (seen.has(source.id)) continue;
      seen.add(source.id);
      lines.push(`• ${source.citation}`);
      if (lines.length >= MAX_SOURCES) break;
      continue;
    }
    if (!source?.uri || seen.has(source.uri)) continue;
    seen.add(source.uri);
    const label = String(source.title || hostOf(source.uri) || "source").trim();
    lines.push(`• ${label} — ${source.uri}`);
    if (lines.length >= MAX_SOURCES) break;
  }
  return lines.length ? `\n\n${t("bot.ai.aiAgent.sources")}\n${lines.join("\n")}` : "";
}

/**
 * Run one agent turn.
 *
 * Dispatches on the `ai_provider` setting: gemini runs the native loop below
 * (built-in Google Search, Files uploads); openai and anthropic run the same
 * loop over their own wire formats in aiProviders.cjs.
 *
 * @param {object}   options
 * @param {Array}    options.parts    - the Gemini parts for this message
 * @param {Array}    [options.history]- prior conversation
 * @param {object}   [options.status] - live status message (see utils/statusMessage.cjs)
 * @param {object}   [options.context]- { caller, chatId, senderId, senderName, isOwner, isAdmin, isGroup, chatName }
 *                                      `caller` (aiToolAuth.resolveCaller) is the only thing the
 *                                      tools authorize against; the rest feeds the system prompt.
 * @param {boolean}  [options.useTools=true]
 * @returns {Promise<{text: string, history: Array, toolCalls: Array, steps: number}>}
 */
class GeminiProvider extends BaseAIProvider {
  constructor() {
    super({
      id: "gemini",
      label: "Google Gemini",
      keySetting: "gemini_api_key",
      modelSetting: "gemini_model",
      baseUrlSetting: "gemini_base_url",
      defaultBaseUrl: "",
      supportsFiles: true,
    });
  }

  async prepareMedia(
    parts,
    mediaMessage,
    mimeOverride,
    { downloadContentFromMessage, genAI, downloadType } = {},
  ) {
    if (!genAI) throw new Error("Gemini client unavailable");
    const rawMime = mimeOverride || mediaMessage?.mimetype || "";
    const kind = mediaKind(rawMime);
    const caps = detectModelCapabilities("gemini");
    if (kind === "image" && (!settings.get("ai_vision_enabled") || !caps.supportsVision)) {
      parts.push({
        text: "[تم إرفاق صورة — الرؤية غير مفعّلة للنموذج المحدد / Vision is disabled for the selected model]",
      });
      return null;
    }
    if (kind === "audio" && (!settings.get("ai_stt_enabled") || !caps.supportsAudioStt)) {
      parts.push({
        text: "[تم إرفاق صوت — تحويل الكلام غير مفعّل للنموذج المحدد / Speech-to-text is disabled for the selected model]",
      });
      return null;
    }

    // Uploaded through the Files API, or inline when the configured endpoint
    // has none (a gateway / reverse proxy) — see utils/geminiMedia.cjs.
    const mimeType = baseMimeType(rawMime, kind);
    const buffer = await downloadMedia(
      downloadContentFromMessage,
      mediaMessage,
      downloadType || kind,
    );
    const part = await geminiMediaPart(genAI, buffer, mimeType, {
      baseUrl: settings.get("gemini_base_url"),
    });
    parts.push(part);
    return part.fileData?.fileUri || `inline:${kind}`;
  }

  async runTurn(options) {
    return runGeminiTurn(options);
  }

  async classifyAutoReply(options) {
    return classifyGeminiAutoReply(options);
  }
}

registerProvider("gemini", new GeminiProvider());

/**
 * Run one agent turn.
 * Modular dispatch through getProvider().
 */
async function runAgent(options = {}) {
  const pinnedProvider = options.provider ?? options.geminiPin?.provider;
  const provider =
    pinnedProvider !== undefined && pinnedProvider !== null
      ? getProvider(pinnedProvider)
      : getProvider();
  const result = await provider.runTurn({
    ...options,
    history: trimHistory(options.history),
    systemInstruction: buildSystemInstruction(options.context),
  });
  return {
    ...result,
    history: trimHistory(result.history),
  };
}

function extractGeminiCalls(response) {
  const parts = response?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    return parts.filter((part) => part?.functionCall).map((part) => part.functionCall);
  }
  if (Array.isArray(response?.functionCalls)) {
    return response.functionCalls;
  }
  return [];
}

async function classifyGeminiAutoReply({
  parts,
  context = {},
  systemInstruction = null,
  signal,
} = {}) {
  signal?.throwIfAborted?.();
  const genAI = geminiClient();
  if (!genAI) {
    logger.warn(
      { reason: "missing_key", provider: "gemini" },
      "[aiAgent] Auto Reply classification skipped",
    );
    return null;
  }
  try {
    await assertProviderRequestUrl(settings.get("gemini_base_url"), { allowLoopback: true });
  } catch {
    logger.warn(
      { reason: "invalid_base_url", provider: "gemini" },
      "[aiAgent] Auto Reply classification skipped",
    );
    return null;
  }
  signal?.throwIfAborted?.();

  const instruction = ensureAutoReplyDirective(systemInstruction, context);
  const model = settings.get("gemini_model");
  const normalizedParts = Array.isArray(parts) ? parts : [];

  let response;
  try {
    response = await genAI.models.generateContent({
      model,
      contents: [{ role: "user", parts: normalizedParts }],
      config: {
        systemInstruction: instruction,
        ...(signal ? { abortSignal: signal } : {}),
        // A fresh copy: the SDK rewrites declaration fields and the shared one is frozen.
        tools: [{ functionDeclarations: [structuredClone(AUTO_REPLY_DECISION_DECLARATION)] }],
        toolConfig: {
          functionCallingConfig: {
            mode: FunctionCallingConfigMode?.ANY || "ANY",
            allowedFunctionNames: [AUTO_REPLY_DECISION_TOOL],
          },
        },
      },
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") throw error;
    logger.warn(
      {
        reason: "provider_error",
        provider: "gemini",
        status: error?.status || error?.statusCode || null,
      },
      "[aiAgent] Auto Reply classification request failed",
    );
    return null;
  }
  signal?.throwIfAborted?.();

  const calls = extractGeminiCalls(response);
  const validated = validateDecisionCalls(calls);
  if (!validated.ok) {
    logger.warn(
      { reason: validated.reason, provider: "gemini" },
      "[aiAgent] Auto Reply classification decision rejected",
    );
    return null;
  }
  return validated.decision;
}

/**
 * One-shot Auto Reply classification across Gemini, OpenAI-compatible, and Anthropic.
 * Forces the single `auto_reply_decision` declaration with no tools executed,
 * no Google Search, and no tool loop.
 */
async function classifyAutoReply(options = {}) {
  const provider = getProvider(options.provider);
  if (Object.hasOwn(provider, "runTurn") && !Object.hasOwn(provider, "classifyAutoReply")) {
    return Object.freeze({ action: "task" });
  }
  const systemInstruction = ensureAutoReplyDirective(options.systemInstruction, options.context);
  if (typeof provider.classifyAutoReply === "function") {
    return provider.classifyAutoReply({
      ...options,
      systemInstruction,
    });
  }
  if (provider.id === "openai" || provider.id === "anthropic") {
    return classifyProviderAutoReply(provider.id, {
      ...options,
      systemInstruction,
    });
  }
  return classifyGeminiAutoReply({
    ...options,
    systemInstruction,
  });
}

async function runGeminiTurn({
  parts,
  history = [],
  status = null,
  context = {},
  useTools = true,
  maxSteps = null,
  systemInstruction = null,
  search = null,
  signal,
  geminiPin = null,
} = {}) {
  // Before the endpoint check. A settings change during that await must not
  // move this turn onto another model, endpoint or key. A pin from the command
  // covers the file-recovery retry, which is a second call.
  const pin = geminiPin || readGeminiProviderPin();
  const genAI = geminiClient(pin);
  if (!genAI) throw new Error(t("bot.ai.aiAgent.noGeminiKey"));
  await assertProviderRequestUrl(pin.baseUrl, { allowLoopback: true });

  const stepBudget = maxSteps ?? settings.get("ai_max_tool_steps");
  const instruction = systemInstruction || buildSystemInstruction(context);
  const model = pin.model;
  // Signatures are stripped when gemini_model, gemini_base_url or gemini_api_key
  // changes. When that sweep threw after the setting write, retry it before the
  // first request; if it fails again, strip the loaded history in memory and
  // leave the pending flag set. A leftover 400 (a gateway alias, a restored
  // backup) is retried once below; a provider switch does not drop function
  // calls on its own.
  let inputHistory = history;
  if (store.isGeminiSignatureSweepPending()) {
    try {
      store.stripGeminiThoughtSignatures();
      store.clearGeminiSignatureSweepPending();
    } catch (error) {
      store.markGeminiSignatureSweepPending();
      logger.error({ err: error }, "[ai_history] thought-signature sweep retry failed");
    }
    inputHistory = store.stripThoughtSignaturesFromHistory(inputHistory);
  }
  let activeHistory = trimHistory(inputHistory);

  // `ai.chats` rather than a hand-rolled contents array on purpose. Gemini 3
  // returns a `thoughtSignature` on the parts it produces and expects it back
  // on the following turns of a multi-step tool run; the Chat class records
  // `candidates[0].content` verbatim into its history, signature included, so
  // circulating it is not something this file has to remember to do. Levix
  // persists that same history, and a signature is a plain string, so it
  // survives the round trip through SQLite too.
  const openChat = (search, chatHistory = activeHistory) => {
    const tools = buildTools({ useTools, search });
    const toolConfig = buildToolConfig({ useTools, search });
    return genAI.chats.create({
      model,
      history: chatHistory,
      config: {
        systemInstruction: instruction,
        ...(signal ? { abortSignal: signal } : {}),
        ...(tools.length ? { tools } : {}),
        ...(toolConfig ? { toolConfig } : {}),
      },
    });
  };

  // One-shot callers (the summarize tool) pass search:false explicitly; the
  // chat agent follows the setting.
  let searchOffered = search === null ? googleSearchEnabled() : Boolean(search);
  let chat = openChat(searchOffered, activeHistory);
  const toolCalls = [];
  // Only ever filled from real grounding metadata; see extractSources().
  const sources = [];

  let response;
  try {
    response = await chat.sendMessage({ message: parts });
  } catch (error) {
    if (isThoughtSignatureError(error)) {
      logger.warn(
        { err: error?.message, model },
        "[aiAgent] thought signature rejected on first send — retrying once with sanitized history",
      );
      activeHistory = sanitizeHistoryForThoughtSignatures(activeHistory);
      chat = openChat(searchOffered, activeHistory);
      response = await chat.sendMessage({ message: parts });
    } else if (searchOffered && isToolCombinationError(error)) {
      // Defensive only. Gemini 3 takes the built-in search and custom functions
      // in one request, so this is not the expected path — but a model that
      // refuses the combination must not cost Levix its own tools, which the
      // commands depend on. Search is what gets dropped, never the functions.
      logger.warn(
        { err: error?.message, model },
        "[aiAgent] this model refused Google Search together with function tools — retrying with functions only",
      );
      searchOffered = false;
      chat = openChat(false, activeHistory);
      response = await chat.sendMessage({ message: parts });
    } else {
      throw error;
    }
  }

  sources.push(...extractSources(response));
  let steps = 0;

  while (steps < stepBudget) {
    // `functionCalls` is a getter on the new response object, not a method.
    const calls = response.functionCalls || [];
    if (!calls.length) break;

    steps += 1;

    // Narrate what is about to happen in the same message the user is already
    // looking at.
    if (status) {
      const line = calls.map((call) => describeCall(call.name, call.args)).join("\n");
      await status.update(line);
    }

    const responses = [];
    for (const call of calls) {
      toolCalls.push({ name: call.name, args: call.args });
      logger.info({ tool: call.name }, "[aiAgent] tool call");

      // Named apart from the outer `response` on purpose: that one is the
      // model's reply and is reassigned at the bottom of this loop.
      let toolResult;
      try {
        toolResult = await runToolWithDeadline(
          call.name,
          call.args,
          context,
          settings.get("ai_tool_timeout_ms"),
        );
      } catch (err) {
        toolResult = toolErrorForModel(err);
      }
      sources.push(...docSourcesFromTool(call.name, toolResult));
      responses.push({
        functionResponse: {
          // Echoed back when the model supplied one: with several calls in a
          // single turn the id is how the API pairs each result with its call.
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: toolResult,
        },
      });
    }

    if (status) await status.update(t("bot.ai.aiAgent.writingAnswer"));
    // One message carrying every functionResponse part, which is what the API
    // expects when the model asked for several calls in one turn. A failure
    // here must not rerun the turn: a tool has already executed.
    try {
      response = await chat.sendMessage({ message: responses });
    } catch (error) {
      throw markToolsRan(error);
    }
    // Grounding can happen on any turn, not just the first.
    sources.push(...extractSources(response));
  }

  // `text` is a getter now, and it returns undefined rather than throwing when
  // the candidate has no text part.
  let text = "";
  try {
    text = response.text ?? "";
  } catch (err) {
    logger.warn({ err: err?.message }, "[aiAgent] response had no text part");
  }

  if (!text && steps >= stepBudget) {
    text = t("bot.ai.aiAgent.toolBudget");
  }

  let newHistory = [];
  try {
    // Synchronous in this SDK, and `true` asks for the curated history — the
    // turns the API would actually accept back, with empty or invalid model
    // outputs left out. That is exactly what Levix wants to persist.
    newHistory = trimHistory(chat.getHistory(true));
  } catch (err) {
    logger.warn({ err: err?.message }, "[aiAgent] could not read chat history");
  }

  return {
    text,
    history: newHistory,
    provider: "gemini",
    model,
    toolCalls,
    steps,
    // Empty unless Gemini actually grounded this answer on a search.
    sources,
    searchOffered,
  };
}

module.exports = {
  runAgent,
  classifyAutoReply,
  buildAutoReplySystemInstruction,
  AUTO_REPLY_DECISION_DIRECTIVE,
  AUTO_REPLY_DECISION_TOOL,
  AUTO_REPLY_DECISION_DECLARATION,
  validateAutoReplyDecision,
  validateDecisionCalls,
  runGeminiTurn,
  readGeminiProviderPin,
  geminiClient,
  buildTools,
  buildToolConfig,
  googleSearchEnabled,
  extractSources,
  formatSources,
  isToolCombinationError,
  isThoughtSignatureError,
  sanitizeHistoryForThoughtSignatures,
  classifyAiError,
  describeAiError,
  GOOGLE_SEARCH_TOOL,
  buildSystemInstruction,
  loadPersona,
  stripSealedSections,
  isAgentEnabled,
  activeProviderKeySetting,
  isFileReferenceError,
  sanitizeHistoryForFiles,
  trimHistory,
  PERSONA_FILE,
  detectModelCapabilities,
  getProvider,
  GeminiProvider,
};
