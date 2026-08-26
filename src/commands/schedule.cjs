// file: commands/schedule.js
const {
  scheduleNewJob,
  saveScheduledJob,
} = require("../../scheduler.cjs");
const { zonedTimeToDate, defaultTimezone } = require("../utils/datetime.cjs");

const DATETIME_RE = /^(\d{1,2}):(\d{2})\s+(\d{1,2})-(\d{1,2})-(\d{4})$/;

module.exports = {
  name: "schedule",
  description: "Schedules a message to be sent in the future.",
  usage: 'schedule "HH:mm DD-MM-YYYY" "الرسالة"',
  chat: "all",

  async execute(sock, msg, args) {
    const creatorJid = msg.key.participant || msg.key.remoteJid;
    const targetJid = msg.key.remoteJid;

    // We expect the format: !schedule "HH:mm DD-MM-YYYY" "Your message here"
    const commandBody = args.join(" ");
    const parts = commandBody.match(/(["'])(?:(?=(\\?))\2.)*?\1/g);

    if (!parts || parts.length < 2) {
      return await sock.sendMessage(creatorJid, {
        text: 'الصيغة غير صحيحة. يرجى استخدام:\n`!schedule "HH:mm DD-MM-YYYY" "رسالتك"`',
      });
    }

    const dateTimeString = parts[0].slice(1, -1);
    const message = parts[1].slice(1, -1);

    // Parse date and time: "22:30 07-06-2025"
    const match = DATETIME_RE.exec(dateTimeString.trim());
    if (!match) {
      return await sock.sendMessage(creatorJid, {
        text: "صيغة الوقت غير صحيحة. استخدم `HH:mm DD-MM-YYYY` (مثال: `22:30 07-06-2025`).",
      });
    }

    const [, hour, minute, day, month, year] = match.map(Number);

    // الوقت اللي المستخدم كتبه بتوقيت البوت، مش بتوقيت السيرفر. الكود القديم
    // كان بيبنيه بتوقيت السيرفر المحلي وبعدين الجدولة تتم بتوقيت القاهرة،
    // فالرسالة كانت بتتبعت بفارق ساعات على أي سيرفر شغال UTC.
    const scheduleDate = zonedTimeToDate({
      year,
      month,
      day,
      hour,
      minute,
    });

    if (isNaN(scheduleDate.getTime()) || scheduleDate <= new Date()) {
      return await sock.sendMessage(creatorJid, {
        text: "التاريخ أو الوقت غير صالح أو في الماضي. يرجى استخدام صيغة `HH:mm DD-MM-YYYY` بتاريخ مستقبلي.",
      });
    }

    const newJob = {
      id: Date.now().toString(),
      type: "once",
      date: scheduleDate.toISOString(),
      message: message,
      targetJid: targetJid,
      creatorJid: creatorJid,
      status: "pending",
    };

    // Schedule the job to run in the current session
    if (!scheduleNewJob(sock, newJob)) {
      return await sock.sendMessage(creatorJid, {
        text: "معرفتش أجدول الرسالة دي. راجع الوقت وجرب تاني.",
      });
    }

    saveScheduledJob(newJob);

    await sock.sendMessage(creatorJid, {
      text: `✅ تم جدولة رسالتك بنجاح ليتم إرسالها في:\n*${scheduleDate.toLocaleString(
        "ar-EG",
        { timeZone: defaultTimezone() }
      )}*`,
    });
  },
};
