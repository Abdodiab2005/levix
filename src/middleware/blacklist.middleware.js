import { createRequire } from "module";
import { getSenderCandidates, isAdminInGroup, sameUser } from "../utils/permissions.esm.js";
import { getGroupSettings } from "../utils/storage.esm.js";
import { resolveGroupMetadata } from "../utils/groupMetadataCache.cjs";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");

// Check if user is blacklisted in the group
export async function checkBlacklist(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId.endsWith("@g.us")) return false;

  const senderCandidates = getSenderCandidates(msg, sock);
  const senderId = senderCandidates[0];
  if (!senderId) return false;
  const settings = getGroupSettings(groupId);
  const listed = (settings?.blacklist || []).some((entry) =>
    senderCandidates.some((candidate) => sameUser(entry, candidate)),
  );

  if (listed) {
    // Cache-first: admin detection for a blacklisted sender, only when the
    // blacklist actually matched (see utils/groupMetadataCache.cjs).
    const groupMetadata = await resolveGroupMetadata(sock, groupId);
    const isSenderAdmin = senderCandidates.some((candidate) =>
      isAdminInGroup(groupMetadata, candidate),
    );

    if (!isSenderAdmin) {
      logger.info(`Ignoring message from blacklisted user ${senderId}`);
      return true;
    }
  }

  return false;
}
