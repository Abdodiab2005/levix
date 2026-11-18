import { createRequire } from "node:module";
import { REACTION_ACTION_LIMITS, reactionActionReadiness } from "./engine.js";
import { REACTION_LIMITS } from "./reactions.js";

const require = createRequire(import.meta.url);
const store = require("../db/store.cjs");
const { MAX_IDENTITY_ALIASES } = require("./limits.cjs");
const { definitionIssues, exactJid } = require("./rules.cjs");
const { linkedIdentity } = require("../messaging/identity.cjs");
const { getCached } = require("../utils/groupMetadataCache.cjs");
const status = require("./status.cjs");
let session = null;

export function setSession(manager) {
  session = manager;
}

export class ReactionManageError extends Error {
  constructor(status, code, issues) {
    super(code);
    this.name = "ReactionManageError";
    this.status = status;
    this.code = code;
    if (issues) this.issues = issues;
  }
}

function bodyIssues(body, keys) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    return [{ field: "body", code: "invalid" }];
  return Object.keys(body).some((key) => !keys.includes(key))
    ? [{ field: "body", code: "unknown_field" }]
    : [];
}

function draftIssues(body, update = false) {
  const issues = bodyIssues(body, [
    "chatJid",
    "priority",
    "definition",
    ...(update ? ["revision"] : []),
  ]);
  if (!body || typeof body !== "object" || Array.isArray(body)) return issues;
  try {
    exactJid(body.chatJid);
  } catch {
    issues.push({ field: "chatJid", code: "invalid" });
  }
  if (!Number.isInteger(body.priority) || body.priority < 0 || body.priority > 1000)
    issues.push({ field: "priority", code: "invalid" });
  issues.push(...definitionIssues(body.definition));
  if (update) issues.push(...revisionIssues(body.revision));
  return issues;
}

function revisionIssues(revision) {
  return typeof revision === "string" && revision.length > 0 && revision.length <= 128
    ? []
    : [{ field: "revision", code: "invalid" }];
}

function assertValid(issues) {
  if (issues.length) throw new ReactionManageError(400, "REACTION_RULE_INVALID", issues);
}

function currentRule(id, revision) {
  const row = store.getReactionRule(id);
  if (!row) throw new ReactionManageError(404, "REACTION_RULE_MISSING");
  if (row.revision !== revision) throw new ReactionManageError(409, "REACTION_RULE_CHANGED");
  return row;
}

function write(fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ReactionManageError) throw error;
    if (error.message === "REACTION_RULE_MISSING")
      throw new ReactionManageError(404, "REACTION_RULE_MISSING");
    if (error.message === "REACTION_AUTOMATION_CHANGED")
      throw new ReactionManageError(409, "REACTION_AUTOMATION_CHANGED");
    if (["REACTION_RULE_INVALID", "REACTION_SWITCH_INVALID"].includes(error.message))
      throw new ReactionManageError(400, "REACTION_RULE_INVALID", [
        { field: "definition", code: "invalid" },
      ]);
    throw error;
  }
}

function parsedRule(row) {
  let definition = null;
  try {
    definition = JSON.parse(row.definition);
  } catch {
    // Corrupt rows remain visible so the operator can replace or delete them.
  }
  return {
    row,
    definition,
    valid: draftIssues({ chatJid: row.chat_jid, priority: row.priority, definition }).length === 0,
  };
}

function compareRules(a, b) {
  return a.priority - b.priority || Buffer.compare(Buffer.from(a.id), Buffer.from(b.id));
}

function triggerKeys(definition) {
  if (typeof definition?.emoji !== "string") return [];
  // SQL prefiltering runs before definition validation and uses json_each.
  const values = (value) =>
    new Set(
      (value && typeof value === "object" ? Object.values(value) : [value]).filter(
        (item) => typeof item === "string",
      ),
    );
  const keys = [];
  const types = values(definition.originalTypes);
  for (const transition of values(definition.transitions))
    for (const type of types) keys.push(JSON.stringify([definition.emoji, transition, type]));
  return keys;
}

function triggerIndex(items) {
  const byChat = new Map();
  for (const item of items) {
    const chat = item.row.chat_jid;
    if (!byChat.has(chat)) byChat.set(chat, []);
    byChat.get(chat).push(item);
  }
  const byAliases = new Map();
  const index = new Map();
  for (const chat of byChat.keys()) {
    const aliases = store.reactionIdentityAliases(chat);
    const aliasKey = JSON.stringify([...aliases].sort());
    let buckets = byAliases.get(aliasKey);
    if (!buckets) {
      buckets = new Map();
      // reactionRulesForChats refuses an alias expansion above four chats.
      for (const alias of aliases.length <= MAX_IDENTITY_ALIASES ? aliases : []) {
        for (const item of byChat.get(alias) || []) {
          for (const key of triggerKeys(item.definition)) {
            if (!buckets.has(key)) buckets.set(key, { enabled: 0, first: [] });
            const bucket = buckets.get(key);
            if (item.row.enabled === 1) bucket.enabled++;
            // Later rows cannot enter the capped list of earlier overlaps.
            bucket.first.push(item.row);
            bucket.first.sort(compareRules);
            if (bucket.first.length > 20) bucket.first.pop();
          }
        }
      }
      byAliases.set(aliasKey, buckets);
    }
    index.set(chat, buckets);
  }
  return index;
}

