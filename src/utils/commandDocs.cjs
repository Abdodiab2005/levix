// Command documentation is stored in the generated catalog. Module-owned
// documentation takes precedence for commands added outside the catalog.
const catalog = require("../i18n/catalog.generated.cjs");

const LANGS = ["en", "ar", "pt-BR", "es-419"];

// Words accepted after !help to pick a language.
const LANG_WORDS = new Map([
  ["en", "en"],
  ["english", "en"],
  ["eng", "en"],
  ["انجليزي", "en"],
  ["إنجليزي", "en"],
  ["انجليزى", "en"],
  ["الانجليزية", "en"],
  ["الإنجليزية", "en"],
  ["ar", "ar"],
  ["arabic", "ar"],
  ["عربي", "ar"],
  ["عربى", "ar"],
  ["العربية", "ar"],
  ["pt", "pt-BR"],
  ["pt-br", "pt-BR"],
  ["português", "pt-BR"],
  ["portugues", "pt-BR"],
  ["portuguese", "pt-BR"],
  ["es", "es-419"],
  ["es-419", "es-419"],
  ["español", "es-419"],
  ["espanol", "es-419"],
  ["spanish", "es-419"],
]);

/** Resolve a language word after !help, or return null. */
function parseLang(word) {
  return (
    LANG_WORDS.get(
      String(word || "")
        .trim()
        .toLowerCase(),
    ) || null
  );
}

/** Pick a locale, then English, then Arabic. */
function localize(value, lang = "en") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (value[lang]) return value[lang];
  return value.en || value.ar || "";
}

function allLanguages(value) {
  return Object.fromEntries(LANGS.map((lang) => [lang, localize(value, lang)]));
}

function attachCommandDocs(command, category = null) {
  if (!command?.name) return command;
  const key = category === "group" ? `group.${command.name}` : command.name;
  for (const field of ["description", "usage"]) {
    if (Object.hasOwn(command, field)) continue;
    const messageKey = `commands.${key}.${field}`;
    const english = catalog.messages.en?.[messageKey];
    if (english === undefined) continue;
    command[field] = Object.fromEntries(
      LANGS.map((lang) => [lang, catalog.messages[lang]?.[messageKey] ?? english]),
    );
  }
  return command;
}

module.exports = {
  LANGS,
  parseLang,
  localize,
  allLanguages,
  bothLanguages: allLanguages,
  attachCommandDocs,
};
