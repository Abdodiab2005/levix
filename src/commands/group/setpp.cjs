// file: /commands/group/setpp.js
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");
const { createStatus } = require("../../utils/statusMessage.cjs");

module.exports = {
  name: "setpp", // pp = profile picture
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    // Check if the command is a reply to a message, and if that message is an image
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || !quoted.imageMessage) {
      return await sock.sendMessage(groupId, {
        text: t("bot.group.setpp.notImage"),
      });
    }

    const status = await createStatus(sock, groupId, t("bot.group.setpp.changing"), {
      replyTo: msg,
    });
    try {
      // Download the image from the quoted message
      const imageBuffer = await downloadMediaMessage(
        {
          key: msg.message.extendedTextMessage.contextInfo.stanzaId,
          remoteJid: groupId,
          id: msg.message.extendedTextMessage.contextInfo.participant,
        },
        "buffer",
        {},
      );

      // Update the group's profile picture using the downloaded image buffer
      await sock.updateProfilePicture(groupId, imageBuffer);

      await status.finish(t("bot.group.setpp.done"));
    } catch (error) {
      logger.error({ err: error }, "Error in !group setpp command");
      await status.finish(t("bot.group.setpp.failed"));
    }
  },
};
