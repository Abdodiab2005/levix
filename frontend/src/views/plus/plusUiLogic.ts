// file: frontend/src/views/plus/plusUiLogic.ts
import {
  type LabelCopy,
  type RecipientLike,
  type RecipientParts,
  labelRecipients,
} from "../../utils/recipientLabel.ts";
import {
  type AutoReplyChat,
  type AutoReplyPolicy,
  type AutoReplyScopeMode,
  CHAT_JID_PATTERN,
  DEFAULT_AUTO_REPLY_POLICY,
  PLUS_LIMITS,
  type PlusLocale,
  type PlusPreset,
  type PlusTemplateKey,
  type PlusTemplateMode,
  isGroupJid,
} from "./types.ts";

export function showsPlusUntil(state: string): boolean {
  return state === "active" || state === "grace" || state === "canceled";
}

/**
 * Entitlement states in which an owned, acknowledged Play subscription means the
 * server record may be stale. "inactive" covers a subscription that came back with
 * the same purchase token, for example after account hold or pause.
 */
const RECOVERY_REFRESH_STATES: ReadonlySet<string> = new Set([
  "none",
  "expired",
  "unverified",
  "inactive",
]);

/**
 * The verifier answers from its cached Play state for up to 10 minutes unless an
 * RTDN updates it, so a repeated refresh for the same purchases sooner rarely
 * changes the answer.
 */
export const RECOVERY_REFRESH_COOLDOWN_MS = 5 * 60_000;

/** Allows one recovery refresh per set of purchase tokens per cooldown. */
export function createRecoveryRefreshGate(
  cooldownMs = RECOVERY_REFRESH_COOLDOWN_MS,
  now: () => number = Date.now,
) {
  const last = new Map<string, number>();
  return {
    take(tokens: string[]): boolean {
      const key = [...tokens].sort().join("\n");
      const at = now();
      const previous = last.get(key);
      if (previous !== undefined && at - previous < cooldownMs) return false;
      last.set(key, at);
      return true;
    },
  };
}

export type RecoveryGate = ReturnType<typeof createRecoveryRefreshGate>;

export interface RecoveryPurchase {
  status: string;
  acknowledged: boolean;
  purchaseToken: string;
}

/**
 * Foreground recovery of Play purchases. Unacknowledged purchases are claimed.
 * An acknowledged purchase only asks the server to re-verify; the displayed
 * entitlement always comes from the server, never from the Play result.
 */
export async function recoverPlusPurchases<P extends RecoveryPurchase>({
  purchases,
  state,
  claim,
  readState,
  refresh,
  gate,
}: {
  purchases: P[];
  state: string | undefined;
  claim: (fresh: P[]) => Promise<void>;
  readState: () => Promise<string | undefined>;
  refresh: () => Promise<void>;
  gate: RecoveryGate;
}): Promise<"claimed" | "refreshed" | "skipped" | "none"> {
  const owned = purchases.filter((purchase) => purchase.status === "purchased");
  const fresh = owned.filter((purchase) => !purchase.acknowledged);
  const acknowledged = owned.filter((purchase) => purchase.acknowledged);
  if (fresh.length > 0) await claim(fresh);
  if (acknowledged.length === 0) return fresh.length > 0 ? "claimed" : "none";
  const current = fresh.length > 0 ? await readState() : state;
  if (!current || !RECOVERY_REFRESH_STATES.has(current)) {
    return fresh.length > 0 ? "claimed" : "none";
  }
  if (!gate.take(acknowledged.map((purchase) => purchase.purchaseToken))) return "skipped";
  await refresh();
  return "refreshed";
}

export function createRequestGeneration() {
  let generation = 0;
  return {
    begin: () => ++generation,
    isCurrent: (token: number) => token === generation,
  };
}

