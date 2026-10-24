import { createRequire } from "module";
import {
  getSenderCandidates,
  isAdminInGroup,
  isBotAdminUser,
  isOwnerJid,
  sameUser,
} from "../utils/permissions.esm.js";
import { getGroupSettings, getPnForLid } from "../utils/storage.esm.js";
import { resolveGroupMetadata } from "../utils/groupMetadataCache.cjs";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { enforceGroupRule } = require("../utils/moderationAction.cjs");
const { featureActionOf } = require("../utils/moderationSummary.cjs");

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

function identityKeys(groupId, candidates) {
  const ids = new Set();
  const stable = stableSenderId(candidates);
  if (stable) ids.add(stable);
  for (const candidate of candidates) {
    if (candidate) ids.add(candidate);
    try {
      const mapped = getPnForLid(candidate);
      if (mapped) ids.add(mapped);
    } catch {}
  }
  return [...ids].map((id) => `${groupId}::${id}`);
}

function mergeSpamBucket(groupId, candidates, now, timeWindow) {
  const keys = identityKeys(groupId, candidates);
  const timestamps = [];
  for (const key of keys) {
    const bucket = userMessageTimestamps.get(key);
    if (bucket?.timestamps) timestamps.push(...bucket.timestamps);
  }
  timestamps.push(now);
  const recent = timestamps.filter((ts) => now - ts < timeWindow);
  const canonical = `${groupId}::${stableSenderId(candidates) || candidates[0]}`;
  for (const key of keys) {
    if (key !== canonical) userMessageTimestamps.delete(key);
  }
  userMessageTimestamps.set(canonical, { timestamps: recent, lastSeen: now });
  return { recent, canonical };
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
  // Cache-first: antispam runs on EVERY group message, so this read must not
  // be a live query (see utils/groupMetadataCache.cjs).
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
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
  const { recent: recentTimestamps, canonical } = mergeSpamBucket(
    groupId,
    senderCandidates,
    now,
    timeWindow,
  );

  // Check if user exceeded message count
  if (recentTimestamps.length > (spamConfig.message_count || 5)) {
    logger.warn({ user: senderId, group: groupId }, "Spam detected, taking action.");

    const kickNow = featureActionOf(settings, "antispam") === "KICK";
    await enforceGroupRule(sock, {
      msg,
      groupMetadata,
      rule: "spam",
      warningReason: "antispam",
      deleteMessage: false,
      recordWarning: true,
      kickImmediately: kickNow,
      targetCandidates: senderCandidates,
    });

    userMessageTimestamps.delete(canonical);
  }
}
