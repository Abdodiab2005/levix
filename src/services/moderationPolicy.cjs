// Per-group moderation policy.
//
// The stored object is sparse: a missing key means the default, and a feature
// null means "use the default" even when the legacy action key is set. The
// same save mirrors limit and feature actions back into warn_system /
// antilink / media_control / forbidden words / antispam so the old commands
// and the panel keep reading one value. A bad stored field is skipped; the
// message path keeps running.

const logger = require("../utils/logger.cjs");
const { getGroupSettings, saveGroupSettings } = require("../db/store.cjs");

const MODES = ["simple", "severity"];
const LIMIT_ACTIONS = ["KICK", "FLAG"];
const FEATURE_ACTIONS = ["DELETE", "WARN", "KICK"];
const SPAM_ACTIONS = ["WARN", "KICK"];
const MERGES = ["max", "sum"];
const DECAY_MODES = ["off", "expire", "step"];
const MEMBERSHIPS = ["keep", "clear"];
const NOTIFIES = ["group", "silent"];
const WHILE_FLAGGED = ["record", "hold", "escalate"];
const FEATURES = ["antilink", "media", "forbidden", "antispam"];
const WEIGHTS = ["antilink", "media", "forbidden", "antispam", "manual"];
const TOP_KEYS = [
  "mode",
  "limit",
  "limitAction",
  "features",
  "hitMerge",
  "weights",
  "flagAt",
  "kickAt",
  "decay",
  "membership",
  "flag",
];
const PRESET_NAMES = ["relaxed", "standard", "strict"];

const RELAXED = {
  limit: 5,
  limitAction: "FLAG",
  decay: { mode: "expire", days: 14 },
  flag: {
    notify: "group",
    mentionAdmins: true,
    cooldownMinutes: 60,
    whileFlagged: "hold",
  },
};

const STRICT = {
  limit: 2,
  limitAction: "KICK",
  features: { antilink: "KICK", antispam: "KICK", media: "WARN", forbidden: "WARN" },
  decay: { mode: "off" },
};

