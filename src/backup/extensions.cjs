// The Levix Plus data a backup may carry. An explicit allowlist: the message
// overrides, the presets and the visibility choices (settings, restored with
// them) and the Auto Reply account data (restored only after the same WhatsApp
// account is paired). Every `plus:*` key and every other `ext:*` key stays out.
const { isCustomizable } = require("../extensions/templateKeys.cjs");
const { BackupError } = require("./format.cjs");

const EXT_ID = "levix-plus";
const CFG_PREFIX = `ext:${EXT_ID}:cfg:`;
const ACCT_PREFIX = `ext:${EXT_ID}:acct:`;
const CFG_FIXED = Object.freeze(["presets", "visibility"]);
const ACCT_NAMES = Object.freeze(["autoReply"]);
const NAME_RE = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
// Same limits as the extension storage in store.cjs.
const VALUE_MAX_BYTES = 64 * 1024;
const MAX_NAMES = 200;
const MAX_DEPTH = 8;
const DANGEROUS = Object.freeze(["__proto__", "constructor", "prototype"]);

/** "cfg" | "acct" | null. Null for anything that is not an allowlisted Plus key. */
function kindOf(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith(CFG_PREFIX)) {
    const name = key.slice(CFG_PREFIX.length);
    if (!NAME_RE.test(name)) return null;
    return CFG_FIXED.includes(name) || isCustomizable(name) ? "cfg" : null;
  }
  if (key.startsWith(ACCT_PREFIX)) return ACCT_NAMES.includes(key.slice(ACCT_PREFIX.length)) ? "acct" : null;
  return null;
}
const isRestorableExtKey = (key) => kindOf(key) !== null;
/** The key without the extension prefix, e.g. `cfg:presets`. */
const shortName = (key) => key.slice(`ext:${EXT_ID}:`.length);

function refuse(message) { return new BackupError("DAMAGED", message); }

/** Parse one stored value. Throws BackupError DAMAGED unless it is a safe plain object. */
function validateExtValue(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > VALUE_MAX_BYTES)
    throw refuse("Invalid extension value");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw refuse("Invalid extension value"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw refuse("Invalid extension value");
  const stack = [[parsed, 1]];
  while (stack.length) {
    const [value, depth] = stack.pop();
    if (depth > MAX_DEPTH) throw refuse("Invalid extension value");
    for (const [name, child] of Array.isArray(value) ? value.entries() : Object.entries(value)) {
      if (!Array.isArray(value) && DANGEROUS.includes(name)) throw refuse("Invalid extension value");
      if (child && typeof child === "object") stack.push([child, depth + 1]);
    }
  }
  return parsed;
}

/** The stored text a value gets when written back, so digests compare by content. */
function canonicalValue(raw) {
  try { return JSON.stringify(JSON.parse(raw)); } catch { return String(raw); }
}

/** Allowlisted rows in `schema`.bot_settings (value null when over the size limit). */
function allowedRows(database, schema = "main") {
  if (schema !== "main" && schema !== "pending") throw new Error("Invalid schema name");
  const prefix = `ext:${EXT_ID}:`;
  return database.prepare(`SELECT key,
    CASE WHEN length(CAST(value AS BLOB)) <= ${VALUE_MAX_BYTES} THEN value ELSE NULL END AS value
    FROM ${schema}.bot_settings WHERE key >= ? AND key < ?`).all(prefix, `${prefix}\uFFFF`)
    .filter((row) => isRestorableExtKey(row.key));
}

/** Allowlisted rows whose value passes validateExtValue; the rest are dropped. */
function validRows(database, schema = "main") {
  const result = [];
  for (const { key, value } of allowedRows(database, schema)) {
    try { result.push({ key, value, parsed: validateExtValue(value) }); } catch { /* skipped */ }
  }
  return result;
}

/** Refuse a staged database that holds any other ext: key or an invalid or too many Plus values. */
function assertStagedExtensions(database, keys) {
  const counts = { cfg: 0, acct: 0 };
  for (const key of keys) {
    const kind = kindOf(key);
    if (!kind) throw refuse("Backup database holds excluded data");
    if (++counts[kind] > MAX_NAMES) throw refuse("Backup database holds too many extension values");
  }
  if (!keys.length) return;
  for (const { value } of allowedRows(database)) validateExtValue(value);
}

/** Ask the extension host to reload stored config. Best effort; never throws. */
function reloadHost() {
  try {
    const result = require("../extensions/host.cjs").reloadExtensions();
    Promise.resolve(result).catch(() => {});
  } catch { /* Plus is optional */ }
}

module.exports = { EXT_ID, VALUE_MAX_BYTES, MAX_NAMES, isRestorableExtKey, kindOf, shortName,
  validateExtValue, canonicalValue, allowedRows, validRows, assertStagedExtensions, reloadHost };
