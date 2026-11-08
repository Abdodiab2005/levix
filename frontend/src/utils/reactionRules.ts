// Mirrors src/automation/rules.cjs (emoji, definition v1) and the 07c RuleView contract.
import type {
  ReactionAction,
  ReactionDefinition,
  ReactionDestinationMode,
  ReactionIssue,
  ReactionLimits,
  ReactionOriginalType,
  ReactionRule,
  ReactionRuleWrite,
  ReactionSenderRole,
  ReactionTransition,
} from "../types";

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export const EMOJI_PALETTE = ["🤦", "🌐", "🧠", "👁️", "💾", "👍", "❤️", "✅"] as const;

export const TRANSITIONS: readonly ReactionTransition[] = ["add", "change", "remove"];

export const ORIGINAL_TYPES: readonly ReactionOriginalType[] = [
  "text",
  "voice",
  "audio",
  "image",
  "video",
  "document",
  "sticker",
];

export const SENDER_ROLES: readonly ReactionSenderRole[] = [
  "any",
  "owner",
  "bot_admin",
  "group_admin",
  "member",
];

export const SENDERS_MAX = 100;
export const PRIORITY_MIN = 0;
export const PRIORITY_MAX = 1000;
export const PRIORITY_DEFAULT = 100;

export const DEFAULT_REACTION_LIMITS: ReactionLimits = {
  perReactor: 3,
  perChat: 10,
  perRule: 5,
  windowMs: 60_000,
  globalJobs: 2,
  candidateLimit: 100,
};

const ATTENTION_STATUS = new Set<string>([
  "RULE_INVALID",
  "NOT_CONNECTED",
  "ACTION_DISABLED",
  "STT_DISABLED",
  "STT_KEY_MISSING",
  "OWNER_NOT_LINKED",
  "CANDIDATE_LIMIT",
]);

const OFF_STATUS = new Set<string>(["AUTOMATION_OFF", "RULE_OFF"]);

export type ReactionSort = "priority" | "chat" | "newest";

export interface ReactionFilters {
  status: "any" | "ready" | "off" | "attention";
  action: "any" | ReactionAction;
}

export const EMPTY_REACTION_FILTERS: ReactionFilters = {
  status: "any",
  action: "any",
};

export interface ReactionDraft {
  chatJid: string;
  chatName: string;
  emoji: string;
  transitions: ReactionTransition[];
  originalTypes: ReactionOriginalType[];
  role: ReactionSenderRole;
  senderIds: string[];
  action: ReactionAction;
  destination: ReactionDestinationMode;
  priority: number;
}

