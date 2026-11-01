const { scheduleNewJob, saveScheduledJob } = require("../../scheduler.cjs");
const { randomUUID } = require("node:crypto");
const logger = require("../utils/logger.cjs");
const { parseRecurringArgs } = require("../utils/recurrence.cjs");
const { t } = require("../utils/i18n.cjs");

module.exports = {
  name: "autoschedule",
  description: {
    en: "Schedules a recurring message (daily or weekly).",
    ar: "يجدول رسالة متكررة (يومية أو أسبوعية).",
  },
  usage: {
    en: "autoschedule daily <HH:mm> <message>\nautoschedule weekly <day> <HH:mm> <message>",
    ar: "autoschedule daily <HH:mm> <الرسالة>\nautoschedule weekly <اليوم> <HH:mm> <الرسالة>",
  },
  chat: "all",

  async execute(sock, msg, args) {
    const creatorJid = msg.key.participant || msg.key.remoteJid;
    const targetJid = msg.key.remoteJid;
    const parsed = parseRecurringArgs(args);

    if (parsed.error) {
      const errors = {
        usage: t("bot.schedules.autoschedule.usage"),
        type: t("bot.schedules.autoschedule.type"),
        day: t("bot.schedules.autoschedule.day"),
        time: t("bot.schedules.autoschedule.time"),
        message: t("bot.schedules.autoschedule.message"),
      };
      return await sock.sendMessage(creatorJid, {
        text: errors[parsed.error],
      });
    }

    const newJob = {
      id: randomUUID(),
      type: "recurring",
      cronString: parsed.cronString,
      message: parsed.message,
      targetJid: targetJid,
      creatorJid: creatorJid,
      status: "active",
    };

    // الجدولة الأول: جوب مش قادرين نجدوله ما يتخزّنش في الملف أصلاً.
    if (!scheduleNewJob(sock, newJob)) {
      return await sock.sendMessage(creatorJid, {
        text: t("bot.schedules.autoschedule.couldNotSchedule"),
      });
    }

    saveScheduledJob(newJob);

    // تأكيد صامت: تفاعل على رسالة الإنشاء بدل رسالة "تم الجدولة" المنفصلة
    try {
      await sock.sendMessage(targetJid, { react: { text: "✅", key: msg.key } });
    } catch (error) {
      logger.warn(
        { err: error, command: "autoschedule" },
        "failed to react to the scheduled message",
      );
    }
  },
};
