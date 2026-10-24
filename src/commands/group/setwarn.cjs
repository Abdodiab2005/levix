// file: /commands/group/setwarn.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const { normalizeWarnAction } = require("../../utils/moderationSummary.cjs");
const { tr } = require("../../utils/i18n.cjs");

module.exports = {
  name: "setwarn",
  description: {
    en: "Configures the automatic warning system.",
    ar: "يضبط نظام التحذيرات التلقائي.",
  },
  usage: {
    en: "setwarn max <count>\nsetwarn action <KICK|FLAG>",
    ar: "setwarn max <عدد>\nsetwarn action <KICK|FLAG>",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0]?.toLowerCase();
    const value = args[1];

    const settings = getGroupSettings(groupId) || {};
    if (!settings.warn_system || typeof settings.warn_system !== "object") {
      settings.warn_system = {};
    }

    const warnConfig = settings.warn_system;

    switch (subCommand) {
      case "max": {
        const max = parseInt(value, 10);
        if (isNaN(max) || max < 1) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Give a valid whole number for the warning limit.",
              "يرجى تحديد عدد صحيح وصالح للحد الأقصى للتحذيرات.",
            ),
          });
        }
        warnConfig.max_warnings = max;
        await sock.sendMessage(groupId, {
          text: tr(`✅ The warning limit is now ${max}.`, `✅ تم تعيين الحد الأقصى للتحذيرات إلى ${max}.`),
        });
        break;
      }

      case "action": {
        const action = normalizeWarnAction(value);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Invalid action. Available: `KICK`, `FLAG`",
              "الإجراء غير صالح. الإجراءات المتاحة: `KICK`, `FLAG`",
            ),
          });
        }
        warnConfig.action = action;
        await sock.sendMessage(groupId, {
          text: tr(`✅ The automatic action is now ${action}.`, `✅ تم تعيين الإجراء التلقائي إلى ${action}.`),
        });
        break;
      }

      default:
        return await sock.sendMessage(groupId, {
          text: tr(
            "Wrong format. Use:\n`!setwarn max <number>`\n`!setwarn action <KICK|FLAG>`",
            "صيغة غير صحيحة. استخدم:\n`!setwarn max <number>`\n`!setwarn action <KICK|FLAG>`",
          ),
        });
    }

    saveGroupSettings(groupId, settings);
  },
};
