// !help in Arabic and English.
//
//   help                 the list, in the bot's language
//   help ar | help en    the list, in that language
//   help <command> [lang] one command, in the bot's language unless one is given
//
// "The bot's language" is the language every reply uses (utils/i18n.cjs; see
// tests/reply-language.test.mjs). Every command documents itself in both
// languages, and this file is what keeps a new command from shipping in only
// one.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-help-i18n");

const settings = require("./src/config/settings.cjs");
const { localize, parseLang } = require("./src/utils/commandDocs.cjs");
const help = require("./src/commands/help.cjs");

const ARABIC_LETTERS = /[\u0621-\u064A]/;
const DM = "201000000004@s.whatsapp.net";

let captured = null;
const sock = {
  async sendMessage(_jid, content) {
    captured = content?.text || "";
    return {};
  },
  async sendPresenceUpdate() {},
};

/** Run !help the way the dispatcher does and return what it sent. */
async function runHelp(args = [], { body, invokedName = "help" } = {}) {
  captured = null;
  await help.execute(
    sock,
    { key: { remoteJid: DM } },
    args,
    body ?? `!${invokedName} ${args.join(" ")}`.trim(),
    null,
    { invokedName },
  );
  return captured;
}

// ---------------------------------------------------------------------------

section("every command documents itself in both languages");

{
  const files = [
    ...readdirSync(join(ROOT, "src/commands"))
      .filter((f) => f.endsWith(".cjs") && !f.startsWith("_"))
      .map((f) => `./src/commands/${f}`),
    ...readdirSync(join(ROOT, "src/commands/group"))
      .filter((f) => f.endsWith(".cjs") && !f.startsWith("_"))
      .map((f) => `./src/commands/group/${f}`),
  ];

  let checked = 0;
  const problems = [];
  for (const file of files) {
    const command = require(file);
    if (!command?.name || !command?.description) continue; // middleware, not a command
    checked += 1;
    for (const field of ["description", "usage"]) {
      const value = command[field];
      if (!value || typeof value !== "object") {
        problems.push(`${command.name}.${field} is not { en, ar }`);
        continue;
      }
      if (!value.en || !value.ar) problems.push(`${command.name}.${field} is missing a language`);
      if (ARABIC_LETTERS.test(value.en || "")) {
        problems.push(`${command.name}.${field}.en has Arabic in it`);
      }
    }
    if (!ARABIC_LETTERS.test(command.description?.ar || "")) {
      problems.push(`${command.name}.description.ar is not Arabic`);
    }
  }
  ok(`checked every command (${checked})`, checked >= 58);
  equal("none is missing a translation", problems.join("; "), "");
}

section("choosing the language");

equal("ar", parseLang("ar"), "ar");
equal("EN in capitals", parseLang("EN"), "en");
equal("عربي", parseLang("عربي"), "ar");
equal("انجليزي", parseLang("انجليزي"), "en");
equal("a command name is not a language", parseLang("kick"), null);

equal("a plain string is shown as-is", localize("only one", "ar"), "only one");
equal("a missing language falls back", localize({ en: "english" }, "ar"), "english");

section("help follows the bot's language");

{
  settings.set("bot_language", "en");
  const en = await runHelp();
  ok("English title", en.includes("Commands* 」"));
  ok("English section", en.includes("*General Commands*"));
  ok("English descriptions", en.includes("Removes a member from the group."));
  ok("English usage placeholders", en.includes("`!kick @member [reason]`"));
  ok("no Arabic description leaks in", !en.includes("يطرد عضوًا"));
  ok("…and it says how to get the other language", en.includes("`!help ar`"));

  settings.set("bot_language", "ar");
  const ar = await runHelp();
  ok("Arabic title", ar.includes("أوامر"));
  ok("Arabic section", ar.includes("*الأوامر العامة*"));
  ok("Arabic descriptions", ar.includes("يطرد عضوًا من المجموعة."));
  ok("Arabic usage placeholders", ar.includes("`!kick @عضو [السبب]`"));
  ok("no English description leaks in", !ar.includes("Removes a member from the group."));
  ok("…and it says how to get English", ar.includes("`!help en`"));
}

