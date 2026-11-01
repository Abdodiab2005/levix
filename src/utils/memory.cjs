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
const { fsyncDirectory } = require("../db/db.cjs");

// The active root is always <data>/memory, so a backup of the data directory
// includes the AI memory. An older install that still has files in
// PACKAGE_ROOT/memory is copied into the data directory once, on first
// memory access — never at require() time, because a copy failure must not
// crash the process during module load. The copy never writes back to the
// legacy folder (a packaged or global install may have it read-only).
const LEGACY_ROOT = path.join(PACKAGE_ROOT, "memory");
const ROOT = dataPath("memory");
const CHATS_DIR = path.join(ROOT, "chats");
const GLOBAL_FILE = path.join(ROOT, "global.md");
// Present after a successful copy, and after unlink, so a later pairing
// cannot import the previous account's PACKAGE_ROOT/memory. Not a memory file.
const LEGACY_COPY_MARKER = ".legacy-copied";
// Present for the duration of an in-place copy so a crash mid-loop can resume
// instead of looking like a conflict. Not a memory file.
const LEGACY_COPYING_MARKER = ".legacy-copying";

// Guardrails so a runaway agent can't grow the prompt without bound.
const MAX_ENTRY_CHARS = 2000;
// Read per call so the dashboard can change it without a restart.
const settings = require("../config/settings.cjs");
const { t } = require("./i18n.cjs");
const maxContextChars = () => settings.get("memory_context_chars");

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------

function ensureDirs() {
  maybeMigrateLegacy();
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
  maybeMigrateLegacy();
  if (normalizeScope(scope) === "global") return GLOBAL_FILE;
  if (!chatId) return GLOBAL_FILE;
  return path.join(CHATS_DIR, `${safeFileName(chatId)}.md`);
}

function headerFor(scope, chatId, chatName) {
  if (normalizeScope(scope) === "global") {
    return [
      "# 🧠 الذاكرة العامة",
      "",
      "> معلومات محفوظة لكل المحادثات. ملف Markdown عادي — يمكنك تعديله يدويًا في أي وقت.",
      "> كل سطر يبدأ بـ `-` يمثّل معلومة محفوظة.",
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
    "> معلومات محفوظة لهذه المحادثة فقط. ملف Markdown عادي — يمكنك تعديله يدويًا في أي وقت.",
    "> كل سطر يبدأ بـ `-` يمثّل معلومة محفوظة.",
    "",
    "",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

function readRaw(filePath) {
  maybeMigrateLegacy();
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
// legacy copy (PACKAGE_ROOT/memory -> <data>/memory)
// ---------------------------------------------------------------------------

let legacyCopyAttempted = false;

function emitLog(log, level, obj, msg) {
  if (!log || typeof log[level] !== "function") return;
  try {
    log[level](obj, msg);
  } catch {
    // A log sink must not fail a copy or a skip.
  }
}

function legacyCopyMarkerPath(dir) {
  return path.join(dir, LEGACY_COPY_MARKER);
}

function hasLegacyCopyMarker(dir) {
  try {
    fs.lstatSync(legacyCopyMarkerPath(dir));
    return true;
  } catch {
    return false;
  }
}

function writeLegacyCopyMarker(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const marker = legacyCopyMarkerPath(dir);
  fs.writeFileSync(marker, "", "utf8");
  const fd = fs.openSync(marker, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // Copied first, then drop the in-progress marker, so a crash between the
  // two still skips on the next start instead of looking like a conflict.
  removeLegacyCopyingMarker(dir);
  fsyncDirectory(dir);
}

function legacyCopyingMarkerPath(dir) {
  return path.join(dir, LEGACY_COPYING_MARKER);
}

function hasLegacyCopyingMarker(dir) {
  try {
    fs.lstatSync(legacyCopyingMarkerPath(dir));
    return true;
  } catch {
    return false;
  }
}

function writeLegacyCopyingMarker(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(legacyCopyingMarkerPath(dir), "", "utf8");
}

function removeLegacyCopyingMarker(dir) {
  try {
    fs.unlinkSync(legacyCopyingMarkerPath(dir));
  } catch {
    // Already gone, or the in-place path never wrote it.
  }
}

/** Writes `.legacy-copied` so a later migrate will not import PACKAGE_ROOT/memory. */
function markLegacyMemoryHandled(dir = ROOT) {
  writeLegacyCopyMarker(dir);
}

function isRegularMarkdownFile(filePath) {
  if (!String(filePath).endsWith(".md")) return false;
  try {
    const st = fs.lstatSync(filePath);
    return st.isFile() && !st.isSymbolicLink();
  } catch {
    return false;
  }
}

function isLiveMemoryMarkdownName(name) {
  return (
    name.endsWith(".md") && name !== LEGACY_COPY_MARKER && name !== LEGACY_COPYING_MARKER
  );
}

function listMarkdownMemoryFiles(root) {
  const files = [];
  if (!root) return files;

  if (isRegularMarkdownFile(path.join(root, "global.md"))) {
    files.push("global.md");
  }

  const chatsDir = path.join(root, "chats");
  try {
    const st = fs.lstatSync(chatsDir);
    if (st.isSymbolicLink() || !st.isDirectory()) return files;
  } catch {
    return files;
  }

  let names = [];
  try {
    names = fs.readdirSync(chatsDir);
  } catch {
    return files;
  }

  for (const name of names) {
    if (!isLiveMemoryMarkdownName(name)) continue;
    if (isRegularMarkdownFile(path.join(chatsDir, name))) {
      files.push(path.join("chats", name));
    }
  }
  return files;
}

function siblingCopyPrefix(dataMemoryDir) {
  return `${path.basename(dataMemoryDir)}.legacy-copy-`;
}

function removeSiblingCopyTemps(dataMemoryDir) {
  const parent = path.dirname(dataMemoryDir);
  const prefix = siblingCopyPrefix(dataMemoryDir);
  let names = [];
  try {
    names = fs.readdirSync(parent);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(parent, name), { recursive: true, force: true });
    } catch {
      // Best effort; the copy may still succeed.
    }
  }
}

function removeInPlaceCopyTemps(dataMemoryDir) {
  const dirs = [dataMemoryDir, path.join(dataMemoryDir, "chats")];
  for (const dir of dirs) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.includes(".legacy-copy-")) continue;
      try {
        fs.rmSync(path.join(dir, name), { force: true });
      } catch {
        // Best effort; the copy may still succeed.
      }
    }
  }
}

