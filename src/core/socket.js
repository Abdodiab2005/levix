import { makeWASocket } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import { useDatabaseAuthState } from "../auth/use-database-auth-state.js";
import { getBaileysConfig, setRecentMessageGetter } from "../config/baileys.config.js";
import { getMessageFromRecent } from "../utils/recentMessageCache.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { withMediaThumbnail } = require("../utils/thumbnail.cjs");
const settings = require("../config/settings.cjs");

// The group-metadata cache lives in one shared CJS module so the CJS command
// files and these ESM core files see the SAME instance (see
// src/utils/groupMetadataCache.cjs). Re-exported under the historical name,
// so every existing import site keeps working.
const groupMetadataCacheModule = require("../utils/groupMetadataCache.cjs");
export const groupMetadataCache = groupMetadataCacheModule.cache;

// Wire the recent-message cache into Baileys' getMessage hook so retries can
// recover (rc10 enableAutoSessionRecreation needs this).
setRecentMessageGetter(getMessageFromRecent);

/**
 * Link previews are opt-in. Baileys fetches the page behind any URL in an
 * outgoing text whenever `linkPreview` is merely undefined — with high-quality
 * previews on it even uploads the page image. That made every AI answer with a
 * Sources block, every short link and every scheduled message with a URL cost
 * a silent page fetch. `linkPreview: null` skips it entirely; the operator
 * opts back in with the `link_previews_enabled` setting (default off).
 *
 * This is the ONE choke point every outbound message passes through
 * (sendBotMessage, the scheduler, status edits, legacy sock.sendMessage), so
 * the guard lives here next to the thumbnail patch it shares a wrapper with.
 */
function withoutUnwantedLinkPreview(content) {
  if (!content || typeof content !== "object") return content;
  if (typeof content.text !== "string") return content;
  if ("linkPreview" in content) return content; // caller decided already
  if (settings.get("link_previews_enabled")) return content; // operator opted in
  return { ...content, linkPreview: null };
}

/**
 * Baileys can't generate media previews in this install (no sharp/jimp, and its
 * video path shells out to a bare `ffmpeg` that isn't on the PATH), so every
 * image/video we sent went out with a blank thumbnail. Patch sendMessage once,
 * at the socket level, so EVERY caller gets a preview — commands that use
 * sendBotMessage and the handful of legacy commands still calling
 * sock.sendMessage directly.
 */
function withOutboundSavers(sock) {
  const original = sock.sendMessage.bind(sock);

  sock.sendMessage = async function sendMessageWithOutboundSavers(jid, content, options) {
    let payload = content;
    try {
      payload = await withMediaThumbnail(content);
    } catch (err) {
      logger.debug({ err: err?.message }, "[Socket] thumbnail step skipped");
      payload = content;
    }
    payload = withoutUnwantedLinkPreview(payload);
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
export async function createWhatsAppSocket({ proxy = null, pairingCode = false } = {}) {
  logger.info(
    proxy
      ? `[Socket] Initializing WhatsApp socket through ${proxy.label}`
      : "[Socket] Initializing WhatsApp socket with database auth",
  );

  const { state, saveCreds, clearAll } = await useDatabaseAuthState();

  // Whether this install is already paired. NOT `store.hasCredentials()`: the
  // auth state writes a `creds` row on its very first call, paired or not.
  // `requestPairingCode` also writes `creds.me.id` *before* the phone accepts
  // the code, so `me.id` alone is not proof. `registered === false` means the
  // handshake never finished.
  const isPaired = !!state?.creds?.me?.id && state?.creds?.registered !== false;

  const cachedGroupMetadata = (jid) => groupMetadataCache.get(jid);

  const config = getBaileysConfig(cachedGroupMetadata, { pairingCode });

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

  const sock = withOutboundSavers(
    makeWASocket({
      auth: state,
      ...config,
    }),
  );

  return { sock, saveCreds, clearAll, isPaired };
}
