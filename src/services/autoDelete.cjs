// Keyword auto-delete: rules, matching, and the per-message delete hook.
//
// Keywords are stored and returned as entered: trimmed, NFC, internal
// whitespace collapsed. Matching uses a normalized form (NFKC, Arabic
// diacritics/alef/ya, lowercase, collapsed whitespace), derived on first
// match and memoized per cached rule object, next to the compiled word
// patterns. The store drops those objects on any write.
// De-duplication uses that normalized form and keeps the first spelling.
// Rows saved before this split are already normalized; normalization is
// idempotent, so they keep matching without a migration.
//
// The first enabled rule that matches wins. A message that invokes this
// command is exempt only when the sender may run it right now, so
// `!autodelete add x` cannot delete itself while a member writing
// `!autodelete <keyword>` still matches.

const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.cjs");
const { resolveGroupMetadata } = require("../utils/groupMetadataCache.cjs");
const { mediaType } = require("../utils/messageContent.cjs");
const store = require("../db/store.cjs");

const MAX_RULES = 100;
const MAX_KEYWORDS = 50;
const MAX_KEYWORD_CHARS = 100;
const MAX_NAME_CHARS = 60;
const MAX_SENDERS = 200;
const LOG_TEXT_MAX = 8000;
const DECLARED_ALIASES = ["ad", "حذف_تلقائي"];

const MATCH_MODES = new Set(["contains", "word", "exact"]);
const CHAT_SCOPES = new Set(["all", "groups", "private"]);
const SENDER_MODES = new Set(["everyone", "selected"]);

const TASHKEEL = /[\u064B-\u065F\u0670\u0640]/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g;
const ALEF_MAKSURA = /\u0649/g;
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

class AutoDeleteError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = "AutoDeleteError";
    this.status = status;
  }
}

function asBool(value, field) {
  if (typeof value === "boolean") return value;
  throw new AutoDeleteError(`${field} must be true or false`);
}

function escapeRegex(value) {
  return String(value).replace(REGEX_ESCAPE, "\\$&");
}

function wordPattern(keyword) {
  return new RegExp(
    `(?<![\\p{L}\\p{N}\\p{M}])${escapeRegex(keyword)}(?![\\p{L}\\p{N}\\p{M}])`,
    "u",
  );
}

// Normalized keywords and word-mode regexes, one entry per cached rule object.
// The store drops those objects when the rule cache is rebuilt (any write).
const matchIndexByRule = new WeakMap();

function compileWordPatterns(keywords) {
  return (keywords || []).map((keyword) => {
    try {
      return wordPattern(keyword);
    } catch {
      return null;
    }
  });
}

function indexRuleForMatch(rule) {
  const matchKeywords = (rule?.keywords || []).map((keyword) => normalizeMatchText(keyword));
  const patterns = rule?.match === "word" ? compileWordPatterns(matchKeywords) : null;
  const index = { matchKeywords, patterns };
  if (rule && typeof rule === "object") matchIndexByRule.set(rule, index);
  return index;
}

function matchIndexFor(rule) {
  if (rule && typeof rule === "object") {
    const cached = matchIndexByRule.get(rule);
    if (cached) return cached;
  }
  return indexRuleForMatch(rule);
}

