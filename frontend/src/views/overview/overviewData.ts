// file: frontend/src/views/overview/overviewData.ts
// Pure derivation helpers for the Overview screen. No React import so root Node
// tests can exercise every signal directly.

import type { ViewTab } from "../../components/Sidebar";
import type { MessageKey } from "../../i18n/translations";
import type { ReactionOverview, ScheduleItem, SessionStatus } from "../../types";
import {
  accessFromStatus,
  isPlusSubscribed,
  type PlusStatusInput,
} from "../../utils/plusAccess.ts";

export type OverviewAttentionId =
  | "session"
  | "ai_key"
  | "plus"
  | "schedule_failed"
  | "reactions_switch_off"
  | "reactions_failed";

export interface OverviewAttentionItem {
  id: OverviewAttentionId;
  tone: "warn" | "danger";
  titleKey: MessageKey;
  metaKey: MessageKey;
  metaCount?: number;
  actionKey: MessageKey;
  targetView: ViewTab;
  targetHash: string;
}

export interface OverviewQuickAction {
  id: "connect" | "reaction" | "schedule" | "ai" | "backup";
  labelKey: MessageKey;
  descKey: MessageKey;
  view: ViewTab;
  hash: string;
}

export interface SettingRowLike {
  key: string;
  value?: unknown;
  configured?: boolean;
}

export interface TodoRowLike {
  user_id?: string;
  tasks?: unknown[];
}

export interface OpenTodoItem {
  id: string;
  text: string;
}

const PROVIDER_KEY_MAP: Record<string, string> = {
  gemini: "gemini_api_key",
  openai: "openai_api_key",
  anthropic: "anthropic_api_key",
};

const NON_FAILURE_REACTION_CODES = new Set(["DELIVERED", "NO_MATCH", "DUPLICATE"]);

export function isActiveProviderKeyConfigured(
  settings: readonly SettingRowLike[] | null | undefined,
  statsAiConfigured?: boolean | null,
): boolean {
  if (Array.isArray(settings) && settings.length > 0) {
    const providerRow = settings.find((row) => row.key === "ai_provider");
    const provider = String(providerRow?.value || "gemini").toLowerCase();
    const keySetting = PROVIDER_KEY_MAP[provider] || "gemini_api_key";
    const keyRow = settings.find((row) => row.key === keySetting);
    if (keyRow) {
      if (typeof keyRow.configured === "boolean") return keyRow.configured;
      return Boolean(keyRow.value);
    }
  }
  if (typeof statsAiConfigured === "boolean") return statsAiConfigured;
  return true;
}

export function isReactionOutcomeFailure(code: string | null | undefined): boolean {
  if (typeof code !== "string" || !code.trim()) return false;
  return !NON_FAILURE_REACTION_CODES.has(code.trim());
}

