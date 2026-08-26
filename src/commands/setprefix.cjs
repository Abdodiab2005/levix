// file: /commands/setprefix.cjs
const logger = require("../utils/logger.cjs");
// Same validation and storage the dashboard uses, so both doors agree.
const runtimeConfig = require("../config/runtime-config.cjs");

module.exports = {
  name: "setprefix",
  aliases: ["prefix"],
  description: "Set custom prefix for the bot (Owner only)",
  usage: "setprefix <البادئة الجديدة>",
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    if (args.length === 0) {
      // Show current prefix
      const currentPrefix = runtimeConfig.getPrefix();

      await sock.sendMessage(chatId, {
        text: `البادئة الحالية للبوت: \`${currentPrefix}\`\n\nلتغيير البادئة، استخدم:\n\`${currentPrefix}setprefix <البادئة_الجديدة>\`\n\nمثال: \`${currentPrefix}setprefix /\`\n\n⚠️ ملاحظة: يمكن للمالك فقط تغيير البادئة.`
      });
      return;
    }

    let newPrefix;
    try {
      newPrefix = runtimeConfig.setPrefix(args[0]);
    } catch (error) {
      await sock.sendMessage(chatId, { text: `❌ ${error.message}` });
      return;
    }

    logger.info(`[Prefix] Bot prefix changed to: ${newPrefix}`);

    await sock.sendMessage(chatId, {
      text: `✅ تم تغيير البادئة بنجاح إلى: \`${newPrefix}\`\n\nالآن استخدم \`${newPrefix}help\` لعرض الأوامر.\n\n⚠️ البادئة الجديدة تعمل الآن في كل المحادثات.`
    });
  },
};
