// file: /commands/unblock.js (Upgraded with private chat context)
const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js");

module.exports = {
  name: "unblock",
  description: "Unblocks a user.",
  usage: "unblock [@عضو|رقم]   (أو رد على رسالته)",
  chat: "all",

  async execute(sock, msg, args) {
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");
    let targetJid;

    if (!isGroup && args.length === 0) {
      targetJid = remoteJid;
    } else {
      const mentionedJid =
        msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const numberArg = args[0];

      if (mentionedJid) {
        targetJid = mentionedJid;
      } else if (numberArg) {
        targetJid = `${numberArg.replace(/\D/g, "")}@s.whatsapp.net`;
      } else {
        return await sock.sendMessage(remoteJid, {
          text: "لفك حظر عضو، استخدم الأمر في شاته الخاص، أو قم بعمل منشن له، أو كتابة رقمه.",
        });
      }
    }

    const normalizedTargetJid = normalizeJid(targetJid);

    try {
      // ✅ --- THE FIX IS HERE ---
      await sock.updateBlockStatus(normalizedTargetJid, "unblock");

      // const successMsg = `✅ تم فك حظر @${
      //   normalizedTargetJid.split("@")[0]
      // } بنجاح.`;
      // await sock.sendMessage(remoteJid, {
      //   text: successMsg,
      //   mentions: [normalizedTargetJid],
      // });
    } catch (error) {
      logger.error(
        { err: error, command: "unblock" },
        "Error in !unblock command"
      );
      await sock.sendMessage(remoteJid, {
        text: "حدث خطأ أثناء محاولة فك حظر المستخدم.",
      });
    }
  },
};
