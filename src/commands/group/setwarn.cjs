// file: /commands/group/setwarn.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");

module.exports = {
  name: "setwarn",
  description: "Configures the automatic warning system.",
  usage: "setwarn max <عدد>\nsetwarn action <KICK|NONE>",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0]?.toLowerCase();
    const value = args[1];

    const settings = getGroupSettings(groupId);
    if (!settings.warn_system) {
      settings.warn_system = { max_warnings: 3, action: "NONE" };
    }

    const warnConfig = settings.warn_system;

    switch (subCommand) {
      case "max":
        const max = parseInt(value, 10);
        if (isNaN(max) || max < 1) {
          return await sock.sendMessage(groupId, {
            text: "يرجى تحديد عدد صحيح وصالح للحد الأقصى للتحذيرات.",
          });
        }
        warnConfig.max_warnings = max;
        await sock.sendMessage(groupId, {
          text: `✅ تم تعيين الحد الأقصى للتحذيرات إلى ${max}.`,
        });
        break;

      case "action":
        const action = value?.toUpperCase();
        if (action !== "KICK" && action !== "NONE") {
          return await sock.sendMessage(groupId, {
            text: "الإجراء غير صالح. الإجراءات المتاحة: `KICK`, `NONE`",
          });
        }
        warnConfig.action = action;
        await sock.sendMessage(groupId, {
          text: `✅ تم تعيين الإجراء التلقائي إلى ${action}.`,
        });
        break;

      default:
        return await sock.sendMessage(groupId, {
          text: "صيغة غير صحيحة. استخدم:\n`!setwarn max <number>`\n`!setwarn action <KICK|NONE>`",
        });
    }

    saveGroupSettings(groupId, settings);
  },
};
