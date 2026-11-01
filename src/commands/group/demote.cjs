// file: /commands/demote.js
const logger = require("../../utils/logger.cjs");
const {
  findGroupParticipantSync,
  rosterJidForSync,
} = require("../../utils/permissions.cjs");
const { targetFromCommand } = require("../../utils/moderationAction.cjs");
const { t } = require("../../utils/i18n.cjs");

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
    const target = targetFromCommand(msg);
    const targetJid = target?.jid;

    if (!targetJid) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.demote.noTarget"),
      });
    }

    const targetUser = findGroupParticipantSync(groupMetadata, target.candidates);
    const rosterJid = rosterJidForSync(groupMetadata, target.candidates) || targetJid;

    if (!targetUser || !targetUser.admin) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.demote.notAdmin", { number: targetJid.split("@")[0] }),
        mentions: [targetJid],
      });
    }

    if (targetUser.admin === "superadmin") {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.demote.creator"),
      });
    }

    try {
      await sock.groupParticipantsUpdate(groupId, [rosterJid], "demote");
      await sock.sendMessage(groupId, {
        text: t("bot.group.demote.done", { number: targetJid.split("@")[0] }),
        mentions: [targetJid],
      });
    } catch (error) {
      logger.error({ err: error, command: "demote" }, "Error in !demote command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.demote.failed"),
      });
    }
  },
};
