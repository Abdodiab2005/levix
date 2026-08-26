// commands/mod.js

const { getGroupSettings, saveGroupSettings } = require("../utils/storage.cjs");
const {
  isOwnerJidSync,
  isAdminInGroupSync,
} = require("../utils/permissions.cjs");

// الهيكل الافتراضي لإعدادات المراقبة
const defaultModSettings = {
  antiLink: { enabled: false },
  antiSpam: { enabled: true }, // نفعّله افتراضيًا لأنه مهم
  forbiddenWords: {
    enabled: false,
    list: [],
  },
};

module.exports = {
  name: "mod",
  aliases: ["moderation", "settings"],
  description: "التحكم في إعدادات المراقبة للجروب.",
  usage: "mod status\nmod <enable|disable> <antiLink|antiSpam|forbiddenWords>\nmod words <add|remove> <الكلمة>\nmod words list",
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
      return sock.sendMessage(
        groupId,
        { text: "🚫 هذا الأمر للمشرفين فقط." },
        { quoted: msg }
      );
    }

    const command = args[0]?.toLowerCase();
    const feature = args[1]?.toLowerCase();

    // الحصول على الإعدادات الحالية للجروب أو إنشاء إعدادات افتراضية
    let settings = getGroupSettings(groupId) || {};
    if (!settings.moderation) {
      settings.moderation = JSON.parse(JSON.stringify(defaultModSettings)); // نسخة عميقة
    }

    const modSettings = settings.moderation;

    switch (command) {
      case "enable":
        if (!modSettings.hasOwnProperty(feature)) {
          return sock.sendMessage(
            groupId,
            { text: `⚠️ الميزة "${feature}" غير موجودة.` },
            { quoted: msg }
          );
        }
        modSettings[feature].enabled = true;
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: `✅ تم تفعيل ميزة *${feature}*.` },
          { quoted: msg }
        );
        break;

      case "disable":
        if (!modSettings.hasOwnProperty(feature)) {
          return sock.sendMessage(
            groupId,
            { text: `⚠️ الميزة "${feature}" غير موجودة.` },
            { quoted: msg }
          );
        }
        modSettings[feature].enabled = false;
        saveGroupSettings(groupId, settings);
        await sock.sendMessage(
          groupId,
          { text: `❌ تم تعطيل ميزة *${feature}*.` },
          { quoted: msg }
        );
        break;

      case "status":
        let statusText = "📊 *حالة إعدادات المراقبة* 📊\n\n";
        for (const key in modSettings) {
          const status = modSettings[key].enabled ? "✅ مفعل" : "❌ معطل";
          statusText += `› *${key}*: ${status}\n`;
        }
        statusText += `\n- لعرض قائمة الكلمات الممنوعة، اكتب: \`!mod words list\``;
        await sock.sendMessage(groupId, { text: statusText }, { quoted: msg });
        break;

      case "words":
        const wordAction = args[1]?.toLowerCase();
        const word = args.slice(2).join(" ").toLowerCase();

        if (wordAction === "add") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: "الرجاء كتابة الكلمة التي تريد إضافتها.",
            });
          modSettings.forbiddenWords.list.push(word);
          saveGroupSettings(groupId, settings);
          await sock.sendMessage(groupId, {
            text: `✅ تم إضافة "${word}" إلى قائمة الكلمات الممنوعة.`,
          });
        } else if (wordAction === "remove") {
          if (!word)
            return sock.sendMessage(groupId, {
              text: "الرجاء كتابة الكلمة التي تريد إزالتها.",
            });
          modSettings.forbiddenWords.list =
            modSettings.forbiddenWords.list.filter((w) => w !== word);
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

      default:
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
  },
};