section("help ar / help en override it");

{
  settings.set("bot_language", "ar");
  const en = await runHelp(["en"]);
  ok("help en on an Arabic bot is English", en.includes("*General Commands*"));

  settings.set("bot_language", "en");
  const ar = await runHelp(["ar"]);
  ok("help ar on an English bot is Arabic", ar.includes("*الأوامر العامة*"));
  const arabicWord = await runHelp(["عربي"]);
  ok("…and so is help عربي", arabicWord.includes("*الأوامر العامة*"));
}

section("one command, in either language");

{
  settings.set("bot_language", "en");
  const en = await runHelp(["kick"]);
  ok("details in the bot's language", en.includes("*Command Details*"));
  ok(
    "English description",
    en.includes("├─ *Description:*\n│     Removes a member from the group."),
  );
  ok("English permission label", en.includes("├─ *Permission:*"));
  ok("English admin warning", en.includes("You must be a group admin"));

  const ar = await runHelp(["kick", "ar"]);
  ok("help kick ar is Arabic", ar.includes("*تفاصيل الأمر*"));
  ok("Arabic description", ar.includes("├─ *الوصف:*\n│     يطرد عضوًا من المجموعة."));
  ok("Arabic usage", ar.includes("`!kick @عضو [السبب]`"));
  ok("Arabic place", ar.includes("├─ *المكان:*\n│     المجموعات فقط"));

  const arFirst = await runHelp(["ar", "kick"]);
  equal("help ar kick says the same thing", arFirst, ar);

  const byAlias = await runHelp(["calculate", "ar"]);
  ok("an alias finds its command", byAlias.includes("!calc"));

  settings.set("bot_language", "ar");
  const enOnArabicBot = await runHelp(["kick", "en"]);
  ok("help kick en on an Arabic bot is English", enOnArabicBot.includes("*Command Details*"));
}

section("auto: help follows the message like every other reply");

{
  settings.set("bot_language", "auto");
  const bare = await runHelp([], { invokedName: "help" });
  ok("a bare !help is Arabic, the bot's default", bare.includes("*الأوامر العامة*"));
  const arabic = await runHelp([], { invokedName: "مساعدة" });
  ok("!مساعدة is Arabic", arabic.includes("*الأوامر العامة*"));
  const commandName = await runHelp(["kick"], { invokedName: "help" });
  ok("a command name is not English: !help kick stays Arabic", commandName.includes("*تفاصيل الأمر*"));
  const english = await runHelp(["please"], { invokedName: "help" });
  ok("an English word makes it English", english.includes("Command \"*please*\" not found"));
  const explicit = await runHelp(["en"], { invokedName: "help" });
  ok("and help en is English", explicit.includes("*General Commands*"));
}

section("an unknown command is answered in the same language");

{
  settings.set("bot_language", "en");
  ok("English", (await runHelp(["nope"])).includes('Command "*nope*" not found'));
  ok("Arabic", (await runHelp(["nope", "ar"])).includes('الأمر "*nope*" غير موجود'));
}

section("the dashboard gets both languages");

{
  const { loadCommands, getCommandCatalog } = await import(
    join(ROOT, "src/handlers/command.handler.js")
  );
  await loadCommands();
  const kick = getCommandCatalog().find((c) => c.name === "kick");
  equal("description stays a string", typeof kick?.description, "string");
  equal("…in English", kick?.description, "Removes a member from the group.");
  equal("both descriptions ride along (ar)", kick?.descriptions?.ar, "يطرد عضوًا من المجموعة.");
  equal(
    "both descriptions ride along (en)",
    kick?.descriptions?.en,
    "Removes a member from the group.",
  );
  equal("usage stays a string", kick?.usage, "kick @member [reason]");
  equal("…with both languages beside it", kick?.usages?.ar, "kick @عضو [السبب]");
}

settings.set("bot_language", "auto");
finish();