function ruleView(item, index, context) {
  const { row, definition, valid } = item;
  const statuses = [];
  if (!context.automation.enabled) statuses.push("AUTOMATION_OFF");
  if (!row.enabled) statuses.push("RULE_OFF");
  if (!valid) statuses.push("RULE_INVALID");
  if (!context.connection.connected) statuses.push("NOT_CONNECTED");
  if (valid) {
    statuses.push(...reactionActionReadiness(definition.action));
    if (definition.destination.mode === "owner_private" && !context.owner.linked)
      statuses.push("OWNER_NOT_LINKED");
  }
  const buckets = triggerKeys(definition)
    .map((key) => index.get(row.chat_jid).get(key))
    .filter(Boolean);
  if (buckets.some((bucket) => bucket.enabled > REACTION_ACTION_LIMITS.candidateLimit))
    statuses.push("CANDIDATE_LIMIT");
  if (!statuses.length) statuses.push("READY");
  const earlier = new Map();
  for (const bucket of buckets)
    for (const other of bucket.first)
      if (compareRules(other, row) < 0) earlier.set(other.id, other);
  const overlaps = [...earlier.values()]
    .sort(compareRules)
    .slice(0, 20)
    .map((other) => other.id);
  return {
    id: row.id,
    revision: row.revision,
    chatJid: row.chat_jid,
    chatName: getCached(row.chat_jid)?.subject || store.describePeer(row.chat_jid).label,
    priority: row.priority,
    enabled: row.enabled === 1,
    enabledAt: row.enabled_at,
    definition,
    valid,
    statuses,
    overlaps,
    runtime: status.get(row.id) || { lastCode: null, lastAt: null, counts: {} },
  };
}

function context() {
  return {
    automation: store.getReactionAutomation(),
    connection: { connected: session?.getState().connected === true },
    owner: { linked: linkedIdentity().selfJids.length > 0 },
  };
}

function view(id) {
  const items = store.listReactionRules().map(parsedRule);
  return ruleView(
    items.find((item) => item.row.id === id),
    triggerIndex(items),
    context(),
  );
}

export function overview() {
  const state = context();
  const items = store.listReactionRules().map(parsedRule);
  const index = triggerIndex(items);
  return {
    ...state,
    limits: { ...REACTION_LIMITS, ...REACTION_ACTION_LIMITS },
    rules: items.map((item) => ruleView(item, index, state)),
  };
}

export function checkDraft(body) {
  return { issues: draftIssues(body) };
}

export function createRule(body) {
  assertValid(draftIssues(body));
  return write(() => {
    const row = store.saveReactionRule({
      chatJid: body.chatJid,
      priority: body.priority,
      definition: body.definition,
    });
    return view(row.id);
  });
}

export function updateRule(id, body) {
  assertValid(draftIssues(body, true));
  currentRule(id, body.revision);
  return write(() => {
    const row = store.saveReactionRule({
      id,
      chatJid: body.chatJid,
      priority: body.priority,
      definition: body.definition,
    });
    return view(row.id);
  });
}

export function setRuleEnabled(id, body) {
  const issues = bodyIssues(body, ["revision", "enabled"]);
  issues.push(...revisionIssues(body?.revision));
  if (typeof body?.enabled !== "boolean") issues.push({ field: "enabled", code: "invalid" });
  assertValid(issues);
  const row = currentRule(id, body.revision);
  if (body.enabled === true) {
    assertValid(
      draftIssues({
        chatJid: row.chat_jid,
        priority: row.priority,
        definition: parsedRule(row).definition,
      }),
    );
  }
  return write(() => view(store.setReactionRuleEnabled(id, body.enabled).id));
}

export function deleteRule(id, revision) {
  assertValid(revisionIssues(revision));
  currentRule(id, revision);
  return write(() => store.deleteReactionRule(id));
}

export function setAutomation(body) {
  const issues = bodyIssues(body, ["enabled", "revision"]);
  if (typeof body?.enabled !== "boolean") issues.push({ field: "enabled", code: "invalid" });
  issues.push(...revisionIssues(body?.revision));
  assertValid(issues);
  return write(() => store.setReactionAutomationEnabled(body.enabled, body.revision));
}
