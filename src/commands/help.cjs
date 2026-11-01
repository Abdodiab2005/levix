// !help lists commands or shows one command in the selected locale.
//
//   help                 the list, in the bot's language
//   help ar | en | pt | es  the list, in that language
//   help <command>       one command, in the bot's language
//   help <command> ar    one command, in that language (`help ar <command>` too)
//
// "The bot's language" is the language every reply uses (utils/i18n.cjs): the
// `bot_language` setting, and in "auto" the language the message is written
// in — with command names counted as syntax, so `!help kick` is not English.
// Command documentation comes from the catalog.

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger.cjs");
const brand = require("../config/brand.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { parseLang, localize, attachCommandDocs } = require("../utils/commandDocs.cjs");
const { detectLang, syntaxWords, t, withLang } = require("../utils/i18n.cjs");

// Every command module, the way the loader finds them: from the generated
// manifest in a packaged build (there is no directory to read inside an
// executable), else from the directory.
function commandModules() {
  try {
    const manifest = require("./_manifest.cjs");
    if (Array.isArray(manifest)) {
      return manifest.map((entry) => ({ module: entry.module, category: entry.category }));
    }
  } catch (error) {
    if (error?.code !== "MODULE_NOT_FOUND") {
      logger.error({ err: error }, "[help] command manifest failed to load");
    }
  }

  const found = [];
  for (const entry of fs.readdirSync(__dirname, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      for (const file of fs.readdirSync(path.join(__dirname, entry.name))) {
        if (!file.endsWith(".cjs") || file.startsWith("_")) continue;
        found.push({ file: path.join(__dirname, entry.name, file), category: entry.name });
      }
    } else if (entry.name.endsWith(".cjs") && !entry.name.startsWith("_")) {
      found.push({ file: path.join(__dirname, entry.name), category: null });
    }
  }
  return found.map(({ file, category }) => {
    try {
      return { module: require(file), category };
    } catch (error) {
      logger.error(error, `Could not load command from ${file}:`);
      return { module: null, category };
    }
  });
}

// Cache the loaded command modules so we don't re-require on every invocation.
let cached = null;
function loadAllCommands() {
  if (cached) return cached;

  const commands = { general: [], group: [] };
  for (const { module: command, category } of commandModules()) {
    if (!command?.name || command === module.exports) continue;
    attachCommandDocs(command, category);
    if (!command.description) continue;
    (category === "group" ? commands.group : commands.general).push(command);
  }
  attachCommandDocs(module.exports);
  commands.general.push(module.exports);

  // Build alias index for inverse lookup.
  const aliasIndex = new Map();
  for (const cmd of [...commands.general, ...commands.group]) {
    for (const alias of aliasesOf(cmd)) {
      aliasIndex.set(String(alias).toLowerCase(), cmd);
    }
  }

  commands.general.sort((a, b) => a.name.localeCompare(b.name));
  commands.group.sort((a, b) => a.name.localeCompare(b.name));

  cached = { commands, aliasIndex };
  return cached;
}

/** Every command's name, aliases and keywords — what may follow !help. */
function helpSyntax(commands) {
  const words = new Set();
  for (const cmd of [...commands.general, ...commands.group]) {
    for (const word of syntaxWords(cmd, aliasesOf(cmd))) words.add(word);
  }
  return words;
}

function findCommand(query, commands, aliasIndex) {
  const q = query.toLowerCase();
  const all = [...commands.general, ...commands.group];
  const direct = all.find((cmd) => cmd.name.toLowerCase() === q);
  if (direct) return direct;
  if (aliasIndex.has(q)) return aliasIndex.get(q);
  return null;
}

// Prefix, aliases and permissions are all changeable at runtime (`!setprefix`,
// the dashboard), so read the live values rather than the file defaults.
function currentPrefix() {
  return runtimeConfig.getPrefix();
}

/** Effective aliases: a dashboard override if there is one, else the file's. */
function aliasesOf(command) {
  return runtimeConfig.getAliases(command.name, command.aliases || []);
}

/**
 * `usage` is authored WITHOUT the prefix ("kick @member [reason]") and may hold
 * several variants separated by newlines. Render each one with the live prefix.
 */
function usageLines(command, prefix, lang) {
  const raw = localize(command.usage, lang) || command.name;
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${prefix}${line}`);
}

function examplesOf(command, lang) {
  const examples = command.examples;
  if (Array.isArray(examples)) return examples;
  const picked = examples && (examples[lang] || examples.en || examples.ar);
  return Array.isArray(picked) ? picked : [];
}

function helpText(lang) {
  const get = (key, params) => withLang(lang, () => t(`bot.help.${key}`, params));
  return {
    title: get("title", { name: brand.name }),
    general: get("general"),
    group: get("group"),
    legendTitle: get("legendTitle"),
    legend: get("legend"),
    languageTitle: get("languageTitle"),
    languages: (prefix) => get("languages", { prefix }),
    footer: (prefix) => get("footer", { prefix }),
    detailTitle: get("detailTitle"),
    command: get("command"),
    aliases: get("aliases"),
    description: get("description"),
    usage: get("usage"),
    examples: get("examples"),
    where: get("where"),
    permission: get("permission"),
    userAdmin: get("userAdmin"),
    botAdmin: get("botAdmin"),
    detailLegend: get("detailLegend"),
    notFound: (query, prefix) => get("notFound", { query, prefix }),
    permissions: Object.fromEntries(
      ["MEMBERS", "ALL", "ADMINS_ONLY", "ADMINS_OWNER", "OWNER_ONLY"].map((level) => [
        level,
        get(`permissions.${level}`),
      ]),
    ),
    chats: Object.fromEntries(
      ["all", "group", "private"].map((chat) => [chat, get(`chats.${chat}`)]),
    ),
  };
}

// Permission level as configured for this command (group sub-commands live in
// their own map). Shown in the detail view so members know why a command is
// refusing them.
function permissionFor(command, isGroupCommand, t) {
  const level = runtimeConfig.getPermission(
    isGroupCommand ? `group:${command.name}` : command.name,
  );
  return t.permissions[level] || level;
}

/** A language word may sit anywhere after !help; whatever is left is the command. */
function parseArgs(args = []) {
  let lang = null;
  const rest = [];
  for (const arg of args) {
    const picked = lang ? null : parseLang(arg);
    if (picked) lang = picked;
    else rest.push(arg);
  }
  return { lang, query: rest[0] || null };
}

function renderList(commands, prefix, lang) {
  const t = helpText(lang);
  const section = (title, list) => {
    let text = `├─ *${title}*\n`;
    list.forEach((cmd) => {
      const aliases = aliasesOf(cmd);
      const aliasSnippet = aliases.length
        ? ` _(${aliases.map((a) => prefix + a).join(", ")})_`
        : "";
      // The description goes on its own line UNDER the command, never
      // beside it: WhatsApp lays a line out by its first strong character,
      // and an Arabic description next to an LTR command name gets its
      // words reordered into unreadability. The colon ends the name line.
      text += `│  ◦ *${prefix}${cmd.name}*${aliasSnippet}:\n`;
      text += `│     ${localize(cmd.description, lang)}\n`;
      // The parameters are the whole point of a help list — show them.
      usageLines(cmd, prefix, lang).forEach((line) => {
        text += `│     ⌨️ \`${line}\`\n`;
      });
    });
    return `${text}│\n`;
  };

  // A command switched off from the dashboard can't run, so it has no
  // business in the menu.
  const live = (list) => list.filter((cmd) => !runtimeConfig.isDisabled(cmd.name));
  const general = live(commands.general);
  const group = live(commands.group);

  let text = `╭───「 *${t.title}* 」\n│\n`;
  if (general.length) text += section(t.general, general);
  if (group.length) text += section(t.group, group);

  text += `├─ *${t.legendTitle}*\n`;
  text += `│  ${t.legend}\n│\n`;
  // Starts with the LTR command, so the line lays out left-to-right in both
  // menus and each language name stays next to its own command.
  text += `├─ *${t.languageTitle}*\n`;
  text += `│  ${t.languages(prefix)}\n│\n`;
  text += `╰───「 ${t.footer(prefix)} 」`;
  return text;
}

