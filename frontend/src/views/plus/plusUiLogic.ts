// file: frontend/src/views/plus/plusUiLogic.ts
import {
  type LabelCopy,
  type RecipientLike,
  type RecipientParts,
  labelRecipients,
} from "../../utils/recipientLabel.ts";
import {
  type AutoReplyChat,
  type AutoReplyConfig,
  type AutoReplyPolicy,
  type AutoReplyScopeMode,
  CHAT_JID_PATTERN,
  DEFAULT_AUTO_REPLY_POLICY,
  normalizeAutoReplyConfig,
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

export interface AutoReplySaveDeps {
  /** The document this tab holds, revision included. */
  current: AutoReplyConfig;
  /** The change to apply, computed from the document it is applied to. */
  patch: (current: AutoReplyConfig) => Partial<AutoReplyConfig>;
  put: (body: AutoReplyConfig) => Promise<AutoReplyConfig>;
  load: () => Promise<AutoReplyConfig>;
  isConflict: (error: unknown) => boolean;
}

/**
 * Saves one Auto Reply change with the revision this tab holds. A 409 CONFLICT
 * means another tab saved first: reload the stored document, then re-apply only
 * this change on top of it, so a toggle never reopens an exclusion somebody
 * else just added. Any other failure is the caller's to report.
 */
export async function saveAutoReplyPatch({
  current,
  patch,
  put,
  load,
  isConflict,
}: AutoReplySaveDeps): Promise<{
  config: AutoReplyConfig;
  reloaded: boolean;
  appliedBaseRevision?: number;
}> {
  const send = (base: AutoReplyConfig) => put(normalizeAutoReplyConfig(base, patch(base)));
  try {
    return {
      config: normalizeAutoReplyConfig(await send(current)),
      reloaded: false,
      appliedBaseRevision: current.revision,
    };
  } catch (error) {
    if (!isConflict(error)) throw error;
  }
  const fresh = normalizeAutoReplyConfig(await load());
  return {
    config: normalizeAutoReplyConfig(await send(fresh)),
    reloaded: true,
    appliedBaseRevision: fresh.revision,
  };
}

export type AutoReplyFormSaveResult =
  | { ok: true; config: AutoReplyConfig }
  | { ok: false; conflict: true; config: AutoReplyConfig; error: unknown };

export interface AutoReplyFormSaveDeps extends AutoReplySaveDeps {
  /**
   * The revision of the baseline the draft was last reset or reconciled from.
   * When provided, binds the save to the draft's base revision rather than
   * `current.revision`, so a queued save cannot borrow a newer revision fetched
   * by a concurrent toggle conflict recovery.
   */
  baseRevision?: number;
}

/**
 * Saves the full Auto Reply form bound to the draft's base revision. On 409
 * CONFLICT it reloads the stored document and returns `conflict: true` without
 * re-sending the stale form, so the caller resets to the reloaded document and
 * displays the translated conflict message.
 */
export async function saveAutoReplyForm(
  deps: AutoReplyFormSaveDeps,
): Promise<AutoReplyFormSaveResult> {
  const { current, patch, put, load, isConflict } = deps;
  const hasExplicitBase = Object.hasOwn(deps, "baseRevision");
  const revision = hasExplicitBase ? deps.baseRevision : current.revision;
  const body = normalizeAutoReplyConfig({ ...current, revision }, { ...patch(current), revision });
  try {
    const saved = await put(body);
    return { ok: true, config: normalizeAutoReplyConfig(saved) };
  } catch (error) {
    if (!isConflict(error)) throw error;
    const fresh = normalizeAutoReplyConfig(await load());
    return { ok: false, conflict: true, config: fresh, error };
  }
}

export type AutoReplyPolicyDraft = Omit<AutoReplyPolicy, "globalMemory">;

export type AutoReplyFormData = {
  baseRevision?: number;
  scopeMode: AutoReplyScopeMode;
  globalPerHour: number;
  chats: AutoReplyChat[];
  excludedChats: string[];
  policy: AutoReplyPolicyDraft;
};

export function policyDraftFrom(policy?: AutoReplyPolicy): AutoReplyPolicyDraft {
  const source = policy ?? DEFAULT_AUTO_REPLY_POLICY;
  return {
    privateTrigger: source.privateTrigger,
    groupTrigger: source.groupTrigger,
    keywords: [...source.keywords],
    instructions: source.instructions,
    cooldownSeconds: source.cooldownSeconds,
    perSenderPerHour: source.perSenderPerHour,
    perChatPerHour: source.perChatPerHour,
  };
}

export function autoReplyFormDataFrom(config: AutoReplyConfig): AutoReplyFormData {
  return {
    baseRevision:
      typeof config.revision === "number" &&
      Number.isSafeInteger(config.revision) &&
      config.revision >= 0
        ? config.revision
        : undefined,
    scopeMode: config.scopeMode ?? "only",
    globalPerHour: config.globalPerHour,
    chats: config.chats,
    excludedChats: config.excludedChats ?? [],
    policy: policyDraftFrom(config.policy),
  };
}

export function sameAutoReplyFormFields(a: AutoReplyFormData, b: AutoReplyFormData): boolean {
  return (
    a.scopeMode === b.scopeMode &&
    a.globalPerHour === b.globalPerHour &&
    JSON.stringify(a.chats) === JSON.stringify(b.chats) &&
    JSON.stringify(a.excludedChats) === JSON.stringify(b.excludedChats) &&
    JSON.stringify(a.policy) === JSON.stringify(b.policy)
  );
}

/**
 * Reconciles the local form draft when the saved baseline changes:
 * - After a 409 CONFLICT on a full-form save (`conflictReload: true`), replaces
 *   the draft with the newly reloaded baseline so the operator sees the server
 *   document that caused the conflict.
 * - After a full-form save completes, compares each draft field against the
 *   submitted snapshot (`submittedDraft`) so any edit made while the request
 *   was in flight is preserved and untouched fields adopt the server's baseline.
 * - After an immediate toggle updates the baseline: if the draft has no unsaved
 *   edits and is built on `previousBaseline`, it adopts `nextBaseline`; if the
 *   server's form fields did not change (only the toggle switch and revision
 *   changed) and the draft's `baseRevision` equals the revision of the server
 *   baseline the toggle was applied over (the immediately previous revision),
 *   the draft keeps its edits and advances `baseRevision` to
 *   `nextBaseline.baseRevision`; otherwise the draft keeps its original
 *   `baseRevision` and never merges list fields silently, so saving it gets 409
 *   CONFLICT.
 */
export function reconcileAutoReplyDraft({
  draft,
  previousBaseline,
  nextBaseline,
  submittedDraft = null,
  conflictReload = false,
  appliedBaseRevision,
}: {
  draft: AutoReplyFormData;
  previousBaseline: AutoReplyFormData;
  nextBaseline: AutoReplyFormData;
  submittedDraft?: AutoReplyFormData | null;
  conflictReload?: boolean;
  appliedBaseRevision?: number;
}): AutoReplyFormData {
  if (conflictReload) return nextBaseline;
  if (submittedDraft === null) {
    const hasDraftEdits =
      !sameAutoReplyFormFields(draft, previousBaseline) ||
      draft.baseRevision !== previousBaseline.baseRevision;
    if (!hasDraftEdits) return nextBaseline;
    const baselineFormChanged = !sameAutoReplyFormFields(previousBaseline, nextBaseline);
    const expectedPreviousRevision =
      appliedBaseRevision !== undefined
        ? appliedBaseRevision
        : nextBaseline.baseRevision !== undefined && nextBaseline.baseRevision > 0
          ? nextBaseline.baseRevision - 1
          : undefined;
    const canAdvanceBaseRevision =
      !baselineFormChanged &&
      ((draft.baseRevision === undefined &&
        previousBaseline.baseRevision === undefined &&
        nextBaseline.baseRevision === undefined) ||
        (draft.baseRevision !== undefined &&
          draft.baseRevision === previousBaseline.baseRevision &&
          expectedPreviousRevision !== undefined &&
          draft.baseRevision === expectedPreviousRevision));
    if (!canAdvanceBaseRevision) {
      return {
        ...draft,
        baseRevision:
          draft.baseRevision !== undefined ? draft.baseRevision : previousBaseline.baseRevision,
      };
    }
  }
  const ref = submittedDraft ?? previousBaseline;
  const editedScope = draft.scopeMode !== ref.scopeMode;
  const editedLimit = draft.globalPerHour !== ref.globalPerHour;
  const editedChats = JSON.stringify(draft.chats) !== JSON.stringify(ref.chats);
  const editedExcluded = JSON.stringify(draft.excludedChats) !== JSON.stringify(ref.excludedChats);
  const editedPolicy = JSON.stringify(draft.policy) !== JSON.stringify(ref.policy);
  return {
    baseRevision: nextBaseline.baseRevision,
    scopeMode: editedScope ? draft.scopeMode : nextBaseline.scopeMode,
    globalPerHour: editedLimit ? draft.globalPerHour : nextBaseline.globalPerHour,
    chats: editedChats ? draft.chats : nextBaseline.chats,
    excludedChats: editedExcluded ? draft.excludedChats : nextBaseline.excludedChats,
    policy: editedPolicy ? draft.policy : nextBaseline.policy,
  };
}

/** True when a peer title is a formatted phone number (e.g. "+201 000 000 010"). */
export function isPhoneTitle(title: string): boolean {
  const trimmed = String(title || "").trim();
  return /^\+?\d[\d\s()-]*$/.test(trimmed);
}

const SAMPLE_PLACEHOLDER_VALUES: Readonly<Record<string, string>> = Object.freeze({
  action: "delete",
  actionText: "Deleted",
  add: "added",
  admin: "Alex",
  allowed: "allowed",
  amount: "50",
  atLimit: "5",
  baileysVersion: "7.0.0",
  blocked: "blocked",
  brand: "Levix",
  brandName: "Levix",
  char: "!",
  chat: "Family",
  chatCount: "3",
  city: "Cairo",
  code: "ABC123",
  command: "!help",
  content: "Sample message",
  count: "3",
  create: "created",
  creditor: "Alex",
  cron: "0 9 * * *",
  current: "3",
  currentVersion: "2.0.1",
  date: "2026-11-20",
  day: "Monday",
  days: "3",
  debtor: "Sam",
  deletedCount: "4",
  description: "Sample description",
  detail: "Detail",
  details: "Details",
  dir: "/home/levix/data",
  domainToAllow: "example.com",
  domainToDisallow: "spam.example",
  emoji: "👍",
  entries: "5",
  errorMessage: "Something failed",
  errorName: "Error",
  expression: "2 + 2",
  failed: "1",
  feature: "Auto Reply",
  featureName: "Auto Reply",
  feelsLike: "31°C",
  ffmpegLine: "ffmpeg -i input.mp4",
  field: "name",
  fields: "2",
  fileName: "photo.jpg",
  globalCount: "12",
  globalJobs: "2",
  got: "3",
  group: "Family",
  hint: "Type !help",
  hintBlock: "Type !help for the list",
  hours: "2",
  humidity: "40%",
  i: "1",
  id: "12",
  ids: "12, 13",
  introPrice: "$1.99",
  items: "5",
  keyword: "urgent",
  keywordCount: "2",
  keywords: "urgent, help",
  kind: "photo",
  label: "Label",
  last: "5",
  latestVersion: "5.0.1",
  lead: "Alex",
  limit: "5",
  limitAction: "delete",
  limitFrames: "60",
  limitMb: "16",
  linkAction: "delete",
  linkMode: "on",
  list: "1, 2, 3",
  match: "contains",
  max: "10",
  maxDice: "6",
  maxItems: "10",
  maxSides: "20",
  maxSplit: "5",
  maxWarnings: "3",
  mediaAction: "warn",
  member: "Alex",
  memoryMb: "256",
  mentionTag: "@Alex",
  message: "Sample message",
  messageCount: "5",
  min: "1",
  minute: "5",
  minutes: "5",
  mode: "on",
  months: "12",
  more: "3 more",
  n: "5",
  name: "Levix",
  names: "photos, videos",
  next: "2",
  nodeVersion: "24.22.2",
  notify: "group",
  number: "7",
  option: "2",
  osFamily: "Linux",
  osRelease: "6.8",
  outcome: "deleted",
  pack: "Favorites",
  page: "1",
  pages: "3",
  path: "/home/levix/data",
  perChat: "30",
  perReactor: "3",
  perRule: "5",
  percent: "15%",
  period: "30 days",
  place: "Cairo",
  platform: "android",
  prefix: "!",
  price: "$1.99",
  prompt: "Say hello",
  provider: "gemini",
  query: "weather in Cairo",
  question: "Which one?",
  quotedText: "Hello!",
  raw: "raw text",
  reason: "Contains a forbidden word",
  ref: "ABC123",
  renewalMonth: "December",
  requested: "3",
  rest: "2 more",
  role: "admin",
  rule: "Auto delete",
  rules: "2",
  scope: "all",
  seconds: "30",
  sections: "3",
  sender: "Alex",
  shown: "5",
  size: "12.3 MB",
  skipped: "1",
  spam: "2",
  spamAction: "warn",
  state: "on",
  status: "connected",
  sticker: "Favorites 1",
  summary: "Chat summary",
  symbol: "+",
  tag: "urgent",
  target: "Alex",
  task: "Send the report",
  temp: "28°C",
  text: "Sample message",
  time: "09:00",
  timeWindow: "30 minutes",
  title: "Title",
  total: "5",
  transcription: "Sample voice note",
  transitions: "add, remove",
  typeToBlock: "block",
  typeToUnblock: "unblock",
  types: "photo, video",
  unchanged: "3",
  uptime: "2 days",
  url: "https://example.com",
  used: "3",
  user: "Alex",
  value: "5",
  version: "5.0.1",
  warningDate: "2026-11-20",
  when: "09:00",
  who: "Alex",
  wind: "12 km/h",
  windowSec: "30",
  windowSeconds: "30",
  winner: "Alex",
  word: "urgent",
});

/** `currentVersion` becomes "Current version": words, never a `<token>`. */
export function humanizePlaceholder(name: string): string {
  const words = String(name || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return "";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export function hasSamplePlaceholderValue(name: string): boolean {
  return Object.hasOwn(SAMPLE_PLACEHOLDER_VALUES, name);
}

/**
 * A readable sample for a placeholder. A list preview never shows a token, so a
 * name without a curated sample becomes its own words ("chatCount" -> "Chat
 * count") instead of `<chatCount>`. `tests/plus-ui-logic.test.mjs` walks every
 * placeholder in the bot catalogs and fails on a token or an empty sample.
 */
export function samplePlaceholderValue(name: string): string {
  if (hasSamplePlaceholderValue(name)) {
    return SAMPLE_PLACEHOLDER_VALUES[name];
  }
  return humanizePlaceholder(name) || "Sample";
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
