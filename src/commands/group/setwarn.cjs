// file: /commands/group/setwarn.js
const { normalizeWarnAction } = require("../../utils/moderationSummary.cjs");
const { t } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

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

    switch (subCommand) {
      case "max": {
        const max = parseInt(value, 10);
        if (!Number.isInteger(max) || max < 1 || max > 50) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.setwarn.giveAWholeNumberFrom"),
          });
        }
        applyModerationPolicy(groupId, { limit: max });
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.setwarn.theWarningLimitIsNow", { max }),
        });
      }

      case "action": {
        const action = normalizeWarnAction(value);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.setwarn.invalidActionAvailableKickFlag"),
          });
        }
        applyModerationPolicy(groupId, { limitAction: action });
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.setwarn.theAutomaticActionIsNow", { action }),
        });
      }

      default:
        return await sock.sendMessage(groupId, {
          text: t("bot.moderation.setwarn.wrongFormatUseSetwarnMax"),
        });
    }
  },
};
