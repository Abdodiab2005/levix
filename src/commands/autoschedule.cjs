const {
  scheduleNewJob,
  saveScheduledJob,
} = require("../../scheduler.cjs");
const { randomUUID } = require("node:crypto");
const { defaultTimezone } = require("../utils/datetime.cjs");
const { parseRecurringArgs } = require("../utils/recurrence.cjs");

module.exports = {
  name: "autoschedule",
  description: "Schedules a recurring message (daily, weekly).",
  usage: "autoschedule daily <HH:mm> <الرسالة>\nautoschedule weekly <اليوم> <HH:mm> <الرسالة>",
  chat: "all",

  async execute(sock, msg, args) {
    const creatorJid = msg.key.participant || msg.key.remoteJid;
    const targetJid = msg.key.remoteJid;
    const parsed = parseRecurringArgs(args);

    if (parsed.error) {
      const errors = {
        usage:
          "الصيغة غير صحيحة. استخدم:\n`!autoschedule daily HH:mm رسالتك`\n`!autoschedule weekly day HH:mm رسالتك`",
        type: "النوع غير مدعوم. استخدم: `daily` أو `weekly`.",
        day: "اليوم غير صالح. استخدم اسم اليوم بالعربية أو الإنجليزية، أو رقمًا من 0 إلى 7 (0 و7 للأحد).",
        time: "الوقت غير صالح. استخدم صيغة `HH:mm` (مثال: `09:30`).",
        message: "اكتب الرسالة التي تريد جدولتها بعد الوقت.",
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
        text: "معرفتش أجدول الرسالة دي. راجع الوقت وجرب تاني.",
      });
    }

    saveScheduledJob(newJob);

    await sock.sendMessage(creatorJid, {
      text:
        parsed.type === "weekly"
          ? `✅ تم جدولة الرسالة أسبوعيًا يوم ${args[1]} الساعة ${parsed.time} (${defaultTimezone()})`
          : `✅ تم جدولة الرسالة يوميًا الساعة ${parsed.time} (${defaultTimezone()})`,
    });
  },
};
