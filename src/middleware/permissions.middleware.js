// file: /middleware/permissions.middleware.js
import { createRequire } from "module";
import {
  isOwnerJid,
  isBotAdminUser,
  isAdminInGroup,
  isBotAdminInGroup,
  getSenderId,
  getSenderCandidates,
} from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const runtimeConfig = require("../config/runtime-config.cjs");
const logger = require("../utils/logger.cjs");

/**
 * Resolves the permission level in force for a command name — the dashboard
 * override if the operator set one, otherwise the default from defaults.cjs
 * (see src/config/runtime-config.cjs).
 *
 * The `group` command is special: its config entry is an object with
 * sub_commands, and runtime-config folds that to its `default_permission`,
 * which is the least-privileged level that lets group.cjs route to a
 * sub-command. The sub-command itself then enforces the precise level.
 */
function resolvePermissionLevel(commandName) {
  return runtimeConfig.getPermission(commandName);
}

/**
 * Check if user has permission to execute a command.
 *
 * @param {string} commandName - Canonical command name
 * @param {object} msg          - Baileys message
 * @param {object} groupMetadata - Group metadata (null for private chats)
 * @param {object} sock          - Baileys socket
 * @returns {{hasPermission: boolean, reason: string, isOwner: boolean, isSenderAdmin: boolean}}
 */
export function checkCommandPermission(commandName, msg, groupMetadata, sock) {
  const isGroup = msg.key.remoteJid?.endsWith("@g.us");
  const senderId = getSenderId(msg, sock);

  // v7/LID: check every identifier the sender could appear under (LID + PN
  // alternates), so owner/admin detection isn't defeated by a LID<->PN mismatch.
  const senderCandidates = getSenderCandidates(msg, sock);
  const candidates = senderCandidates.length ? senderCandidates : [senderId];

  // fromMe is an immediate owner indicator (the bot is always its own owner).
  let isOwner = msg.key.fromMe || candidates.some((c) => isOwnerJid(c));

  // Bot-level admins (granted with `!perm add admin`, from the dashboard, or by
  // asking the AI) count as admins everywhere — including DMs, where there is
  // no group roster to consult.
  const isBotAdmin = !isOwner && candidates.some((c) => isBotAdminUser(c));

  const isSenderAdmin =
    isBotAdmin ||
    (isGroup ? candidates.some((c) => isAdminInGroup(groupMetadata, c)) : false);

  const permissionLevel = resolvePermissionLevel(commandName);

  let hasPermission = false;
  let reason = "";

  switch (permissionLevel) {
    case "MEMBERS":
    case "ALL":
      hasPermission = true;
      break;

    case "OWNER_ONLY":
      hasPermission = isOwner;
      reason = "🚫 هذا الأمر متاح للمالك فقط.";
      break;

    case "ADMINS_ONLY":
      if (!isGroup) {
        // Owners and bot-admins can run admin-only commands from anywhere —
        // useful for the operator pinging the bot privately to manage a group.
        hasPermission = isOwner || isBotAdmin;
        reason = "⚠️ هذا الأمر يعمل في المجموعات فقط (أو للمالك في الخاص).";
      } else {
        hasPermission = isSenderAdmin || isOwner;
        reason = "🚫 هذا الأمر متاح للمشرفين فقط.";
      }
      break;

    case "ADMINS_OWNER":
      if (!isGroup) {
        hasPermission = isOwner || isBotAdmin;
        reason = "⚠️ هذا الأمر يعمل في المجموعات أو للمالك فقط.";
      } else {
        hasPermission = isOwner || isSenderAdmin;
        reason = "🚫 هذا الأمر متاح للمشرفين والمالك فقط.";
      }
      break;

    default:
      logger.warn(
        `Unknown permission level: ${permissionLevel} for command: ${commandName}`
      );
      hasPermission = false;
      reason = "🚫 مستوى الصلاحية غير معروف.";
  }

  return { hasPermission, reason, isOwner, isSenderAdmin, isBotAdmin };
}

/**
 * Check if bot has admin role in the given group.
 */
export function checkBotAdmin(groupMetadata, sock) {
  return isBotAdminInGroup(groupMetadata, sock);
}
