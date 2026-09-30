// file: /commands/demote.js
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "demote",
  description: {
    en: "Demotes an admin to a regular member.",
    ar: "يحوّل مشرفًا إلى عضو عادي.",
  },
  usage: {
    en: "demote @member",
    ar: "demote @عضو",
  },
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;

    // Logic to identify the target user from mention or reply
    const targetJid =
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0] ||
      msg.message?.extendedTextMessage?.contextInfo?.participant;

    if (!targetJid) {
      return await sock.sendMessage(groupId, {
        text: tr(
          "Mention the admin, or reply to their message, to demote them.",
          "يجب عمل منشن للمشرف أو الرد على رسالته لعزله.",
        ),
      });
    }

    // Safety check: Is the target user NOT an admin?
    const targetUser = groupMetadata.participants.find((p) => p.id === targetJid);
    if (!targetUser || !targetUser.admin) {
      return await sock.sendMessage(groupId, {
        text: tr(
          `⚠️ @${targetJid.split("@")[0]} isn't an admin.`,
          `⚠️ العضو @${targetJid.split("@")[0]} ليس مشرفًا بالفعل.`,
        ),
        mentions: [targetJid],
      });
    }

    // Safety check: Cannot demote the group creator
    if (targetUser.admin === "superadmin") {
      return await sock.sendMessage(groupId, {
        text: tr("The group's creator can't be demoted.", "لا يمكن عزل منشئ المجموعة."),
      });
    }

    try {
      await sock.groupParticipantsUpdate(
        groupId,
        [targetJid],
        "demote", // The action is 'demote'
      );
      await sock.sendMessage(groupId, {
        text: tr(
          `👤 @${targetJid.split("@")[0]} is no longer an admin.`,
          `👤 تم عزل @${targetJid.split("@")[0]} من الإشراف.`,
        ),
        mentions: [targetJid],
      });
    } catch (error) {
      logger.error({ err: error, command: "demote" }, "Error in !demote command");
      await sock.sendMessage(groupId, {
        text: tr("Something went wrong while demoting.", "حدث خطأ أثناء محاولة العزل."),
      });
    }
  },
};
