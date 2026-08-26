// file: /middleware/forward-tracking.middleware.js
import { createRequire } from "module";
import { incrementForwardScore } from "../utils/storage.esm.js";
import normalizeJid from "../utils/normalizeJid.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");

/**
 * Track forwarded messages and increment their score
 * @param {object} msg - WhatsApp message object
 */
export async function trackForwardedMessage(msg) {
  try {
    // Check if this is a forwarded message
    const contextInfo =
      msg.message?.extendedTextMessage?.contextInfo ||
      msg.message?.imageMessage?.contextInfo ||
      msg.message?.videoMessage?.contextInfo ||
      msg.message?.documentMessage?.contextInfo ||
      msg.message?.audioMessage?.contextInfo;

    // A message is considered forwarded if it has isForwarded flag or forwardingScore > 0
    const isForwarded = contextInfo?.isForwarded || (contextInfo?.forwardingScore && contextInfo.forwardingScore > 0);

    if (!isForwarded) {
      return false;
    }

    const messageId = msg.key.id;
    const groupId = msg.key.remoteJid;
    const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);

    // Only track forwarded messages in groups
    if (!groupId.endsWith("@g.us")) {
      return false;
    }

    // Increment the forward score
    const newScore = incrementForwardScore(messageId, groupId, senderId);

    logger.info(`[Forward Tracking] Message ${messageId} forwarded. New score: ${newScore}`);

    return true;
  } catch (error) {
    logger.error({ err: error }, "Error tracking forwarded message");
    return false;
  }
}
