// file: /commands/group/setwarn.js
const { normalizeWarnAction } = require("../../utils/moderationSummary.cjs");
const { tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

module.exports = {
  name: "setwarn",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0]?.toLowerCase();
    const value = args[1];

    switch (subCommand) {
      case "max": {
        const max = parseInt(value, 10);
        if (!Number.isInteger(max) || max < 1 || max > 50) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Give a whole number from 1 to 50 for the warning limit.",
              "يرجى تحديد عدد صحيح من 1 إلى 50 للحد الأقصى للتحذيرات.",
            ),
          });
        }
        applyModerationPolicy(groupId, { limit: max });
        return await sock.sendMessage(groupId, {
          text: tr(`✅ The warning limit is now ${max}.`, `✅ تم تعيين الحد الأقصى للتحذيرات إلى ${max}.`),
        });
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
        applyModerationPolicy(groupId, { limitAction: action });
        return await sock.sendMessage(groupId, {
          text: tr(`✅ The automatic action is now ${action}.`, `✅ تم تعيين الإجراء التلقائي إلى ${action}.`),
        });
      }

      default:
        return await sock.sendMessage(groupId, {
          text: tr(
            "Wrong format. Use:\n`!setwarn max <number>`\n`!setwarn action <KICK|FLAG>`",
            "صيغة غير صحيحة. استخدم:\n`!setwarn max <number>`\n`!setwarn action <KICK|FLAG>`",
          ),
        });
    }
  },
};
