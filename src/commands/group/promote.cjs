// file: /commands/promote.js
const logger = require("../../utils/logger.cjs");
const {
  findGroupParticipantSync,
  rosterJidForSync,
} = require("../../utils/permissions.cjs");
const { targetFromCommand } = require("../../utils/moderationAction.cjs");
const { t } = require("../../utils/i18n.cjs");

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
        text: t("bot.group.promote.noTarget"),
      });
    }

    const targetUser = findGroupParticipantSync(groupMetadata, target.candidates);
    const rosterJid = rosterJidForSync(groupMetadata, target.candidates) || targetJid;

    if (targetUser && (targetUser.admin === "admin" || targetUser.admin === "superadmin")) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.promote.alreadyAdmin", { number: targetJid.split("@")[0] }),
        mentions: [targetJid],
      });
    }

    try {
      await sock.groupParticipantsUpdate(groupId, [rosterJid], "promote");
      await sock.sendMessage(groupId, {
        text: t("bot.group.promote.done", { number: targetJid.split("@")[0] }),
        mentions: [targetJid],
      });
    } catch (error) {
      logger.error({ err: error, command: "promote" }, "Error in !promote command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.promote.failed"),
      });
    }
  },
};
