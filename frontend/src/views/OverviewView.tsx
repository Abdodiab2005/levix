// file: frontend/src/views/OverviewView.tsx

import {
  Activity,
  Bot,
  ChevronRight,
  Clock,
  Folder,
  MessageSquare,
  Play,
  Radio,
  Sliders,
  Square,
  Terminal,
  Users,
} from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import type { ViewTab } from "../components/Sidebar";
import { useToast } from "../components/Toasts";
import { Button, Card, StatusPill } from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { DashboardStats, SessionStatus } from "../types";

/** `201012345678:5@s.whatsapp.net` -> `+20 100 772 9621`, device suffix dropped. */
const formatLinkedNumber = (id?: string | null): string | null => {
  if (!id) return null;
  const digits = id.split("@")[0].split(":")[0].replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 12) {
    return `+${digits.slice(0, 2)} ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  if (digits.length === 11) {
    return `+${digits.slice(0, 1)} ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  return `+${digits}`;
};

interface OverviewViewProps {
  status: SessionStatus | null;
  onNavigate: (view: ViewTab) => void;
}

export const OverviewView: FC<OverviewViewProps> = ({ status, onNavigate }) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

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
  const linkedNumber = formatLinkedNumber(status?.user?.id);

  const handleStart = async () => {
    try {
      await api.startSession();
      toast(t("starting"), "info");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

  const handleStop = async () => {
    try {
      await api.stopSession();
      toast(t("stop"), "info");
    } catch (err: any) {
      toast(err.message, "error");
    }
  };

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
      desc: isConnected ? t("connected") : t(status?.state as any, "disconnected"),
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
    <div className="flex flex-col gap-6">
      {/* Hero connection card: status, title, linked number, then one action row */}
      <Card className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div
            className={`flex size-11 shrink-0 items-center justify-center rounded-xl border ${
              isConnected ? "border-ok/30 bg-ok/10 text-ok" : "border-warn/30 bg-warn/10 text-warn"
            }`}
          >
            <Activity size={22} />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h2 className="text-base font-extrabold tracking-tight text-text-main sm:text-lg">
                {isConnected ? t("connected") : t(status?.state as any, "disconnected")}
              </h2>
              <StatusPill tone={isConnected ? "ok" : "warn"} dot pulse>
                {isConnected ? t("online") : t("offline")}
              </StatusPill>
            </div>
            <p className="text-sm text-muted">
              {isConnected ? (
                linkedNumber ? (
                  <bdi dir="ltr">{linkedNumber}</bdi>
                ) : (
                  t("activeListening")
                )
              ) : (
                t("pausedOrLinking")
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {isConnected ? (
            <Button
              variant="danger"
              icon={<Square size={16} />}
              onClick={handleStop}
              className="flex-1 whitespace-nowrap sm:flex-none"
            >
              {t("stop")}
            </Button>
          ) : (
            <Button
              variant="primary"
              icon={<Play size={16} />}
              onClick={handleStart}
              className="flex-1 whitespace-nowrap sm:flex-none"
            >
              {t("start")}
            </Button>
          )}
          <Button
            variant="secondary"
            icon={<Radio size={16} />}
            onClick={() => onNavigate("connection")}
            className="flex-1 whitespace-nowrap sm:flex-none"
          >
            {t("connection")}
          </Button>
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:gap-5 lg:grid-cols-4">
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

      <Card className="flex items-center gap-3.5">
        <Folder size={20} className="shrink-0 text-faint" />
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-muted">{t("dataDir")}</div>
          <div className="truncate text-start font-mono text-xs text-text-main" dir="ltr">
            {stats?.dataDir || "..."}
          </div>
        </div>
      </Card>
    </div>
  );
};
