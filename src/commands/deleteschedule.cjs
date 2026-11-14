// file: /commands/deleteschedule.js
const { deleteScheduledJob, getScheduledJobsForChat } = require("../../scheduler.cjs");
const { t } = require("../utils/i18n.cjs");

module.exports = {
  name: "deleteschedule",
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const jobIdToDelete = args[0];

    if (!jobIdToDelete) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: t("bot.schedules.deleteschedule.missingId"),
      });
    }

    // A job of another chat answers like an unknown id, so existence never leaks.
    const jobs = getScheduledJobsForChat(msg.key.remoteJid, msg.key.remoteJidAlt);
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
