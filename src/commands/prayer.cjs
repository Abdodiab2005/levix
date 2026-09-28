// Simple time formatter (inline replacement for deleted formatTime module)
function formatTime12Hour(time24) {
  const [hours, minutes] = time24.split(":");
  const hour = parseInt(hours);
  const ampm = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${hour12}:${minutes} ${ampm}`;
}

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "prayer",
  description: {
    en: "Shows prayer times for a city.",
    ar: "يعرض مواقيت الصلاة لمدينة معيّنة.",
  },
  usage: {
    en: "prayer <city in English>",
    ar: "prayer <اسم المدينة بالإنجليزية>",
  },
  chat: "all", // This command can be used anywhere
  // The city is asked for in English whatever language you speak, so it says
  // nothing about which language to answer in (see utils/i18n.cjs).
  neutralArgs: true,

  async execute(sock, msg, args) {
    // 2. Check if the user provided a city name
    if (!args || args.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          "Give the city's name in English.\n\n*Example:* `!prayer cairo`",
          "يرجى تقديم اسم المدينة باللغة الانجليزية.\n\nمثال:* `!prayer cairo`",
        ),
      });
    }

    // 3. Join the arguments to form the city name (in case it's multi-word like "New York")
    const city = args.join(" ");

    // 4. We will build the API URL here once you provide it
    const API_URL = `https://api.aladhan.com/v1/timingsByCity/06-06-2025?city=${city}&country=EG&state=Egypt&method=5&shafaq=general&tune=5&timezonestring=Africa%2FCairo&calendarMethod=UAQ`;

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: tr("Fetching the times...", "يتم جلب البيانات..."),
      });
      // 5. We will make the API call using axios
      const response = await axios.get(API_URL);
      // 6. We will parse the prayer timings from the response data
      const timings = response.data.data.timings;

      // 7. We will format the reply message
      const reply =
        tr(`*Prayer times for ${city}:*\n\n`, `*مواقيت الصلاة لمدينة ${city}:*\n\n`) +
        `${tr("Fajr", "الفجر")}: ${formatTime12Hour(timings.Fajr)}\n` +
        `${tr("Sunrise", "الشروق")}: ${formatTime12Hour(timings.Sunrise)}\n` +
        `${tr("Dhuhr", "الظهر")}: ${formatTime12Hour(timings.Dhuhr)}\n` +
        `${tr("Asr", "العصر")}: ${formatTime12Hour(timings.Asr)}\n` +
        `${tr("Maghrib", "المغرب")}: ${formatTime12Hour(timings.Maghrib)}\n` +
        `${tr("Isha", "العشاء")}: ${formatTime12Hour(timings.Isha)}`;

      // 8. Send the formatted message
      await sock.sendMessage(msg.key.remoteJid, {
        text: reply,
      });
    } catch (error) {
      logger.error(error.message, "[Error] in Prayer API:");
      // 9. Handle errors, like city not found or API failure
      await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          `Sorry, I couldn't find prayer times for "${city}". Check the city's name and try again.`,
          `عذراً، لم أتمكن من العثور على وقت الصلاة في "${city}". يرجى التحقق من اسم المدينة ومحاولة مرة أخرى.`,
        ),
      });
    }
  },
};
