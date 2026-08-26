import { createRequire } from 'module';
import { getGroupSettings } from '../utils/storage.esm.js';
import normalizeJid from '../utils/normalizeJid.esm.js';
import {
  isOwnerJid,
  isAdminInGroup,
} from '../utils/permissions.esm.js';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger.cjs');

const userMessageTimestamps = new Map();

// Handle anti-spam detection and action
export async function handleAntiSpam(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId.endsWith('@g.us')) return;

  const senderId = normalizeJid(msg.key.participant);
  const settings = getGroupSettings(groupId);
  const spamConfig = settings?.antispam;

  if (!spamConfig || !spamConfig.enabled) return;

  // Owners and admins are immune. The legacy owner mirror it used to import was
  // only ever populated with the bot's own JID, so real operators were
  // counted as spammers — the centralized check fixes that.
  const isOwner = isOwnerJid(senderId);
  const groupMetadata = await sock.groupMetadata(groupId);
  const isSenderAdmin = isAdminInGroup(groupMetadata, senderId);

  if (isOwner || isSenderAdmin) return;

  // Track message timestamps
  const now = Date.now();
  if (!userMessageTimestamps.has(senderId)) {
    userMessageTimestamps.set(senderId, []);
  }

  const userTimestamps = userMessageTimestamps.get(senderId);
  userTimestamps.push(now);

  // Filter timestamps within time window
  const timeWindow = (spamConfig.time_window || 10) * 1000;
  const recentTimestamps = userTimestamps.filter((ts) => now - ts < timeWindow);
  userMessageTimestamps.set(senderId, recentTimestamps);

  // Check if user exceeded message count
  if (recentTimestamps.length > (spamConfig.message_count || 5)) {
    logger.warn({ user: senderId, group: groupId }, 'Spam detected, taking action.');

    // Take action based on config
    if (spamConfig.action === 'KICK') {
      await sock.sendMessage(groupId, {
        text: `🚫 تم حذف @${senderId.split('@')[0]} بسبب الإزعاج (Spam).`,
        mentions: [senderId],
      });
      await sock.groupParticipantsUpdate(groupId, [senderId], 'remove');
    } else {
      await sock.sendMessage(groupId, {
        text: `⚠️ تحذير لـ @${senderId.split('@')[0]}! الرجاء عدم إرسال رسائل مزعجة.`,
        mentions: [senderId],
      });
    }

    userMessageTimestamps.delete(senderId);
  }
}
