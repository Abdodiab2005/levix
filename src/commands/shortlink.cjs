// file: /commands/shortlink.js

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

// A simple regex to validate if the input is a URL
const urlRegex = new RegExp(/^(https?:\/\/[^\s/$.?#].[^\s]*)$/i);

module.exports = {
  name: "shortlink",
  description: "Shortens a long URL using the is.gd service.",
  usage: "shortlink <الرابط>",
  chat: "all", // This command can be used anywhere

  async execute(sock, msg, args) {
    // 1. Check if the user provided any arguments
    if (!args || args.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "يرجى إرسال الرابط الذي تريد اختصاره.\n\n*مثال:*\n`!shortlink https://github.com/WhiskeySockets/Baileys`",
      });
    }

    const longUrl = args[0];

    // 2. Validate if the provided argument is a valid URL
    if (!urlRegex.test(longUrl)) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "الرابط الذي أرسلته غير صالح. يرجى التأكد من أنه يبدأ بـ `http://` أو `https://`.",
      });
    }

    // 3. Define the API endpoint for is.gd
    // We use `encodeURIComponent` to ensure the URL is properly formatted for the API request
    const API_URL = `https://is.gd/create.php?format=simple&url=${encodeURIComponent(
      longUrl
    )}`;

    // One message: "shortening..." becomes the short link itself.
    const status = await createStatus(
      sock,
      msg.key.remoteJid,
      "🔗 بختصر الرابط...",
      { replyTo: msg },
    );

    try {
      // 4. Make the GET request to the API
      const response = await axios.get(API_URL);

      // 5. The API returns the shortened URL as plain text in the response body
      const shortUrl = response.data;

      const reply =
        `✅ تم اختصار الرابط بنجاح!\n\n` + `🔗 *الرابط المختصر:*\n${shortUrl}`;

      await status.finish(reply);
    } catch (error) {
      logger.error(
        error.response ? error.response.data : error.message,
        "[Error] in !shortlink command:"
      );

      // The API returns a plain text error message if something goes wrong
      const errorMessage = error.response
        ? error.response.data
        : "حدث خطأ غير متوقع.";

      await sock.sendMessage(msg.key.remoteJid, {
        text: `*عذرًا، حدث خطأ:*\n\n` + `\`\`\`${errorMessage}\`\`\``,
      });
    }
  },
};
