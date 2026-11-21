import { userErrorMessage } from "../utils/userError";
// file: frontend/src/views/OverviewView.tsx

import {
  AlertCircle,
  AlertTriangle,
  Bot,
  Calendar,
  CheckSquare,
  Clock,
  HardDrive,
  Radio,
  SmilePlus,
  Terminal,
  Users,
} from "lucide-react";
import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import { Button, Card, CodeText, ListRow, Section, StatTile, UserText } from "../components/ui";
import { useI18n } from "../context/I18nContext";
import { usePlusStatus } from "../hooks/usePlusStatus";
import type {
  DashboardStats,
  ReactionOverview,
  ScheduleItem,
  SessionStatus,
  SettingItem,
} from "../types";
import { fill } from "../utils/fill";
import { ConnectedAccountCard } from "./ConnectedAccountCard";
import {
  buildAttentionItems,
  buildQuickActions,
  type OverviewQuickAction,
  selectOpenTodos,
  selectUpcomingSchedules,
  type TodoRowLike,
} from "./overview/overviewData";

interface OverviewViewProps {
  status: SessionStatus | null;
  onNavigate: (view: ViewTab) => void;
}

const QUICK_ACTION_ICON = {
  connect: <Radio size={18} className="text-brand-cyan" />,
  reaction: <SmilePlus size={18} className="text-brand-blue" />,
  schedule: <Calendar size={18} className="text-brand-purple" />,
  ai: <Bot size={18} className="text-brand-purple" />,
  backup: <HardDrive size={18} className="text-ok" />,
} as const;

