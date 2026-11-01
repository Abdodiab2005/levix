const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const { featureActionOf, normalizeFeatureAction } = require("../../utils/moderationSummary.cjs");
const { t, tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

module.exports = {
  name: "antispam",
  description: {
    en: "Controls anti-spam in the group.",
    ar: "يتحكم في مكافحة الإزعاج في المجموعة.",
  },
  usage: {
    en: "antispam [status]\nantispam <on|off>\nantispam action <WARN|KICK>\nantispam window <seconds>\nantispam count <number>",
    ar: "antispam [status]\nantispam <on|off>\nantispam action <WARN|KICK>\nantispam window <ثوان>\nantispam count <عدد>",
  },
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0] ? args[0].toLowerCase() : "status";
    const settings = getGroupSettings(groupId) || {};
    if (!settings.antispam || typeof settings.antispam !== "object") {
      settings.antispam = { enabled: false, time_window: 10, message_count: 5 };
    }
    const spam = settings.antispam;

    switch (subCommand) {
      case "on":
        spam.enabled = true;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamIsOn"),
        });
        break;
      case "off":
        spam.enabled = false;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamIsOff"),
        });
        break;
      case "action": {
        const action = normalizeFeatureAction(args[1], { allowDelete: false });
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antispam.invalidActionAvailableWarnKick"),
          });
        }
        try {
          applyModerationPolicy(groupId, { features: { antispam: action } });
        } catch (error) {
          return await sock.sendMessage(groupId, {
            text: tr(
              error.errors?.[0]?.message || "That action is not allowed.",
              "هذا الإجراء غير مسموح.",
            ),
          });
        }
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamActionIsNow", { action }),
        });
        return;
      }
      case "window": {
        const seconds = parseInt(args[1], 10);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antispam.giveAWindowBetweenAnd"),
          });
        }
        spam.time_window = seconds;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamWindowIsNow", { seconds }),
        });
        break;
      }
      case "count": {
        const count = parseInt(args[1], 10);
        if (!Number.isFinite(count) || count < 2 || count > 100) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antispam.giveAMessageCountBetween"),
          });
        }
        spam.message_count = count;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamLimitIsNow", { count }),
        });
        break;
      }
      default: {
        const state = spam.enabled ? t("bot.moderation.antispam.on") : t("bot.moderation.antispam.off");
        const action = featureActionOf(settings, "antispam");
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antispam.antiSpamStateWindowS", {
            state,
            timeWindow: spam.time_window ?? 10,
            messageCount: spam.message_count ?? 5,
            action,
          }),
        });
        return;
      }
    }
    saveGroupSettings(groupId, settings);
  },
};
