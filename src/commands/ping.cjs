// file: /commands/ping.js

module.exports = {
  name: "ping",
  description: "A simple command to check if the bot is responsive.",
  usage: "ping",
  chat: "all", // <-- الخاصية الجديدة. يمكن أن تكون 'group' أو 'private'

  async execute(sock, msg) {
    // The bot will reply with "Pong!" and quote the original message
    await sock.sendMessage(
      msg.key.remoteJid,
      { text: "Pong! 🏓" },
      { quoted: msg }
    );
  },
};
