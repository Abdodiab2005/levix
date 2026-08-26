// file: /commands/group/approveall.js
const {
  getGroupSettings,
  saveGroupSettings,
} = require("../../utils/storage.cjs"); // Note the path is ../../
const logger = require("../../utils/logger.cjs");

module.exports = {
  name: "approveall",
  description: "Manages the auto-approve feature for join requests.",
  usage: "approveall <on|off>",
  chat: "group",
  userAdminRequired: true,
  botAdminRequired: true, // The bot must be an admin to approve requests

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const option = args[0]?.toLowerCase();

    try {
      const settings = getGroupSettings(groupId);
      if (!settings.join_requests) {
        settings.join_requests = { auto_approve_enabled: false };
      }

      if (option === "on") {
        settings.join_requests.auto_approve_enabled = true;
        saveGroupSettings(groupId, settings);
        return await sock.sendMessage(groupId, {
          text: "✅ تم تفعيل نظام الموافقة التلقائية على طلبات الانضمام.",
        });
      } else if (option === "off") {
        settings.join_requests.auto_approve_enabled = false;
        saveGroupSettings(groupId, settings);
        return await sock.sendMessage(groupId, {
          text: "☑️ تم تعطيل نظام الموافقة التلقائية.",
        });
      } else {
        const status = settings.join_requests.auto_approve_enabled
          ? "مفعل ✅"
          : "معطل ☑️";
        return await sock.sendMessage(groupId, {
          text: `حالة الموافقة التلقائية: ${status}.\nاستخدم 'on' أو 'off' للتغيير.`,
        });
      }
    } catch (error) {
      logger.error(
        { err: error, command: "approveall" },
        "Error in !group approveall command"
      );
      await sock.sendMessage(groupId, { text: "حدث خطأ." });
    }
  },
};