export const OverviewView: FC<OverviewViewProps> = ({ status, onNavigate }) => {
  const { t, language } = useI18n();
  const { toast } = useToast();
  const { status: plusStatus, available: plusAvailable } = usePlusStatus();

  const [stats, setStats] = useState<(DashboardStats & { aiConfigured?: boolean }) | null>(null);
  const [settings, setSettings] = useState<SettingItem[] | null>(null);
  const [schedules, setSchedules] = useState<ScheduleItem[] | null>(null);
  const [reactions, setReactions] = useState<ReactionOverview | null>(null);
  const [todos, setTodos] = useState<TodoRowLike[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [starting, setStarting] = useState(false);

  const isStartable = Boolean(
    status && ["idle", "disconnected", "retry_exhausted", "error"].includes(status.state),
  );
  const isLinked = Boolean(status?.user?.id || status?.linked);
  const canQuickStart = isStartable && isLinked;

  const handleStart = async () => {
    if (!canQuickStart || starting) return;
    setStarting(true);
    try {
      await api.startSession();
      toast(t("starting"), "info");
    } catch (err: unknown) {
      toast(userErrorMessage(t, err, "sessionStartError"), "error");
    } finally {
      setStarting(false);
    }
  };

  const navigateTo = (view: ViewTab, hash?: string) => {
    onNavigate(view);
    if (hash && hash !== `#${view}` && hash !== view) {
      window.location.hash = hash.replace(/^#/, "");
    }
  };

  const handleQuickAction = (action: OverviewQuickAction) => {
    if (action.id === "connect" && canQuickStart) {
      void handleStart();
      return;
    }
    navigateTo(action.view, action.hash);
  };

  // Fetch summaries once on mount and on explicit refresh.
  // Never refetch the entire dataset on session state transitions.
  useEffect(() => {
    let mounted = true;
    Promise.allSettled([
      api.getStats(),
      api.getSettings(),
      api.getSchedules(),
      api.getReactions(),
      api.get<{ todos?: TodoRowLike[] }>("/todos"),
    ])
      .then(([statsRes, settingsRes, schedulesRes, reactionsRes, todosRes]) => {
        if (!mounted) return;
        if (statsRes.status === "fulfilled" && statsRes.value?.stats) {
          setStats(statsRes.value.stats);
        } else if (statsRes.status === "rejected") {
          toast(userErrorMessage(t, statsRes.reason, "overviewLoadError"), "error");
        }
        if (settingsRes.status === "fulfilled" && Array.isArray(settingsRes.value?.settings)) {
          setSettings(settingsRes.value.settings);
        }
        if (schedulesRes.status === "fulfilled" && Array.isArray(schedulesRes.value?.schedules)) {
          const allSchedules = schedulesRes.value.schedules;
          const upcoming = selectUpcomingSchedules(allSchedules, 3);
          const failed = allSchedules.filter(
            (s) => s.lastDeliveryStatus === "failed" || Boolean(s.lastError),
          );
          const bounded = new Map<string, ScheduleItem>();
          for (const s of [...upcoming, ...failed]) {
            bounded.set(s.id, s);
          }
          setSchedules([...bounded.values()]);
        }
        if (reactionsRes.status === "fulfilled" && reactionsRes.value) {
          setReactions(reactionsRes.value);
        }
        if (todosRes.status === "fulfilled" && Array.isArray(todosRes.value?.todos)) {
          setTodos(todosRes.value.todos.slice(0, 10));
        }
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [t, toast]);

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days) return `${days} ${t("uptimeDayUnit")} ${hours} ${t("uptimeHourUnit")}`;
    if (hours) return `${hours} ${t("uptimeHourUnit")} ${mins} ${t("uptimeMinuteUnit")}`;
    return `${mins} ${t("uptimeMinuteUnit")}`;
  };

  const activeSchedulesCount = useMemo(() => {
    if (Array.isArray(schedules)) {
      return schedules.filter((item) => item.status === "active").length;
    }
    return stats?.activeSchedules ?? 0;
  }, [schedules, stats?.activeSchedules]);

  const attentionItems = useMemo(
    () =>
      buildAttentionItems({
        status,
        settings,
        statsAiConfigured: stats?.aiConfigured ?? null,
        plusStatus,
        plusAvailable,
        schedules,
        reactions,
      }),
    [status, settings, stats?.aiConfigured, plusStatus, plusAvailable, schedules, reactions],
  );

  const quickActions = useMemo(() => buildQuickActions(), []);
  const upcomingSchedules = useMemo(() => selectUpcomingSchedules(schedules, 3), [schedules]);
  const openTodos = useMemo(() => selectOpenTodos(todos, 5), [todos]);
  const hasUpcoming = upcomingSchedules.length > 0 || openTodos.length > 0;

  const resolveScheduleTarget = (item: ScheduleItem) => {
    if (item.targetNameSource === "none" || !item.targetLabel) {
      return item.targetKind === "group" ? t("recipientGroup") : t("recipientContact");
    }
    return item.targetLabel;
  };

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* 1. The compact account card is the one place Overview states the session. */}
      <ConnectedAccountCard
        status={status}
        variant="compact"
        onManage={() => onNavigate("connection")}
        onStart={canQuickStart ? handleStart : undefined}
        starting={starting}
      />

      {/* 2. Key stats as StatTile in a 2-column mobile grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" data-tour="overview-stats">
        <StatTile
          label={t("totalGroups")}
          value={loading ? "—" : (stats?.totalGroups ?? 0)}
          icon={<Users size={16} />}
        />
        <StatTile
          label={t("commandCount")}
          value={loading ? "—" : (stats?.commandCount ?? 0)}
          icon={<Terminal size={16} />}
        />
        <StatTile
          label={t("uptime")}
          value={loading ? "—" : formatUptime(stats?.uptime || 0)}
          icon={<Clock size={16} />}
        />
        <StatTile
          label={t("activeSchedules")}
          value={loading ? "—" : activeSchedulesCount}
          icon={<Calendar size={16} />}
        />
      </div>

      {/* 3. Needs Attention (hidden entirely when nothing needs attention) */}
      {attentionItems.length > 0 && (
        <Section title={t("overviewNeedsAttentionTitle")}>
          <div className="flex flex-col gap-2">
            {attentionItems.map((item) => {
              const metaText =
                typeof item.metaCount === "number"
                  ? fill(t(item.metaKey), { n: item.metaCount })
                  : t(item.metaKey);
              return (
                <ListRow
                  key={item.id}
                  leading={
                    item.tone === "danger" ? (
                      <AlertCircle size={18} className="text-danger" />
                    ) : (
                      <AlertTriangle size={18} className="text-warn" />
                    )
                  }
                  title={t(item.titleKey)}
                  meta={metaText}
                  trailing={
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => navigateTo(item.targetView, item.targetHash)}
                    >
                      {t(item.actionKey)}
                    </Button>
                  }
                />
              );
            })}
          </div>
        </Section>
      )}

      {/* 4. Quick Actions */}
      <Section title={t("overviewQuickActionsTitle")}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {quickActions.map((action) => (
            <ListRow
              key={action.id}
              leading={QUICK_ACTION_ICON[action.id]}
              title={t(action.labelKey)}
              meta={t(action.descKey)}
              onClick={() => handleQuickAction(action)}
            />
          ))}
        </div>
      </Section>

      {/* 5. Upcoming / recent items (hidden when both are empty) */}
      {hasUpcoming && (
        <Section title={t("overviewUpcomingTitle")}>
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {upcomingSchedules.length > 0 && (
              <Card className="flex flex-col gap-2.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-faint">
                  {t("overviewUpcomingSchedulesHeading")}
                </h3>
                <div className="flex flex-col gap-2">
                  {upcomingSchedules.map((item) => {
                    const whenText = item.whenByLocale?.[language] || item.when;
                    const targetText = resolveScheduleTarget(item);
                    const isPhone =
                      item.targetNameSource === "phone" ||
                      targetText.startsWith("+") ||
                      /^\+?\d+$/.test(targetText);
                    return (
                      <ListRow
                        key={item.id}
                        variant="raised"
                        leading={<Calendar size={16} className="text-brand-purple" />}
                        title={
                          <UserText lines={1}>
                            {item.message || item.media?.fileName || t("schedules")}
                          </UserText>
                        }
                        meta={
                          <span className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted">
                            {isPhone ? (
                              <CodeText className="text-xs text-muted">{targetText}</CodeText>
                            ) : (
                              <UserText lines={1}>{targetText}</UserText>
                            )}
                            <span aria-hidden="true">·</span>
                            <span>{whenText}</span>
                          </span>
                        }
                        onClick={() => onNavigate("schedules")}
                      />
                    );
                  })}
                </div>
              </Card>
            )}

            {openTodos.length > 0 && (
              <Card className="flex flex-col gap-2.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-faint">
                  {t("overviewOpenTodosHeading")}
                </h3>
                <div className="flex flex-col gap-2">
                  {openTodos.map((todo) => (
                    <ListRow
                      key={todo.id}
                      variant="raised"
                      leading={<CheckSquare size={16} className="text-brand-cyan" />}
                      title={<UserText lines={2}>{todo.text}</UserText>}
                    />
                  ))}
                </div>
              </Card>
            )}
          </div>
        </Section>
      )}
    </div>
  );
};