/** Same grapheme / pictographic check as src/automation/rules.cjs:27-38. Hint only. */
export function isReactionEmoji(value: string): boolean {
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

export function emptyReactionDraft(): ReactionDraft {
  return {
    chatJid: "",
    chatName: "",
    emoji: "",
    transitions: ["add"],
    originalTypes: ["voice"],
    role: "owner",
    senderIds: [],
    action: "stt",
    destination: "same_chat",
    priority: PRIORITY_DEFAULT,
  };
}

export function draftFromRule(rule: ReactionRule): ReactionDraft {
  const definition = rule.definition;
  return {
    chatJid: rule.chatJid,
    chatName: rule.chatName || rule.chatJid,
    emoji: definition?.emoji ?? "",
    transitions: definition?.transitions?.length ? [...definition.transitions] : ["add"],
    originalTypes: definition?.originalTypes?.length ? [...definition.originalTypes] : ["voice"],
    role: definition?.senders?.role ?? "owner",
    senderIds: definition?.senders?.ids ? [...definition.senders.ids] : [],
    action: definition?.action ?? "stt",
    destination: definition?.destination?.mode ?? "same_chat",
    priority: Number.isInteger(rule.priority) ? rule.priority : PRIORITY_DEFAULT,
  };
}

export function draftToWrite(draft: ReactionDraft): ReactionRuleWrite {
  const originalTypes =
    draft.action === "stt" ? (["voice"] as ReactionOriginalType[]) : [...draft.originalTypes];
  const definition: ReactionDefinition = {
    version: 1,
    emoji: draft.emoji.trim(),
    transitions: [...draft.transitions],
    originalTypes,
    senders: {
      role: draft.role,
      ids: [...draft.senderIds],
    },
    action: draft.action,
    destination: { mode: draft.destination },
  };
  return {
    chatJid: draft.chatJid,
    priority: draft.priority,
    definition,
  };
}

export function clampPriority(value: number): number {
  if (!Number.isFinite(value)) return PRIORITY_DEFAULT;
  return Math.min(PRIORITY_MAX, Math.max(PRIORITY_MIN, Math.round(value)));
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

export function statusTone(code: string): "ok" | "warn" | "danger" | "neutral" {
  if (code === "READY") return "ok";
  if (code === "AUTOMATION_OFF" || code === "RULE_OFF") return "neutral";
  if (
    code === "RULE_INVALID" ||
    code === "ACTION_DISABLED" ||
    code === "STT_KEY_MISSING" ||
    code === "OWNER_NOT_LINKED"
  ) {
    return "danger";
  }
  return "warn";
}

export function ruleMatchesFilters(rule: ReactionRule, filters: ReactionFilters): boolean {
  if (filters.action !== "any" && rule.definition?.action !== filters.action) return false;
  const statuses = rule.statuses ?? [];
  if (filters.status === "ready") return statuses.includes("READY");
  if (filters.status === "off") return statuses.some((code) => OFF_STATUS.has(code));
  if (filters.status === "attention") return statuses.some((code) => ATTENTION_STATUS.has(code));
  return true;
}

export function sortReactionRules(
  rules: ReactionRule[],
  sort: ReactionSort,
  language: string,
): ReactionRule[] {
  const list = [...rules];
  const byId = (a: ReactionRule, b: ReactionRule) => a.id.localeCompare(b.id);
  if (sort === "chat") {
    list.sort(
      (a, b) =>
        (a.chatName || a.chatJid).localeCompare(b.chatName || b.chatJid, language, {
          sensitivity: "base",
        }) ||
        a.priority - b.priority ||
        byId(a, b),
    );
  } else if (sort === "newest") {
    const stamp = (rule: ReactionRule) => rule.runtime?.lastAt ?? rule.enabledAt ?? 0;
    list.sort((a, b) => stamp(b) - stamp(a) || byId(b, a));
  } else {
    list.sort((a, b) => a.priority - b.priority || byId(a, b));
  }
  return list;
}

export function activeFilterCount(filters: ReactionFilters): number {
  return [filters.status, filters.action].filter((value) => value !== "any").length;
}

export function issueBucket(field: string): string {
  const root = String(field ?? "").split(".")[0];
  if (
    root === "chatJid" ||
    root === "priority" ||
    root === "emoji" ||
    root === "transitions" ||
    root === "originalTypes" ||
    root === "senders" ||
    root === "action" ||
    root === "destination"
  ) {
    return root;
  }
  return "form";
}

export function readLimits(raw: unknown): ReactionLimits {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const num = (key: string, fallback: number) => {
    const value = Number(o[key]);
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  };
  const windowMs = num("windowMs", Number.NaN);
  const windowSeconds = num("windowSeconds", Number.NaN);
  return {
    perReactor: num("perReactor", DEFAULT_REACTION_LIMITS.perReactor),
    perChat: num("perChat", DEFAULT_REACTION_LIMITS.perChat),
    perRule: num("perRule", DEFAULT_REACTION_LIMITS.perRule),
    windowMs: Number.isFinite(windowMs)
      ? windowMs
      : Number.isFinite(windowSeconds)
        ? windowSeconds * 1000
        : DEFAULT_REACTION_LIMITS.windowMs,
    globalJobs: num("globalJobs", DEFAULT_REACTION_LIMITS.globalJobs),
    candidateLimit: num("candidateLimit", DEFAULT_REACTION_LIMITS.candidateLimit),
  };
}

export function reactionApiCode(err: unknown): string | null {
  if (!err || typeof err !== "object") return null;
  const data =
    "data" in err ? (err as { data?: { error?: unknown; issues?: unknown } }).data : undefined;
  if (data && typeof data.error === "string") return data.error;
  if ("message" in err && typeof (err as { message: unknown }).message === "string") {
    const message = (err as { message: string }).message;
    if (
      message === "INTERNAL" ||
      message.startsWith("REACTION_") ||
      message.startsWith("STT_") ||
      message.startsWith("MEDIA_")
    ) {
      return message;
    }
  }
  return null;
}

export function reactionApiIssues(err: unknown): ReactionIssue[] {
  if (!err || typeof err !== "object" || !("data" in err)) return [];
  const issues = (err as { data?: { issues?: unknown } }).data?.issues;
  if (!Array.isArray(issues)) return [];
  return issues.filter(
    (item): item is ReactionIssue =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as ReactionIssue).field === "string" &&
      typeof (item as ReactionIssue).code === "string",
  );
}

