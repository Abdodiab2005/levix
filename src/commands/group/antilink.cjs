// file: /commands/group/antilink.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../../utils/permissions.cjs");
const { visibleText } = require("../../utils/messageContent.cjs");
const { resolveGroupMetadata } = require("../../utils/groupMetadataCache.cjs");
const { tr } = require("../../utils/i18n.cjs");

// --- The Main Command Logic ---
const command = {
  name: "antilink",
  description: {
    en: "Advanced control of the anti-link protection.",
    ar: "تحكم متقدم في ميزة منع الروابط.",
  },
  usage: {
    en: "antilink [status]\nantilink <on|off>\nantilink mode <ALL|WHITELIST|BLACKLIST>\nantilink <allow|disallow> <domain>",
    ar: "antilink [status]\nantilink <on|off>\nantilink mode <ALL|WHITELIST|BLACKLIST>\nantilink <allow|disallow> <النطاق>",
  },
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
          text: tr("✅ Anti-link is on.", "✅ تم تفعيل نظام منع الروابط."),
        });
        break;
      case "off":
        antilinkConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: tr("☑️ Anti-link is off.", "☑️ تم تعطيل نظام منع الروابط."),
        });
        break;
      case "mode": {
        const mode = args[1] ? args[1].toUpperCase() : "";
        if (!["ALL", "WHITELIST", "BLACKLIST"].includes(mode)) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Invalid mode. Available: `ALL`, `WHITELIST`, `BLACKLIST`",
              "الوضع غير صالح. الأوضاع المتاحة: `ALL`, `WHITELIST`, `BLACKLIST`",
            ),
          });
        }
        antilinkConfig.mode = mode;
        await sock.sendMessage(groupId, {
          text: tr(`✅ Anti-link mode is now: ${mode}`, `✅ تم تغيير وضع منع الروابط إلى: ${mode}`),
        });
        break;
      }
      case "allow": {
        const domainToAllow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToAllow)
          return await sock.sendMessage(groupId, {
            text: tr("Say which domain to allow.", "يرجى تحديد دومين للسماح به."),
          });
        if (!antilinkConfig.allowed_domains.includes(domainToAllow)) {
          antilinkConfig.allowed_domains.push(domainToAllow);
        }
        await sock.sendMessage(groupId, {
          text: tr(
            `✅ '${domainToAllow}' is now allowed.`,
            `✅ تم إضافة '${domainToAllow}' إلى قائمة الدومينات المسموح بها.`,
          ),
        });
        break;
      }
      case "disallow": {
        const domainToDisallow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToDisallow)
          return await sock.sendMessage(groupId, {
            text: tr("Say which domain to remove.", "يرجى تحديد دومين لإزالته."),
          });
        antilinkConfig.allowed_domains = antilinkConfig.allowed_domains.filter(
          (d) => d !== domainToDisallow,
        );
        await sock.sendMessage(groupId, {
          text: tr(
            `☑️ '${domainToDisallow}' is no longer allowed.`,
            `☑️ تم إزالة '${domainToDisallow}' من قائمة الدومينات المسموح بها.`,
          ),
        });
        break;
      }
      default: {
        // Display current status
        const state = antilinkConfig.enabled ? tr("on ✅", "مفعل ✅") : tr("off ☑️", "معطل ☑️");
        const allowed = antilinkConfig.allowed_domains.join(", ") || tr("none", "لا يوجد");
        const statusReply = tr(
          `*Anti-link:*\n\nState: ${state}\nMode: ${antilinkConfig.mode}\nAllowed domains: ${allowed}\n`,
          `*حالة نظام منع الروابط:*\n\nالحالة: ${state}\nالوضع: ${antilinkConfig.mode}\nالدومينات المسموح بها: ${allowed}\n`,
        );
        await sock.sendMessage(groupId, { text: statusReply });
      }
    }

    saveGroupSettings(groupId, settings);
  },
};

// --- The Message Handler Logic ---
const linkRegex = new RegExp(
  /(https?:\/\/(?:www\.|(?!www))[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|www\.[a-zA-Z0-9][a-zA-Z0-9-]+[a-zA-Z0-9]\.[^\s]{2,}|https?:\/\/[a-zA-Z0-9]+\.[^\s]{2,}|[a-zA-Z0-9]+\.[^\s]{2,})/i,
);

async function handleAntiLink(sock, msg, _legacyConfig, _normalizeJid) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  if (!isGroup) return false;

  const groupId = msg.key.remoteJid;
  const settings = getGroupSettings(groupId);
  const antilinkConfig = settings.antilink;

  if (!antilinkConfig || !antilinkConfig.enabled) return false;

  const senderId = msg.key.participant || msg.key.remoteJid;

  // Cache-first: this runs on every group message while antilink is enabled.
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  // Centralized checks — handle LID/PN cross-format and bootstrap roster.
  const senderIds = [senderId, msg.key.participantAlt, msg.key.participantPn].filter(Boolean);
  const isOwner = msg.key.fromMe || senderIds.some(isOwnerJidSync);
  const isSenderAdmin = senderIds.some((id) => isAdminInGroupSync(groupMetadata, id));

  if (isOwner || isSenderAdmin) return false;

  const body = visibleText(msg.message);
  if (!linkRegex.test(body)) return false; // No link found

  // --- Link Found, Apply Rules ---
  const foundLinks = body.match(linkRegex);
  let domain;
  try {
    domain = new URL(
      foundLinks[0].startsWith("http") ? foundLinks[0] : `http://${foundLinks[0]}`,
    ).hostname.replace("www.", "");
  } catch {
    return false;
  }

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
    logger.info(`[Anti-Link] Deleting link from ${senderId} in ${groupId}. Domain: ${domain}`);
    await sock.sendMessage(groupId, { delete: msg.key });
    await sock.sendMessage(groupId, {
      text: tr(
        `No links here, @${senderId.split("@")[0]}!`,
        `ممنوع إرسال الروابط هنا يا @${senderId.split("@")[0]}!`,
      ),
      mentions: [senderId],
    });
    return true;
  }
  return false;
}

// Export both the command and the handler
module.exports = { ...command, handleAntiLink };
