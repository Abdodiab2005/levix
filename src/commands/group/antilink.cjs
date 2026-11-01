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
const { t, tr } = require("../../utils/i18n.cjs");
const { applyModerationPolicy } = require("../../services/moderationPolicy.cjs");

// --- The Main Command Logic ---
const command = {
  name: "antilink",
  description: {
    en: "Advanced control of the anti-link protection.",
    ar: "تحكم متقدم في ميزة منع الروابط.",
  },
  usage: {
    en: "antilink [status]\nantilink <on|off>\nantilink mode <ALL|WHITELIST|BLACKLIST>\nantilink action <DELETE|WARN|KICK>\nantilink <allow|disallow> <domain>",
    ar: "antilink [status]\nantilink <on|off>\nantilink mode <ALL|WHITELIST|BLACKLIST>\nantilink action <DELETE|WARN|KICK>\nantilink <allow|disallow> <النطاق>",
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
          text: t("bot.moderation.antilink.antiLinkIsOn"),
        });
        break;
      case "off":
        antilinkConfig.enabled = false;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antilink.antiLinkIsOff"),
        });
        break;
      case "mode": {
        const mode = args[1] ? args[1].toUpperCase() : "";
        if (!["ALL", "WHITELIST", "BLACKLIST"].includes(mode)) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antilink.invalidModeAvailableAllWhitelist"),
          });
        }
        antilinkConfig.mode = mode;
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antilink.antiLinkModeIsNow", { mode }),
        });
        break;
      }
      case "allow": {
        const domainToAllow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToAllow)
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antilink.sayWhichDomainToAllow"),
          });
        if (!antilinkConfig.allowed_domains.includes(domainToAllow)) {
          antilinkConfig.allowed_domains.push(domainToAllow);
        }
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antilink.isNowAllowed", { domainToAllow }),
        });
        break;
      }
      case "action": {
        const action = normalizeFeatureAction(args[1]);
        if (!action) {
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antilink.invalidActionAvailableDeleteWarn"),
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
          text: t("bot.moderation.antilink.antiLinkActionIsNow", { action }),
        });
        return;
      }
      case "disallow": {
        const domainToDisallow = args[1] ? args[1].toLowerCase() : "";
        if (!domainToDisallow)
          return await sock.sendMessage(groupId, {
            text: t("bot.moderation.antilink.sayWhichDomainToRemove"),
          });
        antilinkConfig.allowed_domains = antilinkConfig.allowed_domains.filter(
          (d) => d !== domainToDisallow,
        );
        await sock.sendMessage(groupId, {
          text: t("bot.moderation.antilink.isNoLongerAllowed", { domainToDisallow }),
        });
        break;
      }
      default: {
        // Display current status
        const state = antilinkConfig.enabled ? t("bot.moderation.antilink.on") : t("bot.moderation.antilink.off");
        const allowed = antilinkConfig.allowed_domains.join(", ") || t("bot.moderation.antilink.none");
        const action = featureActionOf(settings, "antilink");
        const statusReply = t("bot.moderation.antilink.antiLinkStateModeAction", {
          state,
          mode: antilinkConfig.mode,
          action,
          allowed,
        });
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
