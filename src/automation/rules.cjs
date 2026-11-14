// Internal configuration contract. No executable expressions or command arguments.
const { canonicalJid } = require("../messaging/router.cjs");
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const TYPES = ["text", "voice", "audio", "image", "video", "document", "sticker"];
function invalid() {
  throw new Error("REACTION_RULE_INVALID");
}
function exactJid(value, userOnly = false) {
  if (
    typeof value !== "string" ||
    !/^\d{1,30}@(s\.whatsapp\.net|lid|g\.us)$/.test(value) ||
    canonicalJid(value) !== value ||
    (userOnly && value.endsWith("@g.us"))
  )
    invalid();
  return value;
}
function isReactionEmoji(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 32 &&
    /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\uFE0F|\u200D|\u20E3|[#*0-9])+$/u.test(
      value,
    ) &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value) &&
    [...segmenter.segment(value)].length === 1
  );
}
function definitionIssues(value) {
  const issues = [];
  const add = (field, code = "invalid") => issues.push({ field, code });
  const object = (item, field, keys) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      add(field);
      return false;
    }
    for (const key of Object.keys(item))
      if (!keys.includes(key)) add(`${field}.${key}`, "unknown_field");
    return true;
  };
  const list = (item, field, allowed) => {
    if (!Array.isArray(item)) return add(field);
    if (!item.length || item.some((entry) => !allowed.includes(entry))) add(field);
    if (item.length > allowed.length) add(field, "too_many");
    if (new Set(item).size !== item.length) add(field, "duplicate");
  };
  if (
    !object(value, "definition", [
      "version",
      "emoji",
      "transitions",
      "originalTypes",
      "senders",
      "action",
      "destination",
    ])
  )
    return issues;
  if (value.version !== 1) add("definition.version");
  if (!isReactionEmoji(value.emoji)) add("definition.emoji");
  list(value.transitions, "definition.transitions", ["add", "change", "remove"]);
  list(value.originalTypes, "definition.originalTypes", TYPES);
  if (object(value.senders, "definition.senders", ["role", "ids"])) {
    if (!["any", "owner", "bot_admin", "group_admin", "member"].includes(value.senders.role))
      add("definition.senders.role");
    const ids = value.senders.ids;
    if (!Array.isArray(ids)) add("definition.senders.ids");
    else {
      if (ids.length > 100) add("definition.senders.ids", "too_many");
      if (new Set(ids).size !== ids.length) add("definition.senders.ids", "duplicate");
      for (const id of ids) {
        try {
          exactJid(id, true);
        } catch {
          add("definition.senders.ids");
          break;
        }
      }
    }
  }
  if (!["stt", "ping"].includes(value.action)) add("definition.action");
  if (
    value.action === "stt" &&
    (!Array.isArray(value.originalTypes) ||
      value.originalTypes.length !== 1 ||
      value.originalTypes[0] !== "voice")
  )
    add("definition.originalTypes", "voice_only");
  if (
    object(value.destination, "definition.destination", ["mode"]) &&
    !["same_chat", "owner_private"].includes(value.destination.mode)
  )
    add("definition.destination.mode");
  if (!issues.length) {
    try {
      structuredClone(value);
    } catch {
      add("definition");
    }
  }
  return issues;
}
function validateDefinition(value) {
  if (definitionIssues(value).length) invalid();
  return structuredClone(value);
}
function originalType(original) {
  const msg = original?.message || {};
  if (msg.audioMessage) return msg.audioMessage.ptt === true ? "voice" : "audio";
  if (msg.conversation != null || msg.extendedTextMessage) return "text";
  return ["image", "video", "document", "sticker"].find((type) => msg[`${type}Message`]) || null;
}
module.exports = { definitionIssues, validateDefinition, exactJid, originalType, isReactionEmoji };
