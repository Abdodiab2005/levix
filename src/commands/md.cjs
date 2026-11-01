const runtimeConfig = require("../config/runtime-config.cjs");
const { t } = require("../utils/i18n.cjs");
const { quotedOf, visibleText } = require("../utils/messageContent.cjs");
const { formatMarkdownForWhatsApp } = require("../utils/markdownParser.cjs");

module.exports = {
  name: "md",
  aliases: ["markdown"],
  chat: "all",

  async execute(sock, msg, args, body) {
    const prefix = runtimeConfig.getPrefix();
    // args have been split by the dispatcher. Read the body to retain table
    // rows, code indentation and paragraph breaks, including !md\n<text>.
    const inline =
      typeof body === "string"
        ? body
            .slice(prefix.length)
            .trimStart()
            .replace(/^\S+[ \t]*(?:\r?\n)?/, "")
        : (args || []).join(" ");
    const text = inline.trim() ? inline : visibleText(quotedOf(msg));
    return sock.sendMessage(
      msg.key.remoteJid,
      {
        text: text.trim()
          ? formatMarkdownForWhatsApp(text)
          : t("bot.core.md.usage", { prefix }),
      },
      { quoted: msg },
    );
  },
};
