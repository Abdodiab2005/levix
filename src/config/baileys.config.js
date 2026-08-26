import { Browsers } from "@whiskeysockets/baileys";
import pino from "pino";
import NodeCache from "node-cache";
// rc10 supports several pluggable caches; we keep them in-process so message
// retries / device discovery don't keep slamming the network.
const msgRetryCounterCache = new NodeCache({
  stdTTL: 60 * 60,
  useClones: false,
});
const userDevicesCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });
const callOfferCache = new NodeCache({ stdTTL: 60 * 60, useClones: false });
const placeholderResendCache = new NodeCache({
  stdTTL: 60 * 60,
  useClones: false,
});

// Optional getMessage hook backed by our in-process recent-messages cache
// (set up at runtime by core/socket.js). Falling back to an empty conversation
// keeps Baileys happy when we genuinely don't have the message anymore.
let getRecentMessage = null;
export function setRecentMessageGetter(fn) {
  getRecentMessage = fn;
}

export const getBaileysConfig = (cachedGroupMetadata) => ({
  browser: Browsers.windows("Desktop"),
  markOnlineOnConnect: false,
  logger: pino({ level: "silent" }),
  cachedGroupMetadata,
  version: [2, 3000, 1044062641],

  // rc10: stability hooks
  msgRetryCounterCache,
  userDevicesCache,
  callOfferCache,
  placeholderResendCache,
  enableAutoSessionRecreation: true,
  enableRecentMessageCache: true,
  generateHighQualityLinkPreview: true,

  // V7: Add getMessage for message history
  getMessage: async (key) => {
    if (getRecentMessage) {
      const cached = await getRecentMessage(key);
      if (cached) return cached;
    }
    return { conversation: "" };
  },
  syncFullHistory: false,
  shouldSyncHistoryMessage: () => false,
});
