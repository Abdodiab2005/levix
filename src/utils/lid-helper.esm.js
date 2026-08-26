// Baileys v7 LID Helper Functions
// These functions help work with the new LID system

import { getLidForPn, getPnForLid } from '../utils/storage.esm.js';

/**
 * Get the preferred identifier for a user (LID if available, otherwise PN)
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} pn - Phone number JID (e.g., "1234567890@s.whatsapp.net")
 * @returns {Promise<string>} - LID if available, otherwise the original PN
 */
export async function getPreferredJid(sock, pn) {
  if (!pn || !pn.includes('@s.whatsapp.net')) {
    return pn; // Not a phone number, return as-is
  }

  try {
    // First check database
    const lidFromDb = getLidForPn(pn);
    if (lidFromDb) {
      return lidFromDb;
    }

    // Try to get from Baileys' internal store if available
    if (sock.signalRepository?.lidMapping) {
      const lid = await sock.signalRepository.lidMapping.getLIDForPN(pn);
      if (lid) {
        return lid;
      }
    }

    // Fallback to PN
    return pn;
  } catch (error) {
    // If any error, return the original PN
    return pn;
  }
}

/**
 * Convert LID to PN if needed
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} lid - LID JID (e.g., "lid@lid")
 * @returns {Promise<string>} - PN if found, otherwise the original LID
 */
export async function lidToPn(sock, lid) {
  if (!lid || !lid.includes('@lid')) {
    return lid; // Not a LID, return as-is
  }

  try {
    // First check database
    const pnFromDb = getPnForLid(lid);
    if (pnFromDb) {
      return pnFromDb;
    }

    // Try to get from Baileys' internal store if available
    if (sock.signalRepository?.lidMapping) {
      const pn = await sock.signalRepository.lidMapping.getPNForLID(lid);
      if (pn) {
        return pn;
      }
    }

    // Fallback to LID
    return lid;
  } catch (error) {
    return lid;
  }
}

/**
 * Get user identifier from message key
 * Returns LID if available, otherwise PN
 * @param {Object} sock - WhatsApp socket instance
 * @param {Object} msgKey - Message key object
 * @returns {Promise<string>} - User identifier (LID or PN)
 */
export async function getUserIdFromKey(sock, msgKey) {
  const isGroup = msgKey.remoteJid?.endsWith('@g.us');

  if (isGroup) {
    // In groups, use participant field
    const participantId = msgKey.participant || msgKey.remoteJid;

    // V7: Check for participantAlt (the alternate JID)
    if (msgKey.participantAlt) {
      // If we have participantAlt, the participant is likely a LID
      // Return the LID for privacy
      return participantId;
    }

    return participantId;
  } else {
    // In DMs, use remoteJid
    const remoteId = msgKey.remoteJid;

    // V7: Check for remoteJidAlt
    if (msgKey.remoteJidAlt) {
      // If we have remoteJidAlt, the remoteJid is likely a LID
      return remoteId;
    }

    return remoteId;
  }
}

/**
 * Format user mention using LID when available
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} jid - User JID (LID or PN)
 * @returns {Promise<Object>} - Object with mention text and mentions array
 */
export async function formatUserMention(sock, jid) {
  // Extract the number/ID part for display
  const displayId = jid.split('@')[0];

  return {
    text: `@${displayId}`,
    mentions: [jid]
  };
}

/**
 * Resolve multiple JIDs to their preferred format (LID when available)
 * @param {Object} sock - WhatsApp socket instance
 * @param {Array<string>} jids - Array of JIDs
 * @returns {Promise<Array<string>>} - Array of resolved JIDs
 */
export async function resolveJids(sock, jids) {
  const resolved = [];

  for (const jid of jids) {
    if (jid.includes('@s.whatsapp.net')) {
      resolved.push(await getPreferredJid(sock, jid));
    } else {
      resolved.push(jid);
    }
  }

  return resolved;
}
