// file: /commands/group.js (Permission-aware sub-command router)
//
// Audit fix: this used to read owner status from `config.owners` (always
// empty) and admin status with a raw `p.id === senderId`
// comparison that breaks under v7's LID/PN split. Both checks now go
// through the centralized permissions module.

const fs = require("fs");
const path = require("path");
const logger = require("../utils/logger.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const {
  isOwnerJidSync,
  isAdminInGroupSync,
  isBotAdminInGroupSync,
} = require("../utils/permissions.cjs");
const normalizeJid = require("../utils/normalizeJid.cjs");

// --- Sub-command Loader ---
//
// Same story as the top-level command loader: read the directory normally, and
// take a generated manifest instead when there is no directory to read (a
// packaged executable). See scripts/build-sea.mjs.
const subCommands = new Map();

function register(command, label) {
  try {
    if (!command?.name) return;
    subCommands.set(command.name, command);
    if (Array.isArray(command.aliases)) {
      command.aliases.forEach((alias) => subCommands.set(alias, command));
    }
  } catch (error) {
    logger.error({ err: error, file: label }, `Failed to load group sub-command from ${label}`);
  }
}

let manifest = null;
try {
  const loaded = require("./group/_manifest.cjs");
  if (Array.isArray(loaded)) manifest = loaded;
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") {
    logger.error({ err: error }, "[group] manifest failed to load");
  }
}

if (manifest) {
  for (const entry of manifest) register(entry.module, entry.label);
} else {
  const subCommandsPath = path.join(__dirname, "group");
  for (const file of fs.readdirSync(subCommandsPath)) {
    if (!file.endsWith(".cjs") || file.startsWith("_")) continue;
    try {
      register(require(path.join(subCommandsPath, file)), file);
    } catch (error) {
      logger.error(
        { err: error, file },
        `Failed to load group sub-command from ${file}`
      );
    }
  }
}

module.exports = {
  name: "group",
  description: "Main command for all group management actions.",
  usage: "group <أمر فرعي> [المعاملات]",
  chat: "group",

  async execute(sock, msg, args, body, groupMetadata) {
    const subCommandName = args.shift()?.toLowerCase();

    if (!subCommandName) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "يرجى تحديد أمر فرعي بعد `!group`.",
      });
    }

    const subCommand = subCommands.get(subCommandName);
    if (!subCommand) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: `الأمر الفرعي \`${subCommandName}\` غير معروف.`,
      });
    }

    // Switched off from the dashboard: `!group kick` has to refuse it too, not
    // just the direct `!kick`.
    if (runtimeConfig.isDisabled(subCommand.name)) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "⛔ الأمر ده متوقف حاليًا.",
      });
    }

    const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);
    // Centralized owner check — covers the bot itself, LID<->PN,
    // and the user_metadata table.
    const isOwner = msg.key.fromMe || isOwnerJidSync(senderId);
    const isSenderAdmin = isAdminInGroupSync(groupMetadata, senderId);

    // "group:kick" — the flat key runtime-config uses for sub-commands, so a
    // level changed from the dashboard applies here too.
    const permissionLevel = runtimeConfig.getPermission(
      `group:${subCommand.name}`
    );

    let hasPermission = false;
    switch (permissionLevel) {
      case "MEMBERS":
      case "ALL":
        hasPermission = true;
        break;
      case "OWNER_ONLY":
        hasPermission = isOwner;
        break;
      case "ADMINS_ONLY":
        hasPermission = isSenderAdmin || isOwner;
        break;
      case "ADMINS_OWNER":
        hasPermission = isOwner || isSenderAdmin;
        break;
      default:
        logger.warn(
          `[group] Unknown permission level "${permissionLevel}" for sub-command "${subCommand.name}"`
        );
    }

    if (!hasPermission) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "🚫 ليس لديك الصلاحية لاستخدام هذا الأمر.",
      });
    }

    const isBotAdmin = isBotAdminInGroupSync(groupMetadata, sock);
    if (subCommand.userAdminRequired && !isSenderAdmin && !isOwner) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "⚠️ هذا الأمر يتطلب أن تكون مشرفًا.",
      });
    }
    if (subCommand.botAdminRequired && !isBotAdmin) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "⚠️ يجب أن أكون مشرفًا لتنفيذ هذا الأمر.",
      });
    }

    try {
      await subCommand.execute(sock, msg, args, body, groupMetadata);
    } catch (error) {
      logger.error(
        { err: error, subCommand: subCommandName },
        "Error executing a group sub-command"
      );
      await sock.sendMessage(msg.key.remoteJid, {
        text: `❌ *فشل تنفيذ الأمر الفرعي* (\`${error.name || "Error"}\`): ${
          error.message || "غير معروف"
        }`,
      });
    }
  },
};
