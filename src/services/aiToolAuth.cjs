// Who the AI agent is acting for, and whether that person may do what a tool
// is about to do.
//
// The agent reads other people's messages, quoted text and web pages, and any
// of them can ask it to call a tool. So authorization never comes from the
// model. The caller is resolved once from the Baileys message that started the
// run, with the command dispatcher's own resolveSender(), and frozen. Only a
// caller minted here counts: a lookalike object — built from tool arguments,
// spread from a context, typed into a test — is treated as nobody.
//
// A tool with a side effect declares `access`: the command it stands in for,
// and an extra role when that command checks one internally (global memory,
// the owner role). The check is that command's live permission level through
// the same evaluatePermissionLevel() the dispatcher runs, so a dashboard change
// to `!schedule` moves create_reminder with it.

const runtimeConfig = require("../config/runtime-config.cjs");
const { evaluatePermissionLevel } = require("../utils/permissionLevel.cjs");

/** Every caller this module has resolved from a real message. */
const minted = new WeakSet();

/**
 * Roles some commands demand on top of their permission level, named the way
 * those commands name them.
 */
const ROLES = Object.freeze({
  // Owner only — `!perm` for the owner role.
  owner: (caller) => caller.isOwner,
  // Owner or bot admin, never a mere group admin — `!memory` for global scope.
  botPrivileged: (caller) => caller.isOwner || caller.isBotAdmin,
  // The above, or an admin of this WhatsApp group — `!memory` deleting chat memory.
  chatModerator: (caller) => caller.isOwner || caller.isBotAdmin || caller.isGroupAdmin,
});

const ROLE_ERRORS = Object.freeze({
  owner: "only the bot owner can do this",
  botPrivileged: "only the bot owner or a bot admin can do this",
  chatModerator: "only the bot owner, a bot admin, or an admin of this group can do this",
});

/**
 * Resolve the person behind `msg` — the one message that started this agent
 * run — into a frozen caller the tools can trust.
 *
 * @param {object} options
 * @param {object} options.msg             - the Baileys message that invoked the AI
 * @param {object} options.sock            - Baileys socket (fromMe resolves to its account)
 * @param {object} [options.groupMetadata] - for group-admin detection
 * @param {string} [options.text]          - what the sender typed (role tools bind targets to it)
 */
async function resolveCaller({ msg, sock, groupMetadata = null, text = "" }) {
  if (!msg?.key?.remoteJid) throw new Error("resolveCaller needs the incoming message");
  const { resolveSender } = await import("../middleware/permissions.middleware.js");
  const sender = resolveSender(msg, groupMetadata, sock);
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;

  const caller = Object.freeze({
    chatId: msg.key.remoteJid,
    chatName: groupMetadata?.subject || null,
    isGroup: sender.isGroup,
    senderId: sender.senderId,
    senderName: msg.pushName || null,
    candidates: Object.freeze([...sender.candidates]),
    isOwner: sender.isOwner,
    isBotAdmin: sender.isBotAdmin,
    isGroupAdmin: sender.isGroupAdmin,
    isSenderAdmin: sender.isSenderAdmin,
    // What the sender pointed at in their own message. A quoted message's
    // author is only a *target* here — never who the agent acts for.
    mentionedJids: Object.freeze([...(contextInfo?.mentionedJid || [])]),
    quotedParticipant: contextInfo?.participant || null,
    text: String(text || ""),
  });
  minted.add(caller);
  return caller;
}

/** True only for a caller resolveCaller() produced. */
function isTrustedCaller(caller) {
  return Boolean(caller) && typeof caller === "object" && minted.has(caller);
}

/**
 * May `caller` use a tool whose access rule is `access`?
 *
 * @param {null|{command: string, role?: keyof ROLES}} access - null = open tool
 * @param {object} caller
 * @returns {{allowed: true} | {allowed: false, error: string}}
 */
function authorize(access, caller) {
  if (!access) return { allowed: true };
  if (!isTrustedCaller(caller)) {
    return { allowed: false, error: "this action needs a verified sender, and there is none" };
  }

  const level = runtimeConfig.getPermission(access.command);
  const { hasPermission } = evaluatePermissionLevel(level, caller);
  if (!hasPermission) {
    return {
      allowed: false,
      error: `not allowed: this does what !${access.command} does, and that is ${level} here`,
    };
  }

  if (access.role) {
    const check = ROLES[access.role];
    if (!check) return { allowed: false, error: `unknown role requirement: ${access.role}` };
    if (!check(caller)) return { allowed: false, error: ROLE_ERRORS[access.role] };
  }
  return { allowed: true };
}

module.exports = { resolveCaller, isTrustedCaller, authorize, ROLES };
