// file: /commands/group/setpp.js
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setpp", // pp = profile picture
  description: {
    en: "Changes the group's profile picture.",
    ar: "يغيّر صورة المجموعة.",
  },
  usage: {
    en: "setpp   (reply to an image)",
    ar: "setpp   (رد على صورة)",
  },
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    // Check if the command is a reply to a message, and if that message is an image
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || !quoted.imageMessage) {
      return await sock.sendMessage(groupId, {
        text: tr(
          "To change the group's picture, reply to the image you want with this command.",
          "لتغيير صورة المجموعة، يرجى الرد على الصورة التي تريدها بهذا الأمر.",
        ),
      });
    }

    try {
      await sock.sendMessage(groupId, {
        text: tr("🖼️ Changing the group's picture...", "🖼️ جارٍ تغيير صورة المجموعة..."),
      });

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

      await sock.sendMessage(groupId, {
        text: tr("✅ The group's picture was updated.", "✅ تم تحديث صورة المجموعة بنجاح."),
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !group setpp command");
      await sock.sendMessage(groupId, {
        text: tr(
          "Something went wrong. Make sure I'm an admin and the image is valid.",
          "حدث خطأ. تأكد من أنني مشرف وأن الصورة صالحة.",
        ),
      });
    }
  },
};
