// file: src/commands/lang.cjs
const logger = require("../utils/logger.cjs");
const settings = require("../config/settings.cjs");
const runtimeConfig = require("../config/runtime-config.cjs");
const { isOwnerJidSync, isBotAdminUserSync } = require("../utils/permissions.cjs");
const { normalizeLocale, t, withLang } = require("../utils/i18n.cjs");

module.exports = {
  name: "lang",
  aliases: ["language", "لغة"],
  chat: "all",

  async execute(sock, msg, args) {
    const chatId = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    const prefix = runtimeConfig.getPrefix();
    const currentLang = settings.get("bot_language") || "auto";
    const firstArg = args?.[0] ? String(args[0]).toLowerCase().trim() : "";
    const requestedLang = firstArg === "auto" ? "auto" : normalizeLocale(firstArg);

    if (!args || args.length === 0) {
      const labels = {
        auto: t("bot.lang.autoLabel"),
        ar: t("bot.lang.arLabel"),
        en: t("bot.lang.enLabel"),
        "pt-BR": t("bot.lang.ptBrLabel"),
        "es-419": t("bot.lang.es419Label"),
      };
      const text = t("bot.lang.list", { prefix, current: labels[currentLang] || currentLang });
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    if (requestedLang) {
      if (args.length > 1) {
        await sock.sendMessage(
          chatId,
          { text: t("bot.lang.digitHint", { prefix, option: firstArg, rest: args.slice(1).join(" ") }) },
          { quoted: msg },
        );
        return;
      }

      const isOwner = isOwnerJidSync(sender);
      const isAdmin = isBotAdminUserSync(sender);
      if (!isOwner && !isAdmin) {
        await sock.sendMessage(chatId, { text: t("bot.lang.denied", { prefix }) }, { quoted: msg });
        return;
      }

      settings.set("bot_language", requestedLang);
      logger.info(`[Language] Bot response language set to: ${requestedLang}`);

      const confirmation = {
        ar: "selectedAr",
        en: "selectedEn",
        auto: "selectedAuto",
        "pt-BR": "selectedPtBr",
        "es-419": "selectedEs419",
      }[requestedLang];
      const text = requestedLang !== "auto"
        ? withLang(requestedLang, () => t(`bot.lang.${confirmation}`))
        : t(`bot.lang.${confirmation}`);
      await sock.sendMessage(chatId, { text }, { quoted: msg });
      return;
    }

    await sock.sendMessage(chatId, { text: t("bot.lang.unknown", { prefix }) }, { quoted: msg });
  },
};
