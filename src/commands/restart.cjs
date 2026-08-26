// file: /commands/restart.js
const { delay } = require("@whiskeysockets/baileys");
const logger = require("../utils/logger.cjs");

module.exports = {
  name: "restart",
  description: "Restarts the bot.",
  usage: "restart",
  chat: "all",

  async execute(sock, msg) {
    logger.warn("Received !restart command. Restarting bot...");

    // Send a confirmation message before exiting
    await sock.sendMessage(msg.key.remoteJid, {
      text: "✅ جاري إعادة تشغيل البوت... سأعود بعد لحظات.",
    });

    // A small delay to ensure the message is sent before the process exits
    await delay(2000); // 2-second delay

    // This will stop the current process. PM2 will automatically restart it.
    process.exit(0);
  },
};
