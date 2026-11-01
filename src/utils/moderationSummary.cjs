// One builder for the "Active moderation" block. !rules, welcome, and the
// panel preview all call this so the wording cannot drift.

const { t, withLang } = require("./i18n.cjs");
const { resolveModerationPolicy, policyFieldVisibility } = require("../services/moderationPolicy.cjs");

const MEDIA_TYPES = ["image", "video", "sticker", "audio"];
const DELETE_WARN_KICK = ["DELETE", "WARN", "KICK"];

function mediaLabel(type) {
  switch (type) {
    case "image":
      return t("bot.moderation.moderationSummary.photos");
    case "video":
      return t("bot.moderation.moderationSummary.videos");
    case "audio":
      return t("bot.moderation.moderationSummary.voiceNotes");
    case "sticker":
      return t("bot.moderation.moderationSummary.stickers");
    default:
      return type;
  }
}

function linkModeLine(antilink) {
  const mode = String(antilink?.mode || "ALL").toUpperCase();
  const allowed = Array.isArray(antilink?.allowed_domains) ? antilink.allowed_domains.length : 0;
  const blocked = Array.isArray(antilink?.blocked_domains) ? antilink.blocked_domains.length : 0;
  if (mode === "WHITELIST") {
    return t("bot.moderation.moderationSummary.allowListedDomainsOnly", { allowed });
  }
  if (mode === "BLACKLIST") {
    return t("bot.moderation.moderationSummary.blockListedDomains", { blocked });
  }
  return t("bot.moderation.moderationSummary.blockAllLinks");
}

function forbiddenInfo(settings) {
  const nested = settings?.moderation?.forbiddenWords;
  const listed = Array.isArray(nested?.list) ? nested.list.length : null;
  const count =
    listed != null ? listed : Number(settings?.forbidden_words?.count) || 0;
  const enabled = Boolean(nested?.enabled ?? settings?.forbidden_words?.enabled);
  return { enabled, count };
}

// Effective warn limit. A stored moderationPolicy field wins; otherwise the
// legacy warn_system values apply. Missing / empty / unknown → KICK at 3.
// Stored "NONE" (pre-v9) and "FLAG" → FLAG.
function warnConfigOf(settings) {
  const policy = resolveModerationPolicy(settings);
  return {
    max_warnings: policy.limit,
    action: policy.limitAction === "FLAG" ? "FLAG" : "KICK",
  };
}

function normalizeWarnAction(raw) {
  const action = String(raw || "").trim().toUpperCase();
  if (action === "FLAG" || action === "NONE") return "FLAG";
  if (action === "KICK") return "KICK";
  return null;
}

function featureActionOf(settings, feature) {
  const action = resolveModerationPolicy(settings).features?.[feature];
  if (feature === "antispam") return action === "KICK" ? "KICK" : "WARN";
  if (DELETE_WARN_KICK.includes(action)) return action;
  return "WARN";
}

function normalizeFeatureAction(raw, { allowDelete = true } = {}) {
  const action = String(raw || "").trim().toUpperCase();
  if (action === "KICK" || action === "WARN") return action;
  if (allowDelete && action === "DELETE") return "DELETE";
  return null;
}

function policyFromFeatureAction(action) {
  const resolved = String(action || "WARN").toUpperCase();
  if (resolved === "DELETE") {
    return { deleteMessage: true, recordWarning: false, kickImmediately: false };
  }
  if (resolved === "KICK") {
    return { deleteMessage: true, recordWarning: true, kickImmediately: true };
  }
  return { deleteMessage: true, recordWarning: true, kickImmediately: false };
}

function deleteWarnKickLabel(action) {
  if (action === "DELETE") return t("bot.moderation.moderationSummary.deleteOnly");
  if (action === "KICK") return t("bot.moderation.moderationSummary.deleteAndRemoveTheMember");
  return t("bot.moderation.moderationSummary.deleteAndWarn");
}

function renderModerationSummary(settings = {}) {
  const lines = [t("bot.moderation.moderationSummary.activeModeration")];

  if (settings.antilink?.enabled) {
    const action = deleteWarnKickLabel(featureActionOf(settings, "antilink"));
    lines.push(
      t("bot.moderation.moderationSummary.antiLinkOnAction", {
        linkMode: linkModeLine(settings.antilink),
        action,
      }),
    );
  }

  if (settings.antispam?.enabled) {
    const windowSec = settings.antispam.time_window ?? 10;
    const count = settings.antispam.message_count ?? 5;
    const action = featureActionOf(settings, "antispam");
    const actionText =
      action === "KICK"
        ? t("bot.moderation.moderationSummary.removeTheMember")
        : t("bot.moderation.moderationSummary.warn");
    lines.push(
      t("bot.moderation.moderationSummary.antiSpamOnMessagesS", { count, windowSec, actionText }),
    );
  }

  const blocked = (settings.media_control?.blocked_types || []).filter((type) =>
    MEDIA_TYPES.includes(type),
  );
  if (settings.media_control?.enabled && blocked.length) {
    const names = blocked.map(mediaLabel).join(t("bot.moderation.moderationSummary.mediaListSeparator"));
    const action = deleteWarnKickLabel(featureActionOf(settings, "media"));
    lines.push(
      t("bot.moderation.moderationSummary.mediaAction", { names, action }),
    );
  }

  const words = forbiddenInfo(settings);
  if (words.enabled) {
    const action = deleteWarnKickLabel(featureActionOf(settings, "forbidden"));
    lines.push(
      t("bot.moderation.moderationSummary.forbiddenWordsAction", { count: words.count, action }),
    );
  }

  const warn = warnConfigOf(settings);
  const atLimit =
    warn.action === "FLAG"
      ? t("bot.moderation.moderationSummary.flagForAdminReview")
      : t("bot.moderation.moderationSummary.removeTheMember");
  lines.push(
    t("bot.moderation.moderationSummary.warnLimitAtTheLimit", { maxWarnings: warn.max_warnings, atLimit }),
  );

  const policy = resolveModerationPolicy(settings);
  const visibility = policyFieldVisibility(policy);
  if (policy.decay.mode === "expire") {
    lines.push(
      t("bot.moderation.moderationSummary.warningsDropAfterDays", { days: policy.decay.days }),
    );
  } else if (policy.decay.mode === "step") {
    lines.push(
      t("bot.moderation.moderationSummary.warningsLoseOnePointEvery", { days: policy.decay.days }),
    );
  }
  if (visibility["flag.notify"]) {
    const notify =
      policy.flag.notify === "silent"
        ? t("bot.moderation.moderationSummary.silent")
        : t("bot.moderation.moderationSummary.inTheGroup");
    lines.push(
      t("bot.moderation.moderationSummary.flagNotice", { notify }),
    );
  }
  lines.push(
    policy.membership === "keep"
      ? t("bot.moderation.moderationSummary.leavingOrBeingRemovedKeeps")
      : t("bot.moderation.moderationSummary.leavingOrBeingRemovedClears"),
  );

  return lines.join("\n");
}

function buildModerationSummary(settings, lang) {
  if (lang) return withLang(lang, () => renderModerationSummary(settings));
  return renderModerationSummary(settings);
}

function buildModerationSummaryBoth(settings) {
  return {
    en: buildModerationSummary(settings, "en"),
    ar: buildModerationSummary(settings, "ar"),
  };
}

module.exports = {
  buildModerationSummary,
  buildModerationSummaryBoth,
  mediaLabel,
  warnConfigOf,
  normalizeWarnAction,
  featureActionOf,
  normalizeFeatureAction,
  policyFromFeatureAction,
  forbiddenInfo,
};
