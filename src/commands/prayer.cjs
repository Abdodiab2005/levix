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
const settings = require("../config/settings.cjs");
const { tr } = require("../utils/i18n.cjs");

// The one HTTP GET the command performs. Exposed so tests can stub the network.
const http = {
  get: (url, options) => axios.get(url, options),
};

// AlAdhan's path date is DD-MM-YYYY. Parts are taken in `timeZone` so the
// day is the local day, including just after midnight.
function prayerDate(now, timeZone) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(now);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value("day")}-${value("month")}-${value("year")}`;
}

function buildPrayerUrl(city, { now = new Date(), timeZone = settings.get("bot_timezone") } = {}) {
  const url = new URL(`https://api.aladhan.com/v1/timingsByCity/${prayerDate(now, timeZone)}`);
  url.searchParams.set("city", city);
  url.searchParams.set("country", "EG");
  url.searchParams.set("state", "Egypt");
  url.searchParams.set("method", "5");
  url.searchParams.set("shafaq", "general");
  url.searchParams.set("tune", "5");
  url.searchParams.set("timezonestring", timeZone);
  url.searchParams.set("calendarMethod", "UAQ");
  return url.toString();
}

module.exports = {
  name: "prayer",
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

    // 4. Today's date in the bot timezone, with the city encoded as a query value.
    const API_URL = buildPrayerUrl(city);

    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: tr("Fetching the times...", "يتم جلب البيانات..."),
      });
      // 5. We will make the API call using axios
      const response = await http.get(API_URL);
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

  // Pure helper and the HTTP seam, kept for tests.
  http,
  buildPrayerUrl,
};
