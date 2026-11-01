// file: /commands/members.js
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");

module.exports = {
  name: "members",
  description: {
    en: "Lists every member of the group with their number.",
    ar: "يعرض كل أعضاء المجموعة مع أرقامهم.",
  },
  usage: {
    en: "members",
    ar: "members",
  },
  chat: "group", // This command only works in groups

  async execute(sock, msg) {
    try {
      // Get the group ID from the message
      const groupId = msg.key.remoteJid;

      // Send a temporary message to let the user know we're working on it
      await sock.sendMessage(groupId, {
        text: t("bot.group.members.fetching"),
      });

      // Fetch the group's metadata
      const metadata = await sock.groupMetadata(groupId);
      const members = metadata.participants;

      // --- Building the reply message ---

      // Start with a header
      let replyText = t("bot.group.members.header", { count: members.length });

      // Create an array of JIDs for the mentions property
      const mentions = [];

      // Loop through each member to create a formatted line
      members.forEach((member, index) => {
        // Get the phone number from the JID
        const phone = member.id.split("@")[0];

        // Check if the member is an admin or superadmin
        const isAdmin = member.admin === "admin" || member.admin === "superadmin";

        // Add the formatted line to our reply text
        // Using @ will create a "mention link" in the WhatsApp message
        replyText += `${index + 1}. @${phone}${isAdmin ? t("bot.group.members.adminBadge") : ""}\n`;

        // Add the member's JID to the mentions array
        mentions.push(member.id);
      });

      // Send the final message with the list and mentions
      await sock.sendMessage(groupId, {
        text: replyText,
        mentions: mentions, // This makes the @ tags clickable
      });
    } catch (error) {
      logger.error(error, "[Error] in !members command:");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.group.members.failed"),
      });
    }
  },
};
