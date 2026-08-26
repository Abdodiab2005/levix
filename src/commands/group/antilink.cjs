// file: /commands/group/antilink.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const {
  isOwnerJidSync,
  isAdminInGroupSync,
} = require("../../utils/permissions.cjs");

// --- The Main Command Logic ---
const command = {
  name: "antilink",
  description: "Advanced control for the anti-link feature.",
  usage: "antilink [status]\nantilink <on|off>\nantilink mode <ALL|WHITELIST|BLACKLIST>\nantilink <allow|disallow> <دومين>",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const subCommand = args[0] ? args[0].toLowerCase() : "status";
    const settings = getGroupSettings(groupId);

    // Initialize settings for antilink if it doesn't exist
    if (!settings.antilink) {
      settings.antilink = {
        enabled: false,
        mode: "ALL",
        allowed_domains: [],
        blocked_domains: [],
      };
    }

    const antilinkConfig = settings.antilink;

    switch (subCommand) {
      case "on":
        antilinkConfig.enabled = true;
        await sock.sendMessage(groupId, {
          text: "✅ تم تفعيل نظام منع الروابط.",
        });
        break;
      case "off":
        antilinkConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: "☑️ تم تعطيل نظام منع الروابط.",
        });
        break;
      case "mode":
        const mode = args[1] ? args[1].toUpperCase() : "";
        if (!["ALL", "WHITELIST", "BLACKLIST"].includes(mode)) {
          return await sock.sendMessage(groupId, {
            text: "الوضع غير صالح. الأوضاع المتاحة: `ALL`, `WHITELIST`, `BLACKLIST`",
          });
        }
        antilinkConfig.mode = mode;
        await sock.sendMessage(groupId, {
          text: `✅ تم تغيير وضع منع الروابط إلى: ${mode}`,
        });
        break;
      case "allow":
        const domainToAllow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToAllow)
          return await sock.sendMessage(groupId, {
            text: "يرجى تحديد دومين للسماح به.",
          });
        if (!antilinkConfig.allowed_domains.includes(domainToAllow)) {
          antilinkConfig.allowed_domains.push(domainToAllow);
        }
        await sock.sendMessage(groupId, {
          text: `✅ تم إضافة '${domainToAllow}' إلى قائمة الدومينات المسموح بها.`,
        });
        break;
      case "disallow":
        const domainToDisallow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToDisallow)
          return await sock.sendMessage(groupId, {
            text: "يرجى تحديد دومين لإزالته.",
          });
        antilinkConfig.allowed_domains = antilinkConfig.allowed_domains.filter(
          (d) => d !== domainToDisallow
        );
        await sock.sendMessage(groupId, {
          text: `☑️ تم إزالة '${domainToDisallow}' من قائمة الدومينات المسموح بها.`,
        });
        break;
      default:
        // Display current status
        let statusReply = `*حالة نظام منع الروابط:*\n\n`;
        statusReply += `الحالة: ${
          antilinkConfig.enabled ? "مفعل ✅" : "معطل ☑️"
        }\n`;
        statusReply += `الوضع: ${antilinkConfig.mode}\n`;
        statusReply += `الدومينات المسموح بها: ${
          antilinkConfig.allowed_domains.join(", ") || "لا يوجد"
        }\n`;
        await sock.sendMessage(groupId, { text: statusReply });
    }

    saveGroupSettings(groupId, settings);
  },
};

// --- The Message Handler Logic ---
const linkRegex = new RegExp(
  /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/[a-zA-Z0-9]+\.[^\s]{2,}|[a-zA-Z0-9]+\.[^\s]{2,})/i
);

async function handleAntiLink(sock, msg, _legacyConfig, _normalizeJid) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  if (!isGroup) return;

  const groupId = msg.key.remoteJid;
  const settings = getGroupSettings(groupId);
  const antilinkConfig = settings.antilink;

  if (!antilinkConfig || !antilinkConfig.enabled) return;

  const senderId = msg.key.participant || msg.key.remoteJid;

  const groupMetadata = await sock.groupMetadata(groupId);
  // Centralized checks — handle LID/PN cross-format and bootstrap roster.
  const isOwner = isOwnerJidSync(senderId);
  const isSenderAdmin = isAdminInGroupSync(groupMetadata, senderId);

  if (isOwner || isSenderAdmin) return;

  const body =
    msg.message.conversation || msg.message.extendedTextMessage?.text || "";
  if (!linkRegex.test(body)) return; // No link found

  // --- Link Found, Apply Rules ---
  const foundLinks = body.match(linkRegex);
  const domain = new URL(
    foundLinks[0].startsWith("http") ? foundLinks[0] : `http://${foundLinks[0]}`
  ).hostname.replace("www.", "");

  let shouldDelete = false;

  switch (antilinkConfig.mode) {
    case "ALL":
      shouldDelete = true;
      break;
    case "WHITELIST":
      if (!antilinkConfig.allowed_domains.includes(domain)) {
        shouldDelete = true;
      }
      break;
    case "BLACKLIST":
      if (antilinkConfig.blocked_domains.includes(domain)) {
        shouldDelete = true;
      }
      break;
  }

  if (shouldDelete) {
    logger.info(
      `[Anti-Link] Deleting link from ${senderId} in ${groupId}. Domain: ${domain}`
    );
    await sock.sendMessage(groupId, { delete: msg.key });
    await sock.sendMessage(groupId, {
      text: `ممنوع إرسال الروابط هنا يا @${senderId.split("@")[0]}!`,
      mentions: [senderId],
    });
  }
}

// Export both the command and the handler
module.exports = { ...command, handleAntiLink };
