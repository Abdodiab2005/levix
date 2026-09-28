const { scheduleNewJob, saveScheduledJob } = require("../../scheduler.cjs");
const { randomUUID } = require("node:crypto");
const { defaultTimezone } = require("../utils/datetime.cjs");
const { parseRecurringArgs } = require("../utils/recurrence.cjs");
const { tr } = require("../utils/i18n.cjs");

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
        usage: tr(
          "Wrong format. Use:\n`!autoschedule daily HH:mm your message`\n`!autoschedule weekly day HH:mm your message`",
          "الصيغة غير صحيحة. استخدم:\n`!autoschedule daily HH:mm رسالتك`\n`!autoschedule weekly day HH:mm رسالتك`",
        ),
        type: tr(
          "Unsupported type. Use `daily` or `weekly`.",
          "النوع غير مدعوم. استخدم: `daily` أو `weekly`.",
        ),
        day: tr(
          "Invalid day. Use the day's name in English or Arabic, or a number from 0 to 7 (0 and 7 are Sunday).",
          "اليوم غير صالح. استخدم اسم اليوم بالعربية أو الإنجليزية، أو رقمًا من 0 إلى 7 (0 و7 للأحد).",
        ),
        time: tr(
          "Invalid time. Use `HH:mm` (for example `09:30`).",
          "الوقت غير صالح. استخدم صيغة `HH:mm` (مثال: `09:30`).",
        ),
        message: tr(
          "Write the message you want to schedule after the time.",
          "اكتب الرسالة التي تريد جدولتها بعد الوقت.",
        ),
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
        text: tr(
          "I couldn't schedule that message. Check the time and try again.",
          "معرفتش أجدول الرسالة دي. راجع الوقت وجرب تاني.",
        ),
      });
    }

    saveScheduledJob(newJob);

    await sock.sendMessage(creatorJid, {
      text:
        parsed.type === "weekly"
          ? tr(
              `✅ Scheduled weekly on ${args[1]} at ${parsed.time} (${defaultTimezone()})`,
              `✅ تم جدولة الرسالة أسبوعيًا يوم ${args[1]} الساعة ${parsed.time} (${defaultTimezone()})`,
            )
          : tr(
              `✅ Scheduled daily at ${parsed.time} (${defaultTimezone()})`,
              `✅ تم جدولة الرسالة يوميًا الساعة ${parsed.time} (${defaultTimezone()})`,
            ),
    });
  },
};
