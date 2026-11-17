// file: frontend/src/views/OverviewView.tsx

import {
  Bot,
  ChevronRight,
  Clock,
  MessageSquare,
  Radio,
  Sliders,
  Terminal,
  Users,
} from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import { Button, Card } from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { DashboardStats, SessionStatus } from "../types";
import { ConnectedAccountCard } from "./ConnectedAccountCard";

interface OverviewViewProps {
  status: SessionStatus | null;
  onNavigate: (view: ViewTab) => void;
}

export const OverviewView: FC<OverviewViewProps> = ({ status, onNavigate }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
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
    } catch (err: any) {
      toast(err.message, "error");
    } finally {
      setStarting(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    api
      .getStats()
      .then((res) => {
        if (mounted && res?.stats) setStats(res.stats);
      })
      .catch((err) => {
        toast(err.message, "error");
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [toast]);

  const formatUptime = (seconds: number) => {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days) return `${days} ${t("uptimeDayUnit")} ${hours} ${t("uptimeHourUnit")}`;
    if (hours) return `${hours} ${t("uptimeHourUnit")} ${mins} ${t("uptimeMinuteUnit")}`;
    return `${mins} ${t("uptimeMinuteUnit")}`;
  };

  const isConnected = status?.state === "connected";

  const quickNavCards: Array<{
    id: ViewTab;
    title: string;
    desc: string;
    icon: typeof Radio;
    color: string;
  }> = [
    {
      id: "connection",
      title: t("connection"),
      desc: isConnected ? t("connected") : t("accountCardNotConnected"),
      icon: Radio,
      color: "border-brand-cyan/20 bg-brand-cyan/10 text-brand-cyan",
    },
    {
      id: "ai",
      title: t("ai"),
      desc: t("aiAssistantDesc") || "Autonomous tool-calling AI agent",
      icon: Bot,
      color: "border-brand-purple/20 bg-brand-purple/10 text-brand-purple",
    },
    {
      id: "commands",
      title: t("commands"),
      desc: t("quickCommandsDesc").replace("{n}", String(stats?.commandCount ?? 0)),
      icon: Terminal,
      color: "border-brand-blue/20 bg-brand-blue/10 text-brand-blue",
    },
    {
      id: "settings",
      title: t("settings"),
      desc: t("settingsSub") || "Prefix, ports, delays, security & storage",
      icon: Sliders,
      color: "border-ok/20 bg-ok/10 text-ok",
    },
  ];

  const statsCards = [
    {
      label: t("totalGroups"),
      value: stats?.totalGroups ?? 0,
      icon: Users,
      tone: "border-brand-blue/20 bg-brand-blue/10 text-brand-blue",
    },
    {
      label: t("commandCount"),
      value: stats?.commandCount ?? 0,
      icon: Terminal,
      tone: "border-brand-cyan/20 bg-brand-cyan/10 text-brand-cyan",
    },
    {
      label: t("uptime"),
      value: formatUptime(stats?.uptime || 0),
      icon: Clock,
      tone: "border-ok/20 bg-ok/10 text-ok",
    },
    {
      label: t("activeSchedules"),
      value: stats?.activeSchedules ?? 0,
      icon: MessageSquare,
      tone: "border-brand-purple/20 bg-brand-purple/10 text-brand-purple",
    },
  ];

  return (
    <div className="flex flex-col gap-5 sm:gap-6">
      {/* The compact account card is the one place Home states the session. */}
      <ConnectedAccountCard
        status={status}
        variant="compact"
        onManage={() => onNavigate("connection")}
        onStart={canQuickStart ? handleStart : undefined}
        starting={starting}
      />

      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4" data-tour="overview-stats">
        {statsCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.label}>
              <div className="flex items-start justify-between gap-2">
                <span className="line-clamp-2 text-[11px] font-bold uppercase tracking-wider text-muted sm:text-xs">
                  {card.label}
                </span>
                <div
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${card.tone}`}
                >
                  <Icon size={18} />
                </div>
              </div>
              <div className="mt-2 font-mono text-2xl font-extrabold tracking-tight text-text-main sm:text-3xl">
                {loading ? "—" : card.value}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {quickNavCards.map((card) => {
          const Icon = card.icon;
          return (
            <Card
              key={card.id}
              padded={false}
              className="h-full transition-colors hover:border-brand-blue/30"
            >
              <Button
                variant="ghost"
                onClick={() => onNavigate(card.id)}
                className="h-full w-full flex-col items-stretch justify-between gap-3 rounded-2xl p-4 text-start sm:gap-4 sm:p-5"
              >
                <div className="flex w-full items-center justify-between gap-2">
                  <div
                    className={`flex size-10 shrink-0 items-center justify-center rounded-xl border ${card.color}`}
                  >
                    <Icon size={18} />
                  </div>
                  <ChevronRight
                    size={16}
                    className="shrink-0 text-faint rtl:-scale-x-100"
                    aria-hidden
                  />
                </div>
                <div>
                  <h3 className="text-xs font-bold text-text-main sm:text-sm">{card.title}</h3>
                  <p className="mt-0.5 line-clamp-2 text-[11px] leading-relaxed text-muted sm:text-xs">
                    {card.desc}
                  </p>
                </div>
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
};
