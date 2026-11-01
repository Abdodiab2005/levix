// file: /commands/kick.js
const logger = require("../../utils/logger.cjs");
const {
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  sameUserSync,
} = require("../../utils/permissions.cjs");
const { kickGroupMember, targetFromCommand } = require("../../utils/moderationAction.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "kick",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;
    const target = targetFromCommand(msg);
    const targetJid = target?.jid;

    if (!targetJid) {
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
      return await sock.sendMessage(groupId, { text: t("bot.group.kick.self") });
    }

    // Bot owners/admins are privileged across chats and cannot be removed by
    // a group-only admin through an alternate LID/PN representation.
    if (targetCandidates.some((candidate) => hasBotPrivilegesSync(candidate))) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.kick.botPrivileged"),
      });
    }

    // Check if the target is also an admin
    if (targetCandidates.some((candidate) => isAdminInGroupSync(groupMetadata, candidate))) {
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

      // Announce the kick before performing it
      await sock.sendMessage(groupId, {
        text: kickMessage,
        mentions: [targetJid],
      });

      const result = await kickGroupMember(sock, {
        groupId,
        groupMetadata,
        targetCandidates,
      });
      if (!result.kicked) {
        await sock.sendMessage(groupId, {
          text: t("bot.group.kick.failed"),
        });
      }
    } catch (error) {
      logger.error({ err: error, command: "kick" }, "Error in !kick command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.kick.failed"),
      });
    }
  },
};
