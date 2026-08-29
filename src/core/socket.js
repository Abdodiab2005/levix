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

/**
 * Create and configure a WhatsApp socket.
 *
 * @param {object} [options]
 * @param {object|null} [options.proxy] - what createProxyAgents() returned, or
 *   null for a direct connection. Built by the session manager and passed in
 *   rather than read here, so this factory stays a pure function of its
 *   arguments and a test can hand it a fake.
 */
export async function createWhatsAppSocket({ proxy = null } = {}) {
  logger.info(
    proxy
      ? `[Socket] Initializing WhatsApp socket through ${proxy.label}`
      : '[Socket] Initializing WhatsApp socket with database auth'
  );

  const { state, saveCreds, clearAll } = await useDatabaseAuthState();

  // Whether this install is already paired. NOT `store.hasCredentials()`: the
  // auth state writes a `creds` row on its very first call, paired or not, so
  // that row proves nothing. `creds.me.id` is only filled in by a successful
  // pairing, which is exactly the question the session manager is asking —
  // it decides whether a close is a failed pairing attempt or a dropped
  // connection worth retrying.
  const isPaired = !!state?.creds?.me?.id;

  const cachedGroupMetadata = (jid) => groupMetadataCache.get(jid);

  const config = getBaileysConfig(cachedGroupMetadata);

  // Three separate hooks, because Baileys has three separate network paths:
  //   agent              -> the `ws` WebSocket        (https.request, classic agent)
  //   fetchAgent         -> media UPLOAD on Node      (https.request, classic agent)
  //   options.dispatcher -> media DOWNLOAD            (global fetch, undici Dispatcher)
  // Setting only the first would leave every photo the bot sends or receives
  // going out from the real IP. See src/core/proxy.js.
  if (proxy) {
    config.agent = proxy.agent;
    config.fetchAgent = proxy.fetchAgent;
    config.options = { ...(config.options || {}), dispatcher: proxy.dispatcher };
  }

  const sock = withThumbnailSupport(
    makeWASocket({
      auth: state,
      ...config,
    })
  );

  return { sock, saveCreds, clearAll, isPaired };
}
