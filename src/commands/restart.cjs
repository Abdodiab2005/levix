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

    // SIGTERM to ourselves, not process.exit(): that is the path in
    // src/index.js that cancels the reconnect timers, closes the WhatsApp
    // socket, flushes the store and closes the database. Exiting straight from
    // here skipped all four and left the WAL unchecked-pointed. The supervisor
    // (pm2 / systemd / docker) brings the process back.
    process.kill(process.pid, "SIGTERM");
  },
};
