// Long-term memory for the AI, stored as plain Markdown files.
//
// Why files and not a table
// -------------------------
// The operator asked for "save it to your memory" to end up in a `.md` file
// per chat (plus one global file) — the same idea as an agent's AGENTS.md.
// Markdown keeps the memory:
//   * human readable and hand-editable (open the file, fix a line, done),
//   * diffable / backup-able without a DB dump,
//   * trivially injectable into the model's system prompt.
//
// Layout (root overridable with MEMORY_DIR):
//
//   memory/
//     global.md              <- shared by every chat
//     chats/
//       201234567890@s.whatsapp.net.md
//       120363xxxxxxxxx@g.us.md
//
// File shape:
//
//   # 🧠 ذاكرة ...
//   <!-- chat: <jid> -->
//   ...free-form prose the human wrote (never touched by the bot)...
//   - fact one <!-- id:m1a2b3 at:2026-08-21T10:00:00.000Z by:فلان -->
//   - fact two
//
// Every line starting with `-` (or `*`) is one memory entry; indented lines
// continue the entry above. Metadata rides in a trailing HTML comment, which
// Markdown renderers hide and humans can delete without breaking anything —
// entries without it still load fine.
//
// CommonJS because the commands and the AI agent are.

const fs = require("fs");
const path = require("path");

const logger = require("./logger.cjs");

const { dataPath, PACKAGE_ROOT } = require("../config/paths.cjs");

// The memory files live in the data directory. An install that predates that
// keeps using its existing ./memory folder rather than silently starting empty.
const LEGACY_ROOT = path.join(PACKAGE_ROOT, "memory");
const ROOT = fs.existsSync(LEGACY_ROOT) ? LEGACY_ROOT : dataPath("memory");
const CHATS_DIR = path.join(ROOT, "chats");
const GLOBAL_FILE = path.join(ROOT, "global.md");

// Guardrails so a runaway agent can't grow the prompt without bound.
const MAX_ENTRY_CHARS = 2000;
// Read per call so the dashboard can change it without a restart.
const settings = require("../config/settings.cjs");
const maxContextChars = () => settings.get("memory_context_chars");

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function ensureDirs() {
  fs.mkdirSync(CHATS_DIR, { recursive: true });
}

/** `120363@g.us` -> a filename that is safe on every OS we might run on. */
function safeFileName(chatId) {
  return String(chatId || "unknown")
    .replace(/[^A-Za-z0-9._@-]+/g, "_")
    .slice(0, 120);
}

function normalizeScope(scope) {
  const value = String(scope || "chat").toLowerCase();
  if (["global", "عام", "all", "عالمي", "shared"].includes(value)) return "global";
  return "chat";
}

/** Absolute path of the markdown file backing a scope. */
function memoryFilePath(scope, chatId) {
  if (normalizeScope(scope) === "global") return GLOBAL_FILE;
  if (!chatId) return GLOBAL_FILE;
  return path.join(CHATS_DIR, `${safeFileName(chatId)}.md`);
}