/**
 * Reads may overlap, but only the newest one calls `show`. A read that fails after a
 * newer read began settles with the newer read's outcome, so its caller cannot report
 * an error over a status the newer read already displayed. `cancel` makes every
 * pending read stale and lets a stale failure reject with its own error.
 */
export function createLatestReader<T>(fetch: () => Promise<T>, show: (value: T | null) => void) {
  const reads = createRequestGeneration();
  let latest: Promise<T> | null = null;
  return {
    read(): Promise<T> {
      const token = reads.begin();
      const request = fetch().then(
        (value) => {
          if (reads.isCurrent(token)) show(value);
          return value;
        },
        (err) => {
          if (reads.isCurrent(token)) {
            // Only the latest read can clear the displayed value.
            show(null);
            throw err;
          }
          if (latest) return latest;
          throw err;
        },
      );
      latest = request;
      return request;
    },
    cancel() {
      reads.begin();
      latest = null;
    },
  };
}

export interface WriteQueue {
  enqueue<T>(task: () => Promise<T>): Promise<T>;
}

export function createWriteQueue(): WriteQueue {
  let tail = Promise.resolve();
  return {
    enqueue<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        tail = tail
          .catch(() => {})
          .then(async () => {
            try {
              const res = await task();
              resolve(res);
            } catch (err) {
              reject(err);
            }
          });
      });
    },
  };
}

const SAMPLE_PLACEHOLDER_VALUES: Readonly<Record<string, string>> = Object.freeze({
  name: "Levix",
  count: "3",
  quotedText: "Hello!",
  user: "Alex",
  sender: "Alex",
  member: "Alex",
  winner: "Alex",
  who: "Alex",
  group: "Family",
  n: "5",
  total: "5",
  limit: "5",
  max: "10",
  min: "1",
  page: "1",
  pages: "3",
  emoji: "👍",
  prefix: "!",
  city: "Cairo",
  place: "Cairo",
  time: "09:00",
  date: "2026-11-20",
  pack: "Favorites",
  text: "Sample message",
  message: "Sample message",
  content: "Sample message",
  transcription: "Sample voice note",
  summary: "Chat summary",
  url: "https://example.com",
});

export function samplePlaceholderValue(name: string): string {
  if (Object.hasOwn(SAMPLE_PLACEHOLDER_VALUES, name)) {
    return SAMPLE_PLACEHOLDER_VALUES[name];
  }
  return `<${name}>`;
}

export function substitutePlaceholders(template: string): string {
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) =>
    samplePlaceholderValue(name),
  );
}

export function getDraftText(
  locale: PlusLocale,
  mode: PlusTemplateMode,
  sourceLocale: PlusLocale,
  sourceText: string,
  manual: Partial<Record<PlusLocale, string>>,
): string {
  if (mode === "original") {
    return sourceText;
  }
  if (locale === sourceLocale) {
    return sourceText;
  }
  return manual[locale]?.trim() || "";
}

function filled(value: string | undefined): string {
  const text = value ?? "";
  return text.trim() ? text : "";
}

/** Panel language, then English. A saved override wins over the shipped catalog. */
export function visibleTemplateText(item: PlusTemplateKey, locale: PlusLocale): string {
  const values = item.override?.values;
  const source = item.override?.source;
  const overrideText = (loc: PlusLocale) =>
    filled(values?.[loc]) || (source?.locale === loc ? filled(source.text) : "");
  return (
    overrideText(locale) ||
    filled(item.catalog[locale]) ||
    (locale === "en" ? "" : overrideText("en")) ||
    filled(item.catalog.en)
  );
}

/** Human-readable preview for list rows: placeholders are always substituted with sample values. */
export function visibleTemplatePreview(item: PlusTemplateKey, locale: PlusLocale): string {
  const raw = visibleTemplateText(item, locale);
  return raw ? substitutePlaceholders(raw) : "";
}

export type MessageSort = "area" | "customized" | "command";

