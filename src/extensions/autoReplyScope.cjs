// Core-owned Auto Reply scope normalization and eligibility predicate.
// Accepts either a legacy JID array/Set (mode "only") or a v1 scope descriptor
// { mode, groupsEnabled, chats, excluded }. Malformed shapes fail closed to an
// empty "only" descriptor — never wider.

const normalizeJid = require("../utils/normalizeJid.cjs");

const VALID_MODES = new Set(["all", "except", "only"]);

const EMPTY_SCOPE = Object.freeze({
  mode: "only",
  groupsEnabled: false,
  chats: Object.freeze([]),
  excluded: Object.freeze([]),
});

function extractStringArray(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) return null;
    out.push(item);
  }
  return out;
}

function normalizeScope(raw) {
  if (!raw) return EMPTY_SCOPE;
  if (Array.isArray(raw) || raw instanceof Set) {
    const items = Array.isArray(raw) ? raw : [...raw];
    const chats = [];
    for (const jid of items) {
      if (typeof jid !== "string" || !jid.trim()) return EMPTY_SCOPE;
      chats.push(jid);
    }
    return Object.freeze({
      mode: "only",
      groupsEnabled: true,
      chats: Object.freeze(chats),
      excluded: Object.freeze([]),
    });
  }
  if (typeof raw !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) {
    return EMPTY_SCOPE;
  }
  const mode = raw.mode;
  if (typeof mode !== "string" || !VALID_MODES.has(mode)) return EMPTY_SCOPE;
  if (typeof raw.groupsEnabled !== "boolean") return EMPTY_SCOPE;

  let chats = [];
  if (raw.chats !== undefined) {
    const parsed = extractStringArray(raw.chats);
    if (!parsed) return EMPTY_SCOPE;
    chats = parsed;
  } else if (mode === "only") {
    return EMPTY_SCOPE;
  }

  let excluded = [];
  if (raw.excluded !== undefined) {
    const parsed = extractStringArray(raw.excluded);
    if (!parsed) return EMPTY_SCOPE;
    excluded = parsed;
  } else if (mode === "except") {
    return EMPTY_SCOPE;
  }

  for (const key of Object.keys(raw)) {
    if (key !== "mode" && key !== "groupsEnabled" && key !== "chats" && key !== "excluded") {
      return EMPTY_SCOPE;
    }
  }

  return Object.freeze({
    mode,
    groupsEnabled: raw.groupsEnabled,
    chats: Object.freeze(chats),
    excluded: Object.freeze(excluded),
  });
}

function isChatEligible(chatJid, rawScope) {
  if (typeof chatJid !== "string" || !chatJid) return false;
  const norm = normalizeJid(chatJid);
  if (
    !norm ||
    norm === "status@broadcast" ||
    norm.endsWith("@broadcast") ||
    norm.endsWith("@newsletter")
  ) {
    return false;
  }
  const isGroup = norm.endsWith("@g.us");
  if (!isGroup && !norm.endsWith("@s.whatsapp.net") && !norm.endsWith("@lid")) {
    return false;
  }
  const scope = normalizeScope(rawScope);
  if (isGroup && !scope.groupsEnabled) return false;
  if (scope.mode === "all") return true;
  if (scope.mode === "only") {
    return scope.chats.some((jid) => normalizeJid(jid) === norm);
  }
  if (scope.mode === "except") {
    return !scope.excluded.some((jid) => normalizeJid(jid) === norm);
  }
  return false;
}

module.exports = {
  EMPTY_SCOPE,
  normalizeScope,
  isChatEligible,
  inScope: isChatEligible,
};