/** Visible text ready to compare: NFKC, tashkeel/tatweel stripped, alef/ya unified. */
function normalizeMatchText(input) {
  let text = String(input ?? "");
  text = text.normalize("NFKC");
  text = text.replace(TASHKEEL, "");
  text = text.replace(ALEF_VARIANTS, "\u0627");
  text = text.replace(ALEF_MAKSURA, "\u064A");
  text = text.toLowerCase();
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

/** Spelling we store and show. Matching goes through normalizeMatchText. */
function displayKeyword(input) {
  return String(input ?? "")
    .normalize("NFC")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordMatches(normalizedText, keyword, mode, compiledPattern) {
  if (!normalizedText || !keyword) return false;
  if (mode === "exact") return normalizedText === keyword;
  if (mode === "word") {
    try {
      const re = compiledPattern || wordPattern(keyword);
      return re.test(normalizedText);
    } catch {
      return false;
    }
  }
  return normalizedText.includes(keyword);
}

function senderListMatches(list, candidates, sameUser) {
  if (!Array.isArray(list) || !list.length || !candidates?.length) return false;
  for (const candidate of candidates) {
    for (const entry of list) {
      if (sameUser(entry, candidate)) return true;
    }
  }
  return false;
}

function ruleMatches(rule, ctx) {
  if (!rule?.enabled) return false;
  if (ctx.fromMe && !rule.includeOwn) return false;
  if (rule.chatScope === "groups" && !ctx.isGroup) return false;
  if (rule.chatScope === "private" && ctx.isGroup) return false;
  if (rule.senders?.mode === "selected") {
    if (!senderListMatches(rule.senders.list, ctx.senderCandidates, ctx.sameUser)) return false;
  }
  const { matchKeywords, patterns } = matchIndexFor(rule);
  return matchKeywords.some((keyword, i) =>
    keywordMatches(ctx.normalizedText, keyword, rule.match, patterns ? patterns[i] : undefined),
  );
}

function chooseDeleteMode({ forEveryone, fromMe, isGroup, botIsAdmin }) {
  if (!forEveryone) return "deleteForMe";
  if (fromMe) return "revoke";
  if (isGroup && botIsAdmin) return "revoke";
  return "deleteForMe";
}

function looksLikeManagementCommand(body) {
  if (!body) return false;
  const runtimeConfig = require("../config/runtime-config.cjs");
  const prefix = runtimeConfig.getPrefix();
  if (!body.startsWith(prefix)) return false;
  const token = body.slice(prefix.length).trim().split(/\s+/)[0];
  if (!token) return false;
  const name = token.toLowerCase();
  if (name === "autodelete") return true;
  const aliases = runtimeConfig.getAliases("autodelete", DECLARED_ALIASES);
  return aliases.some((alias) => String(alias).toLowerCase() === name);
}

let resolveSenderFn = null;

async function loadResolveSender() {
  if (!resolveSenderFn) {
    const mod = await import("../middleware/permissions.middleware.js");
    resolveSenderFn = mod.resolveSender;
  }
  return resolveSenderFn;
}

/**
 * Exempt only when the sender may actually run !autodelete right now: the
 * command is not disabled, and they pass its live permission level the same
 * way the dispatcher does (fromMe counts as the owner). Prefix+name/alias is
 * the cheap gate; permission work runs only after that hits.
 */
async function isManagementCommand(body, msg, sock) {
  if (!looksLikeManagementCommand(body)) return false;
  try {
    const runtimeConfig = require("../config/runtime-config.cjs");
    if (runtimeConfig.isDisabled("autodelete")) return false;
    const { evaluatePermissionLevel } = require("../utils/permissionLevel.cjs");
    const resolveSender = await loadResolveSender();
    const isGroup = Boolean(msg?.key?.remoteJid?.endsWith("@g.us"));
    const groupMetadata = isGroup ? await resolveGroupMetadata(sock, msg.key.remoteJid) : null;
    const sender = resolveSender(msg, groupMetadata, sock);
    const level = runtimeConfig.getPermission("autodelete");
    return Boolean(evaluatePermissionLevel(level, sender).hasPermission);
  } catch (error) {
    logger.debug({ err: error }, "[auto-delete] management-command auth failed");
    return false;
  }
}

function normalizeKeywords(raw) {
  if (!Array.isArray(raw)) throw new AutoDeleteError("keywords must be a list of strings");
  if (raw.length < 1 || raw.length > MAX_KEYWORDS) {
    throw new AutoDeleteError("A rule needs 1 to 50 keywords");
  }
  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== "string" && typeof item !== "number") {
      throw new AutoDeleteError("Each keyword must be a string");
    }
    const displayed = displayKeyword(item);
    if (displayed.length < 1 || displayed.length > MAX_KEYWORD_CHARS) {
      throw new AutoDeleteError("Each keyword must be 1 to 100 characters");
    }
    const normalized = normalizeMatchText(displayed);
    if (!normalized) throw new AutoDeleteError("Keyword is empty after normalization");
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(displayed);
  }
  if (!out.length) throw new AutoDeleteError("A rule needs 1 to 50 keywords");
  return out;
}

function normalizeSenderEntry(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.endsWith("@g.us") || lower.endsWith("@broadcast") || lower.endsWith("@newsletter")) {
    throw new AutoDeleteError("Senders must be contacts, not groups");
  }
  if (raw.includes("@")) return normalizeJid(raw);
  const digits = raw.replace(/\D/g, "");
  if (digits.length >= 8 && digits.length <= 15) return `${digits}@s.whatsapp.net`;
  throw new AutoDeleteError(`Invalid sender: ${raw}`);
}

function normalizeSenders(senders) {
  if (senders == null) return { mode: "everyone", list: [] };
  if (typeof senders !== "object" || Array.isArray(senders)) {
    throw new AutoDeleteError("senders must be { mode, list }");
  }
  const mode = senders.mode == null ? "everyone" : String(senders.mode);
  if (!SENDER_MODES.has(mode)) {
    throw new AutoDeleteError('senders.mode must be "everyone" or "selected"');
  }
  const list = senders.list == null ? [] : senders.list;
  if (!Array.isArray(list)) throw new AutoDeleteError("senders.list must be a list");
  if (list.length > MAX_SENDERS) throw new AutoDeleteError("Too many senders (max 200)");
  const seen = new Set();
  const normalized = [];
  for (const entry of list) {
    const jid = normalizeSenderEntry(entry);
    if (!jid || seen.has(jid)) continue;
    seen.add(jid);
    normalized.push(jid);
  }
  if (mode === "selected" && !normalized.length) {
    throw new AutoDeleteError("Select at least one sender");
  }
  return { mode, list: mode === "everyone" ? [] : normalized };
}

