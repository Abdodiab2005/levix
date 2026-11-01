// commands/mod.js

const { getGroupSettings, saveGroupSettings } = require("../utils/storage.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../utils/permissions.cjs");
const { visibleText } = require("../utils/messageContent.cjs");
const { resolveGroupMetadata } = require("../utils/groupMetadataCache.cjs");
const { enforceGroupRule, senderCandidates } = require("../utils/moderationAction.cjs");
const {
  featureActionOf,
  normalizeFeatureAction,
  policyFromFeatureAction,
} = require("../utils/moderationSummary.cjs");
const { tr } = require("../utils/i18n.cjs");
const { applyModerationPolicy } = require("../services/moderationPolicy.cjs");

// الهيكل الافتراضي لإعدادات المراقبة
const defaultModSettings = {
  antiLink: { enabled: false },
  antiSpam: { enabled: true }, // نفعّله افتراضيًا لأنه مهم
  forbiddenWords: {
    enabled: false,
    list: [],
  },
};

const FEATURE_KEYS = {
  antilink: "antiLink",
  antispam: "antiSpam",
  forbiddenwords: "forbiddenWords",
};

function ensureModeration(settings) {
  settings.moderation ||= JSON.parse(JSON.stringify(defaultModSettings));
  settings.moderation.forbiddenWords ||= { enabled: false, list: [] };
  settings.moderation.forbiddenWords.list ||= [];
  return settings.moderation;
}

function featureEnabled(settings, key) {
  if (key === "antiLink") return Boolean(settings.antilink?.enabled);
  if (key === "antiSpam") return Boolean(settings.antispam?.enabled);
  return Boolean(settings.moderation?.forbiddenWords?.enabled);
}

function setFeatureEnabled(settings, key, enabled) {
  if (key === "antiLink") {
    settings.antilink ||= { enabled: false, mode: "ALL", allowed_domains: [], blocked_domains: [] };
    settings.antilink.enabled = enabled;
  } else if (key === "antiSpam") {
    settings.antispam ||= { enabled: false, message_count: 5, time_window: 10, action: "WARN" };
    settings.antispam.enabled = enabled;
  } else {
    ensureModeration(settings).forbiddenWords.enabled = enabled;
  }
}

