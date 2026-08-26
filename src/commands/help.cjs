const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger.cjs");
const brand = require("../config/brand.cjs");
const { sendBotMessage } = require("../utils/sendBotMessage.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");

// Recursive function to get all command files
function getAllCommandFiles(dirPath, fileList = []) {
  const files = fs.readdirSync(dirPath);

  files.forEach((file) => {
    const filePath = path.join(dirPath, file);
    if (fs.statSync(filePath).isDirectory()) {
      fileList = getAllCommandFiles(filePath, fileList);
    } else if (file.endsWith(".cjs") || file.endsWith(".js")) {
      fileList.push(filePath);
    }
  });

  return fileList;
}

// Cache the loaded command modules so we don't re-require on every invocation.
let cached = null;
function loadAllCommands() {
  if (cached) return cached;
  const commandsPath = path.join(__dirname);
  const files = getAllCommandFiles(commandsPath).filter(
    (file) =>
      path.basename(file) !== "help.cjs" && path.basename(file) !== "help.js"
  );

  const commands = { general: [], group: [] };
  for (const file of files) {
    try {
      const command = require(file);
      if (!command?.name || !command?.description) continue;
      const relativePath = path.relative(commandsPath, file);
      if (path.dirname(relativePath) === "group") {
        commands.group.push(command);
      } else {
        commands.general.push(command);
      }
    } catch (error) {
      logger.error(error, `Could not load command from ${file}:`);
    }
  }

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
 * `usage` is authored WITHOUT the prefix ("kick @user [reason]") and may hold
 * several variants separated by newlines. Render each one with the live prefix.
 */
function usageLines(command, prefix) {
  const raw = command.usage || command.name;
  return String(raw)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${prefix}${line}`);
}

// Permission level as configured for this command (group sub-commands live in
// their own map). Shown in the detail view so members know why a command is
// refusing them.
const PERMISSION_LABELS = {
  MEMBERS: "الكل",
  ALL: "الكل",
  ADMINS_ONLY: "المشرفين فقط",
  ADMINS_OWNER: "المشرفين والمالك",
  OWNER_ONLY: "المالك فقط",
};

function permissionFor(command, isGroupCommand) {
  const level = runtimeConfig.getPermission(
    isGroupCommand ? `group:${command.name}` : command.name
  );
  return PERMISSION_LABELS[level] || level;
}

const CHAT_LABELS = {
  all: "كل المحادثات",
  group: "المجموعات فقط",
  private: "الخاص فقط",
};

module.exports = {
  name: "help",
  aliases: ["menu", "commands", "h"],
  description: "Shows a list of all commands or info about a specific command.",
  usage: "help [اسم الأمر]",
  chat: "all",

  async execute(sock, msg, args) {
    const prefix = currentPrefix();
    const { commands, aliasIndex } = loadAllCommands();

    if (!args[0]) {
      const section = (title, list) => {
        let text = `├─ *${title}*\n`;
        list.forEach((cmd) => {
          const aliases = aliasesOf(cmd);
          const aliasSnippet = aliases.length
            ? ` _(${aliases.map((a) => prefix + a).join(", ")})_`
            : "";
          text += `│  ◦ *${prefix}${cmd.name}*${aliasSnippet}\n`;
          text += `│     ${cmd.description}\n`;
          // The parameters are the whole point of a help list — show them.
          usageLines(cmd, prefix).forEach((line) => {
            text += `│     ⌨️ \`${line}\`\n`;
          });
        });
        return `${text}│\n`;
      };

      // A command switched off from the dashboard can't run, so it has no
      // business in the menu.
      const live = (list) =>
        list.filter((cmd) => !runtimeConfig.isDisabled(cmd.name));

      const general = live(commands.general);
      const group = live(commands.group);

      let helpText = `╭───「 *🤖 ${brand.name} Commands* 」\n│\n`;
      if (general.length) helpText += section("General Commands", general);
      if (group.length) helpText += section("Group Commands", group);

      helpText += `├─ *الرموز*\n`;
      helpText += `│  \`<...>\` مطلوب · \`[...]\` اختياري · \`a|b\` اختر واحد\n│\n`;
      helpText += `╰───「 اكتب *${prefix}help <أمر>* لتفاصيل أكتر 」`;

      return sendBotMessage(sock, msg.key.remoteJid, { text: helpText }, { replyTo: msg });
    }

    const query = args[0].startsWith(prefix) ? args[0].slice(prefix.length) : args[0];
    const command = findCommand(query, commands, aliasIndex);

    if (!command) {
      return sendBotMessage(
        sock,
        msg.key.remoteJid,
        {
          text:
            `❌ الأمر "*${args[0]}*" غير موجود.\n` +
            `اكتب \`${prefix}help\` لعرض كل الأوامر.`,
        },
        { replyTo: msg }
      );
    }

    let usageText = `╭───「 *Command Details* 」\n│\n`;
    usageText += `├─ *الأمر:* ${prefix}${command.name}\n`;

    const commandAliases = aliasesOf(command);
    if (commandAliases.length) {
      usageText += `├─ *اختصارات:* ${commandAliases
        .map((a) => `${prefix}${a}`)
        .join(", ")}\n`;
    }

    if (command.description) {
      usageText += `├─ *الوصف:* ${command.description}\n`;
    }

    usageText += `├─ *الاستخدام:*\n`;
    usageLines(command, prefix).forEach((line) => {
      usageText += `│     \`${line}\`\n`;
    });

    if (command.examples?.length) {
      usageText += `├─ *أمثلة:*\n`;
      command.examples.forEach((example) => {
        usageText += `│     \`${prefix}${example}\`\n`;
      });
    }

    usageText += `├─ *المكان:* ${CHAT_LABELS[command.chat] || command.chat || "كل المحادثات"}\n`;
    const isGroupCommand = commands.group.includes(command);
    usageText += `├─ *الصلاحية:* ${permissionFor(command, isGroupCommand)}\n`;

    if (command.userAdminRequired) {
      usageText += `├─ ⚠️ لازم تكون مشرف\n`;
    }
    if (command.botAdminRequired) {
      usageText += `├─ ⚠️ لازم البوت يكون مشرف\n`;
    }

    usageText += `│\n├─ \`<...>\` مطلوب · \`[...]\` اختياري\n`;
    usageText += `│\n╰───「 ${brand.name} 」`;

    return sendBotMessage(sock, msg.key.remoteJid, { text: usageText }, { replyTo: msg });
  },
};
