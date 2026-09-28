// file: /commands/ping.js

module.exports = {
  name: "ping",
  description: {
    en: "Checks that the bot is responding.",
    ar: "يتحقق من أن البوت يستجيب.",
  },
  usage: {
    en: "ping",
    ar: "ping",
  },
  chat: "all", // <-- الخاصية الجديدة. يمكن أن تكون 'group' أو 'private'

  async execute(sock, msg) {
    // The bot will reply with "Pong!" and quote the original message
    await sock.sendMessage(msg.key.remoteJid, { text: "Pong! 🏓" }, { quoted: msg });
  },
};
