import { createRequire } from "module";
import {
  getSenderCandidates,
  isAdminInGroup,
  isBotAdminUser,
  isOwnerJid,
  sameUser,
} from "../utils/permissions.esm.js";
import { getGroupSettings, getPnForLid } from "../utils/storage.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");

const userMessageTimestamps = new Map();

function stableSenderId(candidates) {
  const phoneJid = candidates.find((jid) => jid.endsWith("@s.whatsapp.net"));
  if (phoneJid) return phoneJid;
  for (const candidate of candidates) {
    try {
      const mapped = getPnForLid(candidate);
      if (mapped) return mapped;
    } catch {}
  }
  return candidates[0] || null;
}

// Handle anti-spam detection and action
export async function handleAntiSpam(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId.endsWith("@g.us")) return;

  const senderCandidates = getSenderCandidates(msg, sock);
  const senderId = senderCandidates[0];
  if (!senderId) return;
  const settings = getGroupSettings(groupId);
  const spamConfig = settings?.antispam;

  if (!spamConfig || !spamConfig.enabled) return;

  // Owners and admins are immune. The legacy owner mirror it used to import was
  // only ever populated with the bot's own JID, so real operators were
  // counted as spammers — the centralized check fixes that.
  const groupMetadata = await sock.groupMetadata(groupId);
  const protectedSender = senderCandidates.some(
    (candidate) =>
      isOwnerJid(candidate) ||
      isBotAdminUser(candidate) ||
      isAdminInGroup(groupMetadata, candidate) ||
      [sock.user?.id, sock.user?.lid].filter(Boolean).some((botId) => sameUser(candidate, botId)),
  );

  if (protectedSender) return;

  // Track message timestamps
  const now = Date.now();
  const timeWindow = (spamConfig.time_window || 10) * 1000;
  for (const [key, entry] of userMessageTimestamps) {
    if (now - entry.lastSeen > timeWindow) userMessageTimestamps.delete(key);
  }
  const identity = stableSenderId(senderCandidates);
  const bucketKey = `${groupId}::${identity}`;
  const bucket = userMessageTimestamps.get(bucketKey) || { timestamps: [], lastSeen: now };
  const userTimestamps = bucket.timestamps;
  userTimestamps.push(now);

  // Filter timestamps within time window
  const recentTimestamps = userTimestamps.filter((ts) => now - ts < timeWindow);
  userMessageTimestamps.set(bucketKey, { timestamps: recentTimestamps, lastSeen: now });

  // Check if user exceeded message count
  if (recentTimestamps.length > (spamConfig.message_count || 5)) {
    logger.warn({ user: senderId, group: groupId }, "Spam detected, taking action.");

    // Take action based on config
    if (spamConfig.action === "KICK") {
      await sock.sendMessage(groupId, {
        text: `🚫 تم حذف @${senderId.split("@")[0]} بسبب الإزعاج (Spam).`,
        mentions: [senderId],
      });
      await sock.groupParticipantsUpdate(groupId, [senderId], "remove");
    } else {
      await sock.sendMessage(groupId, {
        text: `⚠️ تحذير لـ @${senderId.split("@")[0]}! الرجاء عدم إرسال رسائل مزعجة.`,
        mentions: [senderId],
      });
    }

    userMessageTimestamps.delete(bucketKey);
  }
}