function validateRuleInput(input = {}, { partial = false } = {}) {
  if (input == null || typeof input !== "object" || Array.isArray(input)) {
    throw new AutoDeleteError("Invalid rule");
  }
  const out = {};

  if (!partial || input.name !== undefined) {
    if (input.name == null || input.name === "") {
      out.name = null;
    } else {
      const name = String(input.name).trim();
      if (name.length > MAX_NAME_CHARS) {
        throw new AutoDeleteError("Name must be 60 characters or fewer");
      }
      out.name = name || null;
    }
  }

  if (!partial || input.enabled !== undefined) {
    out.enabled = input.enabled === undefined ? true : asBool(input.enabled, "enabled");
  }

  if (!partial || input.keywords !== undefined) {
    out.keywords = normalizeKeywords(input.keywords);
  }

  if (!partial || input.match !== undefined) {
    const match = input.match === undefined ? "contains" : String(input.match);
    if (!MATCH_MODES.has(match)) {
      throw new AutoDeleteError('match must be "contains", "word", or "exact"');
    }
    out.match = match;
  }

  if (!partial || input.chatScope !== undefined) {
    const chatScope = input.chatScope === undefined ? "all" : String(input.chatScope);
    if (!CHAT_SCOPES.has(chatScope)) {
      throw new AutoDeleteError('chatScope must be "all", "groups", or "private"');
    }
    out.chatScope = chatScope;
  }

  if (!partial) {
    out.senders = normalizeSenders(input.senders);
  } else if (input.senders !== undefined) {
    out.senders = input.senders;
  }

  if (!partial || input.includeOwn !== undefined) {
    out.includeOwn =
      input.includeOwn === undefined ? false : asBool(input.includeOwn, "includeOwn");
  }

  if (!partial || input.forEveryone !== undefined) {
    out.forEveryone =
      input.forEveryone === undefined ? true : asBool(input.forEveryone, "forEveryone");
  }

  if (!partial || input.keepCopy !== undefined) {
    out.keepCopy = input.keepCopy === undefined ? false : asBool(input.keepCopy, "keepCopy");
  }

  return out;
}

function parseRuleId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new AutoDeleteError("Invalid rule id");
  return id;
}

function requireRule(id) {
  const rule = store.getAutoDeleteRule(id);
  if (!rule) throw new AutoDeleteError("Rule not found", 404);
  return rule;
}

function listRules() {
  return store.listAutoDeleteRules();
}

function getRule(id) {
  return requireRule(parseRuleId(id));
}

function createRule(input) {
  if (store.countAutoDeleteRules() >= MAX_RULES) {
    throw new AutoDeleteError("You can keep at most 100 auto-delete rules");
  }
  const fields = validateRuleInput(input, { partial: false });
  if (!fields.keywords?.length) throw new AutoDeleteError("A rule needs 1 to 50 keywords");
  return store.insertAutoDeleteRule(fields);
}

function updateRule(id, input) {
  const ruleId = parseRuleId(id);
  const existing = requireRule(ruleId);
  const fields = validateRuleInput(input, { partial: true });
  if (input?.senders !== undefined) {
    const merged = {
      mode: input.senders?.mode ?? existing.senders.mode,
      list: input.senders?.list ?? existing.senders.list,
    };
    fields.senders = normalizeSenders(merged);
  }
  return store.updateAutoDeleteRule(ruleId, fields);
}

function deleteRule(id) {
  const ruleId = parseRuleId(id);
  requireRule(ruleId);
  store.deleteAutoDeleteRule(ruleId);
  return true;
}

function resetCounter(id) {
  const ruleId = parseRuleId(id);
  requireRule(ruleId);
  return store.resetAutoDeleteCounter(ruleId);
}

function listLog({ ruleId, limit, offset } = {}) {
  let parsedRuleId;
  if (ruleId !== undefined && ruleId !== null && ruleId !== "") {
    parsedRuleId = parseRuleId(ruleId);
  }
  let parsedLimit = 50;
  if (limit !== undefined && limit !== null && limit !== "") {
    parsedLimit = Number(limit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new AutoDeleteError("limit must be a positive integer");
    }
  }
  if (parsedLimit > 200) parsedLimit = 200;
  let parsedOffset = 0;
  if (offset !== undefined && offset !== null && offset !== "") {
    parsedOffset = Number(offset);
    if (!Number.isInteger(parsedOffset) || parsedOffset < 0) {
      throw new AutoDeleteError("offset must be a non-negative integer");
    }
  }
  return store.listAutoDeleteLog({
    ruleId: parsedRuleId,
    limit: parsedLimit,
    offset: parsedOffset,
  });
}