export function buildAttentionItems(input: {
  status: SessionStatus | null;
  settings?: readonly SettingRowLike[] | null;
  statsAiConfigured?: boolean | null;
  plusStatus?: PlusStatusInput | null;
  plusAvailable?: boolean | null;
  schedules?: readonly ScheduleItem[] | null;
  reactions?: Partial<ReactionOverview> | null;
}): OverviewAttentionItem[] {
  const items: OverviewAttentionItem[] = [];
  const { status, settings, statsAiConfigured, plusStatus, plusAvailable, schedules, reactions } =
    input;

  // 1. Session state
  if (status) {
    const isLinked = Boolean(status.linked || status.user?.id);
    if (status.state === "consent_required") {
      items.push({
        id: "session",
        tone: "warn",
        titleKey: "overviewAttentionConsentTitle",
        metaKey: "overviewAttentionConsentMeta",
        actionKey: "overviewAttentionReviewAction",
        targetView: "connection",
        targetHash: "#connection",
      });
    } else if (status.state === "logged_out") {
      items.push({
        id: "session",
        tone: "danger",
        titleKey: "overviewAttentionLoggedOutTitle",
        metaKey: "overviewAttentionLoggedOutMeta",
        actionKey: "overviewAttentionPairAction",
        targetView: "connection",
        targetHash: "#connection",
      });
    } else if (status.state === "retry_exhausted" || status.state === "error") {
      items.push({
        id: "session",
        tone: "danger",
        titleKey: "overviewAttentionSessionErrorTitle",
        metaKey: "overviewAttentionSessionErrorMeta",
        actionKey: "overviewAttentionReconnectAction",
        targetView: "connection",
        targetHash: "#connection",
      });
    } else if (isLinked && status.state !== "connected") {
      items.push({
        id: "session",
        tone: "warn",
        titleKey: "overviewAttentionDisconnectedTitle",
        metaKey: "overviewAttentionDisconnectedMeta",
        actionKey: "overviewAttentionConnectAction",
        targetView: "connection",
        targetHash: "#connection",
      });
    }
  }

  // 2. Active AI provider has no API key
  if ((Array.isArray(settings) && settings.length > 0) || typeof statsAiConfigured === "boolean") {
    if (!isActiveProviderKeyConfigured(settings, statsAiConfigured)) {
      items.push({
        id: "ai_key",
        tone: "warn",
        titleKey: "overviewAttentionAiKeyTitle",
        metaKey: "overviewAttentionAiKeyMeta",
        actionKey: "overviewAttentionAiKeyAction",
        targetView: "ai",
        targetHash: "#ai",
      });
    }
  }

  // 3. Plus entitlement expired / grace / unavailable ONLY where Plus is offered
  const plusAccess = accessFromStatus(plusStatus, plusAvailable ?? null);
  if (plusAvailable === true && plusAccess !== "unavailable" && plusStatus) {
    const entState = plusStatus.entitlement?.state;
    const extState = plusStatus.extension?.state;
    if (entState === "grace") {
      items.push({
        id: "plus",
        tone: "warn",
        titleKey: "overviewAttentionPlusGraceTitle",
        metaKey: "overviewAttentionPlusGraceMeta",
        actionKey: "overviewAttentionPlusAction",
        targetView: "plus",
        targetHash: "#plus",
      });
    } else if (entState === "on_hold" || entState === "billing_retry") {
      // A payment problem on a subscription the operator still wants. An expired
      // or canceled subscription is the operator's choice and raises nothing.
      items.push({
        id: "plus",
        tone: "warn",
        titleKey: "overviewAttentionPlusPaymentTitle",
        metaKey: "overviewAttentionPlusPaymentMeta",
        actionKey: "overviewAttentionPlusAction",
        targetView: "plus",
        targetHash: "#plus",
      });
    } else if (
      entState === "clock" ||
      entState === "unverified" ||
      // Plus switched off in Settings is intentional; only a paid runtime that
      // failed to start needs attention.
      (isPlusSubscribed(entState) && extState !== "active" && extState !== "disabled")
    ) {
      items.push({
        id: "plus",
        tone: "warn",
        titleKey: "overviewAttentionPlusUnavailableTitle",
        metaKey: "overviewAttentionPlusUnavailableMeta",
        actionKey: "overviewAttentionPlusAction",
        targetView: "plus",
        targetHash: "#plus",
      });
    }
  }

  // 4. Schedules whose last delivery failed
  if (Array.isArray(schedules)) {
    const failedCount = schedules.filter(
      (s) => s.lastDeliveryStatus === "failed" || Boolean(s.lastError),
    ).length;
    if (failedCount > 0) {
      items.push({
        id: "schedule_failed",
        tone: "danger",
        titleKey: "overviewAttentionScheduleFailedTitle",
        metaKey: "overviewAttentionScheduleFailedMeta",
        metaCount: failedCount,
        actionKey: "overviewAttentionScheduleFailedAction",
        targetView: "schedules",
        targetHash: "#schedules",
      });
    }
  }

  // 5. Reaction rules enabled while global switch is off, or rules whose last outcome failed
  if (reactions && Array.isArray(reactions.rules)) {
    const anyEnabledRule = reactions.rules.some((rule) => rule.enabled);
    if (reactions.automation?.enabled === false && anyEnabledRule) {
      items.push({
        id: "reactions_switch_off",
        tone: "warn",
        titleKey: "overviewAttentionReactionsOffTitle",
        metaKey: "overviewAttentionReactionsOffMeta",
        actionKey: "overviewAttentionReactionsAction",
        targetView: "reactions",
        targetHash: "#reactions",
      });
    }
    const failedRules = reactions.rules.filter((rule) =>
      isReactionOutcomeFailure(rule.runtime?.lastCode),
    ).length;
    if (failedRules > 0) {
      items.push({
        id: "reactions_failed",
        tone: "danger",
        titleKey: "overviewAttentionReactionsFailedTitle",
        metaKey: "overviewAttentionReactionsFailedMeta",
        metaCount: failedRules,
        actionKey: "overviewAttentionReactionsAction",
        targetView: "reactions",
        targetHash: "#reactions",
      });
    }
  }

  return items;
}

