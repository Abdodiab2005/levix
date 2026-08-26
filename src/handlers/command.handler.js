import { readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import {
  checkCommandPermission,
  checkBotAdmin,
} from "../middleware/permissions.middleware.js";
import { sendBotMessage } from "../utils/sendBotMessage.esm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");

// Commands collection (keyed by both names and aliases)
const commands = new Map();
// Track aliases separately so help.cjs can group them.
const aliasIndex = new Map(); // alias -> canonicalName
// Public reverse view exposed for help command listing
const commandList = new Map(); // canonicalName -> command module

// Commands whose output should stay a SEPARATE message (these answer a
// question, generate content, or take free-form variables — editing the
// trigger into the answer would read badly). Everything else gets the
// "edit the original command message in place" behaviour requested by the
// operator (e.g. `!group all hello` rewrites the trigger into the announcement
// instead of posting a second message).
const EDIT_IN_PLACE_EXCLUDE = new Set([
  "gemini",
  "prayer",
  "tts",
  "stt",
  "weather",
  "qr",
  "status",
  "help",
  "ping",
  "shortlink",
  "score",
  "debt",
  "todo",
  "notes",
  "listschedules",
  "mod",
  "calc",
  "loop",
  "rand",
  "poll",
]);

// Wrap a socket so commands reply nicely:
//   * `editInPlace` commands: the FIRST plain-text send to the command's own
//     chat edits the original command message (only possible when the message
//     is from us — `fromMe`). Falls back to a normal send if the edit fails or
//     isn't allowed. Subsequent sends behave normally.
//   * everything else: `sock.sendMessage(jid, content)` automatically adds
//     `quoted: msg` so the reply threads under the command.
// Every other method (groupMetadata, etc.) is forwarded untouched.
function wrapSockWithReply(sock, originalMsg, editInPlace = false) {
  const chatJid = originalMsg.key.remoteJid;
  let editUsed = false;

  return new Proxy(sock, {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return async function (jid, content, options) {
          // Try to edit the trigger message in place for the first eligible
          // text reply. We can only edit messages we sent ourselves.
          const eligibleForEdit =
            editInPlace &&
            !editUsed &&
            originalMsg.key.fromMe &&
            jid === chatJid &&
            content &&
            typeof content === "object" &&
            typeof content.text === "string" &&
            !content.edit;

          if (eligibleForEdit) {
            editUsed = true;
            try {
              return await target.sendMessage.call(target, jid, {
                ...content,
                edit: originalMsg.key,
              });
            } catch {
              // Editing failed (too old, not ours after all, …) — fall through
              // to a normal quoted send so the user still gets a reply.
            }
          }

          const opts = options ? { ...options } : {};
          if (opts.quoted === undefined) {
            opts.quoted = originalMsg;
          }
          return target.sendMessage.call(target, jid, content, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * Point every alias of `command` at it. The effective list is the dashboard
 * override when there is one, otherwise what the command file declared.
 */
function indexAliases(command) {
  const aliases = runtimeConfig.getAliases(
    command.name,
    command.__declaredAliases || []
  );

  for (const alias of aliases) {
    const existing = commands.get(alias);
    if (existing && existing.name !== command.name) {
      logger.warn(
        `[Commands] Alias conflict: ${alias} already maps to ${existing.name}, ignoring for ${command.name}`
      );
      continue;
    }
    commands.set(alias, command);
    aliasIndex.set(alias, command.name);
  }
}

/**
 * Rebuild the name/alias lookup from the loaded commands. Call this after an
 * alias override changes so the new trigger works on the next message instead
 * of after a restart.
 */
export function rebuildCommandIndex() {
  commands.clear();
  aliasIndex.clear();
  for (const command of commandList.values()) {
    commands.set(command.name, command);
  }
  for (const command of commandList.values()) {
    indexAliases(command);
  }
  logger.info(
    `[Commands] Index rebuilt: ${commandList.size} commands, ${commands.size} entries`
  );
}

/**
 * Everything the dashboard needs to render (and edit) the command list.
 *
 * `permissionLocked` marks the commands whose level can't be lowered from the
 * UI: they declare `userAdminRequired`, i.e. the code demands a real WhatsApp
 * group admin no matter what the permission table says, so offering a
 * "MEMBERS" switch for them would just be a lie.
 */
export function getCommandCatalog() {
  const out = [];

  for (const command of commandList.values()) {
    const isGroupSub = command.__category === "group";
    const key = isGroupSub ? `group:${command.name}` : command.name;

    out.push({
      name: command.name,
      key,
      category: command.__category || "general",
      description: command.description || "",
      usage: command.usage || null,
      chat: command.chat || "all",
      declaredAliases: command.__declaredAliases || [],
      aliases: runtimeConfig.getAliases(command.name, command.__declaredAliases || []),
      aliasesOverridden: runtimeConfig.hasAliasOverride(command.name),
      permission: runtimeConfig.getPermission(key),
      defaultPermission: runtimeConfig.defaultPermission(key),
      permissionLocked: !!command.userAdminRequired,
      userAdminRequired: !!command.userAdminRequired,
      botAdminRequired: !!command.botAdminRequired,
      enabled: !runtimeConfig.isDisabled(command.name),
    });
  }

  return out.sort((a, b) => a.name.localeCompare(b.name));
}

// Load all command files (CommonJS .cjs files)
export async function loadCommands() {
  // A packaged build has no commands/ directory to scan — the build step writes
  // a manifest that requires every command by name instead. When there is no
  // manifest (a normal install) we read the directory, so dropping a new .cjs
  // in there still Just Works.
  const manifest = loadManifest();

  if (manifest) {
    for (const entry of manifest) {
      registerCommand(entry.module, entry.label, entry.category);
    }
  } else {
    const commandsPath = join(__dirname, "../commands");
    for (const entry of readdirSync(commandsPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Load commands from subdirectories (e.g., group/)
        const subDirPath = join(commandsPath, entry.name);
        const subFiles = readdirSync(subDirPath).filter((file) =>
          file.endsWith(".cjs")
        );

        for (const file of subFiles) {
          registerCommandFile(join(subDirPath, file), entry.name);
        }
      } else if (entry.name.endsWith(".cjs")) {
        registerCommandFile(join(commandsPath, entry.name), null);
      }
    }
  }

  logger.info(
    `[Commands] Loaded ${commandList.size} commands (${commands.size} entries with aliases)`
  );
}

function loadManifest() {
  try {
    const manifest = require("../commands/_manifest.cjs");
    return Array.isArray(manifest) ? manifest : null;
  } catch (error) {
    // MODULE_NOT_FOUND is the normal case: there is no manifest outside a
    // packaged build. Anything else means the manifest exists and is broken,
    // which is worth saying out loud before we fall back.
    if (error?.code !== "MODULE_NOT_FOUND") {
      logger.error({ err: error }, "[Commands] manifest failed to load");
    }
    return null;
  }
}

function registerCommandFile(absPath, category) {
  let command;
  try {
    command = require(absPath);
  } catch (error) {
    logger.error({ err: error, file: absPath }, "[Commands] failed to load");
    return;
  }
  registerCommand(command, absPath, category);
}

function registerCommand(command, label, category) {
  try {
    if (!command?.name) return;

    command.__category = category || "general";
    // What the FILE declares, kept aside so a dashboard override can be
    // cleared back to it later (command.aliases itself is what we index).
    command.__declaredAliases = Array.isArray(command.aliases)
      ? [...command.aliases]
      : [];
    commands.set(command.name, command);
    commandList.set(command.name, command);
    logger.info(
      `[Commands] Loaded command: ${command.name}${category ? ` (from ${category}/)` : ""}`
    );

    indexAliases(command);
  } catch (error) {
    logger.error(`[Commands] Failed to load ${label}: ${error.message}`);
    if (error.stack) logger.error(error.stack);
  }
}

export function getLoadedCommands() {
  return commandList;
}

export function getAliasIndex() {
  return aliasIndex;
}

// Handle command execution
export async function handleCommand(sock, msg, body) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");

  const prefix = runtimeConfig.getPrefix();
  if (!body.startsWith(prefix)) return false;

  const args = body.slice(prefix.length).trim().split(/ +/);
  const invokedName = args.shift().toLowerCase();
  const command = commands.get(invokedName);
  if (!command) return false;

  // Turned off from the dashboard. Answered rather than ignored so the user
  // knows the command exists and isn't broken.
  if (runtimeConfig.isDisabled(command.name)) {
    await sendBotMessage(
      sock,
      msg.key.remoteJid,
      { text: "⛔ الأمر ده متوقف حاليًا." },
      { replyTo: msg }
    );
    return true;
  }

  try {
    const groupMetadata = isGroup
      ? await sock.groupMetadata(msg.key.remoteJid).catch(() => null)
      : null;

    if (command.name !== "group") {
      // Enforce the `chat` constraint declared by the command. Until now this
      // was advisory-only and group-only commands could happily run in DMs.
      const chatScope = (command.chat || "all").toLowerCase();
      if (chatScope === "group" && !isGroup) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: "⚠️ هذا الأمر يعمل في المجموعات فقط." },
          { replyTo: msg }
        );
        return true;
      }
      if (chatScope === "private" && isGroup) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: "⚠️ هذا الأمر يعمل في المحادثات الخاصة فقط." },
          { replyTo: msg }
        );
        return true;
      }

      // Group sub-commands are keyed "group:<name>" everywhere — defaults.cjs,
      // the dashboard, and `!group kick`. Use the same key here so running
      // `!kick` directly is gated exactly like running `!group kick`.
      const permissionKey =
        command.__category === "group" ? `group:${command.name}` : command.name;

      const permissionCheck = checkCommandPermission(
        permissionKey,
        msg,
        groupMetadata,
        sock
      );

      if (!permissionCheck.hasPermission) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: permissionCheck.reason },
          { replyTo: msg }
        );
        return true;
      }

      if (command.userAdminRequired && !permissionCheck.isSenderAdmin) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: "⚠️ هذا الأمر يتطلب أن تكون مشرفًا." },
          { replyTo: msg }
        );
        return true;
      }

      if (command.botAdminRequired && !checkBotAdmin(groupMetadata, sock)) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: "⚠️ يجب أن أكون مشرفًا لتنفيذ هذا الأمر." },
          { replyTo: msg }
        );
        return true;
      }
    }

    // Pass the invoked name + canonical name so commands like gemini can
    // detect alias-driven sub-commands (`!del`, `!resetai`, `!generate`).
    const ctx = {
      invokedName,
      canonicalName: command.name,
      isAlias: invokedName !== command.name,
      groupMetadata,
    };

    // Wrap the socket so legacy commands that still call sock.sendMessage
    // directly automatically reply-quote the original command message. This
    // matches the operator's "every bot message should reply to the command"
    // requirement without having to migrate every single .cjs file at once.
    // Action/confirmation commands additionally edit the trigger message in
    // place instead of posting a second message (see EDIT_IN_PLACE_EXCLUDE).
    const editInPlace = !EDIT_IN_PLACE_EXCLUDE.has(command.name);
    const proxiedSock = wrapSockWithReply(sock, msg, editInPlace);
    await command.execute(proxiedSock, msg, args, body, groupMetadata, ctx);
    return true;
  } catch (error) {
    logger.error(
      { err: error, command: invokedName },
      "Error executing command"
    );
    // Surface the error name to the user instead of silently re-throwing.
    try {
      await sendBotMessage(
        sock,
        msg.key.remoteJid,
        {
          text: `❌ *فشل تنفيذ الأمر*\n\n*النوع:* \`${error.name || "Error"}\`\n*التفاصيل:* ${
            error.message || "غير معروف"
          }`,
        },
        { replyTo: msg }
      );
    } catch {}
    throw error;
  }
}
