// One builder for the "Active moderation" block. !rules, welcome, and the
// panel preview all call this so the wording cannot drift.

const { tr, withLang } = require("./i18n.cjs");

const MEDIA_TYPES = ["image", "video", "sticker", "audio"];
const DELETE_WARN_KICK = ["DELETE", "WARN", "KICK"];

function mediaLabel(type) {
  switch (type) {
    case "image":
      return tr("photos", "الصور");
    case "video":
      return tr("videos", "الفيديو");
    case "audio":
      return tr("voice notes", "الصوتيات");
    case "sticker":
      return tr("stickers", "الملصقات");
    default:
      return type;
  }
}

function linkModeLine(antilink) {
  const mode = String(antilink?.mode || "ALL").toUpperCase();
  const allowed = Array.isArray(antilink?.allowed_domains) ? antilink.allowed_domains.length : 0;
  const blocked = Array.isArray(antilink?.blocked_domains) ? antilink.blocked_domains.length : 0;
  if (mode === "WHITELIST") {
    return tr(
      `allow listed domains only (${allowed})`,
      `السماح بالنطاقات المدرجة فقط (${allowed})`,
    );
  }
  if (mode === "BLACKLIST") {
    return tr(`block listed domains (${blocked})`, `حظر النطاقات المدرجة (${blocked})`);
  }
  return tr("block all links", "حظر كل الروابط");
}

function forbiddenInfo(settings) {
  const nested = settings?.moderation?.forbiddenWords;
  const listed = Array.isArray(nested?.list) ? nested.list.length : null;
  const count =
    listed != null ? listed : Number(settings?.forbidden_words?.count) || 0;
  const enabled = Boolean(nested?.enabled ?? settings?.forbidden_words?.enabled);
  return { enabled, count };
}

// Single reader for warn_system. Missing / empty / unknown → KICK.
// Stored "NONE" (pre-v9) and "FLAG" → FLAG. Default max_warnings stays 3.
function warnConfigOf(settings) {
  const warn = settings?.warn_system || {};
  const action = String(warn.action || "").trim().toUpperCase();
  return {
    max_warnings: warn.max_warnings ?? 3,
    action: action === "FLAG" || action === "NONE" ? "FLAG" : "KICK",
  };
}

function normalizeWarnAction(raw) {
  const action = String(raw || "").trim().toUpperCase();
  if (action === "FLAG" || action === "NONE") return "FLAG";
  if (action === "KICK") return "KICK";
  return null;
}

function featureActionOf(settings, feature) {
  let raw = "";
  if (feature === "antilink") raw = settings?.antilink?.action;
  else if (feature === "media") raw = settings?.media_control?.action;
  else if (feature === "forbidden") raw = settings?.moderation?.forbiddenWords?.action ?? settings?.forbidden_words?.action;
  else if (feature === "antispam") raw = settings?.antispam?.action;
  const action = String(raw || "").trim().toUpperCase();
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
  if (action === "DELETE") return tr("delete only", "حذف فقط");
  if (action === "KICK") return tr("delete and remove the member", "حذف وطرد العضو");
  return tr("delete and warn", "حذف وإنذار");
}

function renderModerationSummary(settings = {}) {
  const lines = [tr("*Active moderation*", "*الإشراف المفعّل*")];

  if (settings.antilink?.enabled) {
    const action = deleteWarnKickLabel(featureActionOf(settings, "antilink"));
    lines.push(
      tr(
        `• Anti-link: on — ${linkModeLine(settings.antilink)}. Action: ${action}.`,
        `• منع الروابط: مفعّل — ${linkModeLine(settings.antilink)}. الإجراء: ${action}.`,
      ),
    );
  }

  if (settings.antispam?.enabled) {
    const windowSec = settings.antispam.time_window ?? 10;
    const count = settings.antispam.message_count ?? 5;
    const action = featureActionOf(settings, "antispam");
    const actionText =
      action === "KICK"
        ? tr("remove the member", "طرد العضو")
        : tr("warn", "إنذار");
    lines.push(
      tr(
        `• Anti-spam: on — ${count} messages / ${windowSec}s. Action: ${actionText}.`,
        `• مكافحة الإزعاج: مفعّلة — ${count} رسائل / ${windowSec}ث. الإجراء: ${actionText}.`,
      ),
    );
  }

  const blocked = (settings.media_control?.blocked_types || []).filter((type) =>
    MEDIA_TYPES.includes(type),
  );
  if (settings.media_control?.enabled && blocked.length) {
    const names = blocked.map(mediaLabel).join(tr(", ", "، "));
    const action = deleteWarnKickLabel(featureActionOf(settings, "media"));
    lines.push(
      tr(`• Media: ${names}. Action: ${action}.`, `• الوسائط: ${names}. الإجراء: ${action}.`),
    );
  }

  const words = forbiddenInfo(settings);
  if (words.enabled) {
    const action = deleteWarnKickLabel(featureActionOf(settings, "forbidden"));
    lines.push(
      tr(
        `• Forbidden words: ${words.count}. Action: ${action}.`,
        `• الكلمات الممنوعة: ${words.count}. الإجراء: ${action}.`,
      ),
    );
  }

  const warn = warnConfigOf(settings);
  const atLimit =
    warn.action === "FLAG"
      ? tr("flag for admin review", "إبلاغ المشرفين للمراجعة")
      : tr("remove the member", "طرد العضو");
  lines.push(
    tr(
      `• Warn limit: ${warn.max_warnings}. At the limit: ${atLimit}.`,
      `• حد الإنذارات: ${warn.max_warnings}. عند بلوغ الحد: ${atLimit}.`,
    ),
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
