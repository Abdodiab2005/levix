// file: /commands/kick.js
const logger = require("../../utils/logger.cjs");
const {
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  sameUserSync,
} = require("../../utils/permissions.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "kick",
  description: {
    en: "Removes a member from the group.",
    ar: "يطرد عضوًا من المجموعة.",
  },
  usage: {
    en: "kick @member [reason]",
    ar: "kick @عضو [السبب]",
  },
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;
    let targetJid;

    // --- Target Identification Logic ---
    // 1. Check for mentions
    if (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0) {
      targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
    }
    // 2. Check if it's a reply to another message
    else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      targetJid = msg.message.extendedTextMessage.contextInfo.participant;
    } else {
      return await sock.sendMessage(groupId, {
        text: tr(
          "Mention the member, or reply to their message, to kick them.",
          "يجب عمل منشن للعضو أو الرد على رسالته لطرده.",
        ),
      });
    }

    // --- Safety Checks ---
    // Can't kick the bot itself
    if ([sock.user?.id, sock.user?.lid].filter(Boolean).some((id) => sameUserSync(id, targetJid))) {
      return await sock.sendMessage(groupId, { text: tr("I can't kick myself.", "لا يمكنني طرد نفسي.") });
    }

    // Bot owners/admins are privileged across chats and cannot be removed by
    // a group-only admin through an alternate LID/PN representation.
    if (hasBotPrivilegesSync(targetJid)) {
      return await sock.sendMessage(groupId, {
        text: tr("The bot's owner or admins can't be kicked.", "لا يمكن طرد مالك أو مشرف البوت."),
      });
    }

    // Check if the target is also an admin
    if (isAdminInGroupSync(groupMetadata, targetJid)) {
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

      // Perform the kick
      await sock.groupParticipantsUpdate(groupId, [targetJid], "remove");
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