class ModerationPolicyError extends Error {
  constructor(errors) {
    super(errors?.[0]?.message || "Invalid moderation policy");
    this.name = "ModerationPolicyError";
    this.errors = errors || [];
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function error(field, code, message) {
  return { field, code, message };
}

function canonEnum(value, allowed) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const match = allowed.find((item) => item.toLowerCase() === text.toLowerCase());
  return match || null;
}

function isInteger(value) {
  return typeof value === "number" && Number.isInteger(value);
}

function warnSkip(field) {
  logger.warn({ field }, "ignoring invalid moderation policy field");
}

function legacyLimit(settings) {
  const max = settings?.warn_system?.max_warnings;
  // Old installs stored limits above 50. Keep any positive integer already
  // saved. New writes are rejected outside 1–50 by validateModerationPolicy.
  return isInteger(max) && max >= 1 ? max : 3;
}

function legacyLimitAction(settings) {
  const action = String(settings?.warn_system?.action || "").trim().toUpperCase();
  if (!action) return "KICK";
  if (action === "FLAG" || action === "NONE") return "FLAG";
  if (action === "KICK") return "KICK";
  return "KICK";
}

function legacyFeature(settings, feature) {
  let raw = "";
  if (feature === "antilink") raw = settings?.antilink?.action;
  else if (feature === "media") raw = settings?.media_control?.action;
  else if (feature === "forbidden") {
    raw = settings?.moderation?.forbiddenWords?.action ?? settings?.forbidden_words?.action;
  } else if (feature === "antispam") raw = settings?.antispam?.action;
  const allowed = feature === "antispam" ? SPAM_ACTIONS : FEATURE_ACTIONS;
  return canonEnum(raw == null ? "" : String(raw), allowed);
}

function pickEnum(present, value, allowed, fallback, field) {
  if (!present) return fallback;
  if (value === null) return fallback;
  const canon = canonEnum(value, allowed);
  if (!canon) {
    warnSkip(field);
    return fallback;
  }
  return canon;
}

function pickInt(present, value, min, max, fallback, field) {
  if (!present) return fallback;
  if (!isInteger(value) || value < min || value > max) {
    warnSkip(field);
    return fallback;
  }
  return value;
}

function sectionOf(policy, key) {
  const value = policy?.[key];
  if (value == null) return {};
  if (!isPlainObject(value)) {
    warnSkip(key);
    return {};
  }
  return value;
}

function resolveModerationPolicy(settings) {
  const source = isPlainObject(settings) ? settings : {};
  let policy = source.moderationPolicy;
  if (policy == null) policy = {};
  else if (!isPlainObject(policy)) {
    warnSkip("moderationPolicy");
    policy = {};
  }

  const has = (key) => Object.prototype.hasOwnProperty.call(policy, key);
  const featuresIn = sectionOf(policy, "features");
  const weightsIn = sectionOf(policy, "weights");
  const decayIn = sectionOf(policy, "decay");
  const flagIn = sectionOf(policy, "flag");
  const featureHas = (key) => Object.prototype.hasOwnProperty.call(featuresIn, key);

  const features = {};
  for (const feature of FEATURES) {
    if (featureHas(feature)) {
      const value = featuresIn[feature];
      if (value === null) features[feature] = null;
      else {
        const allowed = feature === "antispam" ? SPAM_ACTIONS : FEATURE_ACTIONS;
        const canon = typeof value === "string" ? canonEnum(value, allowed) : null;
        if (!canon) {
          warnSkip(`features.${feature}`);
          features[feature] = legacyFeature(source, feature);
        } else features[feature] = canon;
      }
    } else features[feature] = legacyFeature(source, feature);
  }

  const weights = {};
  for (const feature of WEIGHTS) {
    weights[feature] = pickInt(
      Object.prototype.hasOwnProperty.call(weightsIn, feature),
      weightsIn[feature],
      1,
      10,
      1,
      `weights.${feature}`,
    );
  }

  const decayMode = pickEnum(
    Object.prototype.hasOwnProperty.call(decayIn, "mode"),
    decayIn.mode,
    DECAY_MODES,
    "off",
    "decay.mode",
  );

  return {
    mode: pickEnum(has("mode"), policy.mode, MODES, "simple", "mode"),
    limit: pickInt(has("limit"), policy.limit, 1, 50, legacyLimit(source), "limit"),
    limitAction: pickEnum(
      has("limitAction"),
      policy.limitAction,
      LIMIT_ACTIONS,
      legacyLimitAction(source),
      "limitAction",
    ),
    features,
    hitMerge: pickEnum(has("hitMerge"), policy.hitMerge, MERGES, "max", "hitMerge"),
    weights,
    flagAt: pickInt(has("flagAt"), policy.flagAt, 1, 49, 3, "flagAt"),
    kickAt: pickInt(has("kickAt"), policy.kickAt, 2, 50, 5, "kickAt"),
    decay: {
      mode: decayMode,
      days: pickInt(
        Object.prototype.hasOwnProperty.call(decayIn, "days"),
        decayIn.days,
        1,
        365,
        30,
        "decay.days",
      ),
    },
    membership: pickEnum(has("membership"), policy.membership, MEMBERSHIPS, "clear", "membership"),
    flag: {
      notify: pickEnum(
        Object.prototype.hasOwnProperty.call(flagIn, "notify"),
        flagIn.notify,
        NOTIFIES,
        "group",
        "flag.notify",
      ),
      mentionAdmins: Object.prototype.hasOwnProperty.call(flagIn, "mentionAdmins")
        ? flagIn.mentionAdmins === true
          ? true
          : flagIn.mentionAdmins === false
            ? false
            : (warnSkip("flag.mentionAdmins"), true)
        : true,
      cooldownMinutes: pickInt(
        Object.prototype.hasOwnProperty.call(flagIn, "cooldownMinutes"),
        flagIn.cooldownMinutes,
        0,
        10080,
        0,
        "flag.cooldownMinutes",
      ),
      whileFlagged: pickEnum(
        Object.prototype.hasOwnProperty.call(flagIn, "whileFlagged"),
        flagIn.whileFlagged,
        WHILE_FLAGGED,
        "record",
        "flag.whileFlagged",
      ),
      escalateAfter: pickInt(
        Object.prototype.hasOwnProperty.call(flagIn, "escalateAfter"),
        flagIn.escalateAfter,
        1,
        50,
        3,
        "flag.escalateAfter",
      ),
    },
  };
}

function policyFieldVisibility(effective) {
  const policy = effective || resolveModerationPolicy({});
  const simple = policy.mode !== "severity";
  const flagBlock = !(policy.mode === "simple" && policy.limitAction === "KICK");
  const escalate = policy.flag?.whileFlagged === "escalate";
  return {
    mode: true,
    limit: simple,
    limitAction: simple,
    "features.antilink": true,
    "features.media": true,
    "features.forbidden": true,
    "features.antispam": true,
    hitMerge: !simple,
    "weights.antilink": !simple,
    "weights.media": !simple,
    "weights.forbidden": !simple,
    "weights.antispam": !simple,
    "weights.manual": !simple,
    flagAt: !simple,
    kickAt: !simple,
    "decay.mode": true,
    "decay.days": policy.decay?.mode !== "off",
    membership: true,
    "flag.notify": flagBlock,
    "flag.mentionAdmins": flagBlock && policy.flag?.notify !== "silent",
    "flag.cooldownMinutes": flagBlock,
    "flag.whileFlagged": flagBlock,
    "flag.escalateAfter": flagBlock && escalate,
  };
}

function cleanStored(raw) {
  if (raw == null) return {};
  if (!isPlainObject(raw)) return {};
  const stored = {};
  if (canonEnum(raw.mode, MODES)) stored.mode = canonEnum(raw.mode, MODES);
  if (isInteger(raw.limit) && raw.limit >= 1 && raw.limit <= 50) stored.limit = raw.limit;
  if (canonEnum(raw.limitAction, LIMIT_ACTIONS)) stored.limitAction = canonEnum(raw.limitAction, LIMIT_ACTIONS);
  if (isPlainObject(raw.features)) {
    const features = {};
    for (const feature of FEATURES) {
      if (!Object.prototype.hasOwnProperty.call(raw.features, feature)) continue;
      const value = raw.features[feature];
      if (value === null) features[feature] = null;
      else {
        const allowed = feature === "antispam" ? SPAM_ACTIONS : FEATURE_ACTIONS;
        const canon = typeof value === "string" ? canonEnum(value, allowed) : null;
        if (canon) features[feature] = canon;
      }
    }
    if (Object.keys(features).length) stored.features = features;
  }
  if (canonEnum(raw.hitMerge, MERGES)) stored.hitMerge = canonEnum(raw.hitMerge, MERGES);
  if (isPlainObject(raw.weights)) {
    const weights = {};
    for (const feature of WEIGHTS) {
      const value = raw.weights[feature];
      if (isInteger(value) && value >= 1 && value <= 10) weights[feature] = value;
    }
    if (Object.keys(weights).length) stored.weights = weights;
  }
  if (isInteger(raw.flagAt) && raw.flagAt >= 1 && raw.flagAt <= 49) stored.flagAt = raw.flagAt;
  if (isInteger(raw.kickAt) && raw.kickAt >= 2 && raw.kickAt <= 50) stored.kickAt = raw.kickAt;
  if (isPlainObject(raw.decay)) {
    const decay = {};
    if (canonEnum(raw.decay.mode, DECAY_MODES)) decay.mode = canonEnum(raw.decay.mode, DECAY_MODES);
    if (isInteger(raw.decay.days) && raw.decay.days >= 1 && raw.decay.days <= 365) decay.days = raw.decay.days;
    if (Object.keys(decay).length) stored.decay = decay;
  }
  if (canonEnum(raw.membership, MEMBERSHIPS)) stored.membership = canonEnum(raw.membership, MEMBERSHIPS);
  if (isPlainObject(raw.flag)) {
    const flag = {};
    if (canonEnum(raw.flag.notify, NOTIFIES)) flag.notify = canonEnum(raw.flag.notify, NOTIFIES);
    if (raw.flag.mentionAdmins === true || raw.flag.mentionAdmins === false) {
      flag.mentionAdmins = raw.flag.mentionAdmins;
    }
    if (isInteger(raw.flag.cooldownMinutes) && raw.flag.cooldownMinutes >= 0 && raw.flag.cooldownMinutes <= 10080) {
      flag.cooldownMinutes = raw.flag.cooldownMinutes;
    }
    if (canonEnum(raw.flag.whileFlagged, WHILE_FLAGGED)) {
      flag.whileFlagged = canonEnum(raw.flag.whileFlagged, WHILE_FLAGGED);
    }
    if (isInteger(raw.flag.escalateAfter) && raw.flag.escalateAfter >= 1 && raw.flag.escalateAfter <= 50) {
      flag.escalateAfter = raw.flag.escalateAfter;
    }
    if (Object.keys(flag).length) stored.flag = flag;
  }
  return stored;
}

function checkInteger(errors, field, value, min, max) {
  if (!isInteger(value)) {
    errors.push(error(field, "type", `${field} must be an integer`));
    return false;
  }
  if (value < min || value > max) {
    errors.push(error(field, "range", `${field} must be from ${min} to ${max}`));
    return false;
  }
  return true;
}

function checkEnum(errors, field, value, allowed) {
  const canon = typeof value === "string" ? canonEnum(value, allowed) : null;
  if (!canon) {
    errors.push(error(field, "enum", `${field} must be ${allowed.join(", ")}`));
    return null;
  }
  return canon;
}

function mergeSection(errors, field, base, patch, allowed) {
  if (patch === undefined) return base;
  if (!isPlainObject(patch)) {
    errors.push(error(field, "type", `${field} must be an object`));
    return base;
  }
  const next = { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (!allowed.includes(key)) {
      errors.push(error(`${field}.${key}`, "unknown", `Unknown field ${field}.${key}`));
      continue;
    }
    next[key] = value;
  }
  return next;
}

function validateModerationPolicy(patch, currentSettings) {
  const errors = [];
  if (!isPlainObject(patch)) {
    return { ok: false, errors: [error("moderation_policy", "type", "Policy must be an object")] };
  }
  const current = isPlainObject(currentSettings) ? currentSettings : {};
  const base = cleanStored(current.moderationPolicy);
  const merged = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!TOP_KEYS.includes(key)) {
      errors.push(error(key, "unknown", `Unknown field ${key}`));
      continue;
    }
    if (key === "features" || key === "weights" || key === "decay" || key === "flag") continue;
    merged[key] = value;
  }
  merged.features = mergeSection(errors, "features", base.features, patch.features, FEATURES);
  merged.weights = mergeSection(errors, "weights", base.weights, patch.weights, WEIGHTS);
  merged.decay = mergeSection(errors, "decay", base.decay, patch.decay, ["mode", "days"]);
  merged.flag = mergeSection(errors, "flag", base.flag, patch.flag, [
    "notify",
    "mentionAdmins",
    "cooldownMinutes",
    "whileFlagged",
    "escalateAfter",
  ]);

  const stored = {};
  if (Object.prototype.hasOwnProperty.call(merged, "mode")) {
    const mode = checkEnum(errors, "mode", merged.mode, MODES);
    if (mode) stored.mode = mode;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "limit")) {
    if (checkInteger(errors, "limit", merged.limit, 1, 50)) stored.limit = merged.limit;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "limitAction")) {
    const action = checkEnum(errors, "limitAction", merged.limitAction, LIMIT_ACTIONS);
    if (action) stored.limitAction = action;
  }
  if (merged.features && Object.keys(merged.features).length) {
    const features = {};
    for (const [feature, value] of Object.entries(merged.features)) {
      if (value === null) {
        features[feature] = null;
        continue;
      }
      const allowed = feature === "antispam" ? SPAM_ACTIONS : FEATURE_ACTIONS;
      if (feature === "antispam" && typeof value === "string" && value.trim().toUpperCase() === "DELETE") {
        errors.push(error("features.antispam", "enum", "features.antispam must be WARN, KICK, or null"));
        continue;
      }
      const action = checkEnum(errors, `features.${feature}`, value, feature === "antispam" ? SPAM_ACTIONS : allowed);
      if (action) features[feature] = action;
    }
    if (Object.keys(features).length) stored.features = features;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "hitMerge")) {
    const merge = checkEnum(errors, "hitMerge", merged.hitMerge, MERGES);
    if (merge) stored.hitMerge = merge;
  }
  if (merged.weights && Object.keys(merged.weights).length) {
    const weights = {};
    for (const [feature, value] of Object.entries(merged.weights)) {
      if (checkInteger(errors, `weights.${feature}`, value, 1, 10)) weights[feature] = value;
    }
    if (Object.keys(weights).length) stored.weights = weights;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "flagAt")) {
    if (checkInteger(errors, "flagAt", merged.flagAt, 1, 49)) stored.flagAt = merged.flagAt;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "kickAt")) {
    if (checkInteger(errors, "kickAt", merged.kickAt, 2, 50)) stored.kickAt = merged.kickAt;
  }
  if (merged.decay && Object.keys(merged.decay).length) {
    const decay = {};
    if (Object.prototype.hasOwnProperty.call(merged.decay, "mode")) {
      const mode = checkEnum(errors, "decay.mode", merged.decay.mode, DECAY_MODES);
      if (mode) decay.mode = mode;
    }
    if (Object.prototype.hasOwnProperty.call(merged.decay, "days")) {
      if (checkInteger(errors, "decay.days", merged.decay.days, 1, 365)) decay.days = merged.decay.days;
    }
    if (Object.keys(decay).length) stored.decay = decay;
  }
  if (Object.prototype.hasOwnProperty.call(merged, "membership")) {
    const membership = checkEnum(errors, "membership", merged.membership, MEMBERSHIPS);
    if (membership) stored.membership = membership;
  }
  if (merged.flag && Object.keys(merged.flag).length) {
    const flag = {};
    if (Object.prototype.hasOwnProperty.call(merged.flag, "notify")) {
      const notify = checkEnum(errors, "flag.notify", merged.flag.notify, NOTIFIES);
      if (notify) flag.notify = notify;
    }
    if (Object.prototype.hasOwnProperty.call(merged.flag, "mentionAdmins")) {
      if (merged.flag.mentionAdmins !== true && merged.flag.mentionAdmins !== false) {
        errors.push(error("flag.mentionAdmins", "type", "flag.mentionAdmins must be true or false"));
      } else flag.mentionAdmins = merged.flag.mentionAdmins;
    }
    if (Object.prototype.hasOwnProperty.call(merged.flag, "cooldownMinutes")) {
      if (checkInteger(errors, "flag.cooldownMinutes", merged.flag.cooldownMinutes, 0, 10080)) {
        flag.cooldownMinutes = merged.flag.cooldownMinutes;
      }
    }
    if (Object.prototype.hasOwnProperty.call(merged.flag, "whileFlagged")) {
      const whileFlagged = checkEnum(errors, "flag.whileFlagged", merged.flag.whileFlagged, WHILE_FLAGGED);
      if (whileFlagged) flag.whileFlagged = whileFlagged;
    }
    if (Object.prototype.hasOwnProperty.call(merged.flag, "escalateAfter")) {
      if (checkInteger(errors, "flag.escalateAfter", merged.flag.escalateAfter, 1, 50)) {
        flag.escalateAfter = merged.flag.escalateAfter;
      }
    }
    if (Object.keys(flag).length) stored.flag = flag;
  }

  if (errors.length) return { ok: false, errors };

  const effective = resolveModerationPolicy({ ...current, moderationPolicy: stored });
  if (effective.mode === "severity" && effective.kickAt <= effective.flagAt) {
    errors.push(error("kickAt", "conflict", "kickAt must be greater than flagAt"));
  }
  if (effective.mode === "severity" && effective.flag.whileFlagged === "escalate") {
    errors.push(error("flag.whileFlagged", "conflict", "escalate is not available when mode is severity"));
  }
  const setsFlag = isPlainObject(patch.flag) && Object.keys(patch.flag).length > 0;
  if (effective.mode === "simple" && effective.limitAction === "KICK" && setsFlag) {
    errors.push(
      error("flag", "conflict", "flag settings do not apply when the limit removes the member"),
    );
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, stored, effective, visibility: policyFieldVisibility(effective) };
}