function headerFor(scope, chatId, chatName) {
  if (normalizeScope(scope) === "global") {
    return [
      "# 🧠 الذاكرة العامة",
      "",
      "> معلومات محفوظة لكل المحادثات. ملف Markdown عادي — عدّله بإيدك وقت ما تحب.",
      "> كل سطر بيبدأ بـ `-` هو معلومة محفوظة.",
      "",
      "",
    ].join("\n");
  }
  return [
    "# 🧠 ذاكرة المحادثة",
    "",
    `<!-- chat: ${chatId || "unknown"} -->`,
    chatName ? `<!-- name: ${chatName} -->` : null,
    "",
    "> معلومات محفوظة لهذه المحادثة فقط. ملف Markdown عادي — عدّله بإيدك وقت ما تحب.",
    "> كل سطر بيبدأ بـ `-` هو معلومة محفوظة.",
    "",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function readRaw(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function writeRaw(filePath, content) {
  ensureDirs();
  fs.writeFileSync(filePath, content, "utf8");
}

// ---------------------------------------------------------------------------
// parsing
// ---------------------------------------------------------------------------

const BULLET_RE = /^\s{0,3}[-*]\s+(.*)$/;
const META_RE = /\s*<!--\s*(id:[^>]*?)\s*-->\s*$/;

function parseMeta(line) {
  const match = line.match(META_RE);
  if (!match) return { text: line, meta: {} };
  const meta = {};
  for (const pair of match[1].split(/\s+/)) {
    const idx = pair.indexOf(":");
    if (idx > 0) meta[pair.slice(0, idx)] = pair.slice(idx + 1);
  }
  return { text: line.replace(META_RE, ""), meta };
}

/**
 * Every entry in a memory file, in file order.
 * @returns {Array<{id:string, at:string, by:string, content:string, start:number, end:number}>}
 */
function parseEntries(raw) {
  const lines = raw.split("\n");
  const entries = [];
  let current = null;

  const flush = () => {
    if (!current) return;
    current.content = current.content.trim();
    if (current.content) entries.push(current);
    current = null;
  };

  lines.forEach((line, index) => {
    const bullet = line.match(BULLET_RE);
    if (bullet) {
      flush();
      const { text, meta } = parseMeta(bullet[1]);
      current = {
        id: meta.id || `m${index}`,
        at: meta.at || "",
        by: meta.by ? meta.by.replace(/_/g, " ") : "",
        content: text.trim(),
        start: index,
        end: index,
      };
      return;
    }
    // Continuation of the previous bullet (indented, non-empty).
    if (current && /^\s{2,}\S/.test(line)) {
      const { text } = parseMeta(line);
      current.content += `\n${text.trim()}`;
      current.end = index;
      return;
    }
    flush();
  });
  flush();

  return entries;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function newId() {
  return `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** All entries for a scope. Never throws — a missing file is an empty memory. */
function listMemory({ scope = "chat", chatId } = {}) {
  try {
    return parseEntries(readRaw(memoryFilePath(scope, chatId)));
  } catch (err) {
    logger.error({ err }, "[memory] failed to read memory");
    return [];
  }
}

/**
 * Append one memory entry. Appending (rather than rewriting the file) is what
 * keeps any prose the human added by hand intact.
 *
 * @returns {{id:string, content:string, scope:string, file:string}}
 */
function addMemory({ scope = "chat", chatId, content, by, chatName } = {}) {
  const normalizedScope = normalizeScope(scope);
  const text = String(content || "").trim().slice(0, MAX_ENTRY_CHARS);
  if (!text) throw new Error("مفيش محتوى أحفظه");

  const filePath = memoryFilePath(normalizedScope, chatId);
  ensureDirs();

  let raw = readRaw(filePath);
  if (!raw.trim()) raw = headerFor(normalizedScope, chatId, chatName);
  if (!raw.endsWith("\n")) raw += "\n";

  const id = newId();
  const meta = [
    `id:${id}`,
    `at:${new Date().toISOString()}`,
    by ? `by:${String(by).replace(/\s+/g, "_").slice(0, 40)}` : null,
  ]
    .filter(Boolean)
    .join(" ");

  // Multi-line facts stay one Markdown list item: continuation lines are
  // indented so parseEntries() glues them back together.
  const [first, ...rest] = text.split("\n");
  const body = [
    `- ${first.trim()} <!-- ${meta} -->`,
    ...rest.map((line) => `  ${line.trim()}`),
  ].join("\n");

  writeRaw(filePath, `${raw}${body}\n`);
  logger.info(
    { scope: normalizedScope, chatId, id },
    "[memory] saved a new entry"
  );
  return { id, content: text, scope: normalizedScope, file: filePath };
}

/**
 * Drop one entry, addressed by id, 1-based index, or a text fragment.
 * @returns {object|null} the removed entry
 */
function removeMemory({ scope = "chat", chatId, ref } = {}) {
  const filePath = memoryFilePath(scope, chatId);
  const raw = readRaw(filePath);
  if (!raw) return null;

  const entries = parseEntries(raw);
  if (!entries.length) return null;

  const needle = String(ref ?? "").trim();
  if (!needle) return null;

  let target =
    entries.find((entry) => entry.id === needle) ||
    (/^\d+$/.test(needle) ? entries[Number(needle) - 1] : null);

  if (!target) {
    const lower = needle.toLowerCase();
    target = entries.find((entry) => entry.content.toLowerCase().includes(lower));
  }
  if (!target) return null;

  const lines = raw.split("\n");
  lines.splice(target.start, target.end - target.start + 1);
  writeRaw(filePath, lines.join("\n"));
  return target;
}

/** Wipe every entry but keep whatever prose/header the file already had. */
function clearMemory({ scope = "chat", chatId } = {}) {
  const filePath = memoryFilePath(scope, chatId);
  const raw = readRaw(filePath);
  if (!raw) return 0;

  const entries = parseEntries(raw);
  if (!entries.length) return 0;

  const drop = new Set();
  for (const entry of entries) {
    for (let i = entry.start; i <= entry.end; i++) drop.add(i);
  }
  const kept = raw.split("\n").filter((_, index) => !drop.has(index));
  writeRaw(filePath, kept.join("\n"));
  return entries.length;
}

/** Case-insensitive substring search across one scope. */
function searchMemory(query, { scope = "chat", chatId } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const entries = listMemory({ scope, chatId });
  if (!needle) return entries;
  return entries.filter((entry) => entry.content.toLowerCase().includes(needle));
}

function renderEntries(entries, limitChars) {
  const lines = [];
  let used = 0;
  // Newest facts matter most, so fill from the end and restore order after.
  for (let i = entries.length - 1; i >= 0; i--) {
    const line = `- ${entries[i].content.replace(/\n/g, " ")}`;
    if (used + line.length > limitChars) break;
    used += line.length + 1;
    lines.unshift(line);
  }
  return lines.join("\n");
}

/**
 * The memory block injected into the model's system instruction.
 * Returns "" when both files are empty, so a fresh install pays nothing.
 */
function buildMemoryContext(chatId, { limitChars = maxContextChars() } = {}) {
  const globalEntries = listMemory({ scope: "global" });
  const chatEntries = chatId ? listMemory({ scope: "chat", chatId }) : [];
  if (!globalEntries.length && !chatEntries.length) return "";

  const perScope = Math.floor(limitChars / (globalEntries.length && chatEntries.length ? 2 : 1));
  const blocks = [];

  if (globalEntries.length) {
    blocks.push(
      `### ذاكرة عامة (global.md)\n${renderEntries(globalEntries, perScope)}`
    );
  }
  if (chatEntries.length) {
    blocks.push(
      `### ذاكرة المحادثة دي (${safeFileName(chatId)}.md)\n${renderEntries(
        chatEntries,
        perScope
      )}`
    );
  }

  return [
    "## 🧠 الذاكرة الدائمة",
    "دي معلومات اتحفظت قبل كده. اعتبرها حقيقة واستخدمها من غير ما تقول إنك بتقرأ من ملف.",
    "",
    ...blocks,
  ].join("\n");
}

/** Counts + file paths, for `!memory` and `!status`. */
function memoryStats(chatId) {
  const globalEntries = listMemory({ scope: "global" });
  const chatEntries = chatId ? listMemory({ scope: "chat", chatId }) : [];
  let chatFiles = 0;
  try {
    chatFiles = fs.readdirSync(CHATS_DIR).filter((f) => f.endsWith(".md")).length;
  } catch {
    chatFiles = 0;
  }
  return {
    root: ROOT,
    globalFile: GLOBAL_FILE,
    chatFile: chatId ? memoryFilePath("chat", chatId) : null,
    globalCount: globalEntries.length,
    chatCount: chatEntries.length,
    chatFiles,
  };
}

module.exports = {
  ROOT,
  CHATS_DIR,
  GLOBAL_FILE,
  ensureDirs,
  normalizeScope,
  memoryFilePath,
  listMemory,
  addMemory,
  removeMemory,
  clearMemory,
  searchMemory,
  buildMemoryContext,
  memoryStats,
  parseEntries,
};
