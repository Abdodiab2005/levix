// Every reply the bot sends goes out in one language (src/utils/i18n.cjs).
//
//   bot_language = ar | en   that language, always
//   bot_language = auto      the language the message is written in: Arabic
//                            letters -> Arabic; English words that aren't the
//                            command's own syntax -> English; a bare command
//                            -> Arabic, the bot's historical default
//
// The last section is the one that catches a forgotten string: it runs the
// commands through the real dispatcher with the bot set to English and fails
// on any Arabic letter that comes back.

import { join } from "node:path";
import { equal, finish, ok, ROOT, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-reply-language");

const settings = require("./src/config/settings.cjs");
const {
  detectLang,
  syntaxWords,
  langForCommand,
  withLang,
  currentLang,
  tr,
} = require("./src/utils/i18n.cjs");

settings.set("bot_min_delay_ms", 0);
settings.set("bot_max_delay_ms", 0);

const ARABIC_LETTERS = /[ء-ي]/;
const todo = require("./src/commands/todo.cjs");
const rand = require("./src/commands/rand.cjs");
const perm = require("./src/commands/perm.cjs");
const prayer = require("./src/commands/prayer.cjs");
const deleteschedule = require("./src/commands/deleteschedule.cjs");

// ---------------------------------------------------------------------------

section("a fixed language wins over the message");

settings.set("bot_language", "en");
equal("en answers Arabic text in English", detectLang("اشتري لبن"), "en");
settings.set("bot_language", "ar");
equal("ar answers English text in Arabic", detectLang("buy milk"), "ar");

section("auto: the language of the message");

settings.set("bot_language", "auto");
equal("Arabic letters -> Arabic", detectLang("اشتري لبن"), "ar");
equal("English words -> English", detectLang("buy milk"), "en");
equal("nothing to go on -> Arabic", detectLang(""), "ar");
equal("mixed, with Arabic in it -> Arabic", detectLang("add اشتري milk"), "ar");
equal("a link is not English", detectLang("https://example.com/some/path"), "ar");
equal("a mention is not English", detectLang("@201234567890"), "ar");
equal("an id is not English", detectLang("3fa85f64-5717-4562-b3fc-2c963f66afa6"), "ar");
equal("2d6 is not English", detectLang("2d6"), "ar");
equal("digits are not English", detectLang("12 + 30"), "ar");

section("a command's own keywords are syntax, not English");

equal("!todo list", detectLang("list", { syntax: syntaxWords(todo) }), "ar");
equal("!todo add buy milk", detectLang("add buy milk", { syntax: syntaxWords(todo) }), "en");
equal("!rand dice 2d6", detectLang("dice 2d6", { syntax: syntaxWords(rand) }), "ar");
equal("!rand coin", detectLang("coin", { syntax: syntaxWords(rand) }), "ar");
ok(
  "declared keywords count too (perm: grant, me)",
  syntaxWords(perm).has("grant") && syntaxWords(perm).has("me"),
);
equal("!perm grant admin me", detectLang("grant admin me", { syntax: syntaxWords(perm) }), "ar");
equal(
  "!deleteschedule <id>",
  langForCommand(deleteschedule, ["3fa85f64-5717-4562-b3fc-2c963f66afa6"]),
  "ar",
);
equal(
  "a city asked for in English says nothing: !prayer cairo",
  langForCommand(prayer, ["cairo"]),
  "ar",
);

section("the language rides along with everything the message causes");

{
  equal("outside any message, auto means Arabic", currentLang(), "ar");
  const seen = await withLang("en", async () => {
    const before = tr("en", "ar");
    await new Promise((resolve) => setImmediate(resolve));
    const afterAwait = tr("en", "ar");
    const inTimer = await new Promise((resolve) => setTimeout(() => resolve(tr("en", "ar")), 5));
    return [before, afterAwait, inTimer];
  });
  equal("inside withLang", seen[0], "en");
  equal("…after an await", seen[1], "en");
  equal("…inside a timer it started", seen[2], "en");
  equal("and nothing leaks out", tr("en", "ar"), "ar");

  const [a, b] = await Promise.all([
    withLang("en", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return tr("en", "ar");
    }),
    withLang("ar", async () => tr("en", "ar")),
  ]);
  equal("two messages at once keep their own language (en)", a, "en");
  equal("two messages at once keep their own language (ar)", b, "ar");
}