function ensureWarn(settings) {
  if (!isPlainObject(settings.warn_system)) settings.warn_system = {};
  return settings.warn_system;
}

function featureBucket(settings, feature, create) {
  if (feature === "antilink") {
    if (create && !isPlainObject(settings.antilink)) {
      settings.antilink = { enabled: false, mode: "ALL", allowed_domains: [], blocked_domains: [] };
    }
    return settings.antilink;
  }
  if (feature === "media") {
    if (create && !isPlainObject(settings.media_control)) {
      settings.media_control = { enabled: false, blocked_types: [] };
    }
    return settings.media_control;
  }
  if (feature === "antispam") {
    if (create && !isPlainObject(settings.antispam)) {
      settings.antispam = { enabled: false, message_count: 5, time_window: 10 };
    }
    return settings.antispam;
  }
  if (create) {
    settings.moderation ||= {};
    settings.moderation.forbiddenWords ||= { enabled: false, list: [] };
  }
  return settings.moderation?.forbiddenWords;
}

function mirrorStored(settings, stored, patch) {
  const next = settings;
  next.moderationPolicy = stored;
  if (patch && Object.prototype.hasOwnProperty.call(patch, "limit")) {
    ensureWarn(next).max_warnings = stored.limit;
  }
  if (patch && Object.prototype.hasOwnProperty.call(patch, "limitAction")) {
    ensureWarn(next).action = stored.limitAction;
  }
  if (patch?.features) {
    for (const [feature, action] of Object.entries(patch.features)) {
      const bucket = featureBucket(next, feature, action != null);
      if (!bucket) continue;
      if (action == null) delete bucket.action;
      else bucket.action = action;
    }
  }
  return next;
}

