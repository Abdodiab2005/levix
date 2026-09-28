// file: /commands/qr.js
const qrcode = require("qrcode");
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "qr",
  description: {
    en: "Generates a QR code from text.",
    ar: "ينشئ رمز QR من نص.",
  },
  usage: {
    en: "qr <text|link>",
    ar: "qr <نص|رابط>",
  },
  chat: "all",
  // What goes in the code is data, not the language you are talking in.
  neutralArgs: true,

  async execute(sock, msg, args) {
    const remoteJid = msg.key.remoteJid;
    const textToEncode = args.join(" ");

    if (!textToEncode) {
      return await sock.sendMessage(remoteJid, {
        text: tr(
          "Write the text or link to encode after the command.\n*Example:*\n`!qr https://google.com`",
          "يرجى كتابة النص أو الرابط الذي تريد تحويله بعد الأمر.\n*مثال:*\n`!qr https://google.com`",
        ),
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
        caption: tr(
          `*QR code for:*\n\`\`\`${textToEncode}\`\`\``,
          `*رمز QR لـ:*\n\`\`\`${textToEncode}\`\`\``,
        ),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to generate QR code");
      await sock.sendMessage(remoteJid, {
        text: tr("Something went wrong while making the QR code.", "حدث خطأ أثناء إنشاء QR code."),
      });
    }
  },
};
