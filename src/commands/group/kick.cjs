// file: /commands/kick.js
const logger = require("../../utils/logger.cjs");
const {
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  sameUserSync,
} = require("../../utils/permissions.cjs");
const { kickGroupMember, targetFromCommand } = require("../../utils/moderationAction.cjs");
const { tr } = require("../../utils/i18n.cjs");

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
        text: tr(
          "Mention the member, or reply to their message, to kick them.",
          "يجب عمل منشن للعضو أو الرد على رسالته لطرده.",
        ),
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
      return await sock.sendMessage(groupId, { text: tr("I can't kick myself.", "لا يمكنني طرد نفسي.") });
    }

    // Bot owners/admins are privileged across chats and cannot be removed by
    // a group-only admin through an alternate LID/PN representation.
    if (targetCandidates.some((candidate) => hasBotPrivilegesSync(candidate))) {
      return await sock.sendMessage(groupId, {
        text: tr("The bot's owner or admins can't be kicked.", "لا يمكن طرد مالك أو مشرف البوت."),
      });
    }

    // Check if the target is also an admin
    if (targetCandidates.some((candidate) => isAdminInGroupSync(groupMetadata, candidate))) {
      return await sock.sendMessage(groupId, {
        text: tr("An admin can't kick another admin.", "لا يمكن للمشرف طرد مشرف آخر."),
      });
    }

    // --- Execution ---
    try {
      const reason = args.slice(1).join(" ") || tr("No reason given", "بدون سبب");
      const senderName = msg.pushName;
      const member = `@${targetJid.split("@")[0]}`;

      const kickMessage = tr(
        `*By:* ${senderName}\n*Action:* kick\n*Member:* ${member}\n*Reason:* ${reason}`,
        `*تم بواسطة:* ${senderName}\n` +
          `*الإجراء:* طرد\n` +
          `*العضو:* ${member}\n` +
          `*السبب:* ${reason}`,
      );

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
          text: tr(
            "Something went wrong while kicking the member. I may not have enough permissions.",
            "حدث خطأ أثناء محاولة طرد العضو. قد تكون صلاحياتي غير كافية.",
          ),
        });
      }
    } catch (error) {
      logger.error({ err: error, command: "kick" }, "Error in !kick command");
      await sock.sendMessage(groupId, {
        text: tr(
          "Something went wrong while kicking the member. I may not have enough permissions.",
          "حدث خطأ أثناء محاولة طرد العضو. قد تكون صلاحياتي غير كافية.",
        ),
      });
    }
  },
};