// ---------------------------------------------------------------------------
// Through the real dispatcher.

const { loadCommands, handleCommand } = await import(join(ROOT, "src/handlers/command.handler.js"));
await loadCommands();

const SELF = "201999999999@s.whatsapp.net";
const GROUP = "120363000000000009@g.us";

function makeSock() {
  const sent = [];
  return {
    sent,
    user: { id: "201999999999:1@s.whatsapp.net" },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: `m${sent.length}`, remoteJid: jid, fromMe: true } };
    },
    async sendPresenceUpdate() {},
    async presenceSubscribe() {},
    async groupMetadata(jid) {
      return {
        id: jid,
        subject: "Test group",
        participants: [{ id: SELF, admin: "superadmin" }],
      };
    },
  };
}

function messageFrom(chat, text, { fromMe = true, participant } = {}) {
  return {
    key: { remoteJid: chat, fromMe, id: `in-${Math.random()}`, participant },
    pushName: "Tester",
    message: { conversation: text },
  };
}

/** Run `text` as a command in `chat`; return every text/caption it sent. */
async function run(text, { chat = SELF, fromMe = true, participant } = {}) {
  const sock = makeSock();
  const msg = messageFrom(chat, text, { fromMe, participant });
  try {
    await handleCommand(sock, msg, text);
  } catch {}
  return sock.sent.map((s) => s.content?.text || s.content?.caption || "").filter(Boolean);
}

section("the dispatcher answers in the language of the message");

{
  settings.set("bot_language", "auto");
  const bare = await run("!ping");
  ok(`a bare command is Arabic (${bare[0]})`, ARABIC_LETTERS.test(bare[0] || ""));

  const english = await run("!todo add buy milk");
  ok(`English words get English (${english[0]})`, /added to your list/.test(english[0] || ""));
  const arabic = await run("!todo add اشتري لبن");
  ok(`Arabic words get Arabic (${arabic[0]})`, /تمت إضافة المهمة/.test(arabic[0] || ""));
  const keywords = await run("!todo list");
  ok(`keywords alone stay Arabic (${keywords[0]})`, ARABIC_LETTERS.test(keywords[0] || ""));

  settings.set("bot_language", "en");
  const fixed = await run("!ping");
  equal("bot_language en: English", fixed[0], "Pong! 🏓");
  const fixedArabic = await run("!todo add اشتري عيش");
  ok("…even for an Arabic message", /added to your list/.test(fixedArabic[0] || ""));

  settings.set("bot_language", "ar");
  const fixedAr = await run("!todo add buy bread");
  ok("bot_language ar: Arabic even for English", /تمت إضافة المهمة/.test(fixedAr[0] || ""));
}

section("refusals before the command runs follow it too");

{
  settings.set("bot_language", "auto");
  const stranger = "201555555555@s.whatsapp.net";
  const ar = await run("!restart", { chat: stranger, fromMe: false });
  ok(`owner-only, bare: Arabic (${ar[0]})`, /للمالك فقط/.test(ar[0] || ""));
  const en = await run("!restart right now please", { chat: stranger, fromMe: false });
  ok(`owner-only, English words: English (${en[0]})`, /Only the bot owner/.test(en[0] || ""));
}

section("!group judges the sub-command's syntax, not its own");

{
  settings.set("bot_language", "auto");
  // With !group's own syntax, "rules" would look like an English word.
  const rules = await run("!group rules", { chat: GROUP, participant: SELF });
  ok(`!group rules is Arabic (${rules[0]})`, ARABIC_LETTERS.test(rules[0] || ""));
  const direct = await run("!rules", { chat: GROUP, participant: SELF });
  equal("…the same as !rules", rules[0], direct[0]);
}

