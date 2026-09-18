// commands/mod.js

const { getGroupSettings, saveGroupSettings } = require("../utils/storage.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../utils/permissions.cjs");
const { visibleText } = require("../utils/messageContent.cjs");

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
  description: "التحكم في إعدادات المراقبة للجروب.",
  usage:
    "mod status\nmod <enable|disable> <antiLink|antiSpam|forbiddenWords>\nmod words <add|remove> <الكلمة>\nmod words list",
  chat: "group", // يعمل في الجروبات فقط
  botAdminRequired: false, // لا يتطلب أن يكون البوت مشرفًا لتغيير الإعدادات

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const senderId = msg.key.participant;

    // التحقق من صلاحيات المشرف (LID-aware via central module). Owners can
    // also drive moderation settings.
    const groupMetadata = await sock.groupMetadata(groupId);
    const senderIsAdmin = isAdminInGroupSync(groupMetadata, senderId);
    const isOwner = msg.key.fromMe || isOwnerJidSync(senderId);
    if (!senderIsAdmin && !isOwner) {
      return sock.sendMessage(groupId, { text: "🚫 هذا الأمر للمشرفين فقط." }, { quoted: msg });
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
            { text: `⚠️ الميزة "${args[1] || ""}" غير موجودة.` },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, true);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: `✅ تم تفعيل ميزة *${feature}*.` },
          { quoted: msg },
        );
        break;

      case "disable":
        if (!feature) {
          return sock.sendMessage(
            groupId,
            { text: `⚠️ الميزة "${args[1] || ""}" غير موجودة.` },
            { quoted: msg },
          );
        }
        setFeatureEnabled(settings, feature, false);
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: `❌ تم تعطيل ميزة *${feature}*.` },
          { quoted: msg },
        );
        break;

      case "status": {
        let statusText = "📊 *حالة إعدادات المراقبة* 📊\n\n";
        for (const key of Object.values(FEATURE_KEYS)) {
          const status = featureEnabled(settings, key) ? "✅ مفعل" : "❌ معطل";
          statusText += `› *${key}*: ${status}\n`;
        }
        statusText += `\n- لعرض قائمة الكلمات الممنوعة، اكتب: \`!mod words list\``;
        await sock.sendMessage(groupId, { text: statusText }, { quoted: msg });
        break;
      }

      case "words": {
        const wordAction = args[1]?.toLowerCase();
        const word = args.slice(2).join(" ").toLowerCase();

        if (wordAction === "add") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: "الرجاء كتابة الكلمة التي تريد إضافتها.",
            });
          if (!modSettings.forbiddenWords.list.includes(word)) {
            modSettings.forbiddenWords.list.push(word.slice(0, 100));
          }
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: `✅ تم إضافة "${word}" إلى قائمة الكلمات الممنوعة.`,
          });
        } else if (wordAction === "remove") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: "الرجاء كتابة الكلمة التي تريد إزالتها.",
            });
          modSettings.forbiddenWords.list = modSettings.forbiddenWords.list.filter(
            (w) => w !== word,
          );
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: `🗑️ تم إزالة "${word}" من القائمة.`,
          });
        } else if (wordAction === "list") {
          let listText = "🚫 *قائمة الكلمات الممنوعة* 🚫\n\n";
          if (modSettings.forbiddenWords.list.length === 0) {
            listText += "القائمة فارغة حاليًا.";
          } else {
            modSettings.forbiddenWords.list.forEach((w, i) => {
              listText += `${i + 1}. ${w}\n`;
            });
          }
          await sock.sendMessage(groupId, { text: listText });
        } else {
          await sock.sendMessage(groupId, {
            text: "استخدام خاطئ. الأوامر المتاحة: `add`, `remove`, `list`",
          });
        }
        break;
      }

      default: {
        let helpText = "🤖 *أوامر التحكم في المراقبة*\n\n";
        helpText +=
          "• `!mod enable <feature>`\nلتفعيل ميزة (antilink, antispam, forbiddenwords)\n\n";
        helpText += "• `!mod disable <feature>`\nلتعطيل ميزة.\n\n";
        helpText += "• `!mod status`\nلعرض حالة الميزات الحالية.\n\n";
        helpText += "• `!mod words add <word>`\nلإضافة كلمة ممنوعة.\n\n";
        helpText += "• `!mod words remove <word>`\nلإزالة كلمة ممنوعة.\n\n";
        helpText += "• `!mod words list`\nلعرض قائمة الكلمات الممنوعة.";
        await sock.sendMessage(groupId, { text: helpText }, { quoted: msg });
        break;
      }
    }
  },
};

async function handleForbiddenWords(sock, msg) {
  const groupId = msg.key.remoteJid;
  if (!groupId?.endsWith("@g.us")) return false;

  const settings = getGroupSettings(groupId) || {};
  const config = settings.moderation?.forbiddenWords;
  if (!config?.enabled || !Array.isArray(config.list) || !config.list.length) return false;

  const body = visibleText(msg.message).toLowerCase();
  if (!body || !config.list.some((word) => word && body.includes(String(word).toLowerCase()))) {
    return false;
  }

  const senderId = msg.key.participant || msg.key.remoteJid;
  const senderIds = [senderId, msg.key.participantAlt, msg.key.participantPn].filter(Boolean);
  const groupMetadata = await sock.groupMetadata(groupId);
  if (
    msg.key.fromMe ||
    senderIds.some(isOwnerJidSync) ||
    senderIds.some((id) => isAdminInGroupSync(groupMetadata, id))
  ) {
    return false;
  }

  await sock.sendMessage(groupId, { delete: msg.key });
  await sock.sendMessage(groupId, {
    text: `🚫 يا @${senderId.split("@")[0]}، الرسالة فيها كلمة ممنوعة.`,
    mentions: [senderId],
  });
  return true;
}

module.exports.handleForbiddenWords = handleForbiddenWords;
