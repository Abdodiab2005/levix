import { createRequire } from "node:module";
import { REACTION_ACTION_LIMITS, reactionActionReadiness } from "./engine.js";
import { REACTION_LIMITS } from "./reactions.js";

const require = createRequire(import.meta.url);
const store = require("../db/store.cjs");
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

function sharesTrigger(a, b) {
  return (
    a.row.chat_jid === b.row.chat_jid &&
    typeof a.definition?.emoji === "string" &&
    a.definition.emoji === b.definition?.emoji &&
    Array.isArray(a.definition.transitions) &&
    Array.isArray(b.definition.transitions) &&
    Array.isArray(a.definition.originalTypes) &&
    Array.isArray(b.definition.originalTypes) &&
    a.definition.transitions.some((item) => b.definition.transitions.includes(item)) &&
    a.definition.originalTypes.some((item) => b.definition.originalTypes.includes(item))
  );
}

function ruleView(item, items, context) {
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
  const related = items.filter((other) => sharesTrigger(item, other));
  if (related.filter((other) => other.row.enabled).length > REACTION_ACTION_LIMITS.candidateLimit)
    statuses.push("CANDIDATE_LIMIT");
  if (!statuses.length) statuses.push("READY");
  const overlaps = related
    .filter(
      (other) =>
        other.row.priority < row.priority ||
        (other.row.priority === row.priority &&
          Buffer.compare(Buffer.from(other.row.id), Buffer.from(row.id)) < 0),
    )
    .slice(0, 20)
    .map((other) => other.row.id);
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
    automation: { enabled: store.getBotSetting("reaction:enabled", false) === true },
    connection: { connected: session?.getState().connected === true },
    owner: { linked: linkedIdentity().selfJids.length > 0 },
  };
}

function view(id) {
  const items = store.listReactionRules().map(parsedRule);
  return ruleView(
    items.find((item) => item.row.id === id),
    items,
    context(),
  );
}

export function overview() {
  const state = context();
  const items = store.listReactionRules().map(parsedRule);
  return {
    ...state,
    limits: { ...REACTION_LIMITS, ...REACTION_ACTION_LIMITS },
    rules: items.map((item) => ruleView(item, items, state)),
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
  assertValid(
    draftIssues({
      chatJid: row.chat_jid,
      priority: row.priority,
      definition: parsedRule(row).definition,
    }),
  );
  return write(() => view(store.setReactionRuleEnabled(id, body.enabled).id));
}

export function deleteRule(id, revision) {
  assertValid(revisionIssues(revision));
  currentRule(id, revision);
  return write(() => store.deleteReactionRule(id));
}

export function setAutomation(body) {
  const issues = bodyIssues(body, ["enabled"]);
  if (typeof body?.enabled !== "boolean") issues.push({ field: "enabled", code: "invalid" });
  assertValid(issues);
  return write(() => {
    store.setReactionAutomationEnabled(body.enabled);
    return { enabled: store.getBotSetting("reaction:enabled", false) === true };
  });
}
