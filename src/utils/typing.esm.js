// Typing simulation utility
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('./logger.cjs');

/**
 * Simulates typing with a random delay between 300-500ms
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} jid - Chat JID to send typing indicator to
 * @param {number} minDelay - Minimum delay in ms (default: 300)
 * @param {number} maxDelay - Maximum delay in ms (default: 500)
 * @returns {Promise<void>}
 */
export async function simulateTyping(sock, jid, minDelay = 300, maxDelay = 500) {
  try {
    // Send typing indicator
    await sock.sendPresenceUpdate('composing', jid);

    // Random delay between min and max
    const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
    await new Promise(resolve => setTimeout(resolve, delay));

    // Stop typing indicator
    await sock.sendPresenceUpdate('paused', jid);
  } catch (error) {
    logger.error({ err: error }, '[Typing] Error simulating typing');
  }
}

/**
 * Send a message with typing simulation
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} jid - Chat JID
 * @param {Object} message - Message content
 * @param {boolean} withTyping - Whether to simulate typing (default: true)
 * @returns {Promise<Object>} - Sent message info
 */
export async function sendMessageWithTyping(sock, jid, message, withTyping = true) {
  try {
    if (withTyping) {
      await simulateTyping(sock, jid);
    }

    const sent = await sock.sendMessage(jid, message);
    return sent;
  } catch (error) {
    logger.error({ err: error }, '[Typing] Error sending message with typing');
    throw error;
  }
}

/**
 * Calculate appropriate typing delay based on message length
 * Simulates realistic typing speed
 * @param {string} text - Message text
 * @param {number} charsPerSecond - Average typing speed (default: 40)
 * @returns {number} - Delay in ms (capped between 300-3000ms)
 */
export function calculateTypingDelay(text, charsPerSecond = 40) {
  if (!text) return 300;

  const baseDelay = (text.length / charsPerSecond) * 1000;
  // Cap between 300ms and 3000ms
  return Math.min(Math.max(baseDelay, 300), 3000);
}

/**
 * Send message with realistic typing delay based on text length
 * @param {Object} sock - WhatsApp socket instance
 * @param {string} jid - Chat JID
 * @param {Object} message - Message content
 * @returns {Promise<Object>} - Sent message info
 */
export async function sendMessageWithRealisticTyping(sock, jid, message) {
  try {
    const text = message.text || message.caption || '';
    const delay = calculateTypingDelay(text);

    // Send typing indicator
    await sock.sendPresenceUpdate('composing', jid);

    // Wait for calculated delay
    await new Promise(resolve => setTimeout(resolve, delay));

    // Stop typing and send message
    await sock.sendPresenceUpdate('paused', jid);
    const sent = await sock.sendMessage(jid, message);

    return sent;
  } catch (error) {
    logger.error({ err: error }, '[Typing] Error sending message with realistic typing');
    throw error;
  }
}

export default {
  simulateTyping,
  sendMessageWithTyping,
  calculateTypingDelay,
  sendMessageWithRealisticTyping,
};
