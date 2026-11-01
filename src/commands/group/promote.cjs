// file: /commands/promote.js
const logger = require("../../utils/logger.cjs");
const {
  findGroupParticipantSync,
  rosterJidForSync,
} = require("../../utils/permissions.cjs");
const { targetFromCommand } = require("../../utils/moderationAction.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "promote",
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
          "Mention the member, or reply to their message, to promote them.",
          "يجب عمل منشن للعضو أو الرد على رسالته لترقيته.",
        ),
      });
    }

    const targetUser = findGroupParticipantSync(groupMetadata, target.candidates);
    const rosterJid = rosterJidForSync(groupMetadata, target.candidates) || targetJid;

    if (targetUser && (targetUser.admin === "admin" || targetUser.admin === "superadmin")) {
      return await sock.sendMessage(groupId, {
        text: tr(
          `⚠️ @${targetJid.split("@")[0]} is already an admin.`,
          `⚠️ العضو @${targetJid.split("@")[0]} مشرف بالفعل.`,
        ),
        mentions: [targetJid],
      });
    }

    try {
      await sock.groupParticipantsUpdate(groupId, [rosterJid], "promote");
      await sock.sendMessage(groupId, {
        text: tr(
          `👑 @${targetJid.split("@")[0]} is now an admin.`,
          `👑 تم ترقية @${targetJid.split("@")[0]} إلى مشرف بنجاح.`,
        ),
        mentions: [targetJid],
      });
    } catch (error) {
      logger.error({ err: error, command: "promote" }, "Error in !promote command");
      await sock.sendMessage(groupId, {
        text: tr("Something went wrong while promoting.", "حدث خطأ أثناء محاولة الترقية."),
      });
    }
  },
};
