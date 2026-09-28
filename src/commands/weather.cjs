// file: /commands/weather.js

const axios = require("axios");
const logger = require("../utils/logger.cjs");
const { createStatus } = require("../utils/statusMessage.cjs");

const settings = require("../config/settings.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "weather",
  description: {
    en: "Shows the current weather for a city.",
    ar: "يعرض حالة الطقس الحالية لمدينة معيّنة.",
  },
  usage: {
    en: "weather <city in English>",
    ar: "weather <اسم المدينة بالإنجليزية>",
  },
  chat: "all",
  // The city is asked for in English whatever language you speak, so it says
  // nothing about which language to answer in (see utils/i18n.cjs).
  neutralArgs: true,

  async execute(sock, msg, args) {
    if (!args || args.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          "Give the city's name in English.\n\n*Example:* `!weather cairo`",
          "يرجى تقديم اسم المدينة باللغة الانجليزية.\n\n*مثال:* `!weather cairo`",
        ),
      });
    }

    const city = args.join(" ");

    // URL الخاص بـ OpenWeatherMap للحصول على الطقس الحالي
    // - units=metric للحصول على درجة الحرارة بالسيليزيوس
    // - lang: الوصف بلغة الرد
    const apiKey = settings.get("openweathermap_api_key");
    const API_URL = `https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric&lang=${tr("en", "ar")}`;

    // One message: it starts as "looking it up" and turns into the forecast.
    const status = await createStatus(
      sock,
      msg.key.remoteJid,
      tr(`🔍 Looking up the weather in ${city}...`, `🔍 بدور على طقس ${city}...`),
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
      const reply = tr(
        `*Weather in ${city}:*\n\n` +
          `🌤️ Conditions: ${weatherDescription}\n` +
          `🌡️ Temperature: ${currentTemp}°C\n` +
          `🤔 Feels like: ${feelsLike}°C\n` +
          `💧 Humidity: ${humidity}%\n` +
          `🌬️ Wind: ${windSpeed} m/s`,
        `*حالة الطقس في مدينة ${city}:*\n\n` +
          `🌤️ الوصف: ${weatherDescription}\n` +
          `🌡️ درجة الحرارة: ${currentTemp}°C\n` +
          `🤔 الإحساس الفعلي: ${feelsLike}°C\n` +
          `💧 الرطوبة: ${humidity}%\n` +
          `🌬️ سرعة الرياح: ${windSpeed} متر/ثانية`,
      );

      await status.finish(reply);
    } catch (error) {
      // التعامل مع الأخطاء
      if (error.response && error.response.status === 404) {
        // خطأ 404 يعني أن المدينة غير موجودة
        await status.finish(
          tr(
            `I couldn't find a city called "${city}". Check the name.`,
            `لم أتمكن من العثور على مدينة باسم "${city}". يرجى التحقق من الاسم.`,
          ),
        );
      } else if (error.response && error.response.status === 401) {
        // خطأ 401 يعني أن مفتاح الـ API غير صالح
        logger.error("[Error] Invalid API Key for OpenWeatherMap.");
        await status.finish(
          tr(
            "The weather service rejected the API key. Check it in the settings.",
            `حدث خطأ في المصادقة مع خدمة الطقس. يرجى مراجعة مفتاح الـ API.`,
          ),
        );
      } else {
        // أي أخطاء أخرى
        logger.error(error.message, "[Error] in Weather API:");
        await status.fail(
          error,
          tr("Sorry, fetching the weather failed", "عذرًا، حدث خطأ أثناء جلب بيانات الطقس"),
        );
      }
    }
  },
};
