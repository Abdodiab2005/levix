// file: /commands/deleteschedule.js
const { deleteScheduledJob, getScheduledJobs } = require("../../scheduler.cjs");

module.exports = {
  name: "deleteschedule",
  description: "Deletes a scheduled job by its ID.",
  usage: "deleteschedule <id>",
  chat: "all",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const jobIdToDelete = args[0];

    if (!jobIdToDelete) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: "يرجى تحديد ID المهمة التي تريد حذفها. يمكنك الحصول على الـ ID باستخدام أمر `!listschedules`.",
      });
    }

    const jobs = getScheduledJobs();
    const jobExists = jobs.some((job) => job.id === jobIdToDelete);

    if (!jobExists) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: `⚠️ لم يتم العثور على مهمة بهذا الـ ID: \`${jobIdToDelete}\``,
      });
    }

    // This function stops the running task and removes it from the JSON file
    deleteScheduledJob(jobIdToDelete);

    await sock.sendMessage(msg.key.remoteJid, {
      text: `✅ تم حذف المهمة المجدولة بالـ ID: \`${jobIdToDelete}\` بنجاح.`,
    });
  },
};
