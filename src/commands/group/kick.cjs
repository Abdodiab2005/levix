// file: /commands/kick.js
const logger = require("../../utils/logger.cjs");
const { isOwnerJidSync } = require("../../utils/permissions.cjs");

module.exports = {
  name: "kick",
  description: "Removes a member from the group.",
  usage: "kick @عضو [السبب]",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args, body, groupMetadata) {
    const groupId = msg.key.remoteJid;
    let targetJid;

    // --- Target Identification Logic ---
    // 1. Check for mentions
    if (
      msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.length > 0
    ) {
      targetJid = msg.message.extendedTextMessage.contextInfo.mentionedJid[0];
    }
    // 2. Check if it's a reply to another message
    else if (msg.message?.extendedTextMessage?.contextInfo?.quotedMessage) {
      targetJid = msg.message.extendedTextMessage.contextInfo.participant;
    } else {
      return await sock.sendMessage(groupId, {
        text: "يجب عمل منشن للعضو أو الرد على رسالته لطرده.",
      });
    }

    // --- Safety Checks ---
    // Can't kick the bot itself
    if (targetJid === sock.user.id) {
      return await sock.sendMessage(groupId, { text: "لا يمكنني طرد نفسي." });
    }

    // Can't kick one of the owners
    if (isOwnerJidSync(targetJid)) {
      return await sock.sendMessage(groupId, {
        text: "لا يمكن طرد مالك البوت.",
      });
    }

    // Check if the target is also an admin
    const targetUser = groupMetadata.participants.find(
      (p) => p.id === targetJid
    );
    if (
      targetUser &&
      (targetUser.admin === "admin" || targetUser.admin === "superadmin")
    ) {
      return await sock.sendMessage(groupId, {
        text: "لا يمكن للمشرف طرد مشرف آخر.",
      });
    }

    // --- Execution ---
    try {
      const reason = args.slice(1).join(" ") || "بدون سبب";
      const senderName = msg.pushName;

      const kickMessage =
        `*تم بواسطة:* ${senderName}\n` +
        `*الإجراء:* طرد\n` +
        `*العضو:* @${targetJid.split("@")[0]}\n` +
        `*السبب:* ${reason}`;

      // Announce the kick before performing it
      await sock.sendMessage(groupId, {
        text: kickMessage,
        mentions: [targetJid],
      });

      // Perform the kick
      await sock.groupParticipantsUpdate(groupId, [targetJid], "remove");
    } catch (error) {
      logger.error({ err: error, command: "kick" }, "Error in !kick command");
      await sock.sendMessage(groupId, {
        text: "حدث خطأ أثناء محاولة طرد العضو. قد تكون صلاحياتي غير كافية.",
      });
    }
  },
};
