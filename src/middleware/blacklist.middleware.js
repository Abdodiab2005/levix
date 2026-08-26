import { createRequire } from 'module';
import { getGroupSettings } from '../utils/storage.esm.js';
import normalizeJid from '../utils/normalizeJid.esm.js';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger.cjs');

// Check if user is blacklisted in the group
export async function checkBlacklist(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId.endsWith('@g.us')) return false;

  const senderId = normalizeJid(msg.key.participant || msg.key.remoteJid);
  const settings = getGroupSettings(groupId);

  if (settings?.blacklist?.includes(senderId)) {
    const groupMetadata = await sock.groupMetadata(groupId);
    const isSenderAdmin = groupMetadata.participants.some(
      (p) => p.admin && p.id === senderId
    );

    if (!isSenderAdmin) {
      logger.info(`Ignoring message from blacklisted user ${senderId}`);
      return true;
    }
  }

  return false;
}
