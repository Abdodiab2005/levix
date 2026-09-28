// file: /commands/setprefix.cjs
const logger = require("../utils/logger.cjs");
// Same validation and storage the dashboard uses, so both doors agree.
const runtimeConfig = require("../config/runtime-config.cjs");
const { tr } = require("../utils/i18n.cjs");

const PREFIX_ERRORS_AR = {
  "Prefix can't be empty": "البادئة لا يمكن أن تكون فارغة",
  "Prefix can't be longer than 3 characters": "البادئة لا يمكن أن تزيد عن 3 أحرف",
  "Prefix can't contain whitespace": "البادئة لا يمكن أن تحتوي على مسافات",
};

module.exports = {
  name: "setprefix",
  aliases: ["prefix"],
  description: {
    en: "Sets the bot's command prefix (owner only).",
    ar: "يغيّر بادئة أوامر البوت (للمالك فقط).",
  },
  usage: {
    en: "setprefix <new prefix>",
    ar: "setprefix <البادئة الجديدة>",
  },
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;

    if (args.length === 0) {
      // Show current prefix
      const currentPrefix = runtimeConfig.getPrefix();

      await sock.sendMessage(chatId, {
        text: tr(
          `The bot's current prefix: \`${currentPrefix}\`\n\nTo change it, use:\n\`${currentPrefix}setprefix <new_prefix>\`\n\nExample: \`${currentPrefix}setprefix /\`\n\n⚠️ Only the owner can change the prefix.`,
          `البادئة الحالية للبوت: \`${currentPrefix}\`\n\nلتغيير البادئة، استخدم:\n\`${currentPrefix}setprefix <البادئة_الجديدة>\`\n\nمثال: \`${currentPrefix}setprefix /\`\n\n⚠️ ملاحظة: يمكن للمالك فقط تغيير البادئة.`,
        ),
      });
      return;
    }

    let newPrefix;
    try {
      newPrefix = runtimeConfig.setPrefix(args[0]);
    } catch (error) {
      // runtime-config words its refusals in English for the dashboard.
      await sock.sendMessage(chatId, {
        text: `❌ ${tr(error.message, PREFIX_ERRORS_AR[error.message] || error.message)}`,
      });
      return;
    }

    logger.info(`[Prefix] Bot prefix changed to: ${newPrefix}`);

    await sock.sendMessage(chatId, {
      text: tr(
        `✅ The prefix is now \`${newPrefix}\`\n\nUse \`${newPrefix}help\` to see the commands.\n\n⚠️ The new prefix works in every chat right away.`,
        `✅ تم تغيير البادئة بنجاح إلى: \`${newPrefix}\`\n\nالآن استخدم \`${newPrefix}help\` لعرض الأوامر.\n\n⚠️ البادئة الجديدة تعمل الآن في كل المحادثات.`,
      ),
    });
  },
};
