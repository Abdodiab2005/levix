import { equal, finish, ok, require, section, throws, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-reaction-rule-issues");
const { definitionIssues, validateDefinition } = require("./src/automation/rules.cjs");
const { canonicalJid } = require("./src/messaging/router.cjs");

// Frozen 07b validator from 7a6e532. Keep independent of the new validator.
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
function oldValidateDefinition(value) {
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

function definition(patch = {}) {
  return {
    version: 1,
    emoji: "😀",
    transitions: ["add", "change", "remove"],
    originalTypes: ["text"],
    senders: { role: "any", ids: [] },
    action: "ping",
    destination: { mode: "same_chat" },
    ...patch,
  };
}
function accepts(fn, value) {
  try {
    fn(value);
    return true;
  } catch {
    return false;
  }
}
function parity(label, value) {
  const expected = accepts(oldValidateDefinition, value);
  equal(`${label}: issues parity`, definitionIssues(value).length === 0, expected);
  equal(`${label}: throwing validator parity`, accepts(validateDefinition, value), expected);
}

section("07b validator vectors");
const group = "120363700000001@g.us";
const vectors = [
  { version: 2 },
  { emoji: "hello" },
  { emoji: "😀😀" },
  { transitions: [] },
  { transitions: ["add", "add"] },
  { transitions: ["execute"] },
  { originalTypes: ["unknown"] },
  { action: "shell" },
  { action: "gemini" },
  { action: "stt" },
  { destination: { mode: "authorized_chat", jid: group } },
  { destination: { mode: "same_chat", url: "https://example.invalid" } },
  { senders: { role: "owner", ids: ["201070000002"] } },
  { senders: { role: "any", ids: [group] } },
  { senders: { role: "root", ids: [] } },
  { code: "process.exit()" },
  { arguments: "!kick @all" },
];
parity("base", definition());
for (const [index, patch] of vectors.entries()) parity(`07b rejected ${index}`, definition(patch));
for (const value of ["👍🏽", "👨‍👩‍👧", "🇧🇷", "1️⃣", "❤️"])
  parity(`single grapheme ${value}`, definition({ emoji: value }));
for (const role of ["any", "owner", "bot_admin", "group_admin", "member"])
  parity(`sender role ${role}`, definition({ senders: { role, ids: ["1001@lid"] } }));
parity("voice STT", definition({ action: "stt", originalTypes: ["voice"] }));
parity("owner destination", definition({ destination: { mode: "owner_private" } }));
for (const value of [null, undefined, 1, true, "rule", [], {}]) parity(`root ${value}`, value);

section("generated definition mutations");
const paths = [
  ["version"],
  ["emoji"],
  ["transitions"],
  ["originalTypes"],
  ["senders"],
  ["senders", "role"],
  ["senders", "ids"],
  ["action"],
  ["destination"],
  ["destination", "mode"],
  ["unknown"],
];
const values = [
  undefined,
  null,
  false,
  0,
  1,
  2,
  "",
  "😀",
  "😀😀",
  "x".repeat(33),
  "ping",
  "stt",
  "any",
  "owner",
  "same_chat",
  "owner_private",
  [],
  {},
  ["add"],
  ["change", "remove"],
  ["add", "add"],
  ["add", "change", "remove", "extra"],
  ["text"],
  ["voice"],
  ["voice", "audio"],
  TYPES,
  ["text", "text"],
  ["1001@lid"],
  ["1001@lid", "1001@lid"],
  [group],
  ["1:7@s.whatsapp.net"],
  ["1@newsletter"],
  ["1@lid@evil"],
  [`${"1".repeat(31)}@lid`],
  { role: "any", ids: [] },
  { mode: "same_chat" },
  Array.from({ length: 100 }, (_, i) => `${i + 1}@lid`),
  Array.from({ length: 101 }, (_, i) => `${i + 1}@lid`),
];
let seed = 0x07c;
function random(max) {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % max;
}
for (let index = 0; index < 768; index++) {
  const value = definition(index % 2 ? { action: "stt", originalTypes: ["voice"] } : {});
  for (let mutation = 0; mutation < 1 + (index % 3); mutation++) {
    const path = paths[random(paths.length)];
    const target = path.length === 1 ? value : value[path[0]];
    if (target && typeof target === "object" && !Array.isArray(target)) {
      if (random(5) === 0) delete target[path.at(-1)];
      else target[path.at(-1)] = structuredClone(values[random(values.length)]);
    }
  }
  parity(`generated ${index}`, value);
}
const sparseTransitions = ["add", "change", "remove"];
delete sparseTransitions[1];
parity("sparse transition array", definition({ transitions: sparseTransitions }));
const uncloneable = definition();
uncloneable.transitions.extra = () => {};
parity("uncloneable array property", uncloneable);

section("field issues and fixed codes");
const cases = [
  [null, "definition", "invalid"],
  [definition({ version: 2 }), "definition.version", "invalid"],
  [definition({ emoji: "x" }), "definition.emoji", "invalid"],
  [definition({ transitions: [] }), "definition.transitions", "invalid"],
  [definition({ transitions: ["add", "add"] }), "definition.transitions", "duplicate"],
  [
    definition({ transitions: ["add", "change", "remove", "extra"] }),
    "definition.transitions",
    "too_many",
  ],
  [definition({ originalTypes: [] }), "definition.originalTypes", "invalid"],
  [definition({ action: "stt" }), "definition.originalTypes", "voice_only"],
  [definition({ senders: null }), "definition.senders", "invalid"],
  [definition({ senders: { role: "root", ids: [] } }), "definition.senders.role", "invalid"],
  [definition({ senders: { role: "any", ids: [group] } }), "definition.senders.ids", "invalid"],
  [
    definition({ senders: { role: "any", ids: ["1@lid", "1@lid"] } }),
    "definition.senders.ids",
    "duplicate",
  ],
  [
    definition({ senders: { role: "any", ids: values.at(-1) } }),
    "definition.senders.ids",
    "too_many",
  ],
  [definition({ action: "shell" }), "definition.action", "invalid"],
  [definition({ destination: null }), "definition.destination", "invalid"],
  [definition({ destination: { mode: "group" } }), "definition.destination.mode", "invalid"],
  [definition({ code: "arbitrary" }), "definition.code", "unknown_field"],
  [
    definition({ destination: { mode: "same_chat", url: "arbitrary" } }),
    "definition.destination.url",
    "unknown_field",
  ],
];
for (const [value, field, code] of cases) {
  ok(
    `${field}/${code}`,
    definitionIssues(value).some((issue) => issue.field === field && issue.code === code),
  );
  equal(
    "invalid validator error stays fixed",
    throws(field, () => validateDefinition(value))?.message,
    "REACTION_RULE_INVALID",
  );
}
const input = definition();
const before = JSON.stringify(input);
equal("valid has no issues", definitionIssues(input).length, 0);
equal("issues do not mutate input", JSON.stringify(input), before);
validateDefinition(input).senders.ids.push("1@lid");
equal("validator still returns a clone", input.senders.ids.length, 0);
finish();
