// What a WhatsApp connection means, minus the decision of when to make one.
//
// The retry schedule, the socket's lifetime and the state machine live in
// src/core/session.js. This file answers two narrower questions:
//
//   classifyDisconnect(statusCode)  — is this close terminal, and why?
//   handleConnectionOpen(sock, …)   — what has to happen once one is open?
//
// Keeping them apart is what lets the state machine be tested without Baileys
// and without a database.

import { DisconnectReason } from "@whiskeysockets/baileys";
import { createRequire } from "module";
import { groupMetadataCache } from "./socket.js";
import {
  saveUserMetadata,
  getAllOwners,
  getAllBotAdmins,
} from "../utils/storage.esm.js";
import { bootstrapOwners, bootstrapAdmins } from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const logger = require("../utils/logger.cjs");
const { primePermissions } = require("../utils/permissions.cjs");

/**
 * WhatsApp answers a `<failure reason="405">` when it refuses the connection
 * outright — the number is not in Baileys' DisconnectReason enum, so it is
 * named here rather than left as a bare literal in a comparison. Retrying it is
 * how an install ends up hammering a server that has already said no, so Levix
 * treats it as terminal and waits for a person.
 */
export const CONNECTION_FAILURE_405 = 405;

/**
 * Read a close and say what should happen next.
 *
 * Terminal means: do not reconnect on our own. Everything else gets the staged
 * retry schedule in session.js.
 *
 * @param {number|undefined} statusCode - `lastDisconnect.error.output.statusCode`
 */
export function classifyDisconnect(statusCode) {
  // Baileys reports an intentional logout and a server-side unlink with the
  // same code (DisconnectReason.loggedOut === 401), and it is the only case
  // where the stored credentials are genuinely dead.
  if (statusCode === DisconnectReason.loggedOut) {
    return {
      terminal: true,
      loggedOut: true,
      restartRequired: false,
      reason: "logged_out",
      label: "logged out",
      detail: "WhatsApp unlinked this device. Start a session to pair again.",
    };
  }

  if (statusCode === CONNECTION_FAILURE_405) {
    return {
      terminal: true,
      loggedOut: false,
      restartRequired: false,
      reason: "connection_failure",
      label: "refused by WhatsApp (405)",
      // Deliberately not a credential wipe: a 405 says WhatsApp would not take
      // this connection, not that the pairing is gone.
      detail:
        "WhatsApp refused the connection (405). The pairing was left alone — try starting the session again later.",
    };
  }

  if (statusCode === DisconnectReason.forbidden) {
    return {
      terminal: true,
      loggedOut: false,
      restartRequired: false,
      reason: "forbidden",
      label: "forbidden",
      detail: "WhatsApp rejected this account (403). Reconnecting will not help.",
    };
  }

  // Part of the pairing handshake: WhatsApp asks for the socket to be made
  // again once a phone has scanned the code. Recoverable, and never the end of
  // a pairing attempt.
  if (statusCode === DisconnectReason.restartRequired) {
    return {
      terminal: false,
      loggedOut: false,
      restartRequired: true,
      reason: "restart_required",
      label: "restart required",
      detail: "WhatsApp asked for a fresh connection.",
    };
  }

  return {
    terminal: false,
    loggedOut: false,
    restartRequired: false,
    reason: "connection_closed",
    label: "recoverable",
    detail: null,
  };
}

/**
 * Everything that has to happen the moment a connection is open: record the
 * paired account as an owner, seed the permission rosters, (re)start the
 * scheduled jobs against the new socket, and cache the group metadata.
 *
 * @param {object} sock
 * @param {(sock: object) => void} [initializeScheduledJobs]
 */
export async function handleConnectionOpen(sock, initializeScheduledJobs) {
  logger.info("✅ Connection opened successfully!");

  // The paired account is always an owner — that's the whole bootstrap.
  // Everyone else is granted from the dashboard (Roles) or with `!perm`, and
  // is already a row in user_metadata by the time we get here.
  await saveBotOwnerMetadata(sock);

  const botPn = sock?.user?.id
    ? `${sock.user.id.split(":")[0].split("@")[0]}@s.whatsapp.net`
    : null;
  const botLid = sock?.user?.lid
    ? `${sock.user.lid.split(":")[0].split("@")[0]}@lid`
    : null;

  // Both rosters are seeded from the database so a permission check never has
  // to hit it on the hot path.
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

  // Called on every open, including a reconnect: scheduleNewJob() stops the
  // previous timer for the same id first, so a weekly message is not sent twice
  // after the first reconnect.
  if (initializeScheduledJobs) initializeScheduledJobs(sock);

  await cacheAllGroups(sock);
}

// Record the paired WhatsApp account as the bot's first owner. Whoever scanned
// the QR owns the bot — there is no owner list to configure anywhere.
async function saveBotOwnerMetadata(sock) {
  try {
    logger.info("[User Metadata] Saving bot owner metadata...");

    const phoneNumber = sock?.user?.id?.split(":")[0]?.split("@")[0];
    const userJid = phoneNumber ? `${phoneNumber}@s.whatsapp.net` : null;
    const userLid = sock?.user?.lid
      ? `${sock.user.lid.split(":")[0].split("@")[0]}@lid`
      : null;
    const displayName = sock?.user?.name || sock?.user?.verifiedName || null;

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
