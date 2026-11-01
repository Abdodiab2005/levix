const { tr } = require("../utils/i18n.cjs");

// file: /commands/ping.js

module.exports = {
  name: "ping",
  chat: "all", // <-- الخاصية الجديدة. يمكن أن تكون 'group' أو 'private'

  async execute(sock, msg) {
    // The bot will reply with "Pong!" and quote the original message
    await sock.sendMessage(
      msg.key.remoteJid,
      { text: tr("Pong! 🏓", "بونج! 🏓") },
      { quoted: msg },
    );
  },
};
