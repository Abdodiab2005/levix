// file: /commands/group/antilink.js
const { getGroupSettings, saveGroupSettings } = require("../../utils/storage.cjs");
const logger = require("../../utils/logger.cjs");
const { isOwnerJidSync, isAdminInGroupSync } = require("../../utils/permissions.cjs");
const { visibleText } = require("../../utils/messageContent.cjs");
const { resolveGroupMetadata } = require("../../utils/groupMetadataCache.cjs");
const { enforceGroupRule, senderCandidates } = require("../../utils/moderationAction.cjs");
const {
  featureActionOf,
  normalizeFeatureAction,
  policyFromFeatureAction,
} = require("../../utils/moderationSummary.cjs");
const { tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

// --- The Main Command Logic ---
const command = {
  name: "antilink",
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
      case "action": {
        const action = normalizeFeatureAction(args[1]);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: tr(
              "Invalid action. Available: `DELETE`, `WARN`, `KICK`",
              "الإجراء غير صالح. الإجراءات المتاحة: `DELETE`, `WARN`, `KICK`",
            ),
          });
        }
        try {
          applyModerationPolicy(groupId, { features: { antilink: action } });
        } catch (error) {
          return await sock.sendMessage(groupId, {
            text: tr(
              error.errors?.[0]?.message || "That action is not allowed.",
              "هذا الإجراء غير مسموح.",
            ),
          });
        }
        await sock.sendMessage(groupId, {
          text: tr(`✅ Anti-link action is now ${action}.`, `✅ تم تعيين إجراء منع الروابط إلى ${action}.`),
        });
        return;
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
        const action = featureActionOf(settings, "antilink");
        const statusReply = tr(
          `*Anti-link:*\n\nState: ${state}\nMode: ${antilinkConfig.mode}\nAction: ${action}\nAllowed domains: ${allowed}\n`,
          `*حالة نظام منع الروابط:*\n\nالحالة: ${state}\nالوضع: ${antilinkConfig.mode}\nالإجراء: ${action}\nالدومينات المسموح بها: ${allowed}\n`,
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

function detectAntiLink(msg, settings) {
  const groupId = msg?.key?.remoteJid;
  if (!groupId?.endsWith("@g.us")) return null;
  const antilinkConfig = settings?.antilink;
  if (!antilinkConfig?.enabled) return null;

  const body = visibleText(msg.message);
  if (!linkRegex.test(body)) return null;
  const foundLinks = body.match(linkRegex);
  let domain;
  try {
    domain = new URL(
      foundLinks[0].startsWith("http") ? foundLinks[0] : `http://${foundLinks[0]}`,
    ).hostname.replace("www.", "");
  } catch {
    return null;
  }

  const allowed = Array.isArray(antilinkConfig.allowed_domains) ? antilinkConfig.allowed_domains : [];
  const blocked = Array.isArray(antilinkConfig.blocked_domains) ? antilinkConfig.blocked_domains : [];
  const mode = String(antilinkConfig.mode || "ALL").toUpperCase();
  let shouldDelete = mode === "ALL";
  if (mode === "WHITELIST") shouldDelete = !allowed.includes(domain);
  else if (mode === "BLACKLIST") shouldDelete = blocked.includes(domain);
  if (!shouldDelete) return null;
  return { rule: "link", reason: `antilink:${domain}`, detail: domain };
}

async function handleAntiLink(sock, msg, _legacyConfig, _normalizeJid) {
  const isGroup = msg.key.remoteJid.endsWith("@g.us");
  if (!isGroup) return false;

  const groupId = msg.key.remoteJid;
  const settings = getGroupSettings(groupId) || {};
  const senderId = msg.key.participant || msg.key.remoteJid;

  // Cache-first: this runs on every group message while antilink is enabled.
  const groupMetadata = await resolveGroupMetadata(sock, groupId);
  const senderIds = senderCandidates(msg, sock);
  const isOwner = msg.key.fromMe || senderIds.some(isOwnerJidSync);
  const isSenderAdmin = senderIds.some((id) => isAdminInGroupSync(groupMetadata, id));
  if (isOwner || isSenderAdmin) return false;

  const hit = detectAntiLink(msg, settings);
  if (!hit) return false;
  logger.info(`[Anti-Link] Deleting link from ${senderId} in ${groupId}. Domain: ${hit.detail}`);
  const policy = policyFromFeatureAction(featureActionOf(settings, "antilink"));
  const result = await enforceGroupRule(sock, {
    msg,
    groupMetadata,
    rule: "link",
    warningReason: hit.reason,
    detail: hit.detail,
    ...policy,
    targetCandidates: senderIds,
  });
  return Boolean(result.acted);
}

module.exports = { ...command, handleAntiLink, detectAntiLink };
