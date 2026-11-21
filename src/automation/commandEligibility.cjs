// Which commands a reaction may invoke in 5.0.1. A missing key is unsupported.
// Mutation forms of a show-only command are rejected by validateArgs, not by a
// second catalog key. The table is the classification source for the API.
const { localize } = require("../utils/commandDocs.cjs");
const catalog = require("../i18n/catalog.generated.cjs");

const TYPES = ["text", "voice", "audio", "image", "video", "document", "sticker"];
const ALL_TRANSITIONS = ["add", "change", "remove"];
const LANGS = ["en", "ar", "pt-BR", "es-419"];
const LINE = /^[^\r\n]*$/;

const none = (extra = {}) => ({
  mode: "none",
  originalTypes: TYPES,
  transitions: ALL_TRANSITIONS,
  ...extra,
});
const quote = (originalTypes = TYPES, extra = {}) => ({
  mode: "quote",
  quote: true,
  originalTypes,
  transitions: ALL_TRANSITIONS,
  ...extra,
});
const args = (fields, extra = {}) => ({
  mode: "args",
  fields,
  originalTypes: TYPES,
  transitions: ALL_TRANSITIONS,
  ...extra,
});
const unsupported = (reason) => ({
  mode: "unsupported",
  reason,
  originalTypes: [],
  transitions: [],
});
const destructive = (originalTypes = TYPES) =>
  quote(originalTypes, { destructive: true, transitions: ["add"] });

const FIELD = {
  prompt: { id: "prompt", maxLength: 2000, required: true },
  city: { id: "city", maxLength: 80, required: true },
  qr: { id: "text", maxLength: 500, required: true },
  language: { id: "language", maxLength: 32, required: false },
  status: { id: "status", maxLength: 16, required: true, pattern: "^status$" },
  keyword: { id: "keyword", maxLength: 41, required: true, pattern: "^#[A-Za-z0-9_]{1,40}$" },
};

// First words that select a gemini management branch. ask/ai name the command.
const GEMINI_RESERVED = new Set([
  "add",
  "send",
  "show",
  "clear",
  "del",
  "delall",
  "resetai",
  "generate",
]);

function geminiReserved(word) {
  if (GEMINI_RESERVED.has(word)) return true;
  const aliases = require("../config/runtime-config.cjs").getAliases("gemini", [
    "ask",
    "ai",
    "resetai",
    "del",
    "delall",
    "generate",
  ]);
  return aliases.some((alias) => {
    const name = String(alias).toLowerCase();
    return name === word && GEMINI_RESERVED.has(name);
  });
}

const TABLE = {
  help: none(),
  lang: none(),
  listschedules: none(),
  ping: none(),
  rand: none(),
  status: none(),
  update: none(),
  autodelete: none(),
  perm: none(),
  setprefix: none(),
  "group:all": none(),
  "group:antispam": none(),
  "group:approveall": none(),
  "group:flagged": none(),
  "group:members": none(),
  "group:policy": none(),
  "group:rules": none(),
  "group:tagadmins": none(),

  calc: quote(),
  digit: quote(),
  md: quote(),
  send: quote(),
  shortlink: quote(),
  stt: quote(["voice"]),
  toimage: quote(["sticker"]),
  tts: quote(),
  "group:kick": destructive(),

  gemini: args([FIELD.prompt], { quote: true }),
  "group:note": args([FIELD.keyword]),
  prayer: args([FIELD.city]),
  weather: args([FIELD.city]),
  qr: args([FIELD.qr]),
  translate: args([FIELD.language], { quote: true }),
  mod: args([FIELD.status]),

  block: unsupported("SESSION_OR_ACCOUNT_ACTION"),
  unblock: unsupported("SESSION_OR_ACCOUNT_ACTION"),
  restart: unsupported("SESSION_OR_ACCOUNT_ACTION"),
  stopbot: unsupported("SESSION_OR_ACCOUNT_ACTION"),
  "group:antilink": unsupported("SETTINGS_CHANGE"),
  "group:media": unsupported("SETTINGS_CHANGE"),
  "group:welcome": unsupported("SETTINGS_CHANGE"),
  "group:setname": unsupported("SETTINGS_CHANGE"),
  "group:setrules": unsupported("SETTINGS_CHANGE"),
  "group:setwarn": unsupported("SETTINGS_CHANGE"),
  "group:add": unsupported("SETTINGS_CHANGE"),
  schedule: unsupported("DURABLE_JOB"),
  autoschedule: unsupported("DURABLE_JOB"),
  deleteschedule: unsupported("DURABLE_JOB"),
  group: unsupported("WRAPPER"),
  notes: unsupported("KNOWN_DEFECT"),
  score: unsupported("KNOWN_DEFECT"),
  "group:setpp": unsupported("KNOWN_DEFECT"),
  "group:warn": unsupported("KNOWN_DEFECT"),
  "group:warns": unsupported("KNOWN_DEFECT"),
  debt: unsupported("KNOWN_DEFECT"),
  memory: unsupported("REQUESTER_SCOPE"),
  todo: unsupported("REQUESTER_SCOPE"),
  packs: unsupported("REQUESTER_SCOPE"),
  stickers: unsupported("REQUESTER_SCOPE"),
  sticker: unsupported("NOT_IN_5_0_1"),
  "group:promote": unsupported("NOT_IN_5_0_1"),
  "group:demote": unsupported("NOT_IN_5_0_1"),
  "group:clearwarns": unsupported("NOT_IN_5_0_1"),
  poll: unsupported("NOT_IN_5_0_1"),
  loop: unsupported("NOT_IN_5_0_1"),
  pack: unsupported("NOT_IN_5_0_1"),
  blacklist: unsupported("NOT_IN_5_0_1"),
  "group:deletenote": unsupported("NOT_IN_5_0_1"),
  "group:save": unsupported("NOT_IN_5_0_1"),
  "group:removeall": unsupported("NOT_IN_5_0_1"),
};

