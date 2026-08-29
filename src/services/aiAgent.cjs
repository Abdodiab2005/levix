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
const path = require("path");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const logger = require("../utils/logger.cjs");
const aiIdentity = require("../config/ai-identity.cjs");
const settings = require("../config/settings.cjs");
const memory = require("../utils/memory.cjs");
const { toolDeclarations, describeCall, runTool } = require("./aiTools.cjs");

// Model, key, tool budget and history length all come from config/settings.cjs
// (what the dashboard saved, else the default) and are read per call, so changing
// any of them from the dashboard takes effect on the next message instead of
// after a restart.

// One client per key. The dashboard can set a key on a bot that started
// without one, so the client is built lazily and rebuilt when the key changes.
let clientCache = { key: null, client: null };

function geminiClient() {
  const key = settings.get("gemini_api_key");
  if (!key) return null;
  if (clientCache.key !== key) {
    clientCache = { key, client: new GoogleGenerativeAI(key) };
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
    const body = raw.includes("\n---") ? raw.split(/\n---\s*\n/).slice(1).join("\n---\n") : raw;
    personaCache = { text: body.trim() || DEFAULT_PERSONA, stamp };
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

/**
 * product identity + persona + who/where/when + long-term memory.
 *
 * The identity block goes FIRST and does not come from the persona file. The
 * operator owns the persona and can rewrite it from the dashboard; they do not
 * own what the product is called or who wrote it, so that part is code (see
 * src/config/ai-identity.cjs) and is never rendered by the panel.
 */
function buildSystemInstruction(context = {}) {
  const {
    chatId,
    senderName,
    senderId,
    isOwner,
    isAdmin,
    isGroup,
    chatName,
  } = context;

  const runtime = [
    "# Current context",
    `- Speaking to you: ${senderName || "unknown"}${senderId ? ` (${senderId})` : ""}`,
    `- Their role: ${isOwner ? "bot owner" : isAdmin ? "bot admin" : "ordinary user"}`,
    `- Where: ${isGroup ? `a group chat${chatName ? ` called "${chatName}"` : ""}` : "a private one-to-one chat"}`,
    `- Local time now: ${nowLabel()}`,
    isGroup
      ? "- This is a group: every participant sees your reply. Say nothing here that belongs to one person."
      : "- This is a private chat: only this person sees your reply.",
  ].join("\n");

  const memoryBlock = memory.buildMemoryContext(chatId);

  return [aiIdentity.systemBlock, loadPersona(), runtime, memoryBlock]
    .filter(Boolean)
    .join("\n\n");
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
  const out = Array.isArray(history) ? [...history] : [];
  while (out.length > maxEntries) out.shift();
  while (out.length && !isOpeningTurn(out[0])) out.shift();
  return out;
}

/** Gemini file URIs live ~48h; after that every call fails on the old parts. */
function isFileReferenceError(error) {
  if (!error) return false;
  const status =
    error.status ||
    error.statusCode ||
    error.response?.status ||
    error.error?.code;
  const message = `${error.message || ""} ${error.details || ""}`.toLowerCase();

  if ([403, 404, 410].includes(Number(status))) return true;
  if (message.includes("permission_denied")) return true;
  if (message.includes("failed_precondition")) return true;

  return (
    message.includes("file") &&
    /not found|not exist|expired|not in an active|not active|permission to access|forbidden|file_?uri/.test(
      message
    )
  );
}

/** Drop every uploaded-media part so a stale file URI can't poison the chat. */
function sanitizeHistoryForFiles(history) {
  if (!Array.isArray(history)) return [];
  return history
    .map((turn) => {
      if (!turn?.parts) return turn;
      const parts = turn.parts.filter((part) => !part?.fileData && !part?.inlineData);
      if (!parts.length) return null;
      return { ...turn, parts };
    })
    .filter(Boolean);
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

function isAgentEnabled() {
  return Boolean(geminiClient()) && settings.get("ai_agent");
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

/** Gemini-only. Nothing here is offered to Groq or any other provider. */
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
  for (const source of sources || []) {
    if (!source?.uri || seen.has(source.uri)) continue;
    seen.add(source.uri);
    const label = String(source.title || hostOf(source.uri) || "source").trim();
    lines.push(`• ${label} — ${source.uri}`);
    if (lines.length >= MAX_SOURCES) break;
  }
  return lines.length ? `\n\n*Sources:*\n${lines.join("\n")}` : "";
}

/**
 * Run one agent turn.
 *
 * @param {object}   options
 * @param {Array}    options.parts    - the Gemini parts for this message
 * @param {Array}    [options.history]- prior conversation
 * @param {object}   [options.status] - live status message (see utils/statusMessage.cjs)
 * @param {object}   [options.context]- { chatId, senderId, senderName, isOwner, isAdmin, isGroup, chatName }
 * @param {boolean}  [options.useTools=true]
 * @returns {Promise<{text: string, history: Array, toolCalls: Array, steps: number}>}
 */
async function runAgent({
  parts,
  history = [],
  status = null,
  context = {},
  useTools = true,
  maxSteps = null,
} = {}) {
  const genAI = geminiClient();
  if (!genAI) throw new Error("GEMINI_API_KEY غير معرف");

  const stepBudget = maxSteps ?? settings.get("ai_max_tool_steps");
  const systemInstruction = buildSystemInstruction(context);
  const trimmed = trimHistory(history);

  const openChat = (search) => {
    const tools = buildTools({ useTools, search });
    const model = genAI.getGenerativeModel({
      model: settings.get("gemini_model"),
      systemInstruction,
      ...(tools.length ? { tools } : {}),
    });
    return model.startChat({ history: trimmed });
  };

  let searchOffered = googleSearchEnabled();
  let chat = openChat(searchOffered);
  const toolCalls = [];
  // Only ever filled from real grounding metadata; see extractSources().
  const sources = [];

  let result;
  try {
    result = await chat.sendMessage(parts);
  } catch (error) {
    // The one case where dropping a tool is correct: this model will not take
    // the built-in search alongside Levix's own functions. Keep the functions —
    // commands depend on them — and say plainly that search went.
    if (!searchOffered || !isToolCombinationError(error)) throw error;
    logger.warn(
      { err: error?.message, model: settings.get("gemini_model") },
      "[aiAgent] this model refuses Google Search together with function tools — retrying with functions only"
    );
    searchOffered = false;
    chat = openChat(false);
    result = await chat.sendMessage(parts);
  }

  sources.push(...extractSources(result.response));
  let steps = 0;

  while (steps < stepBudget) {
    const calls =
      (typeof result.response?.functionCalls === "function"
        ? result.response.functionCalls()
        : null) || [];
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
      logger.info(
        { tool: call.name, chatId: context.chatId },
        "[aiAgent] tool call"
      );

      let response;
      try {
        response = await withTimeout(
          runTool(call.name, call.args, context),
          settings.get("ai_tool_timeout_ms"),
          call.name
        );
      } catch (err) {
        response = { error: err?.message || String(err) };
      }
      responses.push({
        functionResponse: { name: call.name, response },
      });
    }

    if (status) await status.update("🤖 بجهّز الرد...");
    result = await chat.sendMessage(responses);
    // Grounding can happen on any turn, not just the first.
    sources.push(...extractSources(result.response));
  }

  let text = "";
  try {
    text = result.response.text();
  } catch (err) {
    logger.warn({ err: err?.message }, "[aiAgent] response had no text part");
  }

  if (!text && steps >= stepBudget) {
    text =
      "شغّلت الأدوات المتاحة بس مقدرتش أوصل لإجابة نهائية. جرّب تسأل بصيغة أوضح.";
  }

  let newHistory = [];
  try {
    newHistory = trimHistory(await chat.getHistory());
  } catch (err) {
    logger.warn({ err: err?.message }, "[aiAgent] could not read chat history");
  }

  return {
    text,
    history: newHistory,
    toolCalls,
    steps,
    // Empty unless Gemini actually grounded this answer on a search.
    sources,
    searchOffered,
  };
}

module.exports = {
  runAgent,
  buildTools,
  googleSearchEnabled,
  extractSources,
  formatSources,
  isToolCombinationError,
  GOOGLE_SEARCH_TOOL,
  buildSystemInstruction,
  loadPersona,
  isAgentEnabled,
  isFileReferenceError,
  sanitizeHistoryForFiles,
  trimHistory,
  PERSONA_FILE,
};
