import { readdirSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { checkBotAdmin, checkCommandPermission } from "../middleware/permissions.middleware.js";
import { getCached, getRosterVersion, resolveGroupMetadata } from "../utils/groupMetadataCache.cjs";
import { accountEpoch as readAccountEpoch } from "../utils/storage.esm.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const require = createRequire(import.meta.url);
const botSender = require("../utils/sendBotMessage.cjs");
const logger = require("../utils/logger.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const settings = require("../config/settings.cjs");
const { localize, allLanguages, attachCommandDocs } = require("../utils/commandDocs.cjs");
const { langForCommand, withLang, t } = require("../utils/i18n.cjs");
const { parseCommandText, parseCommandTextV1 } = require("../messaging/parser.cjs");
const { createMessage, renderMessage, stampWatermark } = require("../messaging/message.cjs");
const { routeSend, planDelivery, canonicalJid } = require("../messaging/router.cjs");
const { linkedIdentity } = require("../messaging/identity.cjs");
const { withCommand } = require("../utils/commandContext.cjs");

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

const REACTION_CONTROL_CODES = new Set([
  "REACTION_CANCELLED",
  "REACTION_TIMEOUT",
  "REACTION_STALE",
  "REACTION_INACCESSIBLE",
  "REACTION_FORBIDDEN",
  "REACTION_STT_DISABLED",
  "REACTION_DELIVERY_REFUSED",
  "REACTION_CAPACITY",
  "REACTION_IDENTITY_INVALID",
  "REACTION_VOICE_REQUIRED",
  "REACTION_COMMAND_DENIED",
  "REACTION_COMMAND_UNSUPPORTED",
  "REACTION_COMMAND_FAILED",
  "STT_KEY_REQUIRED",
  "STT_OUTPUT_INVALID",
  "MEDIA_AUDIO_INVALID",
  "MEDIA_TOO_LARGE",
  "MEDIA_NOT_AVAILABLE",
  "MEDIA_URL_INVALID",
  "INVOCATION_REFUSAL",
  "DUPLICATE",
  "EVENT_MISSING",
  "RATE_LIMIT",
  "CAPACITY",
]);

function sameTransportKey(left, right) {
  if (!left || !right || left.id !== right.id) return false;
  const a = canonicalJid(left.remoteJid) || left.remoteJid;
  const b = canonicalJid(right.remoteJid) || right.remoteJid;
  return Boolean(a) && a === b;
}

function controlError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function planForSend(chatJid, jid, senderJid, commandName, levix, routeMode) {
  if (routeMode) {
    return planDelivery({
      sourceJid: chatJid,
      requestedJid: jid,
      senderJid,
      commandName,
      routeMode,
      overrides: { commands: {}, categories: {} },
      sensitivity: levix?.sensitivity || "source",
      terminal: levix?.terminal === true,
      identity: routeMode === "same_chat" ? { selfJids: [] } : linkedIdentity(),
    });
  }
  return routeSend({
    sourceJid: chatJid,
    requestedJid: jid,
    senderJid,
    commandName,
    category: levix?.category || "result",
    sensitivity: levix?.sensitivity || "source",
    terminal: levix?.terminal === true,
  });
}

// Wrap a socket so commands reply nicely:
//   * `editInPlace` commands: the FIRST plain-text send to the command's own
//     chat edits the original command message (only possible when the message
//     is from us — `fromMe`). Falls back to a normal send if the edit fails or
//     isn't allowed. Subsequent sends behave normally.
//   * everything else: `sock.sendMessage(jid, content)` automatically adds
//     `quoted: replyAnchor` so the reply threads under the command.
// A reaction never edits or deletes the protected original. Every other method
// is forwarded untouched.
function wrapSockWithReply(sock, originalMsg, options = {}) {
  const editInPlace = options.editInPlace === true;
  const replyAnchor = options.replyAnchor || originalMsg;
  const protectedKeys = Array.isArray(options.protectedKeys) ? options.protectedKeys : [];
  const commandName = options.commandName || "";
  const silentDenials = options.silentDenials === true;
  const routeMode = options.routeMode || null;
  const reaction = options.source === "reaction";
  const state = options.state || { attempted: 0 };
  const chatJid = originalMsg.key.remoteJid;
  const source = canonicalJid(chatJid) || chatJid;
  const senderJid =
    options.requester?.jid ||
    options.senderJid ||
    originalMsg.key.participant ||
    originalMsg.key.remoteJid;
  const allowed = new Set([source]);
  let editUsed = false;
  let noticeSent = false;

  const proxy = new Proxy(sock, {
    get(target, prop, receiver) {
      if (prop === "sendMessage") {
        return async (jid, content, sendOptions) => {
          const opts = sendOptions ? { ...sendOptions } : {};
          const signal = opts.signal || options.signal;
          signal?.throwIfAborted();
          const levix = opts.levix || null;
          delete opts.levix;

          const requested = canonicalJid(jid) || source;
          const protocolKey = content?.edit || content?.delete || null;
          if (protocolKey && protectedKeys.some((key) => sameTransportKey(protocolKey, key))) {
            logger.warn(
              { command: commandName },
              "[Command] refused edit or delete of a protected message",
            );
            return { key: null, refused: true };
          }
          const protocol = Boolean(content && (content.edit || content.delete || content.react));
          if (protocol) {
            // An edit stays on a chat this command already sent to. It cannot
            // open a new destination.
            if (!allowed.has(requested)) return { key: null, refused: true };
            const outgoing =
              content.edit && levix ? stampText(content, commandName, levix) : content;
            state.attempted += 1;
            return target.sendMessage.call(target, jid, outgoing, opts);
          }

          const plan = planForSend(chatJid, jid, senderJid, commandName, levix, routeMode);

          if (!plan.allow) {
            if (!silentDenials && !noticeSent) {
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
                  { quoted: replyAnchor, ...(signal ? { signal } : {}) },
                );
              } catch (error) {
                logger.warn({ err: error?.message }, "[router] refusal notice failed");
              }
            }
            if (reaction) throw controlError("REACTION_DELIVERY_REFUSED");
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
              state.attempted += 1;
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

          let quoted = opts.quoted;
          if (
            quoted === originalMsg ||
            (quoted?.key && sameTransportKey(quoted.key, originalMsg.key))
          )
            quoted = replyAnchor;
          if (sameChat) {
            if (quoted === undefined) quoted = replyAnchor;
          } else {
            quoted = undefined;
          }

          signal?.throwIfAborted();
          state.attempted += 1;
          if (reaction) {
            if (options.deliveryGuard?.refresh) await options.deliveryGuard.refresh();
            const sent = await botSender.sendBotMessage(target, plan.destination, outgoing, {
              signal,
              deliveryGuard: options.deliveryGuard,
              replyTo: sameChat && plan.quote !== false ? quoted || replyAnchor : null,
              quoted: sameChat && plan.quote !== false ? quoted || replyAnchor : null,
              quote: sameChat && plan.quote !== false,
              levix,
            });
            if (!sent?.key || sent.refused) throw controlError("REACTION_DELIVERY_REFUSED");
            return sent;
          }
          if (sameChat) opts.quoted = quoted;
          else if ("quoted" in opts) delete opts.quoted;
          const sent = await target.sendMessage.call(target, plan.destination, outgoing, opts);
          if (sent?.key && !sent.key.remoteJid) sent.key.remoteJid = plan.destination;
          return sent;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return proxy;
}

function stampText(content, commandName, levix) {
  if (!content || typeof content !== "object" || typeof content.text !== "string") return content;
  if (content.image || content.video || content.audio || content.document || content.sticker) {
    return content;
  }
  const text = stampWatermark(content.text, {
    commandName,
    category: levix?.category || "result",
    exact: levix?.exact === true || levix?.sensitivity === "secret",
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
    await botSender.sendBotMessage(sock, msg.key.remoteJid, { text }, { replyTo: msg });
    return true;
  }

  // Everything this command sends goes out in one language: the bot's, or in
  // "auto" the one this message is written in — judged on the arguments, not
  // on the command's own keywords (see utils/i18n.cjs).
  const aliases = runtimeConfig.getAliases(command.name, command.__declaredAliases || []);
  const lang = langForCommand(command, args, aliases);
  return withLang(lang, async () => {
    const outcome = await executeCommandInvocation(sock, {
      command,
      invokedName,
      args,
      body,
      msg,
      isGroup,
      rawRemainder: parsed.rawRemainder,
      accountEpoch: epoch,
      options: {
        source: "text",
        editInPlace: !EDIT_IN_PLACE_EXCLUDE.has(command.name),
        commandName: command.name,
      },
    });
    if (outcome?.status === "failed") throw outcome.error;
    return true;
  });
}

function deny(status, reason) {
  return { status, reason };
}

/**
 * Sync command gates. Reaction delivery re-checks this after media preparation
 * using the roster `refresh` just loaded. Typed commands call it after their
 * own fresh roster read.
 */
export function evaluateCommandGates(sock, invocation, authMetadata) {
  const { command, msg, isGroup, accountEpoch } = invocation;
  const options = invocation.options || {};
  if (!command || command.name === "group") {
    if (readAccountEpoch() !== accountEpoch) return deny("stale", "account");
    return { status: "ready" };
  }
  if (runtimeConfig.isDisabled(command.name)) return deny("disabled", "disabled");
  const chatScope = (command.chat || "all").toLowerCase();
  if (chatScope === "group" && !isGroup) return deny("denied", "scope");
  if (chatScope === "private" && isGroup) return deny("denied", "scope");
  const permissionKey = command.__category === "group" ? `group:${command.name}` : command.name;
  const permissionCheck = checkCommandPermission(permissionKey, msg, authMetadata, sock);
  if (!permissionCheck.hasPermission) return deny("denied", "permission");
  if (command.userAdminRequired && !permissionCheck.isSenderAdmin) return deny("denied", "admin");
  if (command.botAdminRequired && !checkBotAdmin(authMetadata, sock))
    return deny("denied", "botAdmin");
  if (readAccountEpoch() !== accountEpoch) return deny("stale", "account");
  if (options.routeMode) {
    const plan = planForSend(
      msg.key.remoteJid,
      msg.key.remoteJid,
      options.requester?.jid || options.senderJid || msg.key.participant || msg.key.remoteJid,
      command.name,
      null,
      options.routeMode,
    );
    if (!plan.allow) return deny("failed", "REACTION_DELIVERY_REFUSED");
  }
  return { status: "ready", permissionCheck };
}

async function explainDenial(sock, msg, anchor, status, reason) {
  const key =
    status === "disabled"
      ? "bot.core.commandHandler.disabled"
      : reason === "scope" && (msg.key.remoteJid || "").endsWith("@g.us")
        ? "bot.core.commandHandler.privateOnly"
        : reason === "scope"
          ? "bot.core.commandHandler.groupsOnly"
          : reason === "admin"
            ? "bot.core.commandHandler.adminRequired"
            : reason === "botAdmin"
              ? "bot.core.commandHandler.botAdminRequired"
              : null;
  if (!key && reason === "permission") return;
  const text = key ? t(key) : null;
  if (!text) return;
  await botSender.sendBotMessage(sock, msg.key.remoteJid, { text }, { replyTo: anchor || msg });
}

export async function executeCommandInvocation(sock, invocation) {
  const options = invocation.options || {};
  const source = options.source === "reaction" ? "reaction" : "text";
  const silent = source === "reaction" || options.silentDenials === true;
  const neutral = source === "reaction" || options.neutralFailure === true;
  const command = invocation.command;
  const msg = invocation.msg;
  const isGroup = invocation.isGroup;
  const accountEpoch = invocation.accountEpoch;
  const invokedName = invocation.invokedName || command?.name || "";
  const aliases = runtimeConfig.getAliases(command.name, command.__declaredAliases || []);
  const lang = langForCommand(command, invocation.args || [], aliases);
  return withLang(lang, () =>
    runInvocation(sock, invocation, {
      source,
      silent,
      neutral,
      invokedName,
      isGroup,
      accountEpoch,
    }),
  );
}

async function runInvocation(sock, invocation, flags) {
  const { source, silent, neutral, invokedName, isGroup, accountEpoch } = flags;
  const options = invocation.options || {};
  const command = invocation.command;
  const msg = invocation.msg;
  const args = invocation.args || [];
  const body = invocation.body;
  const anchor = options.replyAnchor || msg;
  let authMetadata = invocation.authMetadata;
  if (!options.rosterReady && isGroup) {
    authMetadata = await resolveGroupMetadata(sock, msg.key.remoteJid, { fresh: true });
  }
  const groupMetadata = isGroup ? authMetadata || getCached(msg.key.remoteJid) || null : null;
  const gate = evaluateCommandGates(
    sock,
    { ...invocation, isGroup, accountEpoch, options },
    authMetadata,
  );
  if (gate.status !== "ready") {
    if (gate.status === "stale") {
      logger.debug("[Command] skipped account work after account change");
      return gate;
    }
    if (!silent) {
      if (gate.reason === "permission") {
        const permissionKey =
          command.__category === "group" ? `group:${command.name}` : command.name;
        const permissionCheck = checkCommandPermission(permissionKey, msg, authMetadata, sock);
        await botSender.sendBotMessage(
          sock,
          msg.key.remoteJid,
          { text: permissionCheck.reason },
          { replyTo: anchor },
        );
      } else {
        await explainDenial(sock, msg, anchor, gate.status, gate.reason);
      }
    }
    if (gate.reason === "REACTION_DELIVERY_REFUSED")
      return { status: "failed", reason: gate.reason };
    return gate;
  }
  if (options.preflight) return { status: "ready" };

  const rosterVersion = isGroup ? getRosterVersion(msg.key.remoteJid) : undefined;
  const state = { attempted: 0 };
  const ctx = {
    invokedName,
    canonicalName: command.name,
    isAlias: invokedName !== command.name,
    groupMetadata,
    authGroupMetadata: authMetadata,
    rawRemainder: invocation.rawRemainder || "",
    accountEpoch,
    source,
    silentDenials: silent,
    signal: options.signal,
    beforeEffect: options.beforeEffect,
    requester: options.requester || null,
    effectGuard: options.effectGuard,
    ...(isGroup ? { rosterVersion } : {}),
  };
  const proxiedSock = wrapSockWithReply(sock, msg, {
    ...options,
    source,
    editInPlace: source === "reaction" ? false : options.editInPlace === true,
    commandName: options.commandName || command.name,
    silentDenials: silent,
    state,
    replyAnchor: anchor,
  });
  if (readAccountEpoch() !== accountEpoch) {
    logger.debug("[Command] skipped account work after account change");
    return { status: "stale", reason: "account" };
  }
  try {
    await withCommand(command.name, () =>
      command.execute(proxiedSock, msg, args, body, groupMetadata, ctx),
    );
    return { status: "executed", reason: "ok" };
  } catch (error) {
    const code = error?.code || error?.message;
    if (source === "reaction" && REACTION_CONTROL_CODES.has(code)) {
      return { status: "failed", reason: code, error };
    }
    logger.error({ err: error, command: invokedName }, "Error executing command");
    if (neutral) {
      if (state.attempted > 0) return { status: "failed", reason: "ACTION_FAILED", error };
      try {
        await botSender.sendBotMessage(
          sock,
          msg.key.remoteJid,
          {
            text: t("bot.core.commandHandler.failed", {
              name: error.name || "Error",
              details: t("bot.core.commandHandler.unknownDetails"),
            }),
          },
          { replyTo: anchor },
        );
      } catch {}
      return { status: "failed", reason: "REACTION_COMMAND_FAILED", error };
    }
    try {
      await botSender.sendBotMessage(
        sock,
        msg.key.remoteJid,
        {
          text: t("bot.core.commandHandler.failed", {
            name: error.name || "Error",
            details: error.message || t("bot.core.commandHandler.unknownDetails"),
          }),
        },
        { replyTo: anchor },
      );
    } catch {}
    throw error;
  }
}