function clearLog(ruleId) {
  let parsed;
  if (ruleId !== undefined && ruleId !== null && ruleId !== "") {
    parsed = parseRuleId(ruleId);
    requireRule(parsed);
  }
  return store.clearAutoDeleteLog(parsed);
}

function messageTimestampOf(msg) {
  const n = Number(msg?.messageTimestamp);
  return Number.isFinite(n) ? n : 0;
}

async function performDelete(sock, msg, mode) {
  const jid = msg.key.remoteJid;
  if (mode === "revoke") {
    try {
      await sock.sendMessage(jid, { delete: msg.key });
      return "revoke";
    } catch (error) {
      logger.warn({ err: error }, "[auto-delete] revoke failed, falling back to delete-for-me");
    }
  }
  await sock.chatModify(
    {
      deleteForMe: {
        deleteMedia: false,
        key: msg.key,
        timestamp: messageTimestampOf(msg),
      },
    },
    jid,
  );
  return "deleteForMe";
}

async function identityHelpers(passed = {}) {
  if (passed.sameUser && passed.getSenderCandidates && passed.isBotAdminInGroup) {
    return passed;
  }
  const mod = await import("../utils/permissions.esm.js");
  return {
    sameUser: passed.sameUser || mod.sameUser,
    getSenderCandidates: passed.getSenderCandidates || mod.getSenderCandidates,
    isBotAdminInGroup: passed.isBotAdminInGroup || mod.isBotAdminInGroup,
  };
}

function keepCopyText(body) {
  const text = String(body ?? "");
  if (text.length <= LOG_TEXT_MAX) return text;
  return text.slice(0, LOG_TEXT_MAX);
}

/**
 * Per-message hook. Returns true when a rule successfully deleted the message
 * (caller must stop the rest of the pipeline). Never throws.
 */
async function handleIncoming(sock, msg, body, helpers) {
  try {
    const enabled = store.listEnabledAutoDeleteRules();
    if (!enabled.length) return false;
    if (await isManagementCommand(body, msg, sock)) return false;
    const normalizedText = normalizeMatchText(body);
    if (!normalizedText) return false;

    const ident = await identityHelpers(helpers);
    const isGroup = Boolean(msg.key?.remoteJid?.endsWith("@g.us"));
    const fromMe = Boolean(msg.key?.fromMe);
    const senderCandidates = ident.getSenderCandidates(msg, sock);

    let matched = null;
    for (const rule of enabled) {
      if (
        ruleMatches(rule, {
          normalizedText,
          isGroup,
          fromMe,
          senderCandidates,
          sameUser: ident.sameUser,
        })
      ) {
        matched = rule;
        break;
      }
    }
    if (!matched) return false;

    let botIsAdmin = false;
    if (matched.forEveryone && !fromMe && isGroup) {
      const meta = await resolveGroupMetadata(sock, msg.key.remoteJid);
      botIsAdmin = ident.isBotAdminInGroup(meta, sock);
    }
    const intended = chooseDeleteMode({
      forEveryone: matched.forEveryone,
      fromMe,
      isGroup,
      botIsAdmin,
    });

    let used;
    try {
      used = await performDelete(sock, msg, intended);
    } catch (error) {
      logger.error({ err: error, ruleId: matched.id }, "[auto-delete] delete failed");
      return false;
    }

    store.incrementAutoDeleteCounter(matched.id);
    if (matched.keepCopy) {
      try {
        store.insertAutoDeleteLog({
          ruleId: matched.id,
          chatJid: msg.key.remoteJid,
          sender: senderCandidates[0] || null,
          text: keepCopyText(body),
          mediaType: mediaType(msg.message) || "",
          mode: used,
        });
      } catch (error) {
        logger.error({ err: error, ruleId: matched.id }, "[auto-delete] keepCopy failed");
      }
    }
    logger.debug({ ruleId: matched.id, mode: used }, "[auto-delete] deleted a message");
    return true;
  } catch (error) {
    logger.error({ err: error }, "[auto-delete] hook failed");
    return false;
  }
}

module.exports = {
  AutoDeleteError,
  MAX_RULES,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_NAME_CHARS,
  DECLARED_ALIASES,
  MATCH_MODES,
  CHAT_SCOPES,
  normalizeMatchText,
  keywordMatches,
  ruleMatches,
  chooseDeleteMode,
  isManagementCommand,
  validateRuleInput,
  parseRuleId,
  listRules,
  getRule,
  createRule,
  updateRule,
  deleteRule,
  resetCounter,
  listLog,
  clearLog,
  handleIncoming,
  performDelete,
};
