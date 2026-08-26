import { delay, DisconnectReason } from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { createRequire } from "module";
import { MAX_RETRIES, RETRY_DELAY_MS } from "../config/constants.js";
import { groupMetadataCache } from "./socket.js";
import {
  saveQrCode,
  deleteQrCode,
  saveUserMetadata,
  getAllOwners,
  getAllBotAdmins,
} from "../utils/storage.esm.js";
import {
  bootstrapOwners,
  bootstrapAdmins,
} from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { primePermissions } = require("../utils/permissions.cjs");

let retryCount = 0;

// Handle connection updates
export async function handleConnectionUpdate(
  update,
  sock,
  clearAll,
  io,
  initializeScheduledJobs
) {
  const { connection, lastDisconnect, qr } = update;

  if (qr) {
    logger.info("Scan the QR code below:");
    saveQrCode(qr);
    io.emit("qr", qr);
    io.emit("status_update", { status: "QR Code Received" });
    qrcode.generate(qr, { small: true });
  }

  if (connection === "close") {
    const statusCode = lastDisconnect?.error?.output?.statusCode;
    const reason =
      lastDisconnect?.error?.output?.payload?.error ||
      lastDisconnect?.error?.message ||
      "Unknown";

    // Define which status codes should trigger reconnection
    // 515: QR timeout, 500/503: Server errors, 404: Not found, etc.
    const noReconnectCodes = [401, 403, DisconnectReason.loggedOut];
    const shouldReconnect = !noReconnectCodes.includes(statusCode);

    io.emit("status_update", { status: "Disconnected" });

    // Log full disconnect info for debugging
    logger.debug(
      { lastDisconnect, statusCode, reason },
      "[Connection] Disconnect details"
    );

    if (shouldReconnect && retryCount < MAX_RETRIES) {
      retryCount++;
      const delayMs = RETRY_DELAY_MS * retryCount; // Exponential backoff: 5s, 10s, 15s, 20s, 25s

      // Special message for QR timeout
      const messagePrefix =
        statusCode === 515 ? "🔄 QR code expired" : "🔌 Connection closed";

      logger.warn(
        `${messagePrefix}. Reason: ${statusCode || reason}. Retrying in ${
          delayMs / 1000
        }s... (Attempt ${retryCount}/${MAX_RETRIES})`
      );

      await delay(delayMs);
      return { shouldReconnect: true };
    } else if (!shouldReconnect) {
      if (statusCode === DisconnectReason.loggedOut) {
        logger.error(
          "❌ Connection closed permanently. Logged out. Clearing auth data from database."
        );

        // Clear authentication data from database
        if (clearAll) {
          await clearAll();
          logger.info("[Auth] Authentication data cleared from database");
        }

        // Reset retry count and trigger reconnection for new QR
        retryCount = 0;
        return { shouldReconnect: true };
      } else {
        logger.error(
          `❌ Connection closed with non-recoverable error: ${statusCode}. Not retrying.`
        );
      }
    } else {
      logger.error(`❌ Max retries (${MAX_RETRIES}) reached. Exiting.`);

      process.exit(1);
    }
  } else if (connection === "open") {
    logger.info("✅ Connection opened successfully!");
    deleteQrCode();

    retryCount = 0;
    io.emit("status_update", { status: "Connected" });

    // The paired account is always an owner — that's the whole bootstrap.
    // Everyone else is granted from the dashboard (Roles) or with `!perm`, and
    // is already a row in user_metadata by the time we get here.
    await saveBotOwnerMetadata(sock);

    const botPn = sock.user?.id
      ? `${sock.user.id.split(":")[0].split("@")[0]}@s.whatsapp.net`
      : null;
    const botLid = sock.user?.lid
      ? `${sock.user.lid.split(":")[0].split("@")[0]}@lid`
      : null;

    // Both rosters are seeded from the database so a permission check never
    // has to hit it on the hot path.
    const ownersRoster = [
      botPn,
      botLid,
      ...getAllOwners().flatMap((user) => [user.jid, user.lid]),
    ].filter(Boolean);
    const adminsRoster = getAllBotAdmins()
      .flatMap((user) => [user.jid, user.lid])
      .filter(Boolean);

    bootstrapOwners(ownersRoster);
    bootstrapAdmins(adminsRoster);

    await primePermissions();
    logger.info(
      `[Permissions] Owner roster: ${ownersRoster.length} entries; ` +
        `admin roster: ${adminsRoster.length} entries`
    );

    // Initialize scheduled jobs
    initializeScheduledJobs(sock);

    // Cache all groups
    await cacheAllGroups(sock);
  }

  return { shouldReconnect: false };
}

// Record the paired WhatsApp account as the bot's first owner. Whoever scanned
// the QR owns the bot — there is no owner list to configure anywhere.
async function saveBotOwnerMetadata(sock) {
  try {
    logger.info("[User Metadata] Saving bot owner metadata...");

    const phoneNumber = sock.user?.id?.split(":")[0]?.split("@")[0];
    const userJid = phoneNumber ? `${phoneNumber}@s.whatsapp.net` : null;
    const userLid = sock.user?.lid
      ? `${sock.user.lid.split(":")[0].split("@")[0]}@lid`
      : null;
    const displayName = sock.user?.name || sock.user?.verifiedName || null;

    if (userJid) {
      saveUserMetadata({
        jid: userJid,
        lid: userLid,
        phone: phoneNumber,
        isOwner: true,
        displayName,
      });
      logger.info(
        `[User Metadata] Saved bot owner: ${phoneNumber} (JID: ${userJid}, LID: ${userLid})`
      );
    }
  } catch (err) {
    logger.error({ err }, "[Error] Failed to save bot owner metadata");
  }
}

// Cache all group metadata
async function cacheAllGroups(sock) {
  logger.info("[Cache] Fetching and caching metadata for all groups...");

  try {
    const groups = await sock.groupFetchAllParticipating();
    let cachedCount = 0;

    for (const jid in groups) {
      groupMetadataCache.set(jid, groups[jid]);
      cachedCount++;
    }

    logger.info(`[Cache] Successfully cached ${cachedCount} groups.`);
  } catch (err) {
    logger.error("[Error] Failed to fetch and cache groups:", err);
  }
}
