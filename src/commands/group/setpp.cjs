// file: /commands/group/setpp.js
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "setpp", // pp = profile picture
  description: "Changes the group's profile picture.",
  usage: "setpp   (رد على صورة)",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg) {
    const groupId = msg.key.remoteJid;

    // Check if the command is a reply to a message, and if that message is an image
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || !quoted.imageMessage) {
      return await sock.sendMessage(groupId, {
        text: "لتغيير صورة الجروب، يرجى الرد على الصورة التي تريدها بهذا الأمر.",
      });
    }

    try {
      await sock.sendMessage(groupId, { text: "🖼️ جاري تغيير صورة الجروب..." });

      // Download the image from the quoted message
      const imageBuffer = await downloadMediaMessage(
        {
          key: msg.message.extendedTextMessage.contextInfo.stanzaId,
          remoteJid: groupId,
          id: msg.message.extendedTextMessage.contextInfo.participant,
        },
        "buffer",
        {}
      );

      // Update the group's profile picture using the downloaded image buffer
      await sock.updateProfilePicture(groupId, imageBuffer);

      await sock.sendMessage(groupId, {
        text: "✅ تم تحديث صورة الجروب بنجاح.",
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !group setpp command");
      await sock.sendMessage(groupId, {
        text: "حدث خطأ. تأكد من أنني مشرف وأن الصورة صالحة.",
      });
    }
  },
};
