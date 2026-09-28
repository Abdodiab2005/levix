// A command's documentation, in the language the reader wants.
//
// `description` and `usage` on a command are either a plain string — one
// language, shown as-is in both menus — or `{ en, ar }`. localize() picks the
// requested language and falls back to the other one, so a command that ships
// only one language still appears in both.
//
// Which language: `!help ar` / `!help en` say so explicitly. Otherwise it is
// the `bot_language` setting, and when that is "auto" the script the message
// was typed in — `!help` is English, `!مساعدة` is Arabic.

const settings = require("../config/settings.cjs");

const LANGS = ["en", "ar"];

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
]);

const ARABIC_SCRIPT = /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF]/;

/** "ar" | "en" for a word like `ar`, `english`, `عربي`; null otherwise. */
function parseLang(word) {
  return (
    LANG_WORDS.get(
      String(word || "")
        .trim()
        .toLowerCase(),
    ) || null
  );
}

/**
 * The language to answer `text` in: the bot's language setting, or — when
 * that is "auto" — Arabic if the text is written in Arabic script, else
 * English.
 */
function resolveLang(text = "") {
  const setting = settings.get("bot_language");
  if (setting === "ar" || setting === "en") return setting;
  return ARABIC_SCRIPT.test(String(text)) ? "ar" : "en";
}

/** Pick `lang` out of a string or an `{ en, ar }` object. */
function localize(value, lang = "en") {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof value !== "object") return String(value);
  if (value[lang]) return value[lang];
  for (const other of LANGS) {
    if (value[other]) return value[other];
  }
  return "";
}

/** Both languages, for the dashboard (which follows its own UI language). */
function bothLanguages(value) {
  return { en: localize(value, "en"), ar: localize(value, "ar") };
}

module.exports = { LANGS, parseLang, resolveLang, localize, bothLanguages };