module.exports = {
  name: "mod",
  aliases: ["moderation", "settings"],
  chat: "group", // يعمل في الجروبات فقط
  botAdminRequired: false, // لا يتطلب أن يكون البوت مشرفًا لتغيير الإعدادات

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const senderIds = senderCandidates(msg, sock);

    // التحقق من صلاحيات المشرف (LID-aware via central module). Owners can
    // also drive moderation settings.
    const groupMetadata = await resolveGroupMetadata(sock, groupId);
    const senderIsAdmin = senderIds.some((id) => isAdminInGroupSync(groupMetadata, id));
    const isOwner = msg.key.fromMe || senderIds.some(isOwnerJidSync);
    if (!senderIsAdmin && !isOwner) {
      return sock.sendMessage(
        groupId,
        { text: tr("🚫 This command is for admins only.", "🚫 هذا الأمر للمشرفين فقط.") },
        { quoted: msg },
      );
    }

    const command = args[0]?.toLowerCase();
    const feature = FEATURE_KEYS[args[1]?.toLowerCase()];

    // الحصول على الإعدادات الحالية للجروب أو إنشاء إعدادات افتراضية
    const settings = getGroupSettings(groupId) || {};
    const modSettings = ensureModeration(settings);

    switch (command) {
      case "enable":
        if (!feature) {
          return sock.sendMessage(
            groupId,
            {
              text: tr(
                `⚠️ There is no feature called "${args[1] || ""}".`,
                `⚠️ الميزة "${args[1] || ""}" غير موجودة.`,
              ),
            },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, true);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: tr(`✅ *${feature}* is on.`, `✅ تم تفعيل ميزة *${feature}*.`) },
          { quoted: msg },
        );
        break;

      case "disable":
        if (!feature) {
          return sock.sendMessage(
            groupId,
            {
              text: tr(
                `⚠️ There is no feature called "${args[1] || ""}".`,
                `⚠️ الميزة "${args[1] || ""}" غير موجودة.`,
              ),
            },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, false);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: tr(`❌ *${feature}* is off.`, `❌ تم تعطيل ميزة *${feature}*.`) },
          { quoted: msg },
        );
        break;

      case "action": {
        if (!feature) {
          return sock.sendMessage(
            groupId,
            {
              text: tr(
                `⚠️ There is no feature called "${args[1] || ""}".`,
                `⚠️ الميزة "${args[1] || ""}" غير موجودة.`,
              ),
            },
            { quoted: msg },
          );
        }
        const allowDelete = feature !== "antiSpam";
        const action = normalizeFeatureAction(args[2], { allowDelete });
        if (!action) {
          return sock.sendMessage(
            groupId,
            {
              text: tr(
                allowDelete
                  ? "Invalid action. Available: `DELETE`, `WARN`, `KICK`"
                  : "Invalid action. Available: `WARN`, `KICK`",
                allowDelete
                  ? "الإجراء غير صالح. الإجراءات المتاحة: `DELETE`, `WARN`, `KICK`"
                  : "الإجراء غير صالح. الإجراءات المتاحة: `WARN`, `KICK`",
              ),
            },
            { quoted: msg },
          );
        }
        const featureName =
          feature === "antiLink" ? "antilink" : feature === "antiSpam" ? "antispam" : "forbidden";
        try {
          applyModerationPolicy(groupId, { features: { [featureName]: action } });
        } catch (error) {
          return sock.sendMessage(
            groupId,
            {
              text: tr(
                error.errors?.[0]?.message || "That action is not allowed.",
                "هذا الإجراء غير مسموح.",
              ),
            },
            { quoted: msg },
          );
        }
        await sock.sendMessage(
          groupId,
          { text: tr(`✅ *${feature}* action is now ${action}.`, `✅ تم تعيين إجراء *${feature}* إلى ${action}.`) },
          { quoted: msg },
        );
        break;
      }

      case "status": {
        let statusText = tr("📊 *Moderation settings* 📊\n\n", "📊 *حالة إعدادات المراقبة* 📊\n\n");
        const actionOf = {
          antiLink: featureActionOf(settings, "antilink"),
          antiSpam: featureActionOf(settings, "antispam"),
          forbiddenWords: featureActionOf(settings, "forbidden"),
        };
        for (const key of Object.values(FEATURE_KEYS)) {
          const status = featureEnabled(settings, key)
            ? tr("✅ on", "✅ مفعل")
            : tr("❌ off", "❌ معطل");
          statusText += `› *${key}*: ${status} · ${actionOf[key]}\n`;
        }
        statusText += tr(
          `\n- To see the forbidden words, type: \`!mod words list\``,
          `\n- لعرض قائمة الكلمات الممنوعة، اكتب: \`!mod words list\``,
        );
        await sock.sendMessage(groupId, { text: statusText }, { quoted: msg });
        break;
      }

      case "words": {
        const wordAction = args[1]?.toLowerCase();
        const word = args.slice(2).join(" ").toLowerCase();

        if (wordAction === "add") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: tr("Write the word you want to add.", "الرجاء كتابة الكلمة التي تريد إضافتها."),
            });
          if (!modSettings.forbiddenWords.list.includes(word)) {
            modSettings.forbiddenWords.list.push(word.slice(0, 100));
          }
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: tr(
              `✅ Added "${word}" to the forbidden words.`,
              `✅ تم إضافة "${word}" إلى قائمة الكلمات الممنوعة.`,
            ),
          });
        } else if (wordAction === "remove") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: tr("Write the word you want to remove.", "الرجاء كتابة الكلمة التي تريد إزالتها."),
            });
          modSettings.forbiddenWords.list = modSettings.forbiddenWords.list.filter(
            (w) => w !== word,
          );
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: tr(`🗑️ Removed "${word}" from the list.`, `🗑️ تم إزالة "${word}" من القائمة.`),
          });
        } else if (wordAction === "list") {
          let listText = tr("🚫 *Forbidden words* 🚫\n\n", "🚫 *قائمة الكلمات الممنوعة* 🚫\n\n");
          if (modSettings.forbiddenWords.list.length === 0) {
            listText += tr("The list is empty.", "القائمة فارغة حاليًا.");
          } else {
            modSettings.forbiddenWords.list.forEach((w, i) => {
              listText += `${i + 1}. ${w}\n`;
            });
          }
          await sock.sendMessage(groupId, { text: listText });
        } else {
          await sock.sendMessage(groupId, {
            text: tr(
              "Wrong usage. Available: `add`, `remove`, `list`",
              "استخدام خاطئ. الأوامر المتاحة: `add`, `remove`, `list`",
            ),
          });
        }
        break;
      }

      default: {
        const helpText = tr(
          "🤖 *Moderation commands*\n\n" +
            "• `!mod enable <feature>`\nTurn a feature on (antilink, antispam, forbiddenwords)\n\n" +
            "• `!mod disable <feature>`\nTurn a feature off.\n\n" +
            "• `!mod action <feature> <DELETE|WARN|KICK>`\nSet the feature action (antiSpam: WARN|KICK).\n\n" +
            "• `!mod status`\nShow which features are on.\n\n" +
            "• `!mod words add <word>`\nAdd a forbidden word.\n\n" +
            "• `!mod words remove <word>`\nRemove a forbidden word.\n\n" +
            "• `!mod words list`\nList the forbidden words.",
          "🤖 *أوامر التحكم في المراقبة*\n\n" +
            "• `!mod enable <feature>`\nلتفعيل ميزة (antilink, antispam, forbiddenwords)\n\n" +
            "• `!mod disable <feature>`\nلتعطيل ميزة.\n\n" +
            "• `!mod action <feature> <DELETE|WARN|KICK>`\nتعيين إجراء الميزة (antiSpam: WARN|KICK).\n\n" +
            "• `!mod status`\nلعرض حالة الميزات الحالية.\n\n" +
            "• `!mod words add <word>`\nلإضافة كلمة ممنوعة.\n\n" +
            "• `!mod words remove <word>`\nلإزالة كلمة ممنوعة.\n\n" +
            "• `!mod words list`\nلعرض قائمة الكلمات الممنوعة.",
        );
        await sock.sendMessage(groupId, { text: helpText }, { quoted: msg });
        break;
      }
    }
  },
};