const SETTINGS_ARGS = new Set([
  "setprefix",
  "perm",
  "autodelete",
  "lang",
  "memory",
  "todo",
  "group:approveall",
  "status",
]);

function classify(key) {
  if (typeof key !== "string" || !Object.hasOwn(TABLE, key)) {
    return unsupported("UNCLASSIFIED");
  }
  return TABLE[key];
}

function validateArgs(key, args) {
  const spec = classify(key);
  const errors = [];
  const fail = (code = "invalid") => errors.push({ field: "definition.command.args", code });
  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    fail();
    return { ok: false, errors };
  }
  if (spec.mode === "unsupported") {
    errors.push({ field: "definition.command.name", code: spec.reason || "UNCLASSIFIED" });
    return { ok: false, errors };
  }
  if (spec.mode === "none" || spec.mode === "quote") {
    if (args.length) fail(SETTINGS_ARGS.has(key) ? "SETTINGS_CHANGE" : "invalid");
    return { ok: errors.length === 0, errors };
  }
  const fields = spec.fields || [];
  if (args.length > fields.length) fail();
  fields.forEach((field, index) => {
    const value = args[index];
    if (value == null || value === "") {
      if (field.required) fail("required");
      return;
    }
    if (!LINE.test(value) || value.length > field.maxLength) fail();
    if (field.pattern && !new RegExp(field.pattern).test(value)) fail();
  });
  if (errors.length === 0 && key === "gemini" && typeof args[0] === "string") {
    const word = args[0].trim().split(/\s+/)[0].toLowerCase();
    if (geminiReserved(word)) fail();
  }
  return { ok: errors.length === 0, errors };
}

function descriptionFor(key, lang, provided) {
  if (provided && typeof provided === "object") return localize(provided, lang);
  const messageKey = key.startsWith("group:")
    ? `commands.group.${key.slice(6)}.description`
    : `commands.${key}.description`;
  const value = {};
  for (const code of LANGS) {
    const text = catalog.messages?.[code]?.[messageKey];
    if (typeof text === "string") value[code] = text;
  }
  return localize(value, lang);
}

function listReactionCommands(entries, lang = "en") {
  const rows =
    Array.isArray(entries) && entries.length
      ? entries
      : Object.keys(TABLE).map((key) => ({
          key,
          name: key.startsWith("group:") ? key.slice(6) : key,
        }));
  return rows.map((entry) => {
    const key = entry.key;
    const spec = classify(key);
    return {
      key,
      name: entry.name || (key.startsWith("group:") ? key.slice(6) : key),
      description: descriptionFor(key, lang, entry.descriptions || entry.description),
      mode: spec.mode,
      fields: spec.fields || [],
      originalTypes: spec.originalTypes || [],
      destructive: spec.destructive === true,
      transitions: spec.transitions || [],
      quote: spec.quote === true || spec.mode === "quote",
      reason: spec.reason || null,
    };
  });
}

module.exports = {
  TYPES,
  classify,
  validateArgs,
  listReactionCommands,
};