// The commands both sweeps run: every one that answers without the network
// or a real WhatsApp account behind it.
const SWEEP_DM = [
  "!ping",
  "!help",
  "!help kick",
  "!help nope",
  "!calc",
  "!calc 1/0",
  "!calc 2 +",
  "!rand x",
  "!rand coin",
  "!rand pick one",
  "!loop",
  "!loop 500 hi",
  "!poll",
  "!poll q | a",
  "!digit",
  "!digit hello",
  "!lang",
  "!lang xx",
  "!memory",
  "!memory add",
  "!memory search",
  "!memory search nothing-here",
  "!memory forget",
  "!todo del 9",
  "!perm",
  "!perm nonsense",
  "!score",
  "!stt",
  "!tts",
  "!gemini",
  "!gemini show",
  "!gemini clear",
  "!generate",
  "!setprefix",
  "!setprefix toolong",
  "!qr",
  "!shortlink",
  "!shortlink notalink",
  "!weather",
  "!prayer",
  "!schedule",
  '!schedule "bad" "x"',
  "!autoschedule",
  "!deleteschedule",
  "!deleteschedule nope",
  "!listschedules",
  "!sticker",
  "!debt",
  "!stopbot",
  "!restart",
];
const SWEEP_GROUP = [
  "!group",
  "!group nosuch",
  "!rules",
  "!notes",
  "!mod",
  "!mod status",
  "!mod words list",
  "!media",
  "!antilink",
  "!welcome",
  "!approveall",
  "!warns",
  "!warn",
  "!kick",
  "!promote",
  "!demote",
  "!clearwarns",
  "!note",
  "!deletenote",
  "!save",
  "!setname",
  "!setrules",
  "!setwarn",
  "!blacklist",
  "!tagadmins",
  "!members",
  "!add",
];

section("with the bot set to English, no Arabic comes back");

{
  settings.set("bot_language", "en");
  // What legitimately stays Arabic in an English reply: command aliases (they
  // are names — `!حساب` is typed as-is), the `!lang ar` / `!help ar` lines
  // that name Arabic in Arabic, and the Arabic-Indic digits in !digit's
  // examples.
  const allowed = (text) =>
    text
      .replace(/ _\([^)]*\)_/g, "")
      .replace(/العربية الفصحى دائماً|العربية/g, "")
      .replace(/[٠-٩]/g, "");

  const dm = SWEEP_DM;
  const group = SWEEP_GROUP;

  const leaks = [];
  const crashes = [];
  let replies = 0;
  const check = (text, reply) => {
    replies += 1;
    if (ARABIC_LETTERS.test(allowed(reply))) leaks.push(`${text} -> ${reply.slice(0, 80)}`);
    // A command that throws still answers — with the failure card. A missing
    // import (`tr is not defined`) would hide behind that, so it counts.
    if (/The (sub-)?command failed/.test(reply)) crashes.push(`${text} -> ${reply.slice(0, 120)}`);
  };
  for (const text of dm) {
    for (const reply of await run(text)) check(text, reply);
  }
  for (const text of group) {
    for (const reply of await run(text, { chat: GROUP, participant: SELF })) check(text, reply);
  }
  ok(`the commands answered (${replies} replies)`, replies >= dm.length + group.length - 10);
  equal("none of them in Arabic", leaks.join("\n"), "");
  equal("and none of them crashed", crashes.join("\n"), "");
}

section("with the bot set to Arabic, nothing comes back English-only");

{
  settings.set("bot_language", "ar");
  // A reply with no Arabic at all is an English string nobody translated.
  // Replies that are pure data (a number, a transcript, `Pong`-style
  // symbols) have no Latin words either, so they pass.
  const englishOnly = (text) =>
    !ARABIC_LETTERS.test(text) &&
    /[a-z]{3,}/i.test(text.replace(/`[^`]*`|https?:\/\/\S+|@\S+|\*[A-Za-z .]+\*/g, ""));

  const found = [];
  for (const text of SWEEP_DM) {
    for (const reply of await run(text))
      if (englishOnly(reply)) found.push(`${text} -> ${reply.slice(0, 80)}`);
  }
  for (const text of SWEEP_GROUP) {
    for (const reply of await run(text, { chat: GROUP, participant: SELF })) {
      if (englishOnly(reply)) found.push(`${text} -> ${reply.slice(0, 80)}`);
    }
  }
  equal("every reply has Arabic in it", found.join("\n"), "");
}

settings.set("bot_language", "auto");
finish();
