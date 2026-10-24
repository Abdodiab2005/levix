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
const seenMessageIds = [];
const spamHitIds = [];

function rememberCapped(list, id) {
  if (!id || list.includes(id)) return;
  list.push(id);
  if (list.length > 200) list.shift();
}

function spamHit(rule = "spam") {
  return { rule, reason: "antispam" };
}

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

// Record one message and return a spam hit when the window is exceeded.
// Disabled anti-spam does not record. A message id is observed once; a hit id
// still reports a hit after the bucket is cleared so a redelivery can retry.
// Callers with no id (older tests) record on every call.
export async function observeAntiSpam(sock, msg, settings) {
  const groupId = msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return null;
  const spamConfig = settings?.antispam ?? getGroupSettings(groupId)?.antispam;
  if (!spamConfig?.enabled) return null;

  const messageId = msg.key?.id || null;
  const stamp = messageId ? `${groupId}:${messageId}` : null;
  if (stamp && spamHitIds.includes(stamp)) return spamHit();
  if (stamp && seenMessageIds.includes(stamp)) return null;

  const senderCandidates = getSenderCandidates(msg, sock);
  if (!senderCandidates.length) return null;

  const now = Date.now();
  const timeWindow = (spamConfig.time_window || 10) * 1000;
  for (const [key, entry] of userMessageTimestamps) {
    if (now - entry.lastSeen > timeWindow) userMessageTimestamps.delete(key);
  }
  const { recent, canonical } = mergeSpamBucket(groupId, senderCandidates, now, timeWindow);
  if (stamp) rememberCapped(seenMessageIds, stamp);
  if (recent.length > (spamConfig.message_count || 5)) {
    userMessageTimestamps.delete(canonical);
    if (stamp) rememberCapped(spamHitIds, stamp);
    return spamHit();
  }
  return null;
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

  // Owners and admins are immune. Checked before observe so a protected
  // sender is not recorded. Cache-first: antispam runs on every group message.
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  const protectedSender = senderCandidates.some(
    (candidate) =>
      isOwnerJid(candidate) ||
      isBotAdminUser(candidate) ||
      isAdminInGroup(groupMetadata, candidate) ||
      [sock.user?.id, sock.user?.lid].filter(Boolean).some((botId) => sameUser(candidate, botId)),
  );

  if (protectedSender) return;

  const hit = await observeAntiSpam(sock, msg, settings);
  if (!hit) return;

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
}
