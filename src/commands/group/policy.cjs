const { getGroupSettings } = require("../../utils/storage.cjs");
const { buildModerationSummary } = require("../../utils/moderationSummary.cjs");
const { t, currentLang } = require("../../utils/i18n.cjs");
const {
  applyModerationPolicy,
  applyModerationPreset,
} = require("../../services/moderationPolicy.cjs");

const ENUMS = {
  mode: ["simple", "severity"],
  limitaction: ["KICK", "FLAG"],
  decay: ["off", "expire", "step"],
  membership: ["keep", "clear"],
  merge: ["max", "sum"],
  notify: ["group", "silent"],
  flagged: ["record", "hold", "escalate"],
  preset: ["relaxed", "standard", "strict"],
  "action.antilink": ["DELETE", "WARN", "KICK"],
  "action.media": ["DELETE", "WARN", "KICK"],
  "action.forbidden": ["DELETE", "WARN", "KICK"],
  "action.antispam": ["WARN", "KICK"],
};

const INTS = {
  limit: ["limit", 1, 50],
  decaydays: ["decay.days", 1, 365],
  flagat: ["flagAt", 1, 49],
  kickat: ["kickAt", 2, 50],
  cooldown: ["flag.cooldownMinutes", 0, 10080],
  escalate: ["flag.escalateAfter", 1, 50],
};

const WEIGHTS = ["antilink", "media", "forbidden", "antispam", "manual"];
const ACTIONS = ["antilink", "media", "forbidden", "antispam"];

const FIELD_LIST = [
  "mode",
  "limit",
  "limitaction",
  "decay",
  "decaydays",
  "membership",
  "merge",
  "flagat",
  "kickat",
  ...WEIGHTS.map((name) => `weight.${name}`),
  ...ACTIONS.map((name) => `action.${name}`),
  "notify",
  "mention",
  "cooldown",
  "flagged",
  "escalate",
  "preset",
];

function assignPath(patch, path, value) {
  const parts = path.split(".");
  let cursor = patch;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cursor[parts[i]] ||= {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

function allowedReply(sock, groupId, allowed) {
  const list = allowed.join(", ");
  return sock.sendMessage(groupId, {
    text: t("bot.moderation.policy.invalidValueAvailable", { list }),
  });
}

function rangeReply(sock, groupId, min, max) {
  return sock.sendMessage(groupId, {
    text: t("bot.moderation.policy.giveAWholeNumberFrom", { min, max }),
  });
}

function policyErrorReply(sock, groupId, error) {
  const item = error?.errors?.[0];
  // The validator's detail is English only. Other languages get a generic line.
  // A catalog value of "{detail}" is rejected: placeholder sets must match.
  if (item?.code === "conflict") {
    const text =
      currentLang() === "en" ? item.message : t("bot.moderation.policy.conflictGeneric");
    return sock.sendMessage(groupId, { text });
  }
  const generic = t("bot.moderation.policy.valueNotAllowed");
  const text = currentLang() === "en" ? item?.message || generic : generic;
  return sock.sendMessage(groupId, { text });
}

function parsePatch(field, raw) {
  if (ENUMS[field]) {
    const canon = ENUMS[field].find((item) => item.toLowerCase() === raw.toLowerCase());
    if (!canon) return { error: "enum", allowed: ENUMS[field] };
    if (field === "preset") return { preset: canon.toLowerCase() };
    if (field === "limitaction") return { patch: { limitAction: canon } };
    if (field === "merge") return { patch: { hitMerge: canon.toLowerCase() } };
    if (field === "decay") return { patch: { decay: { mode: canon.toLowerCase() } } };
    if (field === "notify") return { patch: { flag: { notify: canon.toLowerCase() } } };
    if (field === "flagged") return { patch: { flag: { whileFlagged: canon.toLowerCase() } } };
    if (field.startsWith("action.")) {
      const feature = field.slice("action.".length);
      return { patch: { features: { [feature]: canon } } };
    }
    return { patch: { [field]: canon.toLowerCase() } };
  }
  if (INTS[field]) {
    const [path, min, max] = INTS[field];
    if (!/^-?\d+$/.test(raw)) return { error: "range", min, max };
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) return { error: "range", min, max };
    const patch = {};
    assignPath(patch, path, value);
    return { patch };
  }
  if (field.startsWith("weight.")) {
    const feature = field.slice("weight.".length);
    if (!WEIGHTS.includes(feature)) return { error: "field" };
    if (!/^-?\d+$/.test(raw)) return { error: "range", min: 1, max: 10 };
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 1 || value > 10) return { error: "range", min: 1, max: 10 };
    return { patch: { weights: { [feature]: value } } };
  }
  if (field === "mention") {
    const token = raw.toLowerCase();
    if (!["true", "false", "on", "off"].includes(token)) {
      return { error: "enum", allowed: ["true", "false", "on", "off"] };
    }
    return { patch: { flag: { mentionAdmins: token === "true" || token === "on" } } };
  }
  return { error: "field" };
}

module.exports = {
  name: "policy",
  chat: "group",
  userAdminRequired: true,

  async execute(sock, msg, args) {
    const groupId = msg.key.remoteJid;
    const sub = String(args[0] || "").toLowerCase();

    if (!sub) {
      const settings = getGroupSettings(groupId) || {};
      return sock.sendMessage(groupId, { text: buildModerationSummary(settings) });
    }

    if (sub === "reset") {
      try {
        applyModerationPreset(groupId, "standard");
      } catch (error) {
        return policyErrorReply(sock, groupId, error);
      }
      return sock.sendMessage(groupId, {
        text: t("bot.moderation.policy.moderationPolicyResetToStandard"),
      });
    }

    if (sub !== "set") {
      return sock.sendMessage(groupId, {
        text: t("bot.moderation.policy.wrongFormatUseGroupPolicy"),
      });
    }

    const field = String(args[1] || "").toLowerCase();
    const raw = args.slice(2).join(" ").trim();
    if (!field || !raw) {
      return sock.sendMessage(groupId, {
        text: t("bot.moderation.policy.nameAFieldAndA", { fields: FIELD_LIST.join(", ") }),
      });
    }

    const parsed = parsePatch(field, raw);
    if (parsed.error === "enum") return allowedReply(sock, groupId, parsed.allowed);
    if (parsed.error === "range") return rangeReply(sock, groupId, parsed.min, parsed.max);
    if (parsed.error) {
      return sock.sendMessage(groupId, {
        text: t("bot.moderation.policy.unknownFieldAvailable", { fields: FIELD_LIST.join(", ") }),
      });
    }

    try {
      if (parsed.preset) applyModerationPreset(groupId, parsed.preset);
      else applyModerationPolicy(groupId, parsed.patch);
    } catch (error) {
      return policyErrorReply(sock, groupId, error);
    }
    return sock.sendMessage(groupId, {
      text: t("bot.moderation.policy.isNow", { field, raw }),
    });
  },
};
