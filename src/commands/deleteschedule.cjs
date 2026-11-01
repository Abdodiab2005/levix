// file: /commands/deleteschedule.js
const { deleteScheduledJob, getScheduledJobs } = require("../../scheduler.cjs");
const { t } = require("../utils/i18n.cjs");

module.exports = {
  name: "deleteschedule",
  description: {
    en: "Deletes a scheduled message by its ID.",
    ar: "يحذف رسالة مجدولة برقمها التعريفي (ID).",
  },
  usage: {
    en: "deleteschedule <id>",
    ar: "deleteschedule <id>",
  },
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const jobIdToDelete = args[0];

    if (!jobIdToDelete) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.schedules.deleteschedule.missingId"),
      });
    }

    const jobs = getScheduledJobs();
    const jobExists = jobs.some((job) => job.id === jobIdToDelete);

    if (!jobExists) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.schedules.deleteschedule.notFound", { id: jobIdToDelete }),
      });
    }

    // This function stops the running task and removes it from the JSON file
    deleteScheduledJob(jobIdToDelete);

    await sock.sendMessage(msg.key.remoteJid, {
      text: t("bot.schedules.deleteschedule.deleted", { id: jobIdToDelete }),
    });
  },
};
