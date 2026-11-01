const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const { featureActionOf, normalizeFeatureAction } = require("../../utils/moderationSummary.cjs");
const { tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

module.exports = {
  name: "antispam",
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
          text: tr("✅ Anti-spam is on.", "✅ تم تفعيل مكافحة الإزعاج."),
        });
        break;
      case "off":
        spam.enabled = false;
        await sock.sendMessage(groupId, {
          text: tr("☑️ Anti-spam is off.", "☑️ تم تعطيل مكافحة الإزعاج."),
        });
        break;
      case "action": {
        const action = normalizeFeatureAction(args[1], { allowDelete: false });
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Invalid action. Available: `WARN`, `KICK`",
              "الإجراء غير صالح. الإجراءات المتاحة: `WARN`, `KICK`",
            ),
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
          text: tr(`✅ Anti-spam action is now ${action}.`, `✅ تم تعيين إجراء مكافحة الإزعاج إلى ${action}.`),
        });
        return;
      }
      case "window": {
        const seconds = parseInt(args[1], 10);
        if (!Number.isFinite(seconds) || seconds < 1 || seconds > 600) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Give a window between 1 and 600 seconds.",
              "يرجى تحديد مدة بين 1 و 600 ثانية.",
            ),
          });
        }
        spam.time_window = seconds;
        await sock.sendMessage(groupId, {
          text: tr(`✅ Anti-spam window is now ${seconds}s.`, `✅ أصبحت مدة الرصد ${seconds} ثانية.`),
        });
        break;
      }
      case "count": {
        const count = parseInt(args[1], 10);
        if (!Number.isFinite(count) || count < 2 || count > 100) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Give a message count between 2 and 100.",
              "يرجى تحديد عدد رسائل بين 2 و 100.",
            ),
          });
        }
        spam.message_count = count;
        await sock.sendMessage(groupId, {
          text: tr(`✅ Anti-spam limit is now ${count} messages.`, `✅ أصبح حد الرسائل ${count}.`),
        });
        break;
      }
      default: {
        const state = spam.enabled ? tr("on ✅", "مفعل ✅") : tr("off ☑️", "معطل ☑️");
        const action = featureActionOf(settings, "antispam");
        await sock.sendMessage(groupId, {
          text: tr(
            `*Anti-spam:*\n\nState: ${state}\nWindow: ${spam.time_window ?? 10}s\nCount: ${spam.message_count ?? 5}\nAction: ${action}`,
            `*مكافحة الإزعاج:*\n\nالحالة: ${state}\nالمدة: ${spam.time_window ?? 10}ث\nالعدد: ${spam.message_count ?? 5}\nالإجراء: ${action}`,
          ),
        });
        return;
      }
    }
    saveGroupSettings(groupId, settings);
  },
};
