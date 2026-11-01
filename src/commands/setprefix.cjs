// file: /commands/setprefix.cjs
const logger = require("../utils/logger.cjs");
// Same validation and storage the dashboard uses, so both doors agree.
const runtimeConfig = require("../config/runtime-config.cjs");
const { t, tr } = require("../utils/i18n.cjs");

// runtime-config words its refusals in English for the dashboard. Each known
// refusal maps to a catalog message, built when it is sent.
const PREFIX_ERRORS = {
  "Prefix can't be empty": () => t("bot.core.setprefix.errorEmpty"),
  "Prefix can't be longer than 3 characters": () => t("bot.core.setprefix.errorTooLong"),
  "Prefix can't contain whitespace": () => t("bot.core.setprefix.errorWhitespace"),
};

module.exports = {
  name: "setprefix",
  aliases: ["prefix"],
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
        text: `❌ ${Object.hasOwn(PREFIX_ERRORS, error.message) ? PREFIX_ERRORS[error.message]() : error.message}`,
      });
      return;
    }

    logger.info(`[Prefix] Bot prefix changed to: ${newPrefix}`);

    await sock.sendMessage(chatId, {
      text: t("bot.core.setprefix.changed", { prefix: newPrefix }),
    });
  },
};
