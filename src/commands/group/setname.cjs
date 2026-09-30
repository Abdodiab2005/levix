// file: /commands/group/setname.js
const logger = require("../../utils/logger.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setname",
  description: {
    en: "Changes the group's name.",
    ar: "يغيّر اسم المجموعة.",
  },
  usage: {
    en: "setname <new name>",
    ar: "setname <الاسم الجديد>",
  },
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const newName = args.join(" ");

    if (!newName) {
      return await sock.sendMessage(groupId, {
        text: tr("Write the group's new name after the command.", "يرجى كتابة الاسم الجديد للجروب بعد الأمر."),
      });
    }

    // WhatsApp has a limit of 25 characters for the subject
    if (newName.length > 25) {
      return await sock.sendMessage(groupId, {
        text: tr(
          "⚠️ That name is too long. The limit is 25 characters.",
          "⚠️ اسم المجموعة طويل جدًا. الحد الأقصى هو 25 حرفًا.",
        ),
      });
    }

    try {
      await sock.groupUpdateSubject(groupId, newName);
      await sock.sendMessage(groupId, {
        text: tr(`✅ The group is now called:\n*${newName}*`, `✅ تم تغيير اسم المجموعة بنجاح إلى:\n*${newName}*`),
      });
    } catch (error) {
      logger.error({ err: error }, "Error in !group setname command");
      await sock.sendMessage(groupId, {
        text: tr(
          "Something went wrong. Make sure I'm an admin and allowed to change the group's name.",
          "حدث خطأ. تأكد من أنني مشرف ولدي صلاحية تغيير اسم المجموعة.",
        ),
      });
    }
  },
};