// The account card owns the session action, so these never repeat it.
export function buildQuickActions(): OverviewQuickAction[] {
  return [
    {
      id: "reaction",
      labelKey: "overviewQuickCreateReaction",
      descKey: "overviewQuickCreateReactionDesc",
      view: "reactions",
      hash: "#reactions",
    },
    {
      id: "schedule",
      labelKey: "overviewQuickAddSchedule",
      descKey: "overviewQuickAddScheduleDesc",
      view: "schedules",
      hash: "#schedules",
    },
    {
      id: "ai",
      labelKey: "overviewQuickConfigureAi",
      descKey: "overviewQuickConfigureAiDesc",
      view: "ai",
      hash: "#ai",
    },
    {
      id: "backup",
      labelKey: "overviewQuickCreateBackup",
      descKey: "overviewQuickCreateBackupDesc",
      view: "settings",
      hash: "#settings/backup",
    },
  ];
}

function scheduleTimestamp(item: ScheduleItem & { date?: string }): number | null {
  if (typeof item.scheduledTime === "number" && Number.isFinite(item.scheduledTime)) {
    return item.scheduledTime;
  }
  if (typeof item.date === "string" && item.date) {
    const parsed = Date.parse(item.date);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function selectUpcomingSchedules(
  schedules: readonly ScheduleItem[] | null | undefined,
  limit = 3,
): ScheduleItem[] {
  if (!Array.isArray(schedules) || limit <= 0) return [];
  const active = schedules.filter((item) => item && item.status === "active");
  return [...active]
    .sort((a, b) => {
      const aTime = scheduleTimestamp(a);
      const bTime = scheduleTimestamp(b);
      if (aTime !== null && bTime !== null) return aTime - bTime;
      if (aTime !== null) return -1;
      if (bTime !== null) return 1;
      return (a.createdAt ?? 0) - (b.createdAt ?? 0);
    })
    .slice(0, limit);
}

export function selectOpenTodos(
  rows: readonly TodoRowLike[] | null | undefined,
  limit = 5,
): OpenTodoItem[] {
  if (!Array.isArray(rows) || limit <= 0) return [];
  const out: OpenTodoItem[] = [];
  for (let r = 0; r < rows.length && out.length < limit; r++) {
    const tasks = rows[r]?.tasks;
    if (!Array.isArray(tasks)) continue;
    for (let i = 0; i < tasks.length && out.length < limit; i++) {
      const item = tasks[i];
      if (typeof item === "string") {
        const text = item.trim();
        if (text) out.push({ id: `${r}-${i}`, text });
      } else if (item && typeof item === "object") {
        const record = item as {
          text?: unknown;
          task?: unknown;
          title?: unknown;
          done?: unknown;
          completed?: unknown;
        };
        if (record.done === true || record.completed === true) continue;
        const raw = record.text ?? record.task ?? record.title;
        const text = typeof raw === "string" ? raw.trim() : "";
        if (text) out.push({ id: `${r}-${i}`, text });
      }
    }
  }
  return out;
}
