// file: /commands/demote.js
const logger = require("../../utils/logger.cjs");
const {
  findGroupParticipantSync,
  rosterJidForSync,
} = require("../../utils/permissions.cjs");
const { targetFromCommand } = require("../../utils/moderationAction.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "demote",
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
          "Mention the admin, or reply to their message, to demote them.",
          "يجب عمل منشن للمشرف أو الرد على رسالته لعزله.",
        ),
      });
    }

    const targetUser = findGroupParticipantSync(groupMetadata, target.candidates);
    const rosterJid = rosterJidForSync(groupMetadata, target.candidates) || targetJid;

    if (!targetUser || !targetUser.admin) {
      return await sock.sendMessage(groupId, {
        text: tr(
          `⚠️ @${targetJid.split("@")[0]} isn't an admin.`,
          `⚠️ العضو @${targetJid.split("@")[0]} ليس مشرفًا بالفعل.`,
        ),
        mentions: [targetJid],
      });
    }

    if (targetUser.admin === "superadmin") {
      return await sock.sendMessage(groupId, {
        text: tr("The group's creator can't be demoted.", "لا يمكن عزل منشئ المجموعة."),
      });
    }

    try {
      await sock.groupParticipantsUpdate(groupId, [rosterJid], "demote");
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
