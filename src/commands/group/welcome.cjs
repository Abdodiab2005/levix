// file: /commands/welcome.js
const {
  getGroupSettings,
  saveGroupSettings,
} = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "welcome",
  description: "Manages the group's welcome message system.",
  usage: "welcome [status]\nwelcome <on|off>\nwelcome add <نص الترحيب>\nwelcome list\nwelcome delete <رقم>",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0] ? args[0].toLowerCase() : "status"; // Default to showing status

    try {
      const settings = getGroupSettings(groupId);

      // Initialize the welcome system settings if they don't exist
      if (!settings.welcome_system) {
        settings.welcome_system = { enabled: false, messages: [] };
      }
      const welcomeConfig = settings.welcome_system;

      switch (subCommand) {
        case "on":
          welcomeConfig.enabled = true;
          await sock.sendMessage(groupId, {
            text: "✅ تم تفعيل نظام الترحيب التلقائي.",
          });
          break;

        case "off":
          welcomeConfig.enabled = false;
          await sock.sendMessage(groupId, {
            text: "☑️ تم تعطيل نظام الترحيب التلقائي.",
          });
          break;

        case "add":
          const messageToAdd = args.slice(1).join(" ");
          if (!messageToAdd || !messageToAdd.includes("${user}")) {
            return await sock.sendMessage(groupId, {
              text: "يرجى كتابة رسالة ترحيب تحتوي على المتغير ${user} لعمل منشن للعضو الجديد.",
            });
          }
          welcomeConfig.messages.push(messageToAdd);
          await sock.sendMessage(groupId, {
            text: "✅ تم إضافة رسالة الترحيب بنجاح.",
          });
          break;

        case "list":
          if (welcomeConfig.messages.length === 0) {
            return await sock.sendMessage(groupId, {
              text: "لا توجد رسائل ترحيب محفوظة.",
            });
          }
          let listReply = "*قائمة رسائل الترحيب المحفوظة:*\n\n";
          welcomeConfig.messages.forEach((message, index) => {
            listReply += `#${index + 1}: ${message}\n`;
          });
          await sock.sendMessage(groupId, { text: listReply });
          break;

        case "delete":
          const indexToDelete = parseInt(args[1]?.replace("#", ""), 10) - 1;
          if (
            isNaN(indexToDelete) ||
            indexToDelete < 0 ||
            indexToDelete >= welcomeConfig.messages.length
          ) {
            return await sock.sendMessage(groupId, {
              text: "رقم الرسالة غير صالح. استخدم `!welcome list` لمعرفة الأرقام.",
            });
          }
          const deletedMessage = welcomeConfig.messages.splice(
            indexToDelete,
            1
          );
          await sock.sendMessage(groupId, {
            text: `☑️ تم حذف الرسالة بنجاح:\n*${deletedMessage[0]}*`,
          });
          break;

        case "status":
        default:
          const statusReply =
            `*상태 نظام الترحيب:*\n\n` +
            `الحالة: ${welcomeConfig.enabled ? "مفعل ✅" : "معطل ☑️"}\n` +
            `عدد الرسائل المحفوظة: ${welcomeConfig.messages.length}`;
          await sock.sendMessage(groupId, { text: statusReply });
          break;
      }

      // Save the updated settings back to the database
      saveGroupSettings(groupId, settings);
    } catch (error) {
      logger.error(
        { err: error, command: "welcome" },
        "Error in !welcome command"
      );
      await sock.sendMessage(groupId, { text: "حدث خطأ." });
    }
  },
};
