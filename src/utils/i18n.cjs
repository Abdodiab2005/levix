// The language the bot answers in.
//
// Every reply is written in both languages where it is sent —
// `tr("Done.", "تم.")` — and tr() picks one for the message being answered.
// The choice is made once per incoming message, before any handler runs, and
// AsyncLocalStorage carries it through everything that message causes: the
// helpers deep inside a command, the status line it edits, a timer it starts.
// Nothing has to pass a `lang` argument around.
//
//   bot_language = ar | en   that language, always
//   bot_language = auto      the language the message is written in:
//                            Arabic letters          -> Arabic
//                            English words, other than the command's own
//                            syntax (`add`, `on`, `list`, ...) -> English
//                            a bare command (`!ping`, `!kick @x`) -> Arabic
//
// A bare command carries no language of its own, and Arabic is what the bot
// has always answered in, so an operator on the default setting sees no change
// until someone actually writes to it in English. Outside any message (a
// scheduled send, a member joining a group) there is nothing to detect, and
// auto means Arabic there too.

const { AsyncLocalStorage } = require("node:async_hooks");
const settings = require("../config/settings.cjs");

const scope = new AsyncLocalStorage();

const ARABIC_LETTERS = /[\u0621-\u064A\u0671-\u06D3\u06FA-\u06FF]/;
const LATIN_WORD = /[a-z][a-z'’-]*/gi;
// A whole token made of letters. `3fa85f64-…` (an id), `2d6`, `10pm` are not
// words in any language.
const ENGLISH_WORD = /^[a-z][a-z'’-]*[a-z]$/i;
const TOKEN_EDGES = /^[\s.,!?:;()"'`[\]{}<>|*_~]+|[\s.,!?:;()"'`[\]{}<>|*_~]+$/g;
// Not language: links, mentions, e-mail addresses.
const NOT_WORDS = /(?:https?:\/\/|www\.)\S+|\S+@\S+|@\S+/gi;

/** The configured language, or null for "auto". */
function configuredLang() {
  const setting = settings.get("bot_language");
  return setting === "ar" || setting === "en" ? setting : null;
}

/**
 * The language to answer `text` in.
 *
 * @param {string} text   what the person wrote (for a command: the part after
 *                        the command name)
 * @param {object} [options]
 * @param {Iterable<string>} [options.syntax] words that are the command's own
 *                        syntax rather than language — see syntaxWords()
 */
function detectLang(text = "", { syntax = [] } = {}) {
  const fixed = configuredLang();
  if (fixed) return fixed;

  const clean = String(text || "").replace(NOT_WORDS, " ");
  if (ARABIC_LETTERS.test(clean)) return "ar";

  const ignore = new Set([...syntax].map((word) => String(word).toLowerCase()));
  const words = clean
    .split(/\s+/)
    .map((token) => token.replace(TOKEN_EDGES, "").toLowerCase())
    .filter((token) => ENGLISH_WORD.test(token) && !ignore.has(token));
  return words.length ? "en" : "ar";
}

/**
 * The Latin words that are part of a command's syntax: its name, its aliases,
 * the literal keywords in its usage (`add`, `on|off`, `global`, `--multi`)
 * and any `keywords` it declares.
 * The Arabic usage is where those keywords live on their own — its
 * placeholders are Arabic — so it is the one read.
 */
function syntaxWords(command, aliases = command?.aliases || []) {
  const words = new Set();
  const add = (text) => {
    for (const word of String(text || "").match(LATIN_WORD) || []) words.add(word.toLowerCase());
  };
  add(command?.name);
  for (const alias of aliases || []) add(alias);
  const usage = command?.usage;
  add(typeof usage === "string" ? usage : usage?.ar || usage?.en);
  // Synonyms a command accepts but doesn't list in its usage (`grant`, `me`).
  for (const keyword of command?.keywords || []) add(keyword);
  return words;
}

/**
 * The language to answer a command in, judged on its arguments. A command
 * whose arguments are never language — a city name `!prayer` wants in English,
 * a link — sets `neutralArgs` and is answered like a bare command.
 */
function langForCommand(command, args = [], aliases = command?.aliases || []) {
  const text = command?.neutralArgs ? "" : args.join(" ");
  return detectLang(text, { syntax: syntaxWords(command, aliases) });
}

/** Run `fn` with replies in `lang`. Returns what `fn` returns. */
function withLang(lang, fn) {
  return scope.run(lang === "en" ? "en" : "ar", fn);
}

/** The language of the message being answered right now. */
function currentLang() {
  return scope.getStore() || configuredLang() || "ar";
}

/** Pick the reply for the current message. */
function tr(en, ar) {
  return currentLang() === "en" ? en : ar;
}

module.exports = { detectLang, syntaxWords, langForCommand, withLang, currentLang, tr };
