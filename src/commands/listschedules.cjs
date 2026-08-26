// file: /commands/listschedules.js
const { getScheduledJobs } = require("../../scheduler.cjs");

module.exports = {
  name: "listschedules",
  description: "Lists all active and pending scheduled jobs.",
  usage: "listschedules",
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg) {
    const jobs = getScheduledJobs();
    const activeJobs = jobs.filter(
      (job) => job.status === "pending" || job.status === "active"
    );

    if (activeJobs.length === 0) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "لا توجد مهام مجدولة حاليًا.",
      });
    }

    let reply = "*⏰ المهام المجدولة النشطة:*\n\n";

    activeJobs.forEach((job, index) => {
      reply += `*${index + 1}. المهمة:*\n`;
      reply += `*ID:* \`${job.id}\`\n`;
      reply += `*الرسالة:* "${job.message}"\n`;

      if (job.type === "recurring") {
        reply += `*التكرار:* ${job.cronString} (يوميًا/أسبوعيًا)\n`;
      } else {
        const jobDate = new Date(job.date).toLocaleString("ar-EG", {
          timeZone: "Africa/Cairo",
        });
        reply += `*الوقت المحدد:* ${jobDate}\n`;
      }
      reply += `*الوجهة:* ${
        job.targetJid.endsWith("@g.us") ? "هذا الجروب" : "محادثة خاصة"
      }\n\n`;
    });

    reply += "*لحذف مهمة، استخدم:*\n`!deleteschedule <ID>`";

    await sock.sendMessage(msg.key.remoteJid, { text: reply });
  },
};
