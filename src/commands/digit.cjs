// Convert digits between Western 0-9 and Eastern Arabic / Persian numerals.
const runtimeConfig = require("../config/runtime-config.cjs");
const {
  classifyNumerals,
  convertNumerals,
  getQuotedText,
  isExplicitAr,
  isExplicitEn,
  oppositeNumeralLang,
} = require("../utils/numerals.cjs");
const { t } = require("../utils/i18n.cjs");

function mixedDigitsNotice(prefix) {
  return t("bot.tools.digit.mixed", { prefix });
}

function helpText(prefix) {
  return t("bot.tools.digit.help", { prefix });
}

module.exports = {
  name: "digit",
  aliases: ["digits", "num", "numbers", "numeral", "ارقام", "رقم"],
  description: {
    en: "Converts numbers between Arabic-Indic (٠١٢) and English (012) digits.",
    ar: "يحوّل الأرقام بين الأرقام العربية (٠١٢) والإنجليزية (012).",
  },
  usage: {
    en: "digit [en|ar] [number/text]   (or reply to a message)",
    ar: "digit [en|ar] [رقم/نص]   (أو رد على رسالة)",
  },
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const prefix = runtimeConfig.getPrefix();
    const quotedText = getQuotedText(msg);
    const firstArg = args?.[0] ? String(args[0]).toLowerCase().trim() : "";
    const targetAr = isExplicitAr(firstArg);
    const targetEn = isExplicitEn(firstArg);
    const hasExplicitTarget = targetAr || targetEn;

    if (!args || args.length === 0) {
      if (quotedText && classifyNumerals(quotedText) !== "none") {
        const kind = classifyNumerals(quotedText);
        if (kind === "mixed") {
          await sock.sendMessage(chatId, { text: mixedDigitsNotice(prefix) }, { quoted: msg });
          return;
        }
        const converted = convertNumerals(quotedText, oppositeNumeralLang(kind));
        await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
        return;
      }
      await sock.sendMessage(chatId, { text: helpText(prefix) }, { quoted: msg });
      return;
    }

    const inlineText = hasExplicitTarget ? args.slice(1).join(" ").trim() : args.join(" ").trim();
    const textToConvert = inlineText || quotedText;

    if (!textToConvert) {
      await sock.sendMessage(
        chatId,
        {
          text: t("bot.tools.digit.noText", { prefix }),
        },
        { quoted: msg },
      );
      return;
    }

    if (hasExplicitTarget) {
      const converted = convertNumerals(textToConvert, targetAr ? "ar" : "en");
      await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
      return;
    }

    const kind = classifyNumerals(textToConvert);
    if (kind === "mixed") {
      await sock.sendMessage(chatId, { text: mixedDigitsNotice(prefix) }, { quoted: msg });
      return;
    }
    if (kind === "none") {
      await sock.sendMessage(
        chatId,
        {
          text: t("bot.tools.digit.noDigits", { prefix }),
        },
        { quoted: msg },
      );
      return;
    }

    const converted = convertNumerals(textToConvert, oppositeNumeralLang(kind));
    await sock.sendMessage(chatId, { text: converted }, { quoted: msg });
  },
};
