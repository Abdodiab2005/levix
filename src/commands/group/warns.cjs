// file: /commands/warns.js
const { getUserWarnings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { t, tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "warns",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg) {
    try {
      const groupId = msg.key.remoteJid;
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];

      if (!mentionedJid) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.warns.mentionTheMemberWhoseWarnings"),
        });
      }

      // Fetch warnings directly from the database
      const userWarnings = getUserWarnings(groupId, mentionedJid);

      if (userWarnings.length === 0) {
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.warns.hasNoWarnings", { member: mentionedJid.split("@")[0] }),
          mentions: [mentionedJid],
        });
      }

      const who = mentionedJid.split("@")[0];
      let reply = t("bot.moderation.warns.warningsForTotal", { member: who, count: userWarnings.length });

      const mentionedAdmins = [];
      userWarnings.forEach((warning, index) => {
        const adminJid = warning.by;
        mentionedAdmins.push(adminJid);
        const warningDate = new Date(warning.date).toLocaleString(tr("en-GB", "ar-EG"), {
          timeZone: "Africa/Cairo",
        });

        reply += t("bot.moderation.warns.warningReasonByDate", {
          number: index + 1,
          reason: warning.reason,
          admin: adminJid.split("@")[0],
          warningDate,
        });
      });

      const mentions = [mentionedJid, ...mentionedAdmins];

      await sock.sendMessage(groupId, {
        text: reply,
        mentions: mentions,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !warns command");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.moderation.warns.somethingWentWrongWhileListing"),
      });
    }
  },
};