function stripEnforcement(settings) {
  delete settings.moderationPolicy;
  if (isPlainObject(settings.warn_system)) {
    delete settings.warn_system.action;
    delete settings.warn_system.max_warnings;
  }
  for (const feature of FEATURES) {
    const bucket = featureBucket(settings, feature, false);
    if (bucket) delete bucket.action;
  }
  return settings;
}

function projectPreset(settings, name) {
  const preset = String(name || "").trim().toLowerCase();
  if (preset === "standard") return stripEnforcement(settings);
  const patch = preset === "relaxed" ? RELAXED : preset === "strict" ? STRICT : null;
  if (!patch) {
    throw new ModerationPolicyError([
      error("moderation_preset", "enum", "moderation_preset must be relaxed, standard, or strict"),
    ]);
  }
  const bare = { ...settings };
  delete bare.moderationPolicy;
  const validated = validateModerationPolicy(patch, bare);
  if (!validated.ok) throw new ModerationPolicyError(validated.errors);
  stripEnforcement(settings);
  return mirrorStored(settings, validated.stored, patch);
}

function applyModerationPolicy(groupId, patch) {
  const current = getGroupSettings(groupId) || {};
  const validated = validateModerationPolicy(patch, current);
  if (!validated.ok) throw new ModerationPolicyError(validated.errors);
  const settings = mirrorStored(current, validated.stored, patch);
  saveGroupSettings(groupId, settings);
  return { effective: validated.effective, settings };
}

