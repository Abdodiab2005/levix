// file: /commands/listschedules.js
const { getScheduledJobs } = require("../../scheduler.cjs");
const { t, tr } = require("../utils/i18n.cjs");

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
        text: t("bot.schedules.listschedules.none"),
      });
    }

    let reply = t("bot.schedules.listschedules.header");

    activeJobs.forEach((job, index) => {
      reply += t("bot.schedules.listschedules.jobTitle", { number: index + 1 });
      reply += `*ID:* \`${job.id}\`\n`;
      reply += t("bot.schedules.listschedules.message", { message: job.message });

      if (job.type === "recurring") {
        reply += t("bot.schedules.listschedules.repeats", { cron: job.cronString });
      } else {
        const jobDate = new Date(job.date).toLocaleString(tr("en-GB", "ar-EG"), {
          timeZone: "Africa/Cairo",
        });
        reply += t("bot.schedules.listschedules.when", { date: jobDate });
      }
      const inGroup = job.targetJid.endsWith("@g.us");
      reply += t("bot.schedules.listschedules.where", {
        place: inGroup
          ? t("bot.schedules.listschedules.placeGroup")
          : t("bot.schedules.listschedules.placePrivate"),
      });
    });

    reply += t("bot.schedules.listschedules.deleteHint");

    await sock.sendMessage(msg.key.remoteJid, { text: reply });
  },
};