function renderDetail(command, isGroupCommand, prefix, lang) {
  const t = helpText(lang);
  // Same bidi rule as the list: a label ends its own line and the value
  // starts the next one, so no line mixes RTL and LTR content.
  let text = `╭───「 *${t.detailTitle}* 」\n│\n`;
  text += `├─ *${t.command}*\n│     ${prefix}${command.name}\n`;

  const commandAliases = aliasesOf(command);
  if (commandAliases.length) {
    text += `├─ *${t.aliases}*\n│     ${commandAliases.map((a) => `${prefix}${a}`).join(", ")}\n`;
  }

  const description = localize(command.description, lang);
  if (description) {
    text += `├─ *${t.description}*\n│     ${description}\n`;
  }

  text += `├─ *${t.usage}*\n`;
  usageLines(command, prefix, lang).forEach((line) => {
    text += `│     \`${line}\`\n`;
  });

  const examples = examplesOf(command, lang);
  if (examples.length) {
    text += `├─ *${t.examples}*\n`;
    examples.forEach((example) => {
      text += `│     \`${prefix}${example}\`\n`;
    });
  }

  text += `├─ *${t.where}*\n│     ${t.chats[command.chat] || command.chat || t.chats.all}\n`;
  text += `├─ *${t.permission}*\n│     ${permissionFor(command, isGroupCommand, t)}\n`;

  if (command.userAdminRequired) text += `├─ ${t.userAdmin}\n`;
  if (command.botAdminRequired) text += `├─ ${t.botAdmin}\n`;

  text += `│\n├─ ${t.detailLegend}\n`;
  text += `│\n╰───「 ${brand.name} 」`;
  return text;
}

module.exports = {
  name: "help",
  aliases: ["menu", "commands", "h", "مساعدة", "الاوامر", "اوامر"],
  chat: "all",

  async execute(sock, msg, args = [], _body = "", _groupMetadata = null, ctx = {}) {
    const prefix = currentPrefix();
    const { commands, aliasIndex } = loadAllCommands();
    const parsed = parseArgs(args);
    // Command names after !help are syntax, not English: `!help kick` on an
    // auto bot is answered like any bare command.
    const lang =
      parsed.lang ||
      detectLang(`${ctx?.invokedName || ""} ${args.join(" ")}`, { syntax: helpSyntax(commands) });

    if (!parsed.query) {
      return sendBotMessage(
        sock,
        msg.key.remoteJid,
        { text: renderList(commands, prefix, lang) },
        { replyTo: msg },
      );
    }

    const query = parsed.query.startsWith(prefix)
      ? parsed.query.slice(prefix.length)
      : parsed.query;
    const command = findCommand(query, commands, aliasIndex);

    if (!command) {
      return sendBotMessage(
        sock,
        msg.key.remoteJid,
        { text: helpText(lang).notFound(parsed.query, prefix) },
        { replyTo: msg },
      );
    }

    const isGroupCommand = commands.group.includes(command);
    return sendBotMessage(
      sock,
      msg.key.remoteJid,
      { text: renderDetail(command, isGroupCommand, prefix, lang) },
      { replyTo: msg },
    );
  },
};
