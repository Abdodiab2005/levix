import { createRequire } from "module";
import { handleCommand } from "./command.handler.js";
import { handleAntiSpam } from "../middleware/antispam.middleware.js";
import { checkBlacklist } from "../middleware/blacklist.middleware.js";
import { trackForwardedMessage } from "../middleware/forward-tracking.middleware.js";
import { updateUserLastSeen, saveUserMetadata } from "../utils/storage.esm.js";
import { rememberMessage } from "../utils/recentMessageCache.esm.js";
import normalizeJid from "../utils/normalizeJid.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");

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

  // Baileys' getMessage hook needs to hand back messages WE sent when a peer
  // asks for a retry (see utils/recentMessageCache.esm.js). Only our own
  // outgoing messages are kept, in memory, and only for that purpose.
  if (msg.key?.fromMe && msg.key.id && msg.message) {
    rememberMessage(msg.key.id, msg);
  }

  if (!hasUserContent(msg.message)) return;

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
  const body =
    msg.message?.conversation ||
    msg.message?.extendedTextMessage?.text ||
    msg.message?.imageMessage?.caption ||
    msg.message?.videoMessage?.caption ||
    msg.message?.documentMessage?.caption ||
    "";
  const isGroup = msg.key.remoteJid.endsWith("@g.us");

  // Update user metadata (last seen)
  const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);
  if (
    senderId &&
    !senderId.includes("@broadcast") &&
    !senderId.includes("@newsletter")
  ) {
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

  if (isGroup) {
    const isBlacklisted = await checkBlacklist(sock, msg);
    if (isBlacklisted) return;
  }

  // Try to handle as command
  try {
    const wasCommand = await handleCommand(sock, msg, body);
    if (wasCommand) {
      logger.info(`[Message] Handled as command: "${body}"`);
      return;
    }
  } catch (error) {
    logger.error({ err: error }, "Error handling command");
  }

  // Handle regular group messages (moderation)
  if (isGroup) {
    await handleGroupModeration(sock, msg);
  }
}

// Handle group moderation
async function handleGroupModeration(sock, msg) {
  try {
    const { handleAntiLink } = require("../commands/group/antilink.cjs");
    const { handleMediaControl } = require("../commands/group/media.cjs");

    const linkActionTaken = await handleAntiLink(sock, msg, {}, normalizeJid);
    if (linkActionTaken) return;

    const mediaActionTaken = await handleMediaControl(
      sock,
      msg,
      {},
      normalizeJid
    );
    if (mediaActionTaken) return;

    await handleAntiSpam(sock, msg);
  } catch (error) {
    logger.error({ err: error }, "Error in group moderation");
  }
}
