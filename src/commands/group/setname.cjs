// file: /commands/group/setname.js
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "setname",
  description: "Changes the group's subject/name.",
  usage: "setname <الاسم الجديد>",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const newName = args.join(" ");

    if (!newName) {
      return await sock.sendMessage(groupId, {
        text: "يرجى كتابة الاسم الجديد للجروب بعد الأمر.",
      });
    }

    // WhatsApp has a limit of 25 characters for the subject
    if (newName.length > 25) {
      return await sock.sendMessage(groupId, {
        text: "⚠️ اسم الجروب طويل جدًا. الحد الأقصى هو 25 حرفًا.",
      });
    }

    try {
      await sock.groupUpdateSubject(groupId, newName);
      await sock.sendMessage(groupId, {
        text: `✅ تم تغيير اسم الجروب بنجاح إلى:\n*${newName}*`,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !group setname command");
      await sock.sendMessage(groupId, {
        text: "حدث خطأ. تأكد من أنني مشرف ولدي صلاحية تغيير اسم الجروب.",
      });
    }
  },
};
