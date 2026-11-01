// file: /commands/qr.js
const qrcode = require("qrcode");
const logger = require("../utils/logger.cjs");
const { t } = require("../utils/i18n.cjs");

module.exports = {
  name: "qr",
  chat: "all",
  // What goes in the code is data, not the language you are talking in.
  neutralArgs: true,

  async execute(sock, msg, args) {
    const remoteJid = msg.key.remoteJid;
    const textToEncode = args.join(" ");

    if (!textToEncode) {
      return await sock.sendMessage(remoteJid, {
        text: t("bot.core.qr.usage"),
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
        caption: t("bot.core.qr.caption", { text: textToEncode }),
      });
    } catch (error) {
      logger.error({ err: error }, "Failed to generate QR code");
      await sock.sendMessage(remoteJid, {
        text: t("bot.core.qr.failed"),
      });
    }
  },
};
