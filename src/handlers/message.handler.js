import { createRequire } from "module";
import { observeAntiSpam } from "../middleware/antispam.middleware.js";
import { checkBlacklist } from "../middleware/blacklist.middleware.js";
import { trackForwardedMessage } from "../middleware/forward-tracking.middleware.js";
import normalizeJid from "../utils/normalizeJid.esm.js";
import { getSenderCandidates, isBotAdminInGroup, sameUser } from "../utils/permissions.esm.js";
import { accountEpoch, saveUserMetadata, updateUserLastSeen } from "../utils/storage.esm.js";
import { handleCommand } from "./command.handler.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { visibleText } = require("../utils/messageContent.cjs");
const { detectLang, withLang } = require("../utils/i18n.cjs");
const autoDelete = require("../services/autoDelete.cjs");

// Envelopes that carry no user-visible content: message revokes and edits
// (protocolMessage), reactions, poll votes, the undecrypted edit envelope, and
// the sibling keys WhatsApp ships alongside a real message.
//
// These used to be swallowed by the anti-delete handler, which returned early
// on them. With that handler gone they have to be filtered here instead —
// otherwise they reach group moderation, where anti-spam counts each one as a
// message from the sender and deleting a few of your own messages in a row
// gets you warned or kicked.
const NON_CONTENT_KEYS = new Set([
  "protocolMessage",
  "reactionMessage",
  "pollUpdateMessage",
  "secretEncryptedMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
]);

// True when the envelope holds something a person actually sent. Note the
// `.some()`: WhatsApp routinely ships senderKeyDistributionMessage next to a
// real `conversation`, so we look for any content key rather than testing the
// first one.
function hasUserContent(message) {
  if (!message) return false;
  return Object.keys(message).some((key) => !NON_CONTENT_KEYS.has(key));
}

// Handle incoming messages
export async function handleIncomingMessage(sock, m) {
  if (m.type !== "notify" || !m.messages[0]) return;

  const msg = m.messages[0];

  // "Message absent from node" is a CIPHERTEXT placeholder: the message node
  // arrived but its content couldn't be decrypted (Baileys requests a resend).
  if (msg?.messageStubParameters?.[0] === "Message absent from node") {
    logger.debug("[Message] Skipping undecryptable/absent message stub");
    return;
  }

  if (!hasUserContent(msg.message)) return;

  // Captured before the first await. A later unlink, logout or activation
  // advances the epoch and the metadata write below is skipped.
  const epoch = accountEpoch();

  // Track forwarded messages
  await trackForwardedMessage(msg);

  // Skip onward processing for status broadcasts and newsletters.
  if (
    msg.key.remoteJid === "status@broadcast" ||
    msg.key.remoteJid?.endsWith("@broadcast") ||
    msg.key.remoteJid?.endsWith("@newsletter")
  ) {
    return;
  }

  // Parse message context. Crucially we ALSO consider media captions —
  // otherwise sending an image with caption "!gemini حلل ده" is invisible
  // to the command handler and the user sees nothing happen.
  const body = visibleText(msg.message);

  // Keyword auto-delete: after content/status skip, before blacklist/commands
  // /moderation. A successful delete stops the rest of the pipeline.
  try {
    const deleted = await autoDelete.handleIncoming(sock, msg, body, {
      sameUser,
      getSenderCandidates,
      isBotAdminInGroup,
    });
    if (deleted) return;
  } catch (error) {
    logger.error({ err: error }, "auto-delete hook failed");
  }

  // Everything the bot says about this message — a moderation warning, a
  // command's reply — goes out in one language (see utils/i18n.cjs). A
  // command narrows this down to its own arguments.
  return withLang(detectLang(body), () => processMessage(sock, msg, body, epoch));
}

