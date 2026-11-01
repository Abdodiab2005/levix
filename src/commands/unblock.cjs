// file: /commands/unblock.js (Upgraded with private chat context)
const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.esm.js").default;
const { t } = require("../utils/i18n.cjs");

module.exports = {
  name: "unblock",
  chat: "all",

  async execute(sock, msg, args) {
    const remoteJid = msg.key.remoteJid;
    const isGroup = remoteJid.endsWith("@g.us");
    let targetJid;

    if (!isGroup && args.length === 0) {
      targetJid = remoteJid;
    } else {
      const mentionedJid = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid?.[0];
      const numberArg = args[0];

      if (mentionedJid) {
        targetJid = mentionedJid;
      } else if (numberArg) {
        targetJid = `${numberArg.replace(/\D/g, "")}@s.whatsapp.net`;
      } else {
        return await sock.sendMessage(remoteJid, {
          text: t("bot.moderation.unblock.toUnblockSomeoneUseThis"),
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
      logger.error({ err: error, command: "unblock" }, "Error in !unblock command");
      await sock.sendMessage(remoteJid, {
        text: t("bot.moderation.unblock.somethingWentWrongWhileUnblocking"),
      });
    }
  },
};
