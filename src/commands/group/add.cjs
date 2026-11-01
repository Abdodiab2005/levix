// file: /commands/add.js (Upgraded with Invite Fallback)
const logger = require("../../utils/logger.cjs");
const { t } = require("../../utils/i18n.cjs");
const normalizeJid = require("../../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "add",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  // The full, correct execute function for commands/add.js

  async execute(sock, msg, args, body, groupMetadata, confirmationSessions) {
    const groupId = msg.key.remoteJid;
    const senderId = msg.key.participant; // The admin who is running the command
    let targetJid;
    let shouldPromote = false;

    try {
      // --- ✅ THIS IS THE MISSING LOGIC TO DEFINE targetJid ---
      // 1. Identify the Target User
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      let contactJid;

      // Check for contact card in a quoted message
      const quotedVcard =
        msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.contactMessage?.vcard;
      if (quotedVcard) {
        contactJid = quotedVcard.match(/waid=([0-9]+)/)?.[1] + "@s.whatsapp.net";
      }

      // If not found, check for contact card in the main message
      if (!contactJid || !contactJid.includes("@")) {
        const mainVcard = msg.message?.contactMessage?.vcard;
        if (mainVcard) {
          contactJid = mainVcard.match(/waid=([0-9]+)/)?.[1] + "@s.whatsapp.net";
        }
      }

      let numberArg = args.join(" ");

      if (mentionedJid) {
        targetJid = normalizeJid(mentionedJid);
      } else if (contactJid && contactJid.includes("@")) {
        targetJid = normalizeJid(contactJid);
      } else if (numberArg) {
        if (args[0].toLowerCase() === "admin") {
          shouldPromote = true;
          numberArg = args.slice(1).join(" ");
        }
        const cleanNumber = numberArg.replace(/\D/g, "");
        if (!cleanNumber)
          return await sock.sendMessage(groupId, {
            text: t("bot.group.add.invalidNumber"),
          });
        targetJid = `${cleanNumber}@s.whatsapp.net`;
      } else {
        return await sock.sendMessage(groupId, {
          text: t("bot.group.add.usageHint"),
        });
      }
      // --- End of Target Identification Logic ---

      // Pre-check if the user is already in the group
      const isAlreadyMember = groupMetadata.participants.some(
        (p) => normalizeJid(p.id) === normalizeJid(targetJid),
      );
      if (isAlreadyMember) {
        return await sock.sendMessage(groupId, {
          text: t("bot.group.add.alreadyMember", { number: targetJid.split("@")[0] }),
          mentions: [targetJid],
        });
      }

      await sock.sendMessage(groupId, {
        text: t("bot.group.add.trying", { number: targetJid.split("@")[0] }),
        mentions: [targetJid],
      });
      const response = await sock.groupParticipantsUpdate(groupId, [targetJid], "add");
      const status = response[0].status;

      if (status === "200") {
        let successMsg = t("bot.group.add.added", { number: targetJid.split("@")[0] });
        if (shouldPromote) {
          await sock.groupParticipantsUpdate(groupId, [targetJid], "promote");
          successMsg += t("bot.group.add.madeAdmin");
        }
        await sock.sendMessage(groupId, {
          text: successMsg,
          mentions: [targetJid],
        });
      } else if (status === "403") {
        await sock.sendMessage(groupId, {
          text: t("bot.group.add.privacyBlocked", { number: targetJid.split("@")[0] }),
          mentions: [targetJid],
        });

        confirmationSessions.set(senderId, {
          command: "send_invite",
          groupId: groupId,
          targetJid: targetJid,
          adminJid: senderId,
          timestamp: Date.now(),
        });

        setTimeout(() => {
          if (confirmationSessions.has(senderId)) {
            confirmationSessions.delete(senderId);
          }
        }, 30000);
      } else {
        await sock.sendMessage(groupId, {
          text: t("bot.group.add.failedStatus", { status }),
        });
      }
    } catch (error) {
      logger.error({ err: error, command: "add" }, "Error in !add command");
      await sock.sendMessage(groupId, {
        text: t("bot.group.add.failed"),
      });
    }
  },
};
