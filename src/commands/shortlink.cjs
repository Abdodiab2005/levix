// file: /commands/shortlink.js

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");
const { tr } = require("../utils/i18n.cjs");

// A simple regex to validate if the input is a URL
const urlRegex = new RegExp(/^(https?:\/\/[^\s/$.?#].[^\s]*)$/i);

module.exports = {
  name: "shortlink",
  description: {
    en: "Shortens a long URL with the is.gd service.",
    ar: "يختصر رابطًا طويلًا باستخدام خدمة is.gd.",
  },
  usage: {
    en: "shortlink <url>",
    ar: "shortlink <الرابط>",
  },
  chat: "all", // This command can be used anywhere
  neutralArgs: true, // a URL is not a language

  async execute(sock, msg, args) {
    // 1. Check if the user provided any arguments
    if (!args || args.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          "Send the link you want to shorten.\n\n*Example:*\n`!shortlink https://github.com/WhiskeySockets/Baileys`",
          "يرجى إرسال الرابط الذي تريد اختصاره.\n\n*مثال:*\n`!shortlink https://github.com/WhiskeySockets/Baileys`",
        ),
      });
    }

    const longUrl = args[0];

    // 2. Validate if the provided argument is a valid URL
    if (!urlRegex.test(longUrl)) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          "That link isn't valid. Make sure it starts with `http://` or `https://`.",
          "الرابط الذي أرسلته غير صالح. يرجى التأكد من أنه يبدأ بـ `http://` أو `https://`.",
        ),
      });
    }

    // 3. Define the API endpoint for is.gd
    // We use `encodeURIComponent` to ensure the URL is properly formatted for the API request
    const API_URL = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(longUrl)}`;

    // One message: "shortening..." becomes the short link itself.
    const status = await createStatus(
      sock,
      msg.key.remoteJid,
      tr("🔗 Shortening...", "🔗 بختصر الرابط..."),
      {
        replyTo: msg,
      },
    );

    try {
      // 4. Make the GET request to the API
      const response = await axios.get(API_URL);

      // 5. The API returns the shortened URL as plain text in the response body
      const shortUrl = response.data;

      const reply = tr(
        `✅ Link shortened!\n\n🔗 *Short link:*\n${shortUrl}`,
        `✅ تم اختصار الرابط بنجاح!\n\n` + `🔗 *الرابط المختصر:*\n${shortUrl}`,
      );

      await status.finish(reply);
    } catch (error) {
      logger.error(
        error.response ? error.response.data : error.message,
        "[Error] in !shortlink command:",
      );

      // The API returns a plain text error message if something goes wrong
      const errorMessage = error.response
        ? error.response.data
        : tr("Something unexpected went wrong.", "حدث خطأ غير متوقع.");

      await sock.sendMessage(msg.key.remoteJid, {
        text:
          tr(`*Sorry, something went wrong:*\n\n`, `*عذرًا، حدث خطأ:*\n\n`) +
          `\`\`\`${errorMessage}\`\`\``,
      });
    }
  },
};
