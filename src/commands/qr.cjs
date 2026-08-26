// file: /commands/qr.js
const qrcode = require("qrcode");
const logger = require("../utils/logger.cjs");

module.exports = {
  name: "qr",
  description: "Generates a QR code from text.",
  usage: "qr <نص|رابط>",
  chat: "all",

  async execute(sock, msg, args) {
    const remoteJid = msg.key.remoteJid;
    const textToEncode = args.join(" ");

    if (!textToEncode) {
      return await sock.sendMessage(remoteJid, {
        text: "يرجى كتابة النص أو الرابط الذي تريد تحويله بعد الأمر.\n*مثال:*\n`!qr https://google.com`",
      });
    }

    try {
      // Generate the QR code and get it as a Buffer (raw image data)
      const qrImageBuffer = await qrcode.toBuffer(textToEncode, {
        errorCorrectionLevel: "H", // High error correction
      });

      // Send the image buffer as a photo
      await sock.sendMessage(remoteJid, {
        image: qrImageBuffer,
        caption: `*QR Code for:*\n\`\`\`${textToEncode}\`\`\``,
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to generate QR code");
      await sock.sendMessage(remoteJid, {
        text: "حدث خطأ أثناء إنشاء QR code.",
      });
    }
  },
};
