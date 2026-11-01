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
const { t, tr } = require("../utils/i18n.cjs");
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
        { text: t("bot.moderation.mod.thisCommandIsForAdmins") },
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
              text: t("bot.moderation.mod.thereIsNoFeatureCalled", { featureName: args[1] || "" }),
            },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, true);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: t("bot.moderation.mod.isOn", { feature }) },
          { quoted: msg },
        );
        break;

      case "disable":
        if (!feature) {
          return sock.sendMessage(
            groupId,
            {
              text: t("bot.moderation.mod.thereIsNoFeatureCalled", { featureName: args[1] || "" }),
            },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, false);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: t("bot.moderation.mod.isOff", { feature }) },
          { quoted: msg },
        );
        break;

      case "action": {
        if (!feature) {
          return sock.sendMessage(
            groupId,
            {
              text: t("bot.moderation.mod.thereIsNoFeatureCalled", { featureName: args[1] || "" }),
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
              text: allowDelete
                ? t("bot.moderation.mod.invalidActionWithDelete")
                : t("bot.moderation.mod.invalidActionWithoutDelete"),
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
          { text: t("bot.moderation.mod.actionIsNow", { feature, action }) },
          { quoted: msg },
        );
        break;
      }

      case "status": {
        let statusText = t("bot.moderation.mod.moderationSettings");
        const actionOf = {
          antiLink: featureActionOf(settings, "antilink"),
          antiSpam: featureActionOf(settings, "antispam"),
          forbiddenWords: featureActionOf(settings, "forbidden"),
        };
        for (const key of Object.values(FEATURE_KEYS)) {
          const status = featureEnabled(settings, key)
            ? t("bot.moderation.mod.on")
            : t("bot.moderation.mod.off");
          statusText += `› *${key}*: ${status} · ${actionOf[key]}\n`;
        }
        statusText += t("bot.moderation.mod.toSeeTheForbiddenWords");
        await sock.sendMessage(groupId, { text: statusText }, { quoted: msg });
        break;
      }

      case "words": {
        const wordAction = args[1]?.toLowerCase();
        const word = args.slice(2).join(" ").toLowerCase();

        if (wordAction === "add") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: t("bot.moderation.mod.wordToAddRequired"),
            });
          if (!modSettings.forbiddenWords.list.includes(word)) {
            modSettings.forbiddenWords.list.push(word.slice(0, 100));
          }
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: t("bot.moderation.mod.addedToTheForbiddenWords", { word }),
          });
        } else if (wordAction === "remove") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: t("bot.moderation.mod.wordToRemoveRequired"),
            });
          modSettings.forbiddenWords.list = modSettings.forbiddenWords.list.filter(
            (w) => w !== word,
          );
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: t("bot.moderation.mod.removedFromTheList", { word }),
          });
        } else if (wordAction === "list") {
          let listText = t("bot.moderation.mod.forbiddenWords");
          if (modSettings.forbiddenWords.list.length === 0) {
            listText += t("bot.moderation.mod.theListIsEmpty");
          } else {
            modSettings.forbiddenWords.list.forEach((w, i) => {
              listText += `${i + 1}. ${w}\n`;
            });
          }
          await sock.sendMessage(groupId, { text: listText });
        } else {
          await sock.sendMessage(groupId, {
            text: t("bot.moderation.mod.wrongUsageAvailableAddRemove"),
          });
        }
        break;
      }

      default: {
        const helpText = t("bot.moderation.mod.help");
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
