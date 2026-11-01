// The generated translations module is the contract. locale.ts is TypeScript,
// so this file checks that output and the source patterns around it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

section("generated translations");

const generated = readFileSync(join(ROOT, "frontend/src/i18n/translations.ts"), "utf8");
const locales = JSON.parse(readFileSync(join(ROOT, "i18n/locales.json"), "utf8"));
const codes = locales.map((locale) => locale.code);
const union = generated.match(/export type Language = ([^;]+);/);
ok("Language union is declared", Boolean(union));
equal(
  "Language union lists the registry",
  union && union[1],
  codes.map((code) => JSON.stringify(code)).join(" | "),
);

const localesBlock = generated.slice(generated.indexOf("export const LOCALES"));
const entries = [
  ...localesBlock.matchAll(/\{ code: ("[^"]+"), name: ("(?:\\.|[^"\\])*"), dir: ("ltr"|"rtl") \}/g),
];
equal("LOCALES has one entry per registry locale", entries.length, locales.length);
locales.forEach((locale, index) => {
  const entry = entries[index];
  const dir = locale.dir === "rtl" ? "rtl" : "ltr";
  equal(`${locale.code} code`, entry && JSON.parse(entry[1]), locale.code);
  equal(`${locale.code} name`, entry && JSON.parse(entry[2]), locale.name);
  equal(`${locale.code} dir`, entry && JSON.parse(entry[3]), dir);
});

for (const locale of locales) {
  const dashboard = join(ROOT, "i18n", locale.code, "dashboard.json");
  if (existsSync(dashboard)) continue;
  const key = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(locale.code)
    ? locale.code
    : JSON.stringify(locale.code);
  ok(`${locale.code} has no dashboard catalog`, generated.includes(`\n  ${key}: {},`));
}

section("no two-language assumptions in the panel");

const allowTernary = new Set([
  join(ROOT, "frontend/src/context/I18nContext.tsx"),
  join(ROOT, "frontend/src/i18n/locale.ts"),
]);
const ternary = [/language === "ar" \?/, /language === "en" \?/];
const guards = [/=== "ar" \|\|/, /"ar" \|\| "en"/];

function filesUnder(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(path, out);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(path);
  }
  return out;
}

const hits = [];
for (const file of filesUnder(join(ROOT, "frontend/src"))) {
  const text = readFileSync(file, "utf8");
  const relative = file.slice(ROOT.length + 1);
  if (!allowTernary.has(file)) {
    for (const pattern of ternary) {
      if (pattern.test(text)) hits.push(`${relative} ${pattern}`);
    }
  }
  for (const pattern of guards) {
    if (pattern.test(text)) hits.push(`${relative} ${pattern}`);
  }
}
ok("panel source has no two-language language guard", hits.length === 0, hits.join("\n"));

finish();
