import { makeWASocket } from '@whiskeysockets/baileys';
import NodeCache from 'node-cache';
import {
  getBaileysConfig,
  setRecentMessageGetter,
} from '../config/baileys.config.js';
import { CACHE_CONFIG } from '../config/constants.js';
import { useDatabaseAuthState } from '../auth/use-database-auth-state.js';
import { getMessageFromRecent } from '../utils/recentMessageCache.esm.js';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const logger = require('../utils/logger.cjs');
const { withMediaThumbnail } = require('../utils/thumbnail.cjs');

// Group metadata cache
export const groupMetadataCache = new NodeCache(CACHE_CONFIG);

// Wire the recent-message cache into Baileys' getMessage hook so retries can
// recover (rc10 enableAutoSessionRecreation needs this).
setRecentMessageGetter(getMessageFromRecent);

/**
 * Baileys can't generate media previews in this install (no sharp/jimp, and its
 * video path shells out to a bare `ffmpeg` that isn't on the PATH), so every
 * image/video we sent went out with a blank thumbnail. Patch sendMessage once,
 * at the socket level, so EVERY caller gets a preview — commands that use
 * sendBotMessage and the handful of legacy commands still calling
 * sock.sendMessage directly.
 */
function withThumbnailSupport(sock) {
  const original = sock.sendMessage.bind(sock);

  sock.sendMessage = async function sendMessageWithThumbnail(jid, content, options) {
    let payload = content;
    try {
      payload = await withMediaThumbnail(content);
    } catch (err) {
      logger.debug({ err: err?.message }, '[Socket] thumbnail step skipped');
      payload = content;
    }
    return original(jid, payload, options);
  };

  return sock;
}

// Create and configure WhatsApp socket
export async function createWhatsAppSocket() {
  logger.info('[Socket] Initializing WhatsApp socket with database auth');

  const { state, saveCreds, clearAll } = await useDatabaseAuthState();

  const cachedGroupMetadata = (jid) => groupMetadataCache.get(jid);

  const sock = withThumbnailSupport(
    makeWASocket({
      auth: state,
      ...getBaileysConfig(cachedGroupMetadata),
    })
  );

  return { sock, saveCreds, clearAll };
}