function applyModerationPreset(groupId, name) {
  const current = getGroupSettings(groupId) || {};
  const settings = projectPreset(current, name);
  saveGroupSettings(groupId, settings);
  const effective = resolveModerationPolicy(settings);
  return { effective, settings };
}

function readModerationPolicy(groupId) {
  return describeModerationPolicy(getGroupSettings(groupId) || {});
}

function describeModerationPolicy(settings) {
  const source = isPlainObject(settings) ? settings : {};
  const stored = isPlainObject(source.moderationPolicy) ? source.moderationPolicy : {};
  const effective = resolveModerationPolicy(source);
  return { effective, stored, visibility: policyFieldVisibility(effective) };
}

function cloneSettings(settings) {
  try {
    return JSON.parse(JSON.stringify(settings || {}));
  } catch {
    return {};
  }
}

function normalizeLegacyAction(raw, allowDelete) {
  const action = String(raw || "").trim().toUpperCase();
  if (action === "NONE") return "FLAG";
  if (action === "FLAG" || action === "KICK") return action;
  if (action === "WARN") return "WARN";
  if (allowDelete && action === "DELETE") return "DELETE";
  return null;
}

function collectPolicyInputs(body) {
  const errors = [];
  const source = isPlainObject(body) ? body : {};
  const hasPolicy = Object.prototype.hasOwnProperty.call(source, "moderation_policy");
  const hasPreset = Object.prototype.hasOwnProperty.call(source, "moderation_preset");
  if (hasPreset && hasPolicy) {
    errors.push(
      error("moderation_preset", "conflict", "moderation_preset and moderation_policy cannot both be set"),
    );
  }
  let preset = null;
  if (hasPreset && !hasPolicy) {
    preset = String(source.moderation_preset || "").trim().toLowerCase();
    if (!PRESET_NAMES.includes(preset)) {
      errors.push(
        error("moderation_preset", "enum", "moderation_preset must be relaxed, standard, or strict"),
      );
      preset = null;
    }
  }
  let policy = {};
  if (hasPolicy) {
    if (!isPlainObject(source.moderation_policy)) {
      errors.push(error("moderation_policy", "type", "moderation_policy must be an object"));
    } else policy = source.moderation_policy;
  }

  const legacy = {};
  if (source.warn_system && Object.prototype.hasOwnProperty.call(source.warn_system, "max_warnings")) {
    const max = source.warn_system.max_warnings;
    if (!isInteger(max)) legacy.limitError = error("warn_system.max_warnings", "type", "max_warnings must be an integer from 1 to 50");
    else if (max < 1 || max > 50) {
      legacy.limitError = error("warn_system.max_warnings", "range", "max_warnings must be between 1 and 50");
    } else legacy.limit = max;
  }
  if (source.warn_system && Object.prototype.hasOwnProperty.call(source.warn_system, "action")) {
    const action = normalizeLegacyAction(source.warn_system.action, false);
    if (!action || action === "WARN" || action === "DELETE") {
      legacy.limitActionError = error("warn_system.action", "enum", "Unknown warn action");
    } else legacy.limitAction = action;
  }
  const featureSources = [
    ["antilink", source.antilink?.action, Object.prototype.hasOwnProperty.call(source.antilink || {}, "action"), true],
    ["media", source.media_control?.action, Object.prototype.hasOwnProperty.call(source.media_control || {}, "action"), true],
    ["forbidden", source.forbidden_words?.action, Object.prototype.hasOwnProperty.call(source.forbidden_words || {}, "action"), true],
    ["antispam", source.antispam?.action, Object.prototype.hasOwnProperty.call(source.antispam || {}, "action"), false],
  ];
  for (const [feature, raw, present, allowDelete] of featureSources) {
    if (!present) continue;
    const action = normalizeLegacyAction(raw, allowDelete);
    const allowed = allowDelete ? "DELETE, WARN, KICK" : "WARN, KICK";
    if (!action || (feature !== "antispam" && action === "FLAG") || (feature === "antispam" && action === "DELETE")) {
      legacy[`${feature}Error`] = error(
        feature === "forbidden" ? "forbidden_words.action" : `${feature}.action`,
        "enum",
        `Unknown ${feature} action. Available: ${allowed}`,
      );
    } else {
      legacy.features ||= {};
      legacy.features[feature] = action === "FLAG" ? null : action;
    }
  }

  if (legacy.limitError) errors.push(legacy.limitError);
  if (legacy.limitActionError) errors.push(legacy.limitActionError);
  for (const feature of FEATURES) {
    if (legacy[`${feature}Error`]) errors.push(legacy[`${feature}Error`]);
  }

  const patch = hasPolicy ? { ...policy } : {};
  if (isPlainObject(policy.features)) patch.features = { ...policy.features };
  if (isPlainObject(policy.weights)) patch.weights = { ...policy.weights };
  if (isPlainObject(policy.decay)) patch.decay = { ...policy.decay };
  if (isPlainObject(policy.flag)) patch.flag = { ...policy.flag };

  const disagree = (field, left, right) => {
    errors.push(error(field, "conflict", `${field} is set to two different values`));
    return left !== right;
  };
  if (legacy.limit !== undefined) {
    if (patch.limit !== undefined && patch.limit !== legacy.limit) disagree("limit", patch.limit, legacy.limit);
    else patch.limit = legacy.limit;
  }
  if (legacy.limitAction !== undefined) {
    if (patch.limitAction !== undefined && canonEnum(String(patch.limitAction), LIMIT_ACTIONS) !== legacy.limitAction) {
      disagree("limitAction", patch.limitAction, legacy.limitAction);
    } else patch.limitAction = legacy.limitAction;
  }
  if (legacy.features) {
    patch.features ||= {};
    for (const [feature, action] of Object.entries(legacy.features)) {
      const current = patch.features[feature];
      if (current !== undefined && canonEnum(String(current), FEATURE_ACTIONS.concat(SPAM_ACTIONS)) !== action && current !== action) {
        disagree(`features.${feature}`, current, action);
      } else patch.features[feature] = action;
    }
  }

  const legacyPresent =
    legacy.limit !== undefined ||
    legacy.limitAction !== undefined ||
    (legacy.features && Object.keys(legacy.features).length > 0);
  if (hasPreset && legacyPresent) {
    errors.push(
      error("moderation_preset", "conflict", "moderation_preset and a legacy action cannot both be set"),
    );
  }
  const present = hasPolicy || hasPreset || legacyPresent;
  return { errors, present, preset, patch, hasPolicy };
}

