// file: /commands/listschedules.js
const { getScheduledJobs } = require("../../scheduler.cjs");
const { tr } = require("../utils/i18n.cjs");

module.exports = {
  name: "listschedules",
  description: {
    en: "Lists all active and pending scheduled messages.",
    ar: "يعرض كل الرسائل المجدولة النشطة والمعلّقة.",
  },
  usage: {
    en: "listschedules",
    ar: "listschedules",
  },
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg) {
    const jobs = getScheduledJobs();
    const activeJobs = jobs.filter((job) => job.status === "pending" || job.status === "active");

    if (activeJobs.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr("There are no scheduled messages.", "لا توجد مهام مجدولة حاليًا."),
      });
    }

    let reply = tr("*⏰ Active scheduled messages:*\n\n", "*⏰ المهام المجدولة النشطة:*\n\n");

    activeJobs.forEach((job, index) => {
      reply += tr(`*${index + 1}. Job:*\n`, `*${index + 1}. المهمة:*\n`);
      reply += `*ID:* \`${job.id}\`\n`;
      reply += tr(`*Message:* "${job.message}"\n`, `*الرسالة:* "${job.message}"\n`);

      if (job.type === "recurring") {
        reply += tr(
          `*Repeats:* ${job.cronString} (daily/weekly)\n`,
          `*التكرار:* ${job.cronString} (يوميًا/أسبوعيًا)\n`,
        );
      } else {
        const jobDate = new Date(job.date).toLocaleString(tr("en-GB", "ar-EG"), {
          timeZone: "Africa/Cairo",
        });
        reply += tr(`*When:* ${jobDate}\n`, `*الوقت المحدد:* ${jobDate}\n`);
      }
      const inGroup = job.targetJid.endsWith("@g.us");
      reply += tr(
        `*Where:* ${inGroup ? "this group" : "a private chat"}\n\n`,
        `*الوجهة:* ${inGroup ? "هذا الجروب" : "محادثة خاصة"}\n\n`,
      );
    });

    reply += tr(
      "*To delete one, use:*\n`!deleteschedule <ID>`",
      "*لحذف مهمة، استخدم:*\n`!deleteschedule <ID>`",
    );

    await sock.sendMessage(msg.key.remoteJid, { text: reply });
  },
};