export function filterAndSortTemplateKeys(
  keys: readonly PlusTemplateKey[],
  options: {
    search: string;
    area: string;
    onlyCustomized: boolean;
    sort: MessageSort;
    areaOf: (key: string) => string;
    areaLabel: (key: string) => string;
    commandOf: (key: string) => string | null;
    locale?: string;
  },
): PlusTemplateKey[] {
  const needle = options.search.trim().toLowerCase();
  const filtered = keys.filter((item) => {
    if (options.area !== "all" && options.areaOf(item.key) !== options.area) return false;
    if (options.onlyCustomized && !item.override) return false;
    if (!needle) return true;
    const preview = [
      ...Object.values(item.catalog),
      ...Object.values(item.override?.values ?? {}),
      item.override?.source?.text,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n")
      .toLowerCase();
    const command = (options.commandOf(item.key) ?? "").toLowerCase();
    const areaName = options.areaLabel(item.key).toLowerCase();
    return preview.includes(needle) || command.includes(needle) || areaName.includes(needle);
  });

  const loc = options.locale || "en";
  return [...filtered].sort((a, b) => {
    if (options.sort === "customized") {
      const aCustom = a.override ? 1 : 0;
      const bCustom = b.override ? 1 : 0;
      if (aCustom !== bCustom) return bCustom - aCustom;
    } else if (options.sort === "command") {
      const aCmd = options.commandOf(a.key) ?? "\uffff";
      const bCmd = options.commandOf(b.key) ?? "\uffff";
      const cmp = aCmd.localeCompare(bCmd, loc);
      if (cmp !== 0) return cmp;
    }
    const areaCmp = options.areaLabel(a.key).localeCompare(options.areaLabel(b.key), loc);
    if (areaCmp !== 0) return areaCmp;
    return a.key.localeCompare(b.key);
  });
}

export type PresetTranslationKey =
  | "plusPresetMinimalName"
  | "plusPresetMinimalDesc"
  | "plusPresetProfessionalName"
  | "plusPresetProfessionalDesc"
  | "plusPresetFunName"
  | "plusPresetFunDesc";

/** Localized name and description for known Plus presets, with safe fallback to server text. */
export function presetDisplayCopy(
  preset: Pick<PlusPreset, "id" | "name" | "description">,
  t: (key: PresetTranslationKey) => string,
): { name: string; description: string } {
  const id = String(preset.id || "")
    .trim()
    .toLowerCase();
  if (id === "minimal") {
    return {
      name: t("plusPresetMinimalName") || preset.name,
      description: t("plusPresetMinimalDesc") || preset.description,
    };
  }
  if (id === "professional") {
    return {
      name: t("plusPresetProfessionalName") || preset.name,
      description: t("plusPresetProfessionalDesc") || preset.description,
    };
  }
  if (id === "fun") {
    return {
      name: t("plusPresetFunName") || preset.name,
      description: t("plusPresetFunDesc") || preset.description,
    };
  }
  return { name: preset.name, description: preset.description };
}

/**
 * Switching the response scope mode keeps both the selected chat rows (`chats`)
 * and the excluded JIDs list (`excludedChats`) intact.
 */
export function setAutoReplyScopeMode<
  T extends {
    scopeMode?: AutoReplyScopeMode;
    chats: AutoReplyChat[];
    excludedChats?: string[];
  },
>(state: T, scopeMode: AutoReplyScopeMode): T {
  return {
    ...state,
    scopeMode,
    chats: [...state.chats],
    excludedChats: Array.isArray(state.excludedChats) ? [...state.excludedChats] : [],
  };
}

export function addExcludedChat(
  excludedChats: readonly string[],
  jid: string,
  max: number = PLUS_LIMITS.autoReplyExcludedChats,
): {
  excludedChats: string[];
  added: boolean;
  reason: "invalid" | "duplicate" | "limit" | null;
} {
  const value = String(jid || "").trim();
  if (!CHAT_JID_PATTERN.test(value)) {
    return { excludedChats: [...excludedChats], added: false, reason: "invalid" };
  }
  if (excludedChats.includes(value)) {
    return { excludedChats: [...excludedChats], added: false, reason: "duplicate" };
  }
  if (excludedChats.length >= max) {
    return { excludedChats: [...excludedChats], added: false, reason: "limit" };
  }
  return { excludedChats: [...excludedChats, value], added: true, reason: null };
}

export function removeExcludedChat(excludedChats: readonly string[], jid: string): string[] {
  const value = String(jid || "").trim();
  return excludedChats.filter((item) => item !== value);
}

export function createDefaultAutoReplyChat(
  jid: string,
  policy: AutoReplyPolicy = DEFAULT_AUTO_REPLY_POLICY,
): AutoReplyChat {
  const value = String(jid || "").trim();
  const group = isGroupJid(value);
  return {
    jid: value,
    enabled: true,
    trigger: group ? policy.groupTrigger : policy.privateTrigger,
    keywords: [],
    instructions: "",
    cooldownSeconds: policy.cooldownSeconds,
    perSenderPerHour: policy.perSenderPerHour,
    perChatPerHour: policy.perChatPerHour,
    globalMemory: { read: false },
  };
}

export function addAutoReplyChat(
  chats: readonly AutoReplyChat[],
  jid: string,
  policy: AutoReplyPolicy = DEFAULT_AUTO_REPLY_POLICY,
  max: number = PLUS_LIMITS.autoReplyChats,
): {
  chats: AutoReplyChat[];
  chat: AutoReplyChat | null;
  added: boolean;
  reason: "invalid" | "duplicate" | "limit" | null;
} {
  const value = String(jid || "").trim();
  if (!CHAT_JID_PATTERN.test(value)) {
    return { chats: [...chats], chat: null, added: false, reason: "invalid" };
  }
  if (chats.some((item) => item.jid === value)) {
    return { chats: [...chats], chat: null, added: false, reason: "duplicate" };
  }
  if (chats.length >= max) {
    return { chats: [...chats], chat: null, added: false, reason: "limit" };
  }
  const chat = createDefaultAutoReplyChat(value, policy);
  return { chats: [...chats, chat], chat, added: true, reason: null };
}

export function removeAutoReplyChat(chats: readonly AutoReplyChat[], jid: string): AutoReplyChat[] {
  const value = String(jid || "").trim();
  return chats.filter((item) => item.jid !== value);
}

export function fallbackRecipientForJid(jid: string): RecipientLike {
  const clean = String(jid || "").trim();
  if (clean.endsWith("@g.us")) {
    return { id: clean, type: "group", nameSource: "none" };
  }
  const phoneMatch = /^(\d+)@s\.whatsapp\.net$/i.exec(clean);
  if (phoneMatch) {
    return {
      id: clean,
      type: "contact",
      phone: `+${phoneMatch[1]}`,
      nameSource: "phone",
    };
  }
  return { id: clean, type: "contact", nameSource: "none" };
}

export function describeAutoReplyPeers(
  jids: readonly string[],
  recipients: readonly RecipientLike[],
  t: LabelCopy,
  locale = "en",
): Map<string, RecipientParts> {
  const byId = new Map<string, RecipientLike>();
  for (const item of recipients) {
    const id = String(item.id || item.targetJid || "").trim();
    if (id) byId.set(id, item);
  }
  const uniqueJids = [...new Set(jids.map((jid) => String(jid || "").trim()).filter(Boolean))];
  const items = uniqueJids.map((jid) => byId.get(jid) ?? fallbackRecipientForJid(jid));
  const parts = labelRecipients(items, t, locale);
  const out = new Map<string, RecipientParts>();
  uniqueJids.forEach((jid, idx) => {
    if (parts[idx]) out.set(jid, parts[idx]);
  });
  return out;
}
