// file: /commands/deleteschedule.js
const { deleteScheduledJob, getScheduledJobs } = require("../../scheduler.cjs");
const { tr } = require("../utils/i18n.cjs");

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
        text: tr(
          "Give the ID of the scheduled message to delete. `!listschedules` shows the IDs.",
          "يرجى تحديد ID المهمة التي تريد حذفها. يمكنك الحصول على الـ ID باستخدام أمر `!listschedules`.",
        ),
      });
    }

    const jobs = getScheduledJobs();
    const jobExists = jobs.some((job) => job.id === jobIdToDelete);

    if (!jobExists) {
      return await sock.sendMessage(msg.key.remoteJid, {
        text: tr(
          `⚠️ No scheduled message has the ID \`${jobIdToDelete}\``,
          `⚠️ لم يتم العثور على مهمة بهذا الـ ID: \`${jobIdToDelete}\``,
        ),
      });
    }

    // This function stops the running task and removes it from the JSON file
    deleteScheduledJob(jobIdToDelete);

    await sock.sendMessage(msg.key.remoteJid, {
      text: tr(
        `✅ Deleted the scheduled message \`${jobIdToDelete}\`.`,
        `✅ تم حذف المهمة المجدولة بالـ ID: \`${jobIdToDelete}\` بنجاح.`,
      ),
    });
  },
};