function prepareGroupModeration(settings, body) {
  const inputs = collectPolicyInputs(body);
  if (inputs.errors.length) return { ok: false, errors: inputs.errors };
  if (!inputs.present) return { ok: true, kind: "none" };
  if (inputs.preset) return { ok: true, kind: "preset", preset: inputs.preset };
  const validated = validateModerationPolicy(inputs.patch, settings || {});
  if (!validated.ok) return { ok: false, errors: validated.errors };
  return {
    ok: true,
    kind: "patch",
    patch: inputs.patch,
    stored: validated.stored,
    effective: validated.effective,
    visibility: validated.visibility,
  };
}

function commitPreparedModeration(settings, prepared) {
  if (!prepared || prepared.kind === "none") return settings;
  if (prepared.kind === "preset") return projectPreset(settings, prepared.preset);
  return mirrorStored(settings, prepared.stored, prepared.patch);
}

function looseStored(base, patch) {
  const stored = cleanStored(base?.moderationPolicy);
  if (!isPlainObject(patch)) return stored;
  const merged = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (!TOP_KEYS.includes(key)) continue;
    if (key === "features" || key === "weights" || key === "decay" || key === "flag") {
      if (!isPlainObject(value)) continue;
      merged[key] = { ...(isPlainObject(stored[key]) ? stored[key] : {}), ...value };
    } else merged[key] = value;
  }
  return cleanStored(merged);
}

