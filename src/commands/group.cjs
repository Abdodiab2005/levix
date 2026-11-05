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
  isBotAdminUserSync,
  getSenderCandidatesSync,
} = require("../utils/permissions.cjs");
const { evaluatePermissionLevel } = require("../utils/permissionLevel.cjs");
const normalizeJid = require("../utils/normalizeJid.cjs");
const { langForCommand, withLang, t } = require("../utils/i18n.cjs");
const { attachCommandDocs } = require("../utils/commandDocs.cjs");

// --- Sub-command Loader ---
//
// Same story as the top-level command loader: read the directory normally, and
// take a generated manifest instead when there is no directory to read (a
// packaged executable). See scripts/build-sea.mjs.
const subCommands = new Map();

function register(command, label) {
  try {
    if (!command?.name) return;
    attachCommandDocs(command, "group");
    subCommands.set(command.name, command);
    if (Array.isArray(command.aliases)) {
      command.aliases.forEach((alias) => {
        subCommands.set(alias, command);
      });
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
      logger.error({ err: error, file }, `Failed to load group sub-command from ${file}`);
    }
  }
}

/**
 * Who is asking, in the shape `evaluatePermissionLevel` already understands.
 * Bot-admin is honored inside a group (the direct command does the same) and
 * ignored in a private chat so a private `!group` does not widen.
 */
function senderFor(msg, sock, groupMetadata) {
  const remote = msg?.key?.remoteJid || "";
  const isGroup = remote.endsWith("@g.us");
  const senderId = normalizeJid(msg?.key?.participant || remote);
  const senderIds = getSenderCandidatesSync(msg, sock);
  const senderCandidates = senderIds.length ? senderIds : [senderId].filter(Boolean);
  const isOwner = Boolean(msg?.key?.fromMe) || senderCandidates.some((id) => isOwnerJidSync(id));
  const groupAdmin =
    isGroup && senderCandidates.some((id) => isAdminInGroupSync(groupMetadata, id));
  const isBotAdmin = isGroup && !isOwner && senderCandidates.some((id) => isBotAdminUserSync(id));
  return {
    isGroup,
    isOwner,
    isBotAdmin,
    isSenderAdmin: Boolean(isBotAdmin || groupAdmin),
  };
}

/** The level check for one group sub-command. Exported for the permission matrix. */
function subCommandAccess(subCommandName, sender) {
  const level = runtimeConfig.getPermission(`group:${subCommandName}`);
  return { ...evaluatePermissionLevel(level, sender), level };
}

module.exports = {
  name: "group",
  chat: "group",
  subCommandAccess,
  senderFor,

  async execute(sock, msg, args, body, groupMetadata) {
    const subCommandName = args.shift()?.toLowerCase();

    if (!subCommandName) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.group.group.missingSubCommand"),
      });
    }

    const subCommand = subCommands.get(subCommandName);
    if (!subCommand) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.group.group.unknownSubCommand", {
          name: subCommandName,
          prefix: runtimeConfig.getPrefix(),
        }),
      });
    }

    // The dispatcher judged the language against `!group`'s own syntax, where
    // `kick` looks like an English word. Judge it again against the
    // sub-command's, the way a direct `!kick` is judged.
    const lang = langForCommand(subCommand, args);
    return withLang(lang, () => runSubCommand(sock, msg, args, body, groupMetadata, subCommand));
  },
};

async function runSubCommand(sock, msg, args, body, groupMetadata, subCommand) {
  const subCommandName = subCommand.name;

  // Switched off from the dashboard: `!group kick` has to refuse it too, not
  // just the direct `!kick`.
  if (runtimeConfig.isDisabled(subCommand.name)) {
    return await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.group.group.disabled"),
    });
  }

  const sender = senderFor(msg, sock, groupMetadata);
  // The same level check the direct `!kick` path uses. A bot admin in the
  // group is included. A bot admin in a private chat is not, so this door
  // does not open a private chat the direct command already refuses.
  const permission = subCommandAccess(subCommand.name, sender);
  if (permission.unknownLevel) {
    logger.warn(
      `[group] Unknown permission level "${permission.level}" for sub-command "${subCommand.name}"`,
    );
  }

  if (!permission.hasPermission) {
    return await sock.sendMessage(msg.key.remoteJid, {
      text: permission.reason || t("bot.group.group.noPermission"),
    });
  }

  const isBotAdmin = isBotAdminInGroupSync(groupMetadata, sock);
  if (subCommand.userAdminRequired && !sender.isSenderAdmin && !sender.isOwner) {
    return await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.group.group.userAdminRequired"),
    });
  }
  if (subCommand.botAdminRequired && !isBotAdmin) {
    return await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.group.group.botAdminRequired"),
    });
  }

  try {
    await subCommand.execute(sock, msg, args, body, groupMetadata);
  } catch (error) {
    logger.error({ err: error, subCommand: subCommandName }, "Error executing a group sub-command");
    await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.group.group.failed", {
        errorName: error.name || "Error",
        errorMessage: error.message || t("bot.group.group.unknownError"),
      }),
    });
  }
}
