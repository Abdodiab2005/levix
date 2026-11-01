// file: /commands/warn.js (Corrected Logic Flow)
const logger = require("../../utils/logger.cjs");
const {
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  sameUserSync,
} = require("../../utils/permissions.cjs");
const { enforceGroupRule, senderCandidates } = require("../../utils/moderationAction.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "warn",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args, _body, groupMetadata) {
    try {
      const groupId = msg.key.remoteJid;
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const reason = args.slice(1).join(" ");

      // --- 1. Validate Inputs ---
      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.warn.mentionTheMemberYouWant"),
        });
      }
      if (!reason) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.warn.writeAReasonForThe"),
        });
      }
      const isBot = [sock.user?.id, sock.user?.lid]
        .filter(Boolean)
        .some((id) => sameUserSync(id, mentionedJid));
      if (
        isBot ||
        hasBotPrivilegesSync(mentionedJid) ||
        isAdminInGroupSync(groupMetadata, mentionedJid)
      ) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.warn.theBotItsOwnerAnd"),
        });
      }

      const actor = senderCandidates(msg, sock)[0] || msg.key.participant;
      await enforceGroupRule(sock, {
        msg,
        groupMetadata,
        groupId,
        rule: "warn",
        detail: reason,
        warningReason: reason,
        recordWarning: true,
        deleteMessage: false,
        targetCandidates: [mentionedJid],
        actorJid: actor,
      });
    } catch (error) {
      logger.error({ err: error }, "An error occurred in the !warn command.");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.moderation.warn.somethingWentWrongWithThe"),
      });
    }
  },
};
