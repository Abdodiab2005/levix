// file: /commands/all.js
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "all",
  description: "Mentions all members of the group.",
  usage: "all [رسالة التنبيه]",
  chat: "group",

  async execute(sock, msg, args) {
    try {
      // 1. Get the group's JID (JID = WhatsApp ID)
      const groupId = msg.key.remoteJid;

      // 2. Get the group's metadata (this includes the list of participants)
      // We fetch it fresh to make sure we have the latest list of members.
      const metadata = await sock.groupMetadata(groupId);

      // 6. Get the list of all participant JIDs
      const participants = metadata.participants.map((p) => p.id);

      // 7. Prepare the message text and the mentions array
      // You can customize the message text here
      let text = "📢 | تنبيه للجميع";
      if (args && args.length > 0) {
        text = `*📢 | تنبيه للجميع:*\n${args.join(" ")}`;
      }

      // 8. Send the message with mentions
      // The `mentions` property is an array of JIDs that should be mentioned.
      await sock.sendMessage(groupId, {
        text: text,
        mentions: participants,
      });
    } catch (error) {
      logger.error(error, "[Error] in !all command:");
      // Send a reply in case of an error
      await sock.sendMessage(msg.key.remoteJid, {
        text: "حدث خطأ أثناء محاولة عمل منشن للجميع.",
      });
    }
  },
};
