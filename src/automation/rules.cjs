// Internal configuration contract. No executable expressions or command arguments.
const { canonicalJid } = require("../messaging/router.cjs");
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });
const TYPES = ["text", "voice", "audio", "image", "video", "document", "sticker"];
function invalid() {
  throw new Error("REACTION_RULE_INVALID");
}
function object(value, keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
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
function emoji(value) {
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
function list(value, allowed) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > allowed.length ||
    new Set(value).size !== value.length ||
    value.some((item) => !allowed.includes(item))
  )
    invalid();
}
function validateDefinition(value) {
  object(value, [
    "version",
    "emoji",
    "transitions",
    "originalTypes",
    "senders",
    "action",
    "destination",
  ]);
  if (value.version !== 1 || !emoji(value.emoji)) invalid();
  list(value.transitions, ["add", "change", "remove"]);
  list(value.originalTypes, TYPES);
  object(value.senders, ["role", "ids"]);
  if (!["any", "owner", "bot_admin", "group_admin", "member"].includes(value.senders.role))
    invalid();
  const ids = value.senders.ids;
  if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length) invalid();
  for (const id of ids) exactJid(id, true);
  if (
    !["stt", "ping"].includes(value.action) ||
    (value.action === "stt" &&
      (value.originalTypes.length !== 1 || value.originalTypes[0] !== "voice"))
  )
    invalid();
  object(value.destination, ["mode"]);
  if (!["same_chat", "owner_private"].includes(value.destination.mode)) invalid();
  return structuredClone(value);
}
function originalType(original) {
  const msg = original?.message || {};
  if (msg.audioMessage) return msg.audioMessage.ptt === true ? "voice" : "audio";
  if (msg.conversation != null || msg.extendedTextMessage) return "text";
  return ["image", "video", "document", "sticker"].find((type) => msg[`${type}Message`]) || null;
}
module.exports = { validateDefinition, exactJid, originalType };
