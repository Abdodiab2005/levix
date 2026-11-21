// file: /commands/kick.js
const logger = require("../../utils/logger.cjs");
const {
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  sameUserSync,
} = require("../../utils/permissions.cjs");
const moderationAction = require("../../utils/moderationAction.cjs");
const { senderCandidates, targetFromCommand } = moderationAction;
const { t } = require("../../utils/i18n.cjs");

function reactionRefusal() {
  const error = new Error("REACTION_COMMAND_DENIED");
  error.code = "REACTION_COMMAND_DENIED";
  throw error;
}

module.exports = {
  name: "kick",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  // Direct `!kick` has no `ctx.nested`. `!group kick` sets `nested: true`.
  // The re-check below uses the gate that admitted this call.
  async execute(sock, msg, args, body, groupMetadata, ctx) {
    const groupId = msg.key.remoteJid;
    const target = targetFromCommand(msg);
    const targetJid = target?.jid;

    if (!targetJid) {
      if (ctx?.silentDenials) reactionRefusal();
      return await sock.sendMessage(groupId, {
        text: t("bot.group.kick.noTarget"),
      });
    }
    const targetCandidates = target.candidates;

    // --- Safety Checks ---
    // Can't kick the bot itself
    if (
      [sock.user?.id, sock.user?.lid]
        .filter(Boolean)
        .some((id) => targetCandidates.some((candidate) => sameUserSync(id, candidate)))
    ) {
      if (ctx?.silentDenials) reactionRefusal();
      return await sock.sendMessage(groupId, { text: t("bot.group.kick.self") });
    }

    // Bot owners/admins are privileged across chats and cannot be removed by
    // a group-only admin through an alternate LID/PN representation.
    if (targetCandidates.some((candidate) => hasBotPrivilegesSync(candidate, groupMetadata))) {
      if (ctx?.silentDenials) reactionRefusal();
      return await sock.sendMessage(groupId, {
        text: t("bot.group.kick.botPrivileged"),
      });
    }

    // Check if the target is also an admin
    if (targetCandidates.some((candidate) => isAdminInGroupSync(groupMetadata, candidate))) {
      if (ctx?.silentDenials) reactionRefusal();
      return await sock.sendMessage(groupId, {
        text: t("bot.group.kick.targetIsAdmin"),
      });
    }

    // --- Execution ---
    try {
      const reason = args.slice(1).join(" ") || t("bot.group.kick.noReason");
      const senderName = msg.pushName;
      const member = `@${targetJid.split("@")[0]}`;

      const kickMessage = t("bot.group.kick.announcement", {
        sender: senderName,
        member,
        reason,
      });
      const announce = () =>
        sock.sendMessage(groupId, {
          text: kickMessage,
          mentions: [targetJid],
        });
      const remove = () =>
        moderationAction.kickGroupMember(sock, {
          groupId,
          groupMetadata,
          targetCandidates,
          requesterCandidates: senderCandidates(msg, sock),
          requesterFromMe: Boolean(msg.key?.fromMe),
          requesterRule: ctx?.nested === true ? "nested" : "direct",
          accountEpoch: ctx?.accountEpoch,
          effectGuard: ctx?.effectGuard,
        });

      // A reaction announces only after WhatsApp confirms the removal. A typed
      // !kick still announces first, then removes.
      if (ctx?.source === "reaction") {
        const result = await remove();
        if (!result.kicked) {
          if (ctx?.silentDenials) reactionRefusal();
          await sock.sendMessage(groupId, { text: t("bot.group.kick.failed") });
          return;
        }
        await announce();
        return;
      }

      await announce();
      const result = await remove();
      if (!result.kicked) {
        if (ctx?.silentDenials) reactionRefusal();
        await sock.sendMessage(groupId, {
          text: t("bot.group.kick.failed"),
        });
      }
    } catch (error) {
      if (error?.code === "REACTION_COMMAND_DENIED") throw error;
      logger.error({ err: error, command: "kick" }, "Error in !kick command");
      if (ctx?.silentDenials) throw error;
      await sock.sendMessage(groupId, {
        text: t("bot.group.kick.failed"),
      });
    }
  },
};
