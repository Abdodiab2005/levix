// Which bot.* catalog keys Plus may rewrite. English string entries only;
// plural objects are never customizable.

const catalog = require("../i18n/catalog.generated.cjs");
const { hasForbiddenChars } = require("../messaging/escape.cjs");

const ALLOWED_AREAS = new Set(["ai", "core", "schedules", "stickers", "tools", "help", "group"]);
const CORE_ALLOWED = new Set(["status", "restart", "stopbot"]);
const DENY_RE =
  /owner(Only)?|noPermission|denied|forbidden|notAllowed|permission|security|password|reset|consent|legal|terms|privacy|route|unauthori|blocked|warn|kick|ban|flag|limit/i;

const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const MAX_OVERRIDE_CHARS = 1000;

function englishValue(key) {
  return catalog.messages?.en?.[key];
}

function isCustomizable(key) {
  if (typeof key !== "string" || !key.startsWith("bot.")) return false;
  if (typeof englishValue(key) !== "string") return false;
  if (key.startsWith("bot.moderation.")) return false;
  if (key.startsWith("bot.core.message.")) return false;
  if (DENY_RE.test(key)) return false;
  const parts = key.split(".");
  const area = parts[1];
  if (!ALLOWED_AREAS.has(area)) return false;
  if (area === "core" && !CORE_ALLOWED.has(parts[2])) return false;
  return true;
}

let cachedKeys = null;
function customizableKeys() {
  if (!cachedKeys) {
    cachedKeys = Object.freeze(
      Object.keys(catalog.messages?.en || {}).filter((key) => isCustomizable(key)),
    );
  }
  return cachedKeys;
}

function placeholders(key) {
  const value = englishValue(key);
  if (typeof value !== "string") return [];
  const names = [];
  const seen = new Set();
  for (const match of value.matchAll(PLACEHOLDER_RE)) {
    if (!seen.has(match[1])) {
      seen.add(match[1]);
      names.push(match[1]);
    }
  }
  return names;
}

function catalogTemplate(key, locale) {
  const messages = catalog.messages || {};
  const value = messages[locale]?.[key] ?? messages.en?.[key];
  return typeof value === "string" ? value : null;
}

function validateOverride(key, text) {
  if (!isCustomizable(key)) return { ok: false, reason: "key" };
  if (typeof text !== "string") return { ok: false, reason: "type" };
  if (text.length > MAX_OVERRIDE_CHARS) return { ok: false, reason: "length" };
  if (hasForbiddenChars(text)) return { ok: false, reason: "chars" };
  const allowed = new Set(placeholders(key));
  for (const match of text.matchAll(PLACEHOLDER_RE)) {
    if (!allowed.has(match[1])) return { ok: false, reason: "placeholder" };
  }
  return { ok: true };
}

module.exports = {
  isCustomizable,
  customizableKeys,
  placeholders,
  catalogTemplate,
  validateOverride,
  MAX_OVERRIDE_CHARS,
};
