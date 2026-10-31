import { makeWASocket } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import { useDatabaseAuthState } from "../auth/use-database-auth-state.js";
import { getBaileysConfig, setRecentMessageGetter } from "../config/baileys.config.js";
import { getMessageFromRecent } from "../utils/recentMessageCache.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { withMediaThumbnail } = require("../utils/thumbnail.cjs");
const settings = require("../config/settings.cjs");
const { isLinkedCreds } = require("../utils/linkedCreds.cjs");
const { fetchHttpsBuffer } = require("../utils/httpsFetch.cjs");
const { getHttpsUrlInfo } = require("../utils/linkPreview.cjs");
const { tr } = require("../utils/i18n.cjs");
const socketDispatchers = new WeakMap();

// Never leave a remote media URL for Baileys to fetch again without validation.
// Local paths, buffers and streams keep their existing send path. Download once
// for the actual send, then build any thumbnail from those same bytes.
async function withHttpsMedia(sock, content) {
  if (!content || typeof content !== "object") return content;
  let payload = content;
  for (const field of ["image", "video", "audio", "document", "sticker"]) {
    const media = content[field];
    const raw = typeof media === "string" ? media : media?.url;
    if (!raw || !/^https?:/i.test(String(raw).trim())) continue;
    try {
      const { buffer } = await fetchHttpsBuffer(String(raw), {
        maxBytes: settings.get("thumbnail_remote_max_mb") * 1024 * 1024,
        timeoutMs: settings.get("thumbnail_remote_timeout_ms"),
        dispatcher: socketDispatchers.get(sock),
      });
      payload = { ...payload, [field]: buffer };
    } catch (cause) {
      throw new Error(
        tr(
          "Could not fetch remote media securely. Use a public HTTPS URL within the remote media limits, or send a local file.",
          "تعذّر تحميل الوسائط بأمان. استخدم رابط HTTPS عامًا ضمن حدود الوسائط البعيدة، أو أرسل ملفًا محليًا.",
        ),
        { cause },
      );
    }
  }
  return payload;
}

/** Fetch a WhatsApp image through the transport owned by this live socket. */
export async function fetchWhatsAppImage(sock, rawUrl, init = {}) {
  const url = new URL(rawUrl);
  if (
    url.protocol !== "https:" ||
    !/(^|\.)(whatsapp\.net|whatsapp\.com|fbcdn\.net)$/.test(url.hostname)
  ) {
    throw new Error("Invalid WhatsApp image destination");
  }
  const { assertProviderRequestUrl, safeProviderFetch } = require("../utils/providerUrl.cjs");
  const dispatcher = socketDispatchers.get(sock);
  if (!dispatcher) {
    return safeProviderFetch(url.href, init, { allowLoopback: false });
  }
  // Validate before handing the URL to the session's proxy. Never replace or
  // close its dispatcher here: media downloads share the same live transport.
  await assertProviderRequestUrl(url.href, { allowLoopback: false });
  const { fetch } = require("undici");
  return fetch(url.href, { ...init, dispatcher, redirect: "manual" });
}

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
 * opts back in with the `link_previews_enabled` setting (default off). The
 * per-send getUrlInfo hook below keeps that optional fetch HTTPS-only.
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
  const getUrlInfo = (text) => getHttpsUrlInfo(text, { dispatcher: socketDispatchers.get(sock) });

  sock.sendMessage = async function sendMessageWithOutboundSavers(jid, content, options) {
    let payload = await withHttpsMedia(sock, content);
    try {
      payload = await withMediaThumbnail(payload);
    } catch (err) {
      logger.debug({ err: err?.message }, "[Socket] thumbnail step skipped");
    }
    payload = withoutUnwantedLinkPreview(payload);
    // Put the hook last so callers cannot accidentally restore Baileys's unsafe
    // downloader. Explicit linkPreview objects/null are still handled by Baileys.
    return original(jid, payload, { ...options, getUrlInfo });
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
  // auth state writes a `creds` row on its very first call, paired or not. See
  // linkedCreds.cjs for what counts as a finished link.
  const isPaired = isLinkedCreds(state?.creds);

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
  socketDispatchers.set(sock, config.options?.dispatcher ?? null);

  return { sock, saveCreds, clearAll, isPaired };
}
