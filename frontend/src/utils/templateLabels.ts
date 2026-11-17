// file: frontend/src/utils/templateLabels.ts
import type { MessageKey } from "../i18n/translations";

/** Public bot catalogs. An unknown area uses the "Other" label. */
const AREA_LABELS: Record<string, MessageKey> = {
  ai: "plusAreaAi" as MessageKey,
  core: "plusAreaCore" as MessageKey,
  group: "plusAreaGroup" as MessageKey,
  help: "plusAreaHelp" as MessageKey,
  lang: "plusAreaLang" as MessageKey,
  moderation: "plusAreaModeration" as MessageKey,
  schedules: "plusAreaSchedules" as MessageKey,
  stickers: "plusAreaStickers" as MessageKey,
  tools: "plusAreaTools" as MessageKey,
};

const OTHER_AREA = "plusAreaOther" as MessageKey;

const PLACEHOLDER_LABELS: Record<string, MessageKey> = {
  count: "plusPlaceholderCount" as MessageKey,
  name: "plusPlaceholderName" as MessageKey,
  user: "plusPlaceholderUser" as MessageKey,
  group: "plusPlaceholderGroup" as MessageKey,
  n: "plusPlaceholderN" as MessageKey,
  emoji: "plusPlaceholderEmoji" as MessageKey,
  prefix: "plusPlaceholderPrefix" as MessageKey,
  command: "plusPlaceholderCommand" as MessageKey,
};

const OTHER_PLACEHOLDER = "plusPlaceholderValue" as MessageKey;

/** Command names the bot actually answers to. A template segment outside this set is omitted. */
const COMMAND_WORDS = new Set([
  "add",
  "all",
  "antilink",
  "antispam",
  "approveall",
  "autodelete",
  "autoschedule",
  "blacklist",
  "block",
  "calc",
  "clearwarns",
  "debt",
  "deletenote",
  "deleteschedule",
  "demote",
  "digit",
  "flagged",
  "gemini",
  "group",
  "help",
  "kick",
  "lang",
  "listschedules",
  "loop",
  "md",
  "media",
  "members",
  "memory",
  "mod",
  "note",
  "notes",
  "pack",
  "packs",
  "perm",
  "ping",
  "policy",
  "poll",
  "prayer",
  "promote",
  "qr",
  "rand",
  "removeall",
  "restart",
  "rules",
  "save",
  "schedule",
  "score",
  "send",
  "setname",
  "setpp",
  "setprefix",
  "setrules",
  "setwarn",
  "shortlink",
  "status",
  "sticker",
  "stickers",
  "stopbot",
  "stt",
  "tagadmins",
  "todo",
  "toimage",
  "translate",
  "tts",
  "unblock",
  "update",
  "warn",
  "warns",
  "weather",
  "welcome",
]);

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

export type TemplatePart = { kind: "text"; text: string } | { kind: "token"; text: string };

/** `bot.<area>.…` or a bare area id from the filter. */
export function templateArea(key: string): string {
  const parts = key.split(".").filter(Boolean);
  if (parts[0] === "bot" && parts.length >= 2) return parts[1] ?? "";
  return parts[0] ?? "";
}

/** Dashboard key for the area caption and the area filter. */
export function areaLabelKey(key: string): MessageKey {
  return AREA_LABELS[templateArea(key)] ?? OTHER_AREA;
}

/**
 * The command segment of `bot.<area>.<command>.…` when that word is a real command.
 * Otherwise null, so the row does not invent a `!name`.
 */
export function templateCommand(key: string): string | null {
  const parts = key.split(".").filter(Boolean);
  if (parts[0] !== "bot" || parts.length < 3) return null;
  const word = parts[2] ?? "";
  return COMMAND_WORDS.has(word) ? word : null;
}

/** What `{name}` inserts. Unknown names share one explanation. */
export function placeholderExplainKey(name: string): MessageKey {
  return PLACEHOLDER_LABELS[name] ?? OTHER_PLACEHOLDER;
}

/** Split catalog text so `{count}` can render as its own token. */
export function splitTemplateText(text: string): TemplatePart[] {
  const parts: TemplatePart[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    parts.push({ kind: "token", text: match[0] });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  if (parts.length === 0) parts.push({ kind: "text", text });
  return parts;
}

/** A row needs an expand control when two lines cannot hold it. */
export function templateIsLong(text: string): boolean {
  if (text.split("\n").length > 2) return true;
  return text.length > 96;
}
