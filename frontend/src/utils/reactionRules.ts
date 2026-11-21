// Mirrors src/automation/rules.cjs (emoji, definition v2), commandEligibility.cjs, and RuleView.
import type {
  ReactionCommandField,
  ReactionCommandMode,
  ReactionCommandSpec,
  ReactionDefinition,
  ReactionDestinationMode,
  ReactionIssue,
  ReactionLimits,
  ReactionOriginalType,
  ReactionRule,
  ReactionRuleWrite,
  ReactionSenderMode,
  ReactionSenderRole,
  ReactionTransition,
} from "../types";
import { fill } from "./fill.ts";

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
  "owner_group_admin",
  "owner",
  "group_admin",
  "bot_admin",
  "member",
];

export const TRIGGER_MODES: readonly Exclude<ReactionSenderMode, "custom">[] = [
  "any",
  "owner_group_admin",
  "owner",
  "group_admin",
  "selected",
];

export const LEGACY_SENDER_ROLES: readonly ReactionSenderRole[] = ["bot_admin", "member"];

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

const LINE_PATTERN = /^[^\r\n]*$/;

const SETTINGS_ARGS = new Set<string>([
  "setprefix",
  "perm",
  "autodelete",
  "lang",
  "memory",
  "todo",
  "group:approveall",
  "status",
]);

export const REACTION_COMMAND_FIELDS: Record<string, ReactionCommandField> = {
  prompt: { id: "prompt", maxLength: 2000, required: true },
  city: { id: "city", maxLength: 80, required: true },
  qr: { id: "text", maxLength: 500, required: true },
  language: { id: "language", maxLength: 32, required: false },
  status: { id: "status", maxLength: 16, required: true, pattern: "^status$" },
  keyword: { id: "keyword", maxLength: 41, required: true, pattern: "^#[A-Za-z0-9_]{1,40}$" },
};

function makeSpec(
  key: string,
  mode: ReactionCommandMode,
  opts: {
    fields?: ReactionCommandField[];
    originalTypes?: readonly ReactionOriginalType[];
    destructive?: boolean;
    transitions?: readonly ReactionTransition[];
    quote?: boolean;
    reason?: string | null;
    description?: string;
  } = {},
): ReactionCommandSpec {
  const name = key.startsWith("group:") ? key.slice(6) : key;
  const isUnsupported = mode === "unsupported";
  const destructive = opts.destructive === true;
  return {
    key,
    name,
    description: opts.description ?? "",
    mode,
    fields: opts.fields ? [...opts.fields] : [],
    originalTypes: isUnsupported
      ? []
      : opts.originalTypes
        ? [...opts.originalTypes]
        : [...ORIGINAL_TYPES],
    destructive,
    transitions: isUnsupported
      ? []
      : opts.transitions
        ? [...opts.transitions]
        : destructive
          ? ["add"]
          : [...TRANSITIONS],
    quote: opts.quote === true || mode === "quote",
    reason: isUnsupported ? (opts.reason ?? "UNCLASSIFIED") : null,
  };
}

