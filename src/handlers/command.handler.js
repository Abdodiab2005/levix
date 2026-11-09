import { readdirSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checkBotAdmin, checkCommandPermission } from "../middleware/permissions.middleware.js";
import { getCached, getRosterVersion, resolveGroupMetadata } from "../utils/groupMetadataCache.cjs";
import { sendBotMessage } from "../utils/sendBotMessage.esm.js";
import { accountEpoch as readAccountEpoch } from "../utils/storage.esm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const settings = require("../config/settings.cjs");
const { localize, allLanguages, attachCommandDocs } = require("../utils/commandDocs.cjs");
const { langForCommand, withLang, t } = require("../utils/i18n.cjs");
const { parseCommandText, parseCommandTextV1 } = require("../messaging/parser.cjs");
const { createMessage, renderMessage, stampWatermark } = require("../messaging/message.cjs");
const { routeSend, canonicalJid } = require("../messaging/router.cjs");

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
  "md",
  "prayer",
  "tts",
  "stt",
  "send",
  "weather",
  "translate",
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
  "sticker",
  "toimage",
  "pack",
  "stickers",
  "autodelete",
]);

// Wrap a socket so commands reply nicely:
//   * `editInPlace` commands: the FIRST plain-text send to the command's own
//     chat edits the original command message (only possible when the message
//     is from us — `fromMe`). Falls back to a normal send if the edit fails or
//     isn't allowed. Subsequent sends behave normally.
//   * everything else: `sock.sendMessage(jid, content)` automatically adds
//     `quoted: msg` so the reply threads under the command.
// Every other method (groupMetadata, etc.) is forwarded untouched.
function wrapSockWithReply(sock, originalMsg, editInPlace = false, commandName = "") {
  const chatJid = originalMsg.key.remoteJid;
  const source = canonicalJid(chatJid) || chatJid;
  const allowed = new Set([source]);
  let editUsed = false;
  let noticeSent = false;

  return new Proxy(sock, {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return async (jid, content, options) => {
          const opts = options ? { ...options } : {};
          const signal = opts.signal;
          signal?.throwIfAborted();
          const levix = opts.levix || null;
          delete opts.levix;

          const requested = canonicalJid(jid) || source;
          const protocol = Boolean(content && (content.edit || content.delete || content.react));
          if (protocol) {
            // An edit stays on a chat this command already sent to. It cannot
            // open a new destination.
            if (!allowed.has(requested)) return { key: null, refused: true };
            return target.sendMessage.call(target, jid, content, opts);
          }

          const plan = routeSend({
            sourceJid: chatJid,
            requestedJid: jid,
            senderJid: originalMsg.key.participant || originalMsg.key.remoteJid,
            commandName,
            category: levix?.category || "result",
            sensitivity: levix?.sensitivity || "source",
            terminal: levix?.terminal === true,
          });

          if (!plan.allow) {
            if (!noticeSent) {
              noticeSent = true;
              const notice = renderMessage(
                createMessage({
                  messageKey: plan.noticeKey,
                  category: "system",
                  context: { sourceChat: chatJid, command: commandName },
                  sensitivity: "operational",
                  deliveryPolicy: { terminal: true },
                }),
              );
              try {
                await target.sendMessage.call(
                  target,
                  chatJid,
                  { text: notice, linkPreview: null },
                  { quoted: originalMsg, ...(signal ? { signal } : {}) },
                );
              } catch (error) {
                logger.warn({ err: error?.message }, "[router] refusal notice failed");
              }
            }
            return { key: null, refused: true };
          }

          allowed.add(plan.destination);
          const outgoing = stampText(content, commandName, levix);
          const sameChat = plan.destination === source;

          // Edit the trigger only when the reply stays in this chat. A routed
          // reply must not rewrite the group message it is leaving.
          const eligibleForEdit =
            editInPlace &&
            sameChat &&
            !editUsed &&
            originalMsg.key.fromMe &&
            requested === source &&
            outgoing &&
            typeof outgoing === "object" &&
            typeof outgoing.text === "string" &&
            !outgoing.edit;

          if (eligibleForEdit) {
            editUsed = true;
            try {
              return await target.sendMessage.call(
                target,
                chatJid,
                { ...outgoing, edit: originalMsg.key },
                signal ? { signal } : undefined,
              );
            } catch {
              // Editing failed — fall through to a normal send.
            }
          }

          if (sameChat) {
            if (opts.quoted === undefined) opts.quoted = originalMsg;
          } else if ("quoted" in opts) {
            delete opts.quoted;
          }
          signal?.throwIfAborted();
          const sent = await target.sendMessage.call(target, plan.destination, outgoing, opts);
          if (sent?.key && !sent.key.remoteJid) sent.key.remoteJid = plan.destination;
          return sent;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function stampText(content, commandName, levix) {
  if (!content || typeof content !== "object" || typeof content.text !== "string") return content;
  if (content.image || content.video || content.audio || content.document || content.sticker) {
    return content;
  }
  const text = stampWatermark(content.text, {
    commandName,
    category: levix?.category || "result",
    exact: levix?.exact === true,
  });
  if (text === content.text) return content;
  return { ...content, text };
}

/**
 * Point every alias of `command` at it. The effective list is the dashboard
 * override when there is one, otherwise what the command file declared.
 */
function indexAliases(command) {
  const aliases = runtimeConfig.getAliases(command.name, command.__declaredAliases || []);

  for (const alias of aliases) {
    const existing = commands.get(alias);
    if (existing && existing.name !== command.name) {
      logger.warn(
        `[Commands] Alias conflict: ${alias} already maps to ${existing.name}, ignoring for ${command.name}`,
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
  logger.info(`[Commands] Index rebuilt: ${commandList.size} commands, ${commands.size} entries`);
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
      // Keep the English strings for existing clients and expose all locales.
      description: localize(command.description, "en"),
      descriptions: allLanguages(command.description),
      usage: command.usage ? localize(command.usage, "en") : null,
      usages: command.usage ? allLanguages(command.usage) : null,
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
        const subFiles = readdirSync(subDirPath).filter((file) => file.endsWith(".cjs"));

        for (const file of subFiles) {
          registerCommandFile(join(subDirPath, file), entry.name);
        }
      } else if (entry.name.endsWith(".cjs")) {
        registerCommandFile(join(commandsPath, entry.name), null);
      }
    }
  }

  // Names are registered in directory order, so an alias of an earlier file
  // can occupy a later command's name. Rebuild once names all exist: a real
  // command keeps its name, and the conflicting alias is dropped.
  rebuildCommandIndex();
  logger.info(
    `[Commands] Loaded ${commandList.size} commands (${commands.size} entries with aliases)`,
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

    attachCommandDocs(command, category);
    command.__category = category || "general";
    // What the FILE declares, kept aside so a dashboard override can be
    // cleared back to it later (command.aliases itself is what we index).
    command.__declaredAliases = Array.isArray(command.aliases) ? [...command.aliases] : [];
    commands.set(command.name, command);
    commandList.set(command.name, command);
    logger.info(
      `[Commands] Loaded command: ${command.name}${category ? ` (from ${category}/)` : ""}`,
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
function parseBody(body) {
  const prefix = runtimeConfig.getPrefix();
  const useV1 = settings.get("command_parser") === "v1";
  const parse = useV1 ? parseCommandTextV1 : parseCommandText;
  return { prefix, useV1, parsed: parse(body, { prefix }) };
}

export async function handleCommand(sock, msg, body, accountEpoch) {
  const epoch = Number.isInteger(accountEpoch) ? accountEpoch : readAccountEpoch();
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  const { prefix, useV1, parsed } = parseBody(body);
  if (parsed.kind !== "command") return false;

  const args = parsed.args;
  const invokedName = parsed.name;
  const command = commands.get(invokedName);
  if (!command) {
    // v1 stayed silent, and a token that is not a command name never reaches
    // here. v2 answers a real typo so the person gets an example.
    if (useV1) return false;
    const text = renderMessage(
      createMessage({
        messageKey: "bot.core.commandHandler.unknown",
        category: "error",
        parameters: { name: invokedName, prefix },
        context: { sourceChat: msg.key.remoteJid },
        sensitivity: "operational",
        deliveryPolicy: { terminal: true },
      }),
    );
    await sendBotMessage(sock, msg.key.remoteJid, { text }, { replyTo: msg });
    return true;
  }

  // Everything this command sends goes out in one language: the bot's, or in
  // "auto" the one this message is written in — judged on the arguments, not
  // on the command's own keywords (see utils/i18n.cjs).
  const aliases = runtimeConfig.getAliases(command.name, command.__declaredAliases || []);
  const lang = langForCommand(command, args, aliases);
  return withLang(lang, () =>
    runCommand(sock, msg, body, {
      command,
      args,
      invokedName,
      isGroup,
      rawRemainder: parsed.rawRemainder,
      accountEpoch: epoch,
    }),
  );
}

async function runCommand(
  sock,
  msg,
  body,
  { command, args, invokedName, isGroup, rawRemainder, accountEpoch },
) {
  // Turned off from the dashboard. Answered rather than ignored so the user
  // knows the command exists and isn't broken.
  if (runtimeConfig.isDisabled(command.name)) {
    await sendBotMessage(
      sock,
      msg.key.remoteJid,
      { text: t("bot.core.commandHandler.disabled") },
      { replyTo: msg },
    );
    return true;
  }

  try {
    // One read. Authorization uses a fresh or live roster and denies when the
    // only copy is stale. The command body keeps the last known roster so a
    // failed refresh still protects the last-known admins.
    const jid = msg.key.remoteJid;
    const authMetadata = isGroup ? await resolveGroupMetadata(sock, jid, { fresh: true }) : null;
    const groupMetadata = isGroup ? authMetadata || getCached(jid) || null : null;
    const rosterVersion = isGroup ? getRosterVersion(jid) : undefined;

    if (command.name !== "group") {
      // Enforce the `chat` constraint declared by the command. Until now this
      // was advisory-only and group-only commands could happily run in DMs.
      const chatScope = (command.chat || "all").toLowerCase();
      if (chatScope === "group" && !isGroup) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          {
            text: t("bot.core.commandHandler.groupsOnly"),
          },
          { replyTo: msg },
        );
        return true;
      }
      if (chatScope === "private" && isGroup) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          {
            text: t("bot.core.commandHandler.privateOnly"),
          },
          { replyTo: msg },
        );
        return true;
      }

      // Group sub-commands are keyed "group:<name>" everywhere — defaults.cjs,
      // the dashboard, and `!group kick`. Use the same key here so running
      // `!kick` directly is gated exactly like running `!group kick`.
      const permissionKey = command.__category === "group" ? `group:${command.name}` : command.name;

      const permissionCheck = checkCommandPermission(permissionKey, msg, authMetadata, sock);

      if (!permissionCheck.hasPermission) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: permissionCheck.reason },
          { replyTo: msg },
        );
        return true;
      }

      if (command.userAdminRequired && !permissionCheck.isSenderAdmin) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          {
            text: t("bot.core.commandHandler.adminRequired"),
          },
          { replyTo: msg },
        );
        return true;
      }

      if (command.botAdminRequired && !checkBotAdmin(authMetadata, sock)) {
        await sendBotMessage(
          sock,
          msg.key.remoteJid,
          {
            text: t("bot.core.commandHandler.botAdminRequired"),
          },
          { replyTo: msg },
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
      authGroupMetadata: authMetadata,
      rawRemainder: rawRemainder || "",
      accountEpoch,
      ...(isGroup ? { rosterVersion } : {}),
    };

    // Wrap the socket so legacy commands that still call sock.sendMessage
    // directly automatically reply-quote the original command message. This
    // matches the operator's "every bot message should reply to the command"
    // requirement without having to migrate every single .cjs file at once.
    // Action/confirmation commands additionally edit the trigger message in
    // place instead of posting a second message (see EDIT_IN_PLACE_EXCLUDE).
    const editInPlace = !EDIT_IN_PLACE_EXCLUDE.has(command.name);
    const proxiedSock = wrapSockWithReply(sock, msg, editInPlace, command.name);
    if (readAccountEpoch() !== accountEpoch) {
      logger.debug("[Command] skipped account work after account change");
      return true;
    }
    await command.execute(proxiedSock, msg, args, body, groupMetadata, ctx);
    return true;
  } catch (error) {
    logger.error({ err: error, command: invokedName }, "Error executing command");
    // Surface the error name to the user instead of silently re-throwing.
    try {
      await sendBotMessage(
        sock,
        msg.key.remoteJid,
        {
          text: t("bot.core.commandHandler.failed", {
            name: error.name || "Error",
            details: error.message || t("bot.core.commandHandler.unknownDetails"),
          }),
        },
        { replyTo: msg },
      );
    } catch {}
    throw error;
  }
}