function evaluateModerationDraft(body) {
  const base = isPlainObject(body) ? cloneSettings(body) : {};
  delete base.moderation_policy;
  delete base.moderation_preset;
  const inputs = collectPolicyInputs(body);
  if (inputs.preset && !inputs.errors.length) {
    const settings = projectPreset(cloneSettings(base), inputs.preset);
    const described = describeModerationPolicy(settings);
    return { settings, ...described, errors: [] };
  }
  if (!inputs.present || (inputs.errors.length && !inputs.hasPolicy && !inputs.patch)) {
    const described = describeModerationPolicy(base);
    return { settings: base, ...described, errors: inputs.errors };
  }
  const validated = validateModerationPolicy(inputs.patch || {}, base);
  if (!validated.ok) {
    const settings = { ...base, moderationPolicy: looseStored(base, inputs.patch) };
    const effective = resolveModerationPolicy(settings);
    return {
      settings,
      effective,
      stored: settings.moderationPolicy,
      visibility: policyFieldVisibility(effective),
      errors: inputs.errors.length ? inputs.errors : validated.errors,
    };
  }
  const settings = mirrorStored(cloneSettings(base), validated.stored, inputs.patch);
  return {
    settings,
    effective: validated.effective,
    stored: validated.stored,
    visibility: validated.visibility,
    errors: inputs.errors,
  };
}

