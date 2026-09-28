// file: /commands/add.js (Upgraded with Invite Fallback)
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");
const normalizeJid = require("../../utils/normalizeJid.esm.js").default;

module.exports = {
  name: "add",
  description: {
    en: "Adds a member to the group, or sends an invite if their privacy settings block it.",
    ar: "يضيف عضوًا إلى المجموعة، أو يرسل له دعوة إذا منعت إعدادات الخصوصية إضافته.",
  },
  usage: {
    en: "add [admin] <phone number>",
    ar: "add [admin] <رقم الهاتف>",
  },
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
            text: tr(
              "Give a valid phone number, a mention, or a contact card.",
              "يرجى تقديم رقم هاتف صالح، أو عمل منشن، أو إرسال جهة اتصال.",
            ),
          });
        targetJid = `${cleanNumber}@s.whatsapp.net`;
      } else {
        return await sock.sendMessage(groupId, {
          text: tr(
            "To add someone, mention them, send their number, or send their contact card.",
            "لإضافة عضو، قم بعمل منشن له، أو أرسل رقمه، أو أرسل جهة الاتصال الخاصة به.",
          ),
        });
      }
      // --- End of Target Identification Logic ---

      // Pre-check if the user is already in the group
      const isAlreadyMember = groupMetadata.participants.some(
        (p) => normalizeJid(p.id) === normalizeJid(targetJid),
      );
      if (isAlreadyMember) {
        return await sock.sendMessage(groupId, {
          text: tr(
            `⚠️ @${targetJid.split("@")[0]} is already in the group.`,
            `⚠️ العضو @${targetJid.split("@")[0]} موجود بالفعل في الجروب.`,
          ),
          mentions: [targetJid],
        });
      }

      await sock.sendMessage(groupId, {
        text: tr(
          `Trying to add @${targetJid.split("@")[0]}...`,
          `جاري محاولة إضافة @${targetJid.split("@")[0]}...`,
        ),
        mentions: [targetJid],
      });
      const response = await sock.groupParticipantsUpdate(groupId, [targetJid], "add");
      const status = response[0].status;

      if (status === "200") {
        let successMsg = tr(
          `✅ Added @${targetJid.split("@")[0]}.`,
          `✅ تم إضافة @${targetJid.split("@")[0]} بنجاح.`,
        );
        if (shouldPromote) {
          await sock.groupParticipantsUpdate(groupId, [targetJid], "promote");
          successMsg += tr(`\n👑 And made them an admin.`, `\n👑 وتمت ترقيته إلى مشرف.`);
        }
        await sock.sendMessage(groupId, {
          text: successMsg,
          mentions: [targetJid],
        });
      } else if (status === "403") {
        await sock.sendMessage(groupId, {
          text: tr(
            `⚠️ @${
              targetJid.split("@")[0]
            } can't be added directly because of their privacy settings.\n\nSend them an invite link in private?\nSend \`yes\` to confirm.`,
            `⚠️ لا يمكن إضافة @${
              targetJid.split("@")[0]
            } مباشرة بسبب إعدادات الخصوصية لديه.\n\nهل تود إرسال رابط دعوة له في الخاص؟\nأرسل \`yes\` للتأكيد.`,
          ),
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
          text: tr(
            `⚠️ I couldn't add that number. (status code: ${status})`,
            `⚠️ لم أتمكن من إضافة الرقم. (كود الحالة: ${status})`,
          ),
        });
      }
    } catch (error) {
      logger.error({ err: error, command: "add" }, "Error in !add command");
      await sock.sendMessage(groupId, {
        text: tr(
          "Something went wrong. Make sure I'm an admin and the number is right.",
          "حدث خطأ. تأكد من أنني مشرف وأن الرقم صحيح.",
        ),
      });
    }
  },
};