function detectForbiddenWords(msg, settings) {
  const groupId = msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return null;
  const config = settings?.moderation?.forbiddenWords;
  if (!config?.enabled || !Array.isArray(config.list) || !config.list.length) return null;
  const body = visibleText(msg.message).toLowerCase();
  if (!body || !config.list.some((word) => word && body.includes(String(word).toLowerCase()))) {
    return null;
  }
  return { rule: "forbidden", reason: "forbidden-word" };
}

async function handleForbiddenWords(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId?.endsWith("@g.us")) return false;

  const settings = getGroupSettings(groupId) || {};
  const senderIds = senderCandidates(msg, sock);
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  if (
    msg.key.fromMe ||
    senderIds.some(isOwnerJidSync) ||
    senderIds.some((id) => isAdminInGroupSync(groupMetadata, id))
  ) {
    return false;
  }

  const hit = detectForbiddenWords(msg, settings);
  if (!hit) return false;
  const policy = policyFromFeatureAction(featureActionOf(settings, "forbidden"));
  const result = await enforceGroupRule(sock, {
    msg,
    groupMetadata,
    rule: "forbidden",
    warningReason: hit.reason,
    ...policy,
    targetCandidates: senderIds,
  });
  return Boolean(result.acted);
}

module.exports.handleForbiddenWords = handleForbiddenWords;
module.exports.detectForbiddenWords = detectForbiddenWords;
