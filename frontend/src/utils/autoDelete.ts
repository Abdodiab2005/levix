// Mirrors src/services/autoDelete.cjs (limits, keyword normalization, sender ids).
import type {
  AutoDeleteChatScope,
  AutoDeleteMatch,
  AutoDeleteRule,
  AutoDeleteRuleInput,
  AutoDeleteSenderMode,
} from "../types";

export const AUTO_DELETE_LIMITS = {
  rules: 100,
  keywords: 50,
  keywordChars: 100,
  nameChars: 60,
  senders: 200,
  phoneMin: 8,
  phoneMax: 15,
} as const;

const TASHKEEL = /[\u064B-\u065F\u0670\u0640]/g;
const ALEF_VARIANTS = /[\u0622\u0623\u0625\u0671]/g;
const ALEF_MAKSURA = /\u0649/g;

export type RuleSort = "newest" | "name" | "deleted" | "last";

export interface RuleFilters {
  enabled: "any" | "on" | "off";
  chatScope: "any" | AutoDeleteChatScope;
  senders: "any" | AutoDeleteSenderMode;
}

export const EMPTY_RULE_FILTERS: RuleFilters = {
  enabled: "any",
  chatScope: "any",
  senders: "any",
};

export function normalizeMatchText(input: string): string {
  let text = String(input ?? "");
  text = text.normalize("NFKC");
  text = text.replace(TASHKEEL, "");
  text = text.replace(ALEF_VARIANTS, "\u0627");
  text = text.replace(ALEF_MAKSURA, "\u064A");
  text = text.toLowerCase();
  text = text.replace(/\s+/g, " ").trim();
  return text;
}

export function prepareKeyword(raw: string): { value: string } | { error: "empty" | "long" } {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { error: "empty" };
  if (trimmed.length > AUTO_DELETE_LIMITS.keywordChars) return { error: "long" };
  const normalized = normalizeMatchText(trimmed);
  if (!normalized) return { error: "empty" };
  if (normalized.length > AUTO_DELETE_LIMITS.keywordChars) return { error: "long" };
  return { value: normalized };
}

export class SenderInputError extends Error {
  constructor(public reason: "group" | "invalid") {
    super(reason);
    this.name = "SenderInputError";
  }
}

/** Same acceptance rules as the server's normalizeSenderEntry. */
export function normalizeSenderEntry(value: string): string {
  const raw = String(value ?? "").trim();
  if (!raw) throw new SenderInputError("invalid");
  const lower = raw.toLowerCase();
  if (lower.endsWith("@g.us") || lower.endsWith("@broadcast") || lower.endsWith("@newsletter")) {
    throw new SenderInputError("group");
  }
  if (raw.includes("@")) {
    if (lower.includes("@lid")) {
      const user = raw.split("@")[0]?.split(":")[0];
      if (!user) throw new SenderInputError("invalid");
      return `${user}@lid`;
    }
    if (raw.includes(":")) {
      const user = raw.split(":")[0];
      const domain = raw.split("@")[1];
      if (!user || !domain) throw new SenderInputError("invalid");
      return `${user}@${domain}`;
    }
    return raw;
  }
  const digits = raw.replace(/\D/g, "");
  if (
    digits.length >= AUTO_DELETE_LIMITS.phoneMin &&
    digits.length <= AUTO_DELETE_LIMITS.phoneMax
  ) {
    return `${digits}@s.whatsapp.net`;
  }
  throw new SenderInputError("invalid");
}

export function ruleLabel(rule: { name: string | null; keywords: string[] }): string {
  const name = rule.name?.trim();
  if (name) return name;
  return rule.keywords[0] || "";
}

export function peerLabel(
  jid: string | null | undefined,
  names?: ReadonlyMap<string, string>,
): string {
  if (!jid) return "";
  const known = names?.get(jid);
  if (known) return known;
  const phone = /^(\d+)@s\.whatsapp\.net$/i.exec(jid);
  if (phone) return `+${phone[1]}`;
  return jid;
}

export function peerDir(
  jid: string | null | undefined,
  names?: ReadonlyMap<string, string>,
): "auto" | "ltr" {
  if (jid && names?.has(jid)) return "auto";
  return "ltr";
}

export interface RuleDraft {
  name: string;
  keywords: string[];
  match: AutoDeleteMatch;
  chatScope: AutoDeleteChatScope;
  sendersMode: AutoDeleteSenderMode;
  senders: string[];
  includeOwn: boolean;
  forEveryone: boolean;
  keepCopy: boolean;
}

export interface RuleDraftErrors {
  name?: "long";
  keywords?: "required" | "max";
  senders?: "required" | "max";
}

export function validateRuleDraft(draft: RuleDraft): RuleDraftErrors {
  const errors: RuleDraftErrors = {};
  if (draft.name.trim().length > AUTO_DELETE_LIMITS.nameChars) errors.name = "long";
  if (draft.keywords.length < 1) errors.keywords = "required";
  else if (draft.keywords.length > AUTO_DELETE_LIMITS.keywords) errors.keywords = "max";
  if (draft.sendersMode === "selected") {
    if (draft.senders.length < 1) errors.senders = "required";
    else if (draft.senders.length > AUTO_DELETE_LIMITS.senders) errors.senders = "max";
  }
  return errors;
}

export function draftToInput(draft: RuleDraft, enabled?: boolean): AutoDeleteRuleInput {
  const name = draft.name.trim();
  return {
    name: name || null,
    keywords: draft.keywords,
    match: draft.match,
    chatScope: draft.chatScope,
    senders: {
      mode: draft.sendersMode,
      list: draft.sendersMode === "everyone" ? [] : draft.senders,
    },
    includeOwn: draft.includeOwn,
    forEveryone: draft.forEveryone,
    keepCopy: draft.keepCopy,
    ...(enabled === undefined ? {} : { enabled }),
  };
}

export function ruleMatchesQuery(
  rule: AutoDeleteRule,
  query: string,
  filters: RuleFilters,
): boolean {
  const needle = normalizeMatchText(query);
  if (needle) {
    const haystack = normalizeMatchText(`${rule.name ?? ""} ${rule.keywords.join(" ")}`);
    if (!haystack.includes(needle)) return false;
  }
  if (filters.enabled === "on" && !rule.enabled) return false;
  if (filters.enabled === "off" && rule.enabled) return false;
  if (filters.chatScope !== "any" && rule.chatScope !== filters.chatScope) return false;
  if (filters.senders !== "any" && rule.senders.mode !== filters.senders) return false;
  return true;
}

export function sortRules(
  rules: AutoDeleteRule[],
  sort: RuleSort,
  language: string,
): AutoDeleteRule[] {
  const list = [...rules];
  const byName = (a: AutoDeleteRule, b: AutoDeleteRule) =>
    ruleLabel(a).localeCompare(ruleLabel(b), language, { sensitivity: "base" });
  if (sort === "name") list.sort(byName);
  else if (sort === "deleted") list.sort((a, b) => b.deletedCount - a.deletedCount || byName(a, b));
  else if (sort === "last") {
    list.sort((a, b) => (b.lastDeletedAt ?? -1) - (a.lastDeletedAt ?? -1) || byName(a, b));
  } else list.sort((a, b) => b.createdAt - a.createdAt || b.id - a.id);
  return list;
}

export function activeFilterCount(filters: RuleFilters): number {
  return [filters.enabled, filters.chatScope, filters.senders].filter((value) => value !== "any")
    .length;
}