export const DEFAULT_REACTION_COMMANDS: readonly ReactionCommandSpec[] = [
  makeSpec("help", "none"),
  makeSpec("lang", "none"),
  makeSpec("listschedules", "none"),
  makeSpec("ping", "none"),
  makeSpec("rand", "none"),
  makeSpec("status", "none"),
  makeSpec("update", "none"),
  makeSpec("autodelete", "none"),
  makeSpec("perm", "none"),
  makeSpec("setprefix", "none"),
  makeSpec("group:all", "none"),
  makeSpec("group:antispam", "none"),
  makeSpec("group:approveall", "none"),
  makeSpec("group:flagged", "none"),
  makeSpec("group:members", "none"),
  makeSpec("group:policy", "none"),
  makeSpec("group:rules", "none"),
  makeSpec("group:tagadmins", "none"),

  makeSpec("calc", "quote"),
  makeSpec("digit", "quote"),
  makeSpec("md", "quote"),
  makeSpec("send", "quote"),
  makeSpec("shortlink", "quote"),
  makeSpec("stt", "quote", { originalTypes: ["voice"] }),
  makeSpec("toimage", "quote", { originalTypes: ["sticker"] }),
  makeSpec("tts", "quote"),
  makeSpec("group:kick", "quote", { destructive: true, transitions: ["add"] }),

  makeSpec("group:note", "args", { fields: [REACTION_COMMAND_FIELDS.keyword] }),
  makeSpec("prayer", "args", { fields: [REACTION_COMMAND_FIELDS.city] }),
  makeSpec("weather", "args", { fields: [REACTION_COMMAND_FIELDS.city] }),
  makeSpec("qr", "args", { fields: [REACTION_COMMAND_FIELDS.qr] }),
  makeSpec("translate", "args", { fields: [REACTION_COMMAND_FIELDS.language], quote: true }),
  makeSpec("mod", "args", { fields: [REACTION_COMMAND_FIELDS.status] }),

  makeSpec("block", "unsupported", { reason: "SESSION_OR_ACCOUNT_ACTION" }),
  makeSpec("unblock", "unsupported", { reason: "SESSION_OR_ACCOUNT_ACTION" }),
  makeSpec("restart", "unsupported", { reason: "SESSION_OR_ACCOUNT_ACTION" }),
  makeSpec("stopbot", "unsupported", { reason: "SESSION_OR_ACCOUNT_ACTION" }),
  makeSpec("group:antilink", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:media", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:welcome", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:setname", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:setrules", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:setwarn", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("group:add", "unsupported", { reason: "SETTINGS_CHANGE" }),
  makeSpec("schedule", "unsupported", { reason: "DURABLE_JOB" }),
  makeSpec("autoschedule", "unsupported", { reason: "DURABLE_JOB" }),
  makeSpec("deleteschedule", "unsupported", { reason: "DURABLE_JOB" }),
  makeSpec("group", "unsupported", { reason: "WRAPPER" }),
  makeSpec("notes", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("score", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("group:setpp", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("group:warn", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("group:warns", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("debt", "unsupported", { reason: "KNOWN_DEFECT" }),
  makeSpec("memory", "unsupported", { reason: "REQUESTER_SCOPE" }),
  makeSpec("todo", "unsupported", { reason: "REQUESTER_SCOPE" }),
  makeSpec("packs", "unsupported", { reason: "REQUESTER_SCOPE" }),
  makeSpec("stickers", "unsupported", { reason: "REQUESTER_SCOPE" }),
  makeSpec("sticker", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:promote", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:demote", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:clearwarns", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("poll", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("loop", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("pack", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("blacklist", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:deletenote", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:save", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("group:removeall", "unsupported", { reason: "NOT_IN_5_0_1" }),
  makeSpec("gemini", "unsupported", { reason: "NOT_IN_5_0_1" }),
];

const DEFAULT_COMMAND_MAP = new Map<string, ReactionCommandSpec>(
  DEFAULT_REACTION_COMMANDS.map((spec) => [spec.key, spec]),
);

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

export type ReactionSort = "priority" | "chat" | "recent";

export interface ReactionFilters {
  status: "any" | "ready" | "off" | "attention";
  action: string;
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
  senderMode?: ReactionSenderMode;
  action: string;
  commandArgs: string[];
  allowOthersOnLinkedMessages: boolean;
  destination: ReactionDestinationMode;
  priority: number;
}

export interface ReactionCommandPickerItem extends ReactionCommandSpec {
  token: string;
  disabled: boolean;
  reasonKey: string | null;
}

export type ReactionFieldErrorCode = "required" | "too_long" | "multiline" | "pattern";

export interface ReactionArgsValidation {
  ok: boolean;
  errors: ReactionIssue[];
  fieldErrors: Record<string, ReactionFieldErrorCode>;
}

export function classifyReactionCommand(
  key: string,
  catalog?: readonly ReactionCommandSpec[],
): ReactionCommandSpec {
  if (typeof key !== "string" || !key) {
    return makeSpec("", "unsupported", { reason: "UNCLASSIFIED" });
  }
  const fromCatalog = catalog?.find((entry) => entry.key === key);
  if (fromCatalog) return fromCatalog;
  const fallback = DEFAULT_COMMAND_MAP.get(key);
  if (fallback) return fallback;
  return makeSpec(key, "unsupported", { reason: "UNCLASSIFIED" });
}

export function formatCommandToken(keyOrName: string, prefix = "!"): string {
  const raw = typeof keyOrName === "string" ? keyOrName.trim() : "";
  if (!raw) return "";
  const bare = raw.startsWith("group:") ? raw.slice("group:".length) : raw;
  if (!bare) return "";
  const livePrefix = typeof prefix === "string" && prefix.trim() ? prefix.trim() : "!";
  return `${livePrefix}${bare}`;
}

export function unsupportedReasonKey(reason: string | null | undefined): string {
  switch (reason) {
    case "SESSION_OR_ACCOUNT_ACTION":
      return "reactionReasonSessionOrAccount";
    case "SETTINGS_CHANGE":
      return "reactionReasonSettingsChange";
    case "DURABLE_JOB":
      return "reactionReasonDurableJob";
    case "WRAPPER":
      return "reactionReasonWrapper";
    case "KNOWN_DEFECT":
      return "reactionReasonKnownDefect";
    case "NOT_IN_5_0_1":
      return "reactionReasonNotIn501";
    case "REQUESTER_SCOPE":
      return "reactionReasonRequesterScope";
    default:
      return "reactionReasonUnsupported";
  }
}

export function quoteNoteKey(
  spec:
    | Pick<ReactionCommandSpec, "key" | "mode" | "quote" | "originalTypes" | "destructive">
    | null
    | undefined,
): string | null {
  if (!spec || (spec.mode !== "quote" && !spec.quote)) return null;
  if (spec.key === "stt" || (spec.originalTypes.length === 1 && spec.originalTypes[0] === "voice"))
    return "reactionQuoteVoice";
  if (
    spec.key === "toimage" ||
    (spec.originalTypes.length === 1 && spec.originalTypes[0] === "sticker")
  )
    return "reactionQuoteSticker";
  if (spec.destructive) return "reactionQuoteTargetAuthor";
  return "reactionQuoteMessage";
}

export function commandFieldLabelKey(fieldId: string): string {
  switch (fieldId) {
    case "prompt":
      return "reactionArgPrompt";
    case "city":
      return "reactionArgCity";
    case "text":
      return "reactionArgText";
    case "language":
      return "reactionArgLanguage";
    case "status":
      return "reactionArgStatus";
    case "keyword":
      return "reactionArgKeyword";
    default:
      return "reactionArgValue";
  }
}

export function buildCommandPickerItems(
  commands: readonly ReactionCommandSpec[] = DEFAULT_REACTION_COMMANDS,
  query = "",
  prefix = "!",
): ReactionCommandPickerItem[] {
  const source = commands.length > 0 ? commands : DEFAULT_REACTION_COMMANDS;
  const needle = query.trim().toLowerCase();
  const items: ReactionCommandPickerItem[] = source.map((cmd) => {
    const token = formatCommandToken(cmd.name || cmd.key, prefix);
    const disabled = cmd.mode === "unsupported";
    return {
      ...cmd,
      token,
      disabled,
      reasonKey: disabled ? unsupportedReasonKey(cmd.reason) : null,
    };
  });
  if (!needle) return items;
  return items.filter((item) => {
    const haystacks = [
      item.key.toLowerCase(),
      item.name.toLowerCase(),
      item.token.toLowerCase(),
      (item.description || "").toLowerCase(),
    ];
    return haystacks.some((text) => text.includes(needle));
  });
}

export function validateReactionCommandArgs(
  key: string,
  args: readonly string[],
  catalog?: readonly ReactionCommandSpec[],
): ReactionArgsValidation {
  const spec = classifyReactionCommand(key, catalog);
  const errors: ReactionIssue[] = [];
  const fieldErrors: Record<string, ReactionFieldErrorCode> = {};
  const fail = (code = "invalid") => errors.push({ field: "definition.command.args", code });

  if (!Array.isArray(args) || args.some((item) => typeof item !== "string")) {
    fail();
    return { ok: false, errors, fieldErrors };
  }
  if (spec.mode === "unsupported") {
    errors.push({ field: "definition.command.name", code: spec.reason || "UNCLASSIFIED" });
    return { ok: false, errors, fieldErrors };
  }
  if (spec.mode === "none" || spec.mode === "quote") {
    if (args.length) fail(SETTINGS_ARGS.has(key) ? "SETTINGS_CHANGE" : "invalid");
    return { ok: errors.length === 0, errors, fieldErrors };
  }
  const fields = spec.fields || [];
  if (args.length > fields.length) fail();
  fields.forEach((field, index) => {
    const value = args[index];
    if (value == null || value === "") {
      if (field.required) {
        fail("required");
        fieldErrors[field.id] = "required";
      }
      return;
    }
    if (!LINE_PATTERN.test(value)) {
      fail();
      fieldErrors[field.id] = "multiline";
      return;
    }
    // Same checks as the server, which reports length and pattern separately.
    if (value.length > field.maxLength) {
      fail();
      fieldErrors[field.id] = "too_long";
    }
    if (field.pattern && !new RegExp(field.pattern).test(value)) {
      fail();
      fieldErrors[field.id] ??= "pattern";
    }
  });
  return { ok: errors.length === 0, errors, fieldErrors };
}

export function isLegacySenderConfig(role: string, ids: readonly string[]): boolean {
  if (role === "bot_admin" || role === "member") return true;
  if (role !== "any" && ids.length > 0) return true;
  return false;
}

export function senderModeFromSenders(
  role: ReactionSenderRole,
  ids: readonly string[],
): ReactionSenderMode {
  if (isLegacySenderConfig(role, ids)) return "custom";
  if (ids.length > 0) return "selected";
  if (
    role === "any" ||
    role === "owner_group_admin" ||
    role === "owner" ||
    role === "group_admin"
  ) {
    return role;
  }
  return "custom";
}

export function resolveSenderMode(
  draft: Pick<ReactionDraft, "role" | "senderIds" | "senderMode">,
): ReactionSenderMode {
  const ids = Array.isArray(draft.senderIds) ? draft.senderIds : [];
  if (isLegacySenderConfig(draft.role, ids)) return "custom";
  if (draft.senderMode === "selected") return "selected";
  if (draft.senderMode === "custom") return "custom";
  if (ids.length > 0 && draft.role === "any") return "selected";
  return senderModeFromSenders(draft.role, ids);
}

export function selectSenderMode(draft: ReactionDraft, mode: ReactionSenderMode): ReactionDraft {
  if (mode === "custom") {
    return resolveSenderMode(draft) === "custom" ? draft : draft;
  }
  if (mode === "selected") {
    return {
      ...draft,
      senderMode: "selected",
      role: "any",
    };
  }
  return {
    ...draft,
    senderMode: mode,
    role: mode,
    senderIds: [],
  };
}

export function selectReactionCommand(
  draft: ReactionDraft,
  commandKey: string,
  catalog?: readonly ReactionCommandSpec[],
): ReactionDraft {
  const spec = classifyReactionCommand(commandKey, catalog);
  if (spec.mode === "unsupported") return draft;
  const allowedTypes = spec.originalTypes.length ? [...spec.originalTypes] : [...ORIGINAL_TYPES];
  const transitions: ReactionTransition[] = spec.destructive
    ? ["add"]
    : draft.transitions.length
      ? [...draft.transitions]
      : ["add"];
  const commandArgs =
    spec.mode === "args"
      ? spec.fields.map((field) =>
          field.id === "status" && field.pattern === "^status$" ? "status" : "",
        )
      : [];
  return {
    ...draft,
    action: spec.key,
    commandArgs,
    originalTypes: allowedTypes,
    transitions,
  };
}

export function reuseUnchangedDraftArrays(next: ReactionDraft, base: ReactionDraft): ReactionDraft {
  const sameList = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((item, idx) => item === b[idx]);
  return {
    ...next,
    transitions: sameList(next.transitions, base.transitions) ? base.transitions : next.transitions,
    originalTypes: sameList(next.originalTypes, base.originalTypes)
      ? base.originalTypes
      : next.originalTypes,
    senderIds: sameList(next.senderIds, base.senderIds) ? base.senderIds : next.senderIds,
    commandArgs: sameList(next.commandArgs, base.commandArgs) ? base.commandArgs : next.commandArgs,
  };
}

/** Same grapheme / pictographic check as src/automation/rules.cjs. */
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
    originalTypes: [...ORIGINAL_TYPES],
    role: "owner",
    senderIds: [],
    senderMode: "owner",
    action: "",
    commandArgs: [],
    allowOthersOnLinkedMessages: false,
    destination: "same_chat",
    priority: PRIORITY_DEFAULT,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function commandNameOf(definition: Record<string, unknown> | null): string {
  const command = asRecord(definition?.command);
  if (typeof command?.name === "string") return command.name;
  return typeof definition?.action === "string" ? definition.action : "";
}

function commandArgsOf(definition: Record<string, unknown> | null): string[] {
  const command = asRecord(definition?.command);
  return stringList(command?.args);
}

/** Untrusted stored definition: never throw, give Edit a replaceable draft. */
export function draftFromRule(
  rule: ReactionRule,
  catalog?: readonly ReactionCommandSpec[],
): ReactionDraft {
  const definition = asRecord(rule.definition);
  const senders = asRecord(definition?.senders);
  const destination = asRecord(definition?.destination);
  const transitions = stringList(definition?.transitions).filter(
    (item): item is ReactionTransition => (TRANSITIONS as readonly string[]).includes(item),
  );
  const originalTypes = stringList(definition?.originalTypes).filter(
    (item): item is ReactionOriginalType => (ORIGINAL_TYPES as readonly string[]).includes(item),
  );
  const rawRole = senders?.role;
  const role: ReactionSenderRole = (SENDER_ROLES as readonly string[]).includes(rawRole as string)
    ? (rawRole as ReactionSenderRole)
    : "owner";
  const senderIds = stringList(senders?.ids).slice(0, SENDERS_MAX);
  const senderMode = senderModeFromSenders(role, senderIds);
  const rawName = commandNameOf(definition);
  const name = /^(?:group:)?[a-z][a-z0-9]*$/.test(rawName) ? rawName : "";
  const spec = name ? classifyReactionCommand(name, catalog) : null;
  const rawArgs = commandArgsOf(definition);
  const commandArgs =
    spec?.mode === "args" ? spec.fields.map((_, idx) => rawArgs[idx] ?? "") : rawArgs;
  const mode = destination?.mode;
  return {
    chatJid: typeof rule.chatJid === "string" ? rule.chatJid : "",
    chatName:
      typeof rule.chatName === "string" &&
      rule.chatName !== rule.chatJid &&
      !isRawJid(rule.chatName)
        ? rule.chatName
        : "",
    emoji: typeof definition?.emoji === "string" ? definition.emoji : "",
    transitions: spec?.destructive ? ["add"] : transitions.length ? transitions : ["add"],
    originalTypes: originalTypes.length
      ? originalTypes
      : name === "stt"
        ? ["voice"]
        : spec?.originalTypes.length
          ? [...spec.originalTypes]
          : [...ORIGINAL_TYPES],
    role,
    senderIds,
    senderMode,
    action: name,
    commandArgs,
    allowOthersOnLinkedMessages: definition?.allowOthersOnLinkedMessages === true,
    destination: mode === "owner_private" || mode === "same_chat" ? mode : "same_chat",
    priority: Number.isInteger(rule.priority) ? rule.priority : PRIORITY_DEFAULT,
  };
}

/** Card/title fallbacks when `valid` is false or `definition` is malformed. */
export function displayRuleMeta(rule: ReactionRule): {
  emoji: string;
  action: string;
  args: string[];
  destination: string;
  role: string;
  senderMode: ReactionSenderMode;
  senderCount: number;
} {
  const definition = asRecord(rule.definition);
  const senders = asRecord(definition?.senders);
  const destination = asRecord(definition?.destination);
  const emoji = definition?.emoji;
  const action = commandNameOf(definition);
  const args = commandArgsOf(definition);
  const mode = destination?.mode;
  const rawRole = typeof senders?.role === "string" ? senders.role : "";
  const ids = stringList(senders?.ids);
  const validRole: ReactionSenderRole = (SENDER_ROLES as readonly string[]).includes(rawRole)
    ? (rawRole as ReactionSenderRole)
    : "owner";
  const senderMode = rawRole ? senderModeFromSenders(validRole, ids) : "owner";
  return {
    emoji: typeof emoji === "string" && emoji ? emoji : rule.valid === false ? "?" : "—",
    action,
    args,
    destination: typeof mode === "string" ? mode : "",
    role: rawRole,
    senderMode,
    senderCount: ids.length,
  };
}

function normalizedArgsForWrite(
  spec: ReactionCommandSpec,
  rawArgs: readonly string[] | undefined,
): string[] {
  const list = Array.isArray(rawArgs) ? rawArgs : [];
  if (spec.mode !== "args") return [];
  const fields = spec.fields || [];
  const values = fields.map((_, index) => (typeof list[index] === "string" ? list[index] : ""));
  while (
    values.length > 0 &&
    values[values.length - 1] === "" &&
    !fields[values.length - 1]?.required
  ) {
    values.pop();
  }
  return values;
}

export function draftToWrite(
  draft: ReactionDraft,
  catalog?: readonly ReactionCommandSpec[],
): ReactionRuleWrite {
  if (!draft.action) throw new Error("REACTION_ACTION_REQUIRED");
  const spec = classifyReactionCommand(draft.action, catalog);
  if (spec.mode === "unsupported") throw new Error("REACTION_ACTION_UNSUPPORTED");
  const senderMode = resolveSenderMode(draft);
  const senderIds = Array.isArray(draft.senderIds) ? [...draft.senderIds] : [];
  if (senderMode === "selected" && senderIds.length === 0) {
    throw new Error("REACTION_SENDERS_REQUIRED");
  }
  const senders: ReactionDefinition["senders"] =
    senderMode === "selected"
      ? { role: "any", ids: senderIds }
      : senderMode === "custom"
        ? { role: draft.role, ids: senderIds }
        : { role: senderMode, ids: [] };
  const allowedTypes = spec.originalTypes.length ? spec.originalTypes : ORIGINAL_TYPES;
  const originalTypes: ReactionOriginalType[] =
    draft.action === "stt"
      ? ["voice"]
      : allowedTypes.length === 1 &&
          draft.originalTypes.length === 1 &&
          draft.originalTypes[0] === allowedTypes[0]
        ? [...allowedTypes]
        : draft.originalTypes.filter((type) => allowedTypes.includes(type));
  const transitions: ReactionTransition[] = spec.destructive ? ["add"] : [...draft.transitions];
  const args = normalizedArgsForWrite(spec, draft.commandArgs);
  const definition: ReactionDefinition = {
    version: 2,
    emoji: draft.emoji,
    transitions,
    originalTypes,
    senders,
    command: { name: draft.action, args },
    destination: { mode: draft.destination },
    ...(draft.allowOthersOnLinkedMessages === true ? { allowOthersOnLinkedMessages: true } : {}),
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

export function isRawJid(value: string | null | undefined): boolean {
  if (!value) return false;
  return /@(?:s\.whatsapp\.net|lid|g\.us)\b/i.test(value.trim());
}

export function peerLabel(
  jid: string | null | undefined,
  names?: ReadonlyMap<string, string>,
): string {
  if (!jid) return "";
  const known = names?.get(jid);
  if (known && known !== jid && !isRawJid(known)) return known;
  const phone = /^(\d+)@s\.whatsapp\.net$/i.exec(jid);
  if (phone) return `+${phone[1]}`;
  return "";
}

export function ruleChatLabel(
  rule: Pick<ReactionRule, "chatJid" | "chatName">,
  names?: ReadonlyMap<string, string>,
  fallback = "",
): string {
  if (
    typeof rule.chatName === "string" &&
    rule.chatName.trim() &&
    rule.chatName !== rule.chatJid &&
    !isRawJid(rule.chatName)
  ) {
    return rule.chatName.trim();
  }
  const resolved = peerLabel(rule.chatJid, names);
  if (resolved) return resolved;
  return fallback;
}

/** Client checks run before the read-only server check or any write. */
export function reactionDraftIssues(
  draft: ReactionDraft,
  catalog?: readonly ReactionCommandSpec[],
): ReactionIssue[] {
  const issues: ReactionIssue[] = [];
  if (!draft.chatJid) issues.push({ field: "chatJid", code: "required" });
  if (!isReactionEmoji(draft.emoji))
    issues.push({ field: "definition.emoji", code: draft.emoji ? "invalid" : "required" });

  const spec = draft.action ? classifyReactionCommand(draft.action, catalog) : null;
  if (!draft.action) {
    issues.push({ field: "definition.action", code: "invalid" });
  } else if (spec?.mode === "unsupported") {
    issues.push({ field: "definition.command.name", code: spec.reason || "UNCLASSIFIED" });
  } else if (spec) {
    const rawArgs = Array.isArray(draft.commandArgs) ? draft.commandArgs : [];
    const argsToCheck = spec.mode === "args" ? normalizedArgsForWrite(spec, rawArgs) : rawArgs;
    const argCheck = validateReactionCommandArgs(draft.action, argsToCheck, catalog);
    for (const err of argCheck.errors) issues.push(err);
    if (spec.destructive && (draft.transitions.length !== 1 || draft.transitions[0] !== "add")) {
      issues.push({ field: "definition.transitions", code: "add_only" });
    }
  }

  if (!draft.transitions.length) {
    issues.push({ field: "definition.transitions", code: "invalid" });
  }
  if (draft.action !== "stt") {
    if (!draft.originalTypes.length) {
      issues.push({ field: "definition.originalTypes", code: "invalid" });
    } else if (
      spec &&
      spec.mode !== "unsupported" &&
      spec.originalTypes.length > 0 &&
      draft.originalTypes.some((type) => !spec.originalTypes.includes(type))
    ) {
      issues.push({ field: "definition.originalTypes", code: "invalid" });
    }
  }

  const senderMode = resolveSenderMode(draft);
  const senderIds = Array.isArray(draft.senderIds) ? draft.senderIds : [];
  if (senderMode === "selected" && senderIds.length === 0) {
    issues.push({ field: "definition.senders.ids", code: "required" });
  }
  if (senderIds.length > SENDERS_MAX) {
    issues.push({ field: "definition.senders.ids", code: "too_many" });
  }
  if (new Set(senderIds).size !== senderIds.length) {
    issues.push({ field: "definition.senders.ids", code: "duplicate" });
  }
  return issues;
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

export function reactionOutcomeKey(code: string | null | undefined): string {
  switch (code) {
    case "DELIVERED":
      return "reactionOutcomeDelivered";
    case "NO_MATCH":
      return "reactionOutcomeNoMatch";
    case "BUSY":
      return "reactionOutcomeBusy";
    case "ACTION_FAILED":
      return "reactionOutcomeActionFailed";
    case "RATE_LIMIT":
      return "reactionOutcomeRateLimit";
    case "CAPACITY":
      return "reactionOutcomeCapacity";
    case "EVENT_MISSING":
      return "reactionOutcomeEventMissing";
    case "DUPLICATE":
      return "reactionOutcomeDuplicate";
    case "REACTION_CANCELLED":
      return "reactionOutcomeReactionCancelled";
    case "REACTION_TIMEOUT":
      return "reactionOutcomeReactionTimeout";
    case "REACTION_STALE":
      return "reactionOutcomeReactionStale";
    case "REACTION_INACCESSIBLE":
      return "reactionOutcomeReactionInaccessible";
    case "REACTION_FORBIDDEN":
      return "reactionOutcomeReactionForbidden";
    case "REACTION_STT_DISABLED":
      return "reactionOutcomeReactionSttDisabled";
    case "REACTION_DELIVERY_REFUSED":
      return "reactionOutcomeReactionDeliveryRefused";
    case "REACTION_CAPACITY":
      return "reactionOutcomeReactionCapacity";
    case "REACTION_IDENTITY_INVALID":
      return "reactionOutcomeReactionIdentityInvalid";
    case "REACTION_VOICE_REQUIRED":
      return "reactionOutcomeReactionVoiceRequired";
    case "STT_KEY_REQUIRED":
      return "reactionOutcomeSttKeyRequired";
    case "STT_OUTPUT_INVALID":
      return "reactionOutcomeSttOutputInvalid";
    case "MEDIA_AUDIO_INVALID":
      return "reactionOutcomeMediaAudioInvalid";
    case "MEDIA_TOO_LARGE":
      return "reactionOutcomeMediaTooLarge";
    case "MEDIA_NOT_AVAILABLE":
      return "reactionOutcomeMediaNotAvailable";
    case "MEDIA_URL_INVALID":
      return "reactionOutcomeMediaUrlInvalid";
    case "REACTION_COMMAND_DENIED":
      return "reactionOutcomeReactionCommandDenied";
    case "REACTION_COMMAND_UNSUPPORTED":
      return "reactionOutcomeReactionCommandUnsupported";
    case "REACTION_COMMAND_FAILED":
      return "reactionOutcomeReactionCommandFailed";
    default:
      return code ? "reactionStatusUnknown" : "reactionNeverRan";
  }
}

export function shouldShowAutomationOffCallout(
  automationEnabled: boolean,
  rules: readonly Pick<ReactionRule, "enabled">[],
): boolean {
  return !automationEnabled && rules.some((rule) => rule.enabled);
}

export function ruleMatchesFilters(rule: ReactionRule, filters: ReactionFilters): boolean {
  if (filters.action !== "any" && commandNameOf(asRecord(rule.definition)) !== filters.action)
    return false;
  const statuses = Array.isArray(rule.statuses) ? rule.statuses : [];
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
  } else if (sort === "recent") {
    const stamp = (rule: ReactionRule) => rule.runtime?.lastAt ?? rule.enabledAt ?? 0;
    list.sort((a, b) => stamp(b) - stamp(a) || byId(b, a));
  } else {
    list.sort((a, b) => a.priority - b.priority || byId(a, b));
  }
  return list;
}

export interface AutomationWriteDeps {
  send: (
    enabled: boolean,
    revision: string,
  ) => Promise<{ automation?: { enabled?: boolean; revision?: string } }>;
  revision: () => string;
  remember?: (revision: string) => void;
  reconcile: () => Promise<unknown>;
  show: (enabled: boolean) => void;
  busy: (pending: boolean) => void;
  failed: (err: unknown) => void;
  conflict?: (err: unknown) => void;
  alive: () => boolean;
  written: () => void;
}

function readAutomationEnabled(value: unknown): boolean | undefined {
  if (!value || typeof value !== "object" || !("automation" in value)) return undefined;
  const enabled = (value as { automation?: { enabled?: unknown } }).automation?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function readAutomationRevision(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || !("automation" in value)) return undefined;
  const revision = (value as { automation?: { revision?: unknown } }).automation?.revision;
  return typeof revision === "string" && revision ? revision : undefined;
}

/** Returns a toggle handler that allows one automation write at a time. */
export function createAutomationWriter(
  deps: AutomationWriteDeps,
): (enabled: boolean, previous: boolean) => Promise<boolean> {
  let pending = false;
  return async (enabled, previous) => {
    if (pending) return false;
    pending = true;
    deps.written();
    if (deps.alive()) deps.busy(true);
    let conflict: unknown = null;
    try {
      const res = await deps.send(enabled, deps.revision());
      const next = res.automation?.revision;
      if (typeof next === "string" && next) deps.remember?.(next);
      if (deps.alive()) deps.show(Boolean(res.automation?.enabled));
      return true;
    } catch (err) {
      if (reactionApiCode(err) === "REACTION_AUTOMATION_CHANGED") {
        conflict = err;
        return true;
      }
      if (deps.alive()) {
        deps.show(previous);
        deps.failed(err);
      }
      return true;
    } finally {
      pending = false;
      deps.written();
      if (deps.alive()) {
        deps.busy(false);
        const fresh = await deps.reconcile();
        if (conflict) {
          const server = readAutomationEnabled(fresh);
          if (server !== undefined) deps.show(server);
          const revision = readAutomationRevision(fresh);
          if (revision) deps.remember?.(revision);
          deps.conflict?.(conflict);
        }
      }
    }
  };
}

export function activeFilterCount(filters: ReactionFilters): number {
  return [filters.status, filters.action].filter((value) => value !== "any").length;
}

/** Backend paths like `definition.emoji` bucket as `emoji`; `chatJid` / `priority` / `body` stay. */
export function issueFieldName(field: string): string {
  const raw = String(field ?? "");
  return raw.startsWith("definition.") ? raw.slice("definition.".length) : raw;
}

export function issueBucket(field: string): string {
  const name = issueFieldName(field);
  if (name === "command.args" || name.startsWith("command.args.")) return "args";
  if (name === "command" || name.startsWith("command.")) return "action";
  if (name === "allowOthersOnLinkedMessages") return "senders";
  const root = name.split(".")[0];
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

export function reactionOriginalTypeLabel(
  t: (key: string) => string,
  value: ReactionOriginalType,
): string {
  if (value === "text") return t("reactionTypeText");
  if (value === "voice") return t("reactionTypeVoice");
  if (value === "audio") return t("reactionTypeAudio");
  if (value === "image") return t("reactionTypeImage");
  if (value === "video") return t("reactionTypeVideo");
  if (value === "document") return t("reactionTypeDocument");
  return t("reactionTypeSticker");
}

export function previewRequesterPhrase(
  t: (key: string) => string,
  mode: ReactionSenderMode,
  senderCount = 0,
): string {
  switch (mode) {
    case "owner":
      return t("reactionPreviewRequesterOwner");
    case "owner_group_admin":
      return t("reactionPreviewRequesterOwnerGroupAdmin");
    case "group_admin":
      return t("reactionPreviewRequesterGroupAdmin");
    case "any":
      return t("reactionPreviewRequesterAnyone");
    case "selected":
      return fill(t("reactionPreviewRequesterSelected"), { n: senderCount });
    case "custom":
      return t("reactionPreviewRequesterCustom");
  }
}

export type ReactionPersonVariant = "second" | "mixed" | "third";

export function resolvePersonVariant(mode: ReactionSenderMode): ReactionPersonVariant {
  if (mode === "owner") return "second";
  if (mode === "owner_group_admin") return "mixed";
  return "third";
}

export function previewTransitionsPhrase(
  t: (key: string) => string,
  transitions: readonly ReactionTransition[],
  person: ReactionPersonVariant | boolean,
  emoji: string = t("reactionPreviewEmoji"),
  types: string = t("reactionPreviewAllTypes"),
  who?: string,
): string {
  const normalizedPerson: ReactionPersonVariant =
    person === true || person === "second" ? "second" : person === "mixed" ? "mixed" : "third";

  const hasAdd = transitions.includes("add");
  const hasChange = transitions.includes("change");
  const hasRemove = transitions.includes("remove");

  const suffix =
    normalizedPerson === "second" ? "You" : normalizedPerson === "mixed" ? "Mixed" : "";

  let baseKey: string;
  if (hasAdd && hasChange && hasRemove) {
    baseKey = "reactionPreviewClauseAll";
  } else if (hasAdd && hasChange) {
    baseKey = "reactionPreviewClauseAddChange";
  } else if (hasAdd && hasRemove) {
    baseKey = "reactionPreviewClauseAddRemove";
  } else if (hasChange && hasRemove) {
    baseKey = "reactionPreviewClauseChangeRemove";
  } else if (hasAdd) {
    baseKey = "reactionPreviewClauseAdd";
  } else if (hasChange) {
    baseKey = "reactionPreviewClauseChange";
  } else if (hasRemove) {
    baseKey = "reactionPreviewClauseRemove";
  } else {
    baseKey = "reactionPreviewClauseAdd";
  }

  const key = `${baseKey}${suffix}`;

  const resolvedWho =
    who ??
    (normalizedPerson === "second"
      ? t("reactionPreviewRequesterOwner")
      : normalizedPerson === "mixed"
        ? t("reactionPreviewRequesterOwnerGroupAdmin")
        : t("reactionPreviewRequesterAnyone"));
  const resolvedEmoji = emoji || t("reactionPreviewEmoji");
  const resolvedTypes = types || t("reactionPreviewAllTypes");
  return fill(t(key), { who: resolvedWho, emoji: resolvedEmoji, types: resolvedTypes });
}

export function previewDestinationPhrase(
  t: (key: string) => string,
  destination: ReactionDestinationMode,
): string {
  return destination === "owner_private"
    ? t("reactionPreviewDestOwner")
    : t("reactionPreviewDestSame");
}

export function previewTypesPhrase(
  t: (key: string) => string,
  originalTypes: readonly ReactionOriginalType[],
  action: string,
): string {
  if (action !== "stt" && ORIGINAL_TYPES.every((type) => originalTypes.includes(type))) {
    return t("reactionPreviewAllTypes");
  }
  const typesToFormat = action === "stt" ? (["voice"] as const) : originalTypes;
  if (!typesToFormat.length) return t("reactionTypes");
  return (
    typesToFormat.map((item) => reactionOriginalTypeLabel(t, item)).join(t("reactionListJoin")) ||
    t("reactionTypes")
  );
}

export function previewActionPhrase(
  t: (key: string) => string,
  action: string,
  prefix = "!",
): string {
  if (action === "stt") {
    return t("reactionPreviewActionStt");
  }
  const commandToken = formatCommandToken(action, prefix);
  if (commandToken) {
    return fill(t("reactionPreviewActionCommand"), { command: commandToken });
  }
  return t("reactionPreviewActionUnset");
}

export function previewText(
  t: (key: string) => string,
  draft: ReactionDraft,
  prefix = "!",
): string {
  const mode = resolveSenderMode(draft);
  const person = resolvePersonVariant(mode);
  const who = previewRequesterPhrase(t, mode, draft.senderIds.length);
  const emoji = draft.emoji || t("reactionPreviewEmoji");
  const types = previewTypesPhrase(t, draft.originalTypes, draft.action);
  const clause = previewTransitionsPhrase(t, draft.transitions, person, emoji, types, who);
  const chat = draft.chatName.trim() || t("reactionPreviewChat");
  const action = previewActionPhrase(t, draft.action, prefix);
  const destination = previewDestinationPhrase(t, draft.destination);

  return fill(t("reactionPreview"), {
    who,
    clause,
    emoji,
    types,
    chat,
    action,
    destination,
  });
}
