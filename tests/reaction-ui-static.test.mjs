import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const viewsDir = join(ROOT, "frontend/src/views/reactions");
const catalogPath = join(ROOT, "i18n/en/dashboard.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function filesUnder(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => join(dir, name));
}

const files = filesUnder(viewsDir);
const relativePath = (file) => relative(ROOT, file);
ok("reaction view files exist", files.length > 0, files.join(", "));

const keyPattern = /\bt\(\s*(["'])([A-Za-z][A-Za-z0-9]*)\1/g;
const layoutPattern = /\b(?:ml|mr|pl|pr|left|right)-|\btext-(?:left|right)\b/;
const hexPattern = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
const palettePattern =
  /\b(?:text|bg|border)-(?:red|slate|gray|zinc|neutral|stone|blue|green|yellow|amber|orange|pink|purple|indigo|rose|teal|cyan|sky|violet|fuchsia|lime|emerald)-\d{2,3}\b/;
const importPattern = /\bfrom\s+["']([^"']+)["']/g;

section("t() keys exist in i18n/en/dashboard.json");
const used = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(keyPattern)) used.add(match[2]);
}
equal("views use t() keys", used.size > 0, true);
for (const key of [...used].sort()) {
  ok(`${key} is in en/dashboard.json`, Object.hasOwn(catalog, key));
}

section("no physical-direction classes, hex colours, or one-off palettes");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relative = relativePath(file);
  ok(`${relative} has no ml/mr/pl/pr/left/right layout classes`, !layoutPattern.test(text));
  ok(`${relative} has no raw hex colours`, !hexPattern.test(text));
  ok(`${relative} has no text-red/bg-slate palettes`, !palettePattern.test(text));
}

section("UI primitives import from the barrel");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relative = relativePath(file);
  for (const match of text.matchAll(importPattern)) {
    const source = match[1];
    if (!source.includes("components/ui")) continue;
    equal(`${relative} UI import ${source}`, source, "../../components/ui");
  }
}

section("automation toggle is single-flight; sort is recent activity");
{
  const view = readFileSync(join(viewsDir, "ReactionRulesView.tsx"), "utf8");
  ok(
    "automation Toggle passes disabled=",
    /<Toggle\s+checked=\{automation\}[\s\S]*?disabled=\{[^}]+\}[\s\S]*?\/>/.test(view),
  );
  ok("view has no reactionSortNewest", !view.includes("reactionSortNewest"));
  ok('view has no "newest" sort value', !view.includes('"newest"'));
  for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
    const json = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
    ok(`${locale} has reactionSortRecent`, Object.hasOwn(json, "reactionSortRecent"));
    ok(`${locale} has no reactionSortNewest`, !Object.hasOwn(json, "reactionSortNewest"));
  }
}

finish();
