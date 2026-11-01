// file: /commands/status.js

const os = require("os");
const baileysVersion = require("@whiskeysockets/baileys/package.json").version;
const logger = require("../utils/logger.cjs");
const { checkFfmpeg } = require("../utils/thumbnail.cjs");
const { t } = require("../utils/i18n.cjs");

/**
 * A helper function to format seconds into a human-readable string.
 * e.g., 86461 seconds -> "1 day, 0 hours, 1 minute, 1 second"
 * @param {number} seconds - The total seconds to format.
 * @returns {string} The formatted uptime string.
 */
function formatUptime(seconds) {
  const d = Math.floor(seconds / (3600 * 24));
  const h = Math.floor((seconds % (3600 * 24)) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);

  return t("bot.core.status.uptime", { days: d, hours: h, minutes: m, seconds: s });
}

module.exports = {
  name: "status",
  description: {
    en: "Shows the bot's system status.",
    ar: "يعرض حالة نظام البوت.",
  },
  usage: {
    en: "status",
    ar: "status",
  },
  chat: "all", // Can be used in any chat

  async execute(sock, msg) {
    try {
      // --- GATHERING DATA ---

      // 1. Uptime
      const uptimeSeconds = process.uptime();
      const formattedUptime = formatUptime(uptimeSeconds);

      // 2. RAM Usage
      // process.memoryUsage().rss is the Resident Set Size in bytes
      const rssBytes = process.memoryUsage().rss;
      const rssMb = (rssBytes / 1024 / 1024).toFixed(2); // Convert to MB

      // 3. Node.js Version
      const nodeVersion = process.version;

      // 4. Operating System Info
      const platform = os.platform();
      const osRelease = os.release();

      // 5. ffmpeg — media previews (jpegThumbnail) depend on it, and a broken
      //    binary is otherwise invisible.
      const ffmpeg = await checkFfmpeg();
      const ffmpegLine = ffmpeg.ok
        ? `✅ ${ffmpeg.version || t("bot.core.status.working")}`
        : t("bot.core.status.ffmpegBroken", { path: ffmpeg.path });

      // --- BUILDING THE REPLY ---
      const reply = t("bot.core.status.report", {
        uptime: formattedUptime,
        memoryMb: rssMb,
        nodeVersion,
        baileysVersion,
        platform,
        osRelease,
        ffmpegLine,
      });

      await sock.sendMessage(msg.key.remoteJid, { text: reply });
    } catch (error) {
      logger.error(error, "[Error] في أمر !status:");
      await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.core.status.failed"),
      });
    }
  },
};
