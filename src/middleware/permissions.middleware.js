// file: /middleware/permissions.middleware.js
import { createRequire } from "module";
import {
  getSenderCandidates,
  getSenderId,
  isAdminInGroup,
  isBotAdminInGroup,
  isBotAdminUser,
  isOwnerJid,
} from "../utils/permissions.esm.js";

const require = createRequire(import.meta.url);
const runtimeConfig = require("../config/runtime-config.cjs");
const { evaluatePermissionLevel } = require("../utils/permissionLevel.cjs");
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
 * Who sent `msg`, as far as permissions are concerned. The same answer backs
 * the command dispatcher and the AI agent's tools (services/aiToolAuth.cjs),
 * so a person is never an admin for one door and a member for the other.
 *
 * @param {object} msg           - Baileys message
 * @param {object} groupMetadata - Group metadata (null for private chats)
 * @param {object} sock          - Baileys socket
 * @returns {{isGroup: boolean, senderId: string|null, candidates: string[],
 *            isOwner: boolean, isBotAdmin: boolean, isGroupAdmin: boolean,
 *            isSenderAdmin: boolean}}
 */
export function resolveSender(msg, groupMetadata, sock) {
  const isGroup = Boolean(msg?.key?.remoteJid?.endsWith("@g.us"));
  const senderId = getSenderId(msg, sock);

  // v7/LID: check every identifier the sender could appear under (LID + PN
  // alternates), so owner/admin detection isn't defeated by a LID<->PN mismatch.
  const senderCandidates = getSenderCandidates(msg, sock);
  const candidates = senderCandidates.length ? senderCandidates : [senderId].filter(Boolean);

  // fromMe is an immediate owner indicator (the bot is always its own owner).
  const isOwner = Boolean(msg?.key?.fromMe) || candidates.some((c) => isOwnerJid(c));

  // Bot-level admins (granted with `!perm add admin`, from the dashboard, or by
  // asking the AI) count as admins everywhere — including DMs, where there is
  // no group roster to consult.
  const isBotAdmin = !isOwner && candidates.some((c) => isBotAdminUser(c));

  const isGroupAdmin = isGroup && candidates.some((c) => isAdminInGroup(groupMetadata, c));
  const isSenderAdmin = isBotAdmin || isGroupAdmin;

  return { isGroup, senderId, candidates, isOwner, isBotAdmin, isGroupAdmin, isSenderAdmin };
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
  const sender = resolveSender(msg, groupMetadata, sock);
  const permissionLevel = resolvePermissionLevel(commandName);
  const { hasPermission, reason, unknownLevel } = evaluatePermissionLevel(permissionLevel, sender);

  if (unknownLevel) {
    logger.warn(`Unknown permission level: ${permissionLevel} for command: ${commandName}`);
  }

  return {
    hasPermission,
    reason,
    isOwner: sender.isOwner,
    isSenderAdmin: sender.isSenderAdmin,
    isBotAdmin: sender.isBotAdmin,
  };
}

/**
 * Check if bot has admin role in the given group.
 */
export function checkBotAdmin(groupMetadata, sock) {
  return isBotAdminInGroup(groupMetadata, sock);
}
