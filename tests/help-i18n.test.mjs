// !help in four locales, with English catalog fallback for untranslated locales.
//
//   help                 the list, in the bot's language
//   help ar | help en    the list, in that language
//   help <command> [lang] one command, in the bot's language unless one is given
//
// "The bot's language" is the language every reply uses (utils/i18n.cjs; see
// tests/reply-language.test.mjs). Every shipped command has English and Arabic
// catalog entries.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, require, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-help-i18n");

const settings = require("./src/config/settings.cjs");
const { attachCommandDocs, localize, parseLang } = require("./src/utils/commandDocs.cjs");
const help = require("./src/commands/help.cjs");

// These files check reply language, and the typing delay (400 to 2,500 ms per
// reply) is covered by tests/send-bot-message.test.mjs.
const { timing } = await import(join(ROOT, "src/utils/sendBotMessage.esm.js"));
timing.sleep = async () => {};

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

section("every loaded command has catalog documentation");

{
  const catalogs = Object.fromEntries(
    ["en", "ar"].map((lang) => [
      lang,
      JSON.parse(readFileSync(join(ROOT, `i18n/${lang}/commands.json`), "utf8")),
    ]),
  );
  const files = [
    ...readdirSync(join(ROOT, "src/commands"))
      .filter((f) => f.endsWith(".cjs") && !f.startsWith("_"))
      .map((f) => `./src/commands/${f}`),
    ...readdirSync(join(ROOT, "src/commands/group"))
      .filter((f) => f.endsWith(".cjs") && !f.startsWith("_"))
      .map((f) => `./src/commands/group/${f}`),
  ];

  const known = new Set();
  const problems = [];
  for (const file of files) {
    const command = require(file);
    if (!command?.name) continue;
    const key = file.includes("/group/") ? `group.${command.name}` : command.name;
    if (known.has(key)) problems.push(`duplicate command ${key}`);
    known.add(key);
    for (const field of ["description", "usage"]) {
      for (const lang of ["en", "ar"]) {
        const value = catalogs[lang][`${key}.${field}`];
        if (typeof value !== "string" || !value.trim()) {
          problems.push(`${key}.${field}.${lang} is missing`);
        }
      }
      if (ARABIC_LETTERS.test(catalogs.en[`${key}.${field}`] || "")) {
        problems.push(`${key}.${field}.en has Arabic in it`);
      }
    }
    if (!ARABIC_LETTERS.test(catalogs.ar[`${key}.description`] || "")) {
      problems.push(`${key}.description.ar is not Arabic`);
    }
  }
  for (const lang of ["en", "ar"]) {
    for (const key of Object.keys(catalogs[lang])) {
      const match = /^(.*)\.(description|usage)$/.exec(key);
      if (!match || !known.has(match[1])) problems.push(`${lang} has stale key ${key}`);
    }
  }
  ok(`checked every command (${known.size})`, known.size >= 58);
  equal("none is missing a translation", problems.join("; "), "");

  const { loadCommands, getLoadedCommands } = await import(
    join(ROOT, "src/handlers/command.handler.js")
  );
  await loadCommands();
  for (const command of getLoadedCommands().values()) {
    const key = command.__category === "group" ? `group.${command.name}` : command.name;
    for (const field of ["description", "usage"]) {
      if (!Object.hasOwn(catalogs.en, `${key}.${field}`)) continue;
      for (const lang of ["en", "ar", "pt-BR", "es-419"]) {
        equal(
          `${key}.${field} attached in ${lang}`,
          command[field]?.[lang],
          catalogs[lang]?.[`${key}.${field}`] || catalogs.en[`${key}.${field}`],
        );
      }
    }
  }
}

section("choosing the language");

equal("ar", parseLang("ar"), "ar");
equal("EN in capitals", parseLang("EN"), "en");
equal("عربي", parseLang("عربي"), "ar");
equal("انجليزي", parseLang("انجليزي"), "en");
equal("a command name is not a language", parseLang("kick"), null);
for (const word of ["pt", "pt-br", "português", "portugues", "portuguese"]) {
  equal(`${word} selects Portuguese`, parseLang(word.toUpperCase()), "pt-BR");
}
for (const word of ["es", "es-419", "español", "espanol", "spanish"]) {
  equal(`${word} selects Spanish`, parseLang(word.toUpperCase()), "es-419");
}

equal("a plain string is shown as-is", localize("only one", "ar"), "only one");
equal("a missing language falls back", localize({ en: "english" }, "ar"), "english");

{
  const custom = { name: "kick", description: { en: "Custom", ar: "مخصص" } };
  attachCommandDocs(custom, "group");
  equal("module-owned description is preserved", custom.description.en, "Custom");
  equal("missing usage is attached independently", custom.usage.en, "kick @member [reason]");
}

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
  ok("Portuguese and Spanish choices", en.includes("`!help pt`") && en.includes("`!help es`"));

  settings.set("bot_language", "ar");
  const ar = await runHelp();
  ok("Arabic title", ar.includes("أوامر"));
  ok("Arabic section", ar.includes("*الأوامر العامة*"));
  ok("Arabic descriptions", ar.includes("يطرد عضوًا من المجموعة."));
  ok("Arabic usage placeholders", ar.includes("`!kick @عضو [السبب]`"));
  ok("no English description leaks in", !ar.includes("Removes a member from the group."));
  ok("…and it says how to get English", ar.includes("`!help en`"));
  ok("Arabic footer has four choices", ar.includes("`!help pt`") && ar.includes("`!help es`"));
}

section("help pt and help es use English until translated");

{
  settings.set("bot_language", "ar");
  for (const lang of ["pt", "es"]) {
    const list = await runHelp([lang]);
    ok(`help ${lang} lists English commands`, list.includes("*General Commands*"));
    ok(
      `help ${lang} includes English descriptions`,
      list.includes("Removes a member from the group."),
    );
    const detail = await runHelp(["kick", lang]);
    ok(`help kick ${lang} is English`, detail.includes("*Command Details*"));
    ok(`help kick ${lang} has English usage`, detail.includes("`!kick @member [reason]`"));
  }
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

section("the dashboard gets four languages");

{
  const { loadCommands, getCommandCatalog } = await import(
    join(ROOT, "src/handlers/command.handler.js")
  );
  await loadCommands();
  const kick = getCommandCatalog().find((c) => c.name === "kick");
  equal("description stays a string", typeof kick?.description, "string");
  equal("…in English", kick?.description, "Removes a member from the group.");
  equal("Arabic description rides along", kick?.descriptions?.ar, "يطرد عضوًا من المجموعة.");
  equal(
    "English description rides along",
    kick?.descriptions?.en,
    "Removes a member from the group.",
  );
  equal("usage stays a string", kick?.usage, "kick @member [reason]");
  equal("Arabic usage rides along", kick?.usages?.ar, "kick @عضو [السبب]");
  for (const lang of ["pt-BR", "es-419"]) {
    equal(
      `${lang} description falls back to English`,
      kick?.descriptions?.[lang],
      kick?.description,
    );
    equal(`${lang} usage falls back to English`, kick?.usages?.[lang], kick?.usage);
  }
}

settings.set("bot_language", "auto");
finish();