export async function processMessage(sock, msg, body, epoch) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");

  // Update user metadata (last seen)
  const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);
  if (senderId && !senderId.includes("@broadcast") && !senderId.includes("@newsletter")) {
    if (accountEpoch() !== epoch) {
      logger.debug("[Message] skipped account metadata write after account change");
    } else {
      try {
        saveUserMetadata({
          jid: senderId,
          lid: null,
          phone: senderId.split("@")[0],
          displayName: msg.pushName || null,
        });
        updateUserLastSeen(senderId);
      } catch (err) {
        logger.error({ err }, "Failed to update user metadata");
      }
    }
  }

  if (isGroup) {
    const isBlacklisted = await checkBlacklist(sock, msg);
    if (isBlacklisted) return;
  }

  // The epoch from message entry is this message's account lifetime. A command
  // or a moderation pass that samples accountEpoch() later would otherwise act
  // for the account that paired while this message was still in flight.
  if (accountEpoch() !== epoch) {
    logger.debug("[Message] skipped account work after account change");
    return;
  }

  // Try to handle as command
  try {
    const wasCommand = await handleCommand(sock, msg, body, epoch);
    if (wasCommand) {
      const text = typeof body === "string" ? body : "";
      const command = text.trim().split(/\s+/, 1)[0] || "";
      logger.info(
        { command, chat: isGroup ? "group" : "private", bodyLength: text.length },
        "[Message] Handled as command",
      );
      return;
    }
  } catch (error) {
    logger.error({ err: error }, "Error handling command");
  }

  // Handle regular group messages (moderation)
  let moderationActed = false;
  if (isGroup) {
    if (accountEpoch() !== epoch) {
      logger.debug("[Message] skipped account work after account change");
      return;
    }
    const result = await handleGroupModeration(sock, msg, epoch);
    moderationActed = Boolean(result?.acted);
  }

  if (!moderationActed) {
    try {
      const { host } = require("../extensions/host.cjs");
      const pending = host.dispatchAutoReply(sock, msg, epoch);
      if (pending && typeof pending.catch === "function") {
        pending.catch((error) => logger.error({ err: error }, "auto-reply dispatch failed"));
      }
    } catch (error) {
      logger.error({ err: error }, "auto-reply dispatch failed");
    }
  }
}

// One message, one decision. Detectors only report hits; enforceHits applies
// them. A missing id is refused here so a live redelivery cannot be guessed.
// Direct detector calls used by older tests still enforce without an id.
export async function handleGroupModeration(sock, msg, accountEpoch) {
  try {
    if (!msg?.key?.id) {
      logger.warn(
        { group: msg?.key?.remoteJid },
        "Skipping group moderation: message has no id",
      );
      return;
    }

    const { detectAntiLink } = require("../commands/group/antilink.cjs");
    const { detectMedia } = require("../commands/group/media.cjs");
    const { detectForbiddenWords } = require("../commands/mod.cjs");
    const { enforceHits, isProtectedMember, senderCandidates } = require("../utils/moderationAction.cjs");
    const { getGroupSettings } = require("../utils/storage.cjs");
    const { resolveGroupMetadata } = require("../utils/groupMetadataCache.cjs");
    const { resolveModerationPolicy } = require("../services/moderationPolicy.cjs");

    const groupId = msg.key.remoteJid;
    const settings = getGroupSettings(groupId) || {};
    resolveModerationPolicy(settings);
    const groupMetadata = await resolveGroupMetadata(sock, groupId);
    const candidates = senderCandidates(msg, sock);
    if (msg.key.fromMe || isProtectedMember(sock, groupMetadata, candidates)) return;

    const hits = [];
    const collect = (name, fn) => {
      try {
        const hit = fn();
        if (hit) hits.push(hit);
      } catch (error) {
        logger.error({ err: error, detector: name }, "moderation detector failed");
      }
    };
    collect("forbidden", () => detectForbiddenWords(msg, settings));
    collect("link", () => detectAntiLink(msg, settings));
    collect("media", () => detectMedia(msg, settings));
    try {
      const spam = await observeAntiSpam(sock, msg, settings);
      if (spam) hits.push(spam);
    } catch (error) {
      logger.error({ err: error, detector: "spam" }, "moderation detector failed");
    }
    if (!hits.length) return;
    return await enforceHits(sock, {
      msg,
      groupMetadata,
      hits,
      ...(Number.isInteger(accountEpoch) ? { accountEpoch } : {}),
    });
  } catch (error) {
    logger.error({ err: error }, "Error in group moderation");
  }
}
