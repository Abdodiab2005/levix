// file: /commands/weather.js

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

const settings = require("../config/settings.cjs");
const { t, currentLang } = require("../utils/i18n.cjs");

// OpenWeather codes. A map, not tr(): pt-BR and es-419 are not English.
const OPENWEATHER_LANG = {
  en: "en",
  ar: "ar",
  "pt-BR": "pt_br",
  "es-419": "es",
};

function openWeatherLang() {
  return OPENWEATHER_LANG[currentLang()] || "en";
}

function weatherApiUrl(city, apiKey) {
  const lang = openWeatherLang();
  const query = `q=${city}&appid=${apiKey}&units=metric&lang=${lang}`;
  return `https://api.openweathermap.org/data/2.5/weather?${query}`;
}

module.exports = {
  name: "weather",
  weatherApiUrl,
  chat: "all",
  // The city is asked for in English whatever language you speak, so it says
  // nothing about which language to answer in (see utils/i18n.cjs).
  neutralArgs: true,

  async execute(sock, msg, args) {
    if (!args || args.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.tools.weather.noCity"),
      });
    }

    const city = args.join(" ");

    // URL الخاص بـ OpenWeatherMap للحصول على الطقس الحالي
    // - units=metric للحصول على درجة الحرارة بالسيليزيوس
    // - lang: الوصف بلغة الرد
    const apiKey = settings.get("openweathermap_api_key");
    const API_URL = weatherApiUrl(city, apiKey);

    // One message: it starts as "looking it up" and turns into the forecast.
    const status = await createStatus(
      sock,
      msg.key.remoteJid,
      t("bot.tools.weather.looking", { city }),
      {
        replyTo: msg,
      },
    );

    try {
      const response = await axios.get(API_URL);
      const weatherData = response.data;

      // استخلاص البيانات المهمة من الرد
      const weatherDescription = weatherData.weather[0].description;
      const currentTemp = weatherData.main.temp;
      const feelsLike = weatherData.main.feels_like;
      const humidity = weatherData.main.humidity;
      const windSpeed = weatherData.wind.speed;

      // تنسيق رسالة الرد مع الأيقونات
      const reply = t("bot.tools.weather.forecast", {
        city,
        description: weatherDescription,
        temp: currentTemp,
        feelsLike,
        humidity,
        wind: windSpeed,
      });

      await status.finish(reply);
    } catch (error) {
      // التعامل مع الأخطاء
      if (error.response && error.response.status === 404) {
        // خطأ 404 يعني أن المدينة غير موجودة
        await status.finish(
          t("bot.tools.weather.cityNotFound", { city }),
        );
      } else if (error.response && error.response.status === 401) {
        // خطأ 401 يعني أن مفتاح الـ API غير صالح
        logger.error("[Error] Invalid API Key for OpenWeatherMap.");
        await status.finish(
          t("bot.tools.weather.authError"),
        );
      } else {
        // أي أخطاء أخرى
        logger.error(error.message, "[Error] in Weather API:");
        await status.fail(
          error,
          t("bot.tools.weather.failed"),
        );
      }
    }
  },
};