const MS_DAY = 24 * 60 * 60 * 1000;

function eventPoints(event) {
  if (event && typeof event.points === "number" && Number.isInteger(event.points)) return event.points;
  return 1;
}

function ageDays(date, now) {
  const parsed = Date.parse(date);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((now - parsed) / MS_DAY);
}

function effectivePoints(events, policy, now = Date.now()) {
  const list = Array.isArray(events) ? events : [];
  const resolved = policy?.decay ? policy : resolveModerationPolicy(policy || {});
  const mode = resolved.decay?.mode || "off";
  const days = resolved.decay?.days || 30;
  let total = 0;
  for (const event of list) {
    const points = eventPoints(event);
    if (!event?.date || mode === "off") {
      total += points;
      continue;
    }
    const age = ageDays(event.date, now);
    if (age == null) {
      total += points;
      continue;
    }
    if (mode === "expire") {
      if (age < days) total += points;
      continue;
    }
    if (mode === "step") total += Math.max(0, points - Math.floor(age / days));
  }
  return total;
}

module.exports = {
  ModerationPolicyError,
  resolveModerationPolicy,
  validateModerationPolicy,
  policyFieldVisibility,
  applyModerationPolicy,
  applyModerationPreset,
  readModerationPolicy,
  describeModerationPolicy,
  prepareGroupModeration,
  commitPreparedModeration,
  evaluateModerationDraft,
  effectivePoints,
  PRESET_NAMES,
};
