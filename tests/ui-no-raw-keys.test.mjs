// Static scan: catalog keys and API-shaped ids must not render as panel text.
// The gateway has its own catalog (frontend/src/i18n/gateway.generated.ts), so
// its t() calls are not checked against i18n/*/dashboard.json.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { areaLabelKey, placeholderExplainKey } from "../frontend/src/utils/templateLabels.ts";
import { finish, ok, ROOT, section } from "./harness.mjs";

const srcDir = join(ROOT, "frontend/src");
const locales = JSON.parse(readFileSync(join(ROOT, "i18n/locales.json"), "utf8"))
  .filter((locale) => locale.required)
  .map((locale) => locale.code);
const catalogs = Object.fromEntries(
  locales.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8")),
  ]),
);

// These screens still print a storage key. They are outside this task's files.
const KNOWN_KEY_LEAKS = new Set([
  "frontend/src/views/BackupView.tsx",
  "frontend/src/views/plus/PresetsTab.tsx",
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function isTagStart(source, index) {
  const next = source[index + 1];
  return next === "/" || next === ">" || /[A-Za-z]/.test(next ?? "");
}

function endOfTag(source, index) {
  let quote = "";
  let brace = 0;
  for (let i = index + 1; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") brace += 1;
    else if (ch === "}") brace = Math.max(0, brace - 1);
    else if (ch === ">" && brace === 0) return i + 1;
  }
  return source.length;
}

/** Text and expressions that sit between tags. Attributes such as key={item.key} stay out. */
function jsxChunks(source) {
  const chunks = [];
  let i = 0;
  while (i < source.length) {
    if (source[i] === "<" && isTagStart(source, i)) {
      i = endOfTag(source, i);
      const start = i;
      while (i < source.length && !(source[i] === "<" && isTagStart(source, i))) i += 1;
      chunks.push(source.slice(start, i));
    } else {
      i += 1;
    }
  }
  return chunks;
}

function skipBrace(text, index) {
  let depth = 0;
  let quote = "";
  for (let i = index; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return text.length;
}

/** Plain JSX text, plus string literals inside expressions. Property paths are not text. */
function visibleJsx(chunk) {
  const pieces = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === "{") {
      const end = skipBrace(chunk, i);
      const expr = chunk.slice(i + 1, Math.max(i + 1, end - 1));
      for (const match of expr.matchAll(/(["'`])([\s\S]*?)\1/g)) pieces.push(match[2]);
      i = end;
    } else {
      const start = i;
      while (i < chunk.length && chunk[i] !== "{") i += 1;
      pieces.push(chunk.slice(start, i));
    }
  }
  return pieces.join("\n");
}

const files = walk(srcDir);
const tsxFiles = files.filter((file) => file.endsWith(".tsx"));
ok("frontend tsx files exist", tsxFiles.length > 0);

const renderedKey = /\.key\s*\}/;
const dottedKey = /\b(?:bot|reaction|plus)[A-Za-z]*\.[a-z]+\.[a-zA-Z.]+/;

section("JSX text does not render a template key");
for (const file of tsxFiles) {
  const rel = relative(ROOT, file);
  if (KNOWN_KEY_LEAKS.has(rel)) continue;
  const source = stripComments(readFileSync(file, "utf8"));
  const chunks = jsxChunks(source);
  const between = chunks.join("\n");
  const visible = chunks.map(visibleJsx).join("\n");
  ok(`${rel} does not render .key in JSX text`, !renderedKey.test(between));
  ok(`${rel} does not render a dotted catalog id`, !dottedKey.test(visible));
}

section("message templates keep the key off the screen");
for (const rel of [
  "frontend/src/views/plus/MessagesTab.tsx",
  "frontend/src/views/plus/TemplateEditor.tsx",
]) {
  const source = stripComments(readFileSync(join(ROOT, rel), "utf8"));
  const between = jsxChunks(source).join("\n");
  ok(`${rel} does not render .key`, !renderedKey.test(between));
}

section("literal t() keys exist in every required dashboard locale");
const keyPattern = /\bt\(\s*(["'])([A-Za-z][A-Za-z0-9_]*)\1/g;
const used = new Set();
for (const file of files) {
  const rel = relative(ROOT, file);
  if (rel.startsWith("frontend/src/gateway/")) continue;
  const text = stripComments(readFileSync(file, "utf8"));
  for (const match of text.matchAll(keyPattern)) used.add(match[2]);
}
ok("panel source calls t()", used.size > 0);
for (const key of [...used].sort()) {
  for (const locale of locales) {
    const value = catalogs[locale][key];
    ok(
      `${locale} has ${key}`,
      Object.hasOwn(catalogs[locale], key) && typeof value === "string" && value.length > 0,
    );
  }
}

section("template area and placeholder labels exist in every required locale");
const labelKeys = new Set([
  ...["ai", "core", "group", "help", "lang", "moderation", "schedules", "stickers", "tools", "other"].map(
    (area) => areaLabelKey(area === "other" ? "bot.unknown.x" : `bot.${area}.x`),
  ),
  ...["count", "name", "user", "group", "n", "emoji", "prefix", "command", "slot"].map((name) =>
    placeholderExplainKey(name),
  ),
  "plusMessagesCustomized",
  "plusMessagesNoPreview",
  "plusMessagesShowFull",
  "plusMessagesShowLess",
  "plusMessagesDefault",
  "plusCharactersUsed",
  "plusResetDefault",
  "commandUpdateFailed",
  "commandPermissionUnknown",
  "commandScopeUnknown",
]);
ok("area helper returns ten keys", new Set(
  ["ai", "core", "group", "help", "lang", "moderation", "schedules", "stickers", "tools", "other"].map(
    (area) => areaLabelKey(area === "other" ? "bot.unknown.x" : `bot.${area}.ping`),
  ),
).size === 10);
for (const key of labelKeys) {
  for (const locale of locales) {
    const value = catalogs[locale][key];
    ok(
      `${locale} has ${key}`,
      typeof value === "string" && value.length > 0,
      value,
    );
  }
}

finish();
