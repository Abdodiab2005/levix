// file: /commands/listschedules.js
const { getScheduledJobsForChat } = require("../../scheduler.cjs");
const settings = require("../config/settings.cjs");
const { t, intlTag } = require("../utils/i18n.cjs");

module.exports = {
  name: "listschedules",
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg) {
    // Only this chat's jobs: another chat's reminders are never listed here.
    const jobs = getScheduledJobsForChat(msg.key.remoteJid);
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
        const jobDate = new Date(job.date).toLocaleString(intlTag(), {
          timeZone: settings.get("bot_timezone"),
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