function copyIntoNewDir(dataMemoryDir, legacyDir, files) {
  const tmpDir = path.join(
    path.dirname(dataMemoryDir),
    `${siblingCopyPrefix(dataMemoryDir)}${process.pid}`,
  );
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.mkdirSync(tmpDir, { recursive: true });
  try {
    for (const rel of files) {
      const dest = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(legacyDir, rel), dest);
    }
    writeLegacyCopyMarker(tmpDir);
    fs.renameSync(tmpDir, dataMemoryDir);
  } catch (err) {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // The original error is the one the caller needs.
    }
    throw err;
  }
}

function destPathExists(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function copyIntoExistingDir(dataMemoryDir, legacyDir, files, { afterFile } = {}) {
  fs.mkdirSync(dataMemoryDir, { recursive: true });
  // Before the first file, so a crash mid-loop resumes instead of conflicting.
  writeLegacyCopyingMarker(dataMemoryDir);
  for (const rel of files) {
    const dest = path.join(dataMemoryDir, rel);
    if (destPathExists(dest)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = path.join(
      path.dirname(dest),
      `.${path.basename(dest)}.legacy-copy-${process.pid}`,
    );
    try {
      fs.copyFileSync(path.join(legacyDir, rel), tmp);
      fs.renameSync(tmp, dest);
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // The original error is the one the caller needs.
      }
      throw err;
    }
    // Test hook: throw after a committed file to simulate a crash. Production
    // never passes afterFile.
    if (typeof afterFile === "function") afterFile(rel);
  }
  writeLegacyCopyMarker(dataMemoryDir);
}

/**
 * Decide whether a PACKAGE_ROOT/memory tree should be copied into the data
 * directory. Pure: no writes. Tests pass temp folders so they never touch
 * the real install.
 *
 * @returns {{action: "copy"|"skip"|"conflict", reason: string, files: string[]}}
 */
function planLegacyMemoryCopy({ dataMemoryDir, legacyDir } = {}) {
  if (hasLegacyCopyMarker(dataMemoryDir)) {
    return { action: "skip", reason: "marker", files: [] };
  }
  const destFiles = listMarkdownMemoryFiles(dataMemoryDir);
  const srcFiles = listMarkdownMemoryFiles(legacyDir);
  if (hasLegacyCopyingMarker(dataMemoryDir)) {
    const destSet = new Set(destFiles);
    const missing = srcFiles.filter((rel) => !destSet.has(rel));
    return { action: "copy", reason: "resume", files: missing };
  }
  if (srcFiles.length && destFiles.length) {
    return { action: "conflict", reason: "both", files: srcFiles };
  }
  if (!srcFiles.length) {
    return { action: "skip", reason: "no-legacy", files: [] };
  }
  return { action: "copy", reason: "legacy-only", files: srcFiles };
}

function migrateLegacyMemory({ dataMemoryDir, legacyDir, log, afterFile } = {}) {
  const plan = planLegacyMemoryCopy({ dataMemoryDir, legacyDir });
  if (plan.action === "conflict") {
    emitLog(
      log,
      "warn",
      { legacy: legacyDir, data: dataMemoryDir },
      `[memory] ${legacyDir} still holds memory files; using ${dataMemoryDir}. Merge by hand if needed.`,
    );
    return { ...plan, copied: false };
  }
  if (plan.action !== "copy") {
    return { ...plan, copied: false };
  }

  try {
    removeSiblingCopyTemps(dataMemoryDir);
    if (fs.existsSync(dataMemoryDir)) {
      removeInPlaceCopyTemps(dataMemoryDir);
      copyIntoExistingDir(dataMemoryDir, legacyDir, plan.files, { afterFile });
    } else {
      copyIntoNewDir(dataMemoryDir, legacyDir, plan.files);
    }
    emitLog(
      log,
      "info",
      { from: legacyDir, to: dataMemoryDir, files: plan.files.length },
      `[memory] copied ${plan.files.length} file(s) from ${legacyDir} into ${dataMemoryDir}`,
    );
    return { ...plan, copied: true };
  } catch (err) {
    emitLog(
      log,
      "error",
      { err, from: legacyDir, to: dataMemoryDir },
      "[memory] failed to copy legacy memory; continuing with the data directory",
    );
    return { ...plan, copied: false };
  }
}

function maybeMigrateLegacy() {
  if (legacyCopyAttempted) return;
  legacyCopyAttempted = true;
  try {
    migrateLegacyMemory({
      dataMemoryDir: ROOT,
      legacyDir: LEGACY_ROOT,
      log: logger,
    });
  } catch (err) {
    logger.error({ err }, "[memory] legacy copy failed");
  }
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
  const text = String(content || "")
    .trim()
    .slice(0, MAX_ENTRY_CHARS);
  if (!text) throw new Error(t("bot.ai.memoryStore.nothingToSave"));

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
  logger.info({ scope: normalizedScope, chatId, id }, "[memory] saved a new entry");
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

/**
 * Remove account-derived AI memory when the WhatsApp account is unlinked.
 * A later pairing is a different security principal, so neither chat files nor
 * global facts may silently cross that account boundary.
 */
function clearAllMemoryFiles() {
  // Unlink is an account boundary. Record that the copy is done before
  // deleting .md files, so a later access cannot import PACKAGE_ROOT/memory
  // from the previous account.
  try {
    fs.mkdirSync(ROOT, { recursive: true });
    writeLegacyCopyMarker(ROOT);
  } catch (err) {
    logger.warn({ err }, "[memory] failed to write the unlink memory marker");
  }

  maybeMigrateLegacy();

  let removed = 0;
  try {
    if (fs.existsSync(GLOBAL_FILE)) {
      fs.unlinkSync(GLOBAL_FILE);
      removed += 1;
    }
  } catch (err) {
    logger.warn({ err }, "[memory] failed to remove global memory during unlink");
  }

  try {
    if (fs.existsSync(CHATS_DIR)) {
      for (const name of fs.readdirSync(CHATS_DIR)) {
        if (!isLiveMemoryMarkdownName(name)) continue;
        const filePath = path.join(CHATS_DIR, name);
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        fs.unlinkSync(filePath);
        removed += 1;
      }
    }
  } catch (err) {
    logger.warn({ err }, "[memory] failed to remove chat memory during unlink");
  }

  try {
    writeLegacyCopyMarker(ROOT);
  } catch (err) {
    logger.warn({ err }, "[memory] failed to write the unlink memory marker");
  }
  return removed;
}

/** Case-insensitive substring search across one scope. */
function searchMemory(query, { scope = "chat", chatId } = {}) {
  const needle = String(query || "")
    .trim()
    .toLowerCase();
  const entries = listMemory({ scope, chatId });
  if (!needle) return entries;
  return entries.filter((entry) => entry.content.toLowerCase().includes(needle));
}

/**
 * The meaningful content of one memory file: the bot's entries AND any prose
 * the operator wrote by hand (dashboard editor or a text editor). Entry
 * metadata rides in trailing HTML comments and the file's own header/notes
 * start with `#` or `>` — both are stripped; everything else is injected
 * verbatim, so an edit made from the panel reaches the model the way it was
 * written. Returns "" for a file with nothing to say.
 */
function memoryFileContext(raw) {
  const lines = String(raw || "")
    .split("\n")
    .map((line) => line.replace(/<!--.*?-->/g, "").trimEnd())
    .filter((line) => line.trim() && !line.startsWith("#") && !line.startsWith(">"));
  return lines.join("\n").trim();
}

/** Keep the tail of a block (newest entries are appended at the bottom), cut on a line boundary. */
function clipTail(text, limitChars) {
  if (text.length <= limitChars) return text;
  const kept = text.slice(-Math.max(1, limitChars));
  const firstNewline = kept.indexOf("\n");
  return firstNewline === -1 ? kept : kept.slice(firstNewline + 1);
}

/**
 * The memory block injected into the model's system instruction.
 * Returns "" when both files are empty, so a fresh install pays nothing.
 *
 * Both scopes are injected in full (prose included), each capped at half the
 * character budget when both have content so one busy file can't starve the
 * other.
 */
function buildMemoryContext(chatId, { limitChars = maxContextChars() } = {}) {
  const globalText = memoryFileContext(readRaw(GLOBAL_FILE));
  const chatText = chatId ? memoryFileContext(readRaw(memoryFilePath("chat", chatId))) : "";
  if (!globalText && !chatText) return "";

  const perScope = Math.floor(limitChars / (globalText && chatText ? 2 : 1));
  const blocks = [];

  if (globalText) {
    blocks.push(`### ذاكرة عامة (global.md)\n${clipTail(globalText, perScope)}`);
  }
  if (chatText) {
    blocks.push(
      `### ذاكرة هذه المحادثة (${safeFileName(chatId)}.md)\n${clipTail(chatText, perScope)}`,
    );
  }

  return [
    "## 🧠 الذاكرة الدائمة",
    "هذه معلومات حُفظت سابقًا. الأسطر التي تبدأ بـ `-` أضافها البوت أو مالكه، وأي نص حر كتبه مالك البوت يدويًا. تعامل مع هذه المعلومات بوصفها حقائق، واستخدمها دون الإشارة إلى أنك تقرؤها من ملف.",
    "",
    ...blocks,
  ].join("\n");
}

/** Counts + file paths, for `!memory` and `!status`. */
function memoryStats(chatId) {
  maybeMigrateLegacy();
  const globalEntries = listMemory({ scope: "global" });
  const chatEntries = chatId ? listMemory({ scope: "chat", chatId }) : [];
  let chatFiles = 0;
  try {
    chatFiles = fs.readdirSync(CHATS_DIR).filter((f) => isLiveMemoryMarkdownName(f)).length;
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
  // Getters so the dashboard's first read of GLOBAL_FILE / ROOT still runs
  // the copy: those routes write files themselves and never call ensureDirs.
  get ROOT() {
    maybeMigrateLegacy();
    return ROOT;
  },
  get CHATS_DIR() {
    maybeMigrateLegacy();
    return CHATS_DIR;
  },
  get GLOBAL_FILE() {
    maybeMigrateLegacy();
    return GLOBAL_FILE;
  },
  LEGACY_COPY_MARKER,
  LEGACY_COPYING_MARKER,
  ensureDirs,
  normalizeScope,
  memoryFilePath,
  listMemory,
  addMemory,
  removeMemory,
  clearMemory,
  clearAllMemoryFiles,
  searchMemory,
  buildMemoryContext,
  memoryStats,
  parseEntries,
  planLegacyMemoryCopy,
  migrateLegacyMemory,
  markLegacyMemoryHandled,
};
