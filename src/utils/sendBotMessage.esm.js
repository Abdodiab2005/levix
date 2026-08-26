// Unified outbound message helper.
//
// Every command / handler in the bot should send replies through
// sendBotMessage(...) instead of calling sock.sendMessage directly. It does:
//
//   * typing simulation ("composing") before sending, with realistic delay
//     proportional to text length (capped 300-3000ms).
//   * a randomized inter-message delay per chat so several messages from the
//     same handler don't arrive bunched in the same second.
//   * automatic `quoted: msg` so the bot's reply is threaded under the
//     command. Pass `{ quote: false }` to opt out (e.g. status broadcasts).
//   * tracks the last bot-sent message per chat for follow-up updates.
//
// The helper is resilient: if presence updates fail (rare on Baileys v7) the
// message itself is still sent.

import { createRequire } from "module";

const require = createRequire(import.meta.url);
const logger = require("./logger.cjs");
const settings = require("../config/settings.cjs");

const lastSendTime = new Map(); // chatJid -> timestamp ms

// Read per send: both are editable from the dashboard.
function sendGap() {
  const min = Math.max(0, settings.get("bot_min_delay_ms"));
  return { min, max: Math.max(min, settings.get("bot_max_delay_ms")) };
}

function jitter(min, max) {
  if (max <= min) return min;
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function sleep(ms) {
  if (!ms || ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function typingDelayFor(content) {
  const text = content?.text || content?.caption || "";
  if (!text) return jitter(300, 700);
  // ~40 chars/sec typing rhythm, clamped to [400, 2500] ms
  const base = Math.min(2500, Math.max(400, (text.length / 40) * 1000));
  return Math.floor(base * (0.85 + Math.random() * 0.3));
}

async function safePresence(sock, jid, presence) {
  try {
    await sock.sendPresenceUpdate(presence, jid);
  } catch (err) {
    logger.debug({ err: err?.message, jid, presence }, "[sendBotMessage] presence failed");
  }
}

/**
 * Send a message with typing simulation, inter-message delay, and quoted reply.
 *
 * @param {object} sock - Baileys socket
 * @param {string} jid  - Chat JID
 * @param {object} content - Message content (passed to sock.sendMessage)
 * @param {object} options
 * @param {object} [options.quoted]  - Message to quote. Defaults to options.replyTo.
 * @param {object} [options.replyTo] - Original incoming message (auto-quoted).
 * @param {boolean} [options.quote=true]  - Set false to skip auto-quoting.
 * @param {boolean} [options.typing=true] - Set false to skip typing presence.
 * @param {number}  [options.delayMs]     - Override the inter-message gap.
 * @returns {Promise<object>} Baileys send result
 */
export async function sendBotMessage(sock, jid, content, options = {}) {
  const {
    replyTo = null,
    quoted = null,
    quote = true,
    typing = true,
    delayMs,
  } = options;

  // Respect the per-chat cooldown so multiple replies don't pile up instantly.
  const now = Date.now();
  const lastAt = lastSendTime.get(jid) || 0;
  const elapsed = now - lastAt;
  let targetGap;
  if (typeof delayMs === "number") {
    targetGap = Math.max(0, delayMs);
  } else {
    const { min, max } = sendGap();
    targetGap = jitter(min, max);
  }
  if (elapsed < targetGap) await sleep(targetGap - elapsed);

  if (typing) {
    await safePresence(sock, jid, "composing");
    await sleep(typingDelayFor(content));
    await safePresence(sock, jid, "paused");
  }

  const opts = {};
  if (quote) {
    const quotedMsg = quoted || replyTo;
    if (quotedMsg) opts.quoted = quotedMsg;
  }

  try {
    const sent = await sock.sendMessage(jid, content, opts);
    lastSendTime.set(jid, Date.now());
    return sent;
  } catch (err) {
    logger.error(
      { err, jid, contentKeys: Object.keys(content || {}) },
      "[sendBotMessage] sock.sendMessage failed"
    );
    throw err;
  }
}

/**
 * Helper: send a textual error message that includes the actual error name +
 * a concise reason, so we don't smear the user with "حدث خطأ" alone.
 *
 * @param {object} sock
 * @param {string} jid
 * @param {Error|string} err
 * @param {string} [arabicLead] - optional Arabic prefix ("معرفتش أعمل كذا")
 * @param {object} [options]    - forwarded to sendBotMessage
 */
export async function sendBotError(sock, jid, err, arabicLead = "حدث خطأ", options = {}) {
  const name = err?.name || (typeof err === "string" ? "Error" : "Error");
  const message =
    err?.message || (typeof err === "string" ? err : JSON.stringify(err));
  const text = `❌ *${arabicLead}*\n\n*النوع:* \`${name}\`\n*التفاصيل:* ${message}`.slice(
    0,
    1500
  );
  return sendBotMessage(sock, jid, { text }, options);
}

export default sendBotMessage;
