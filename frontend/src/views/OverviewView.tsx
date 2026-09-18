// file: frontend/src/views/OverviewView.tsx

import {
  Activity,
  Bot,
  Calendar,
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
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useToast } from "../components/Toasts";
import { useI18n } from "../context/I18nContext";
import type { DashboardStats, SessionStatus } from "../types";

interface OverviewViewProps {
  status: SessionStatus | null;
  onNavigate: (view: any) => void;
}

export const OverviewView: React.FC<OverviewViewProps> = ({ status, onNavigate }) => {
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
    if (days) return `${days}d ${hours}h`;
    if (hours) return `${hours}h ${mins}m`;
    return `${mins}m`;
  };

  const isConnected = status?.state === "connected";

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

  const quickNavCards = [
    {
      id: "connection",
      title: t("connection"),
      desc: isConnected ? t("connected") : t(status?.state as any, "disconnected"),
      icon: Radio,
      color: "text-brand-cyan bg-brand-cyan/10 border-brand-cyan/20",
    },
    {
      id: "ai",
      title: t("ai"),
      desc: t("aiAssistantDesc") || "Autonomous tool-calling AI agent",
      icon: Bot,
      color: "text-purple-400 bg-purple-500/10 border-purple-500/20",
    },
    {
      id: "commands",
      title: t("commands"),
      desc: `${stats?.commandCount ?? 56} active bot commands & aliases`,
      icon: Terminal,
      color: "text-brand-blue bg-blue-500/10 border-blue-500/20",
    },
    {
      id: "settings",
      title: t("settings"),
      desc: t("settingsSub") || "Prefix, ports, delays, security & storage",
      icon: Sliders,
      color: "text-ok bg-ok/10 border-ok/20",
    },
  ];

  return (
    <div className="flex flex-col gap-6">
      {/* Hero Session Card */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised via-panel to-panel p-5 sm:p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-5">
        <div className="flex items-center gap-4 min-w-0 flex-1">
          <div
            className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 border ${
              isConnected
                ? "bg-ok/15 text-ok border-ok/30 shadow-sm shadow-ok/20"
                : "bg-warn/15 text-warn border-warn/30 shadow-sm shadow-warn/20"
            }`}
          >
            <Activity size={24} />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5 flex-wrap">
              <h2 className="text-lg sm:text-xl font-extrabold text-text-main tracking-tight truncate">
                {isConnected ? t("connected") : t(status?.state as any, "disconnected")}
              </h2>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border ${
                  isConnected
                    ? "bg-ok/10 text-ok border-ok/30"
                    : "bg-warn/10 text-warn border-warn/30"
                }`}
              >
                <span className="pulse-dot" />
                {isConnected ? "ONLINE" : "OFFLINE"}
              </span>
            </div>
            <p className="text-xs sm:text-sm text-muted truncate mt-1">
              {isConnected
                ? status?.user?.id
                  ? `+${status.user.id.split("@")[0]}`
                  : t("activeListening")
                : t("pausedOrLinking")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap shrink-0">
          {isConnected ? (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-danger/15 hover:border-danger/40 hover:text-danger text-text-main text-xs sm:text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-danger/50"
            >
              <Square size={16} />
              <span>{t("stop")}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              className="inline-flex items-center justify-center gap-2 px-5 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white text-xs sm:text-sm font-bold shadow-md shadow-brand-blue/25 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            >
              <Play size={16} />
              <span>{t("start")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate("connection")}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main text-xs sm:text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          >
            <Radio size={16} className="text-brand-cyan" />
            <span>{t("connection")}</span>
          </button>
        </div>
      </div>

      {/* Responsive Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-5">
        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3 hover:border-brand-blue/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted uppercase tracking-wider">
              {t("totalGroups")}
            </span>
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-brand-blue flex items-center justify-center shrink-0 border border-blue-500/20">
              <Users size={20} />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-text-main font-mono tracking-tight">
            {loading ? "—" : (stats?.totalGroups ?? 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3 hover:border-brand-cyan/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted uppercase tracking-wider">
              {t("commandCount")}
            </span>
            <div className="w-10 h-10 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0 border border-brand-cyan/20">
              <Terminal size={20} />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-text-main font-mono tracking-tight">
            {loading ? "—" : (stats?.commandCount ?? 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3 hover:border-ok/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted uppercase tracking-wider">
              {t("uptime")}
            </span>
            <div className="w-10 h-10 rounded-xl bg-ok/10 text-ok flex items-center justify-center shrink-0 border border-ok/20">
              <Clock size={20} />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-text-main font-mono tracking-tight">
            {loading ? "—" : formatUptime(stats?.uptime || 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5 shadow-sm space-y-3 hover:border-purple-500/40 transition-colors">
          <div className="flex items-center justify-between">
            <span className="text-xs font-bold text-muted uppercase tracking-wider">
              {t("activeSchedules")}
            </span>
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0 border border-purple-500/20">
              <MessageSquare size={20} />
            </div>
          </div>
          <div className="text-3xl font-extrabold text-text-main font-mono tracking-tight">
            {loading ? "—" : (stats?.activeSchedules ?? 0)}
          </div>
        </div>
      </div>

      {/* Quick Access Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {quickNavCards.map((card) => {
          const Icon = card.icon;
          return (
            <button
              key={card.id}
              type="button"
              onClick={() => onNavigate(card.id)}
              className="rounded-2xl border border-line bg-panel hover:bg-panel-hover p-4 sm:p-5 shadow-sm text-start flex flex-col justify-between gap-3 transition-all hover:-translate-y-0.5 focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            >
              <div className="flex items-center justify-between w-full">
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 border ${card.color}`}
                >
                  <Icon size={20} />
                </div>
                <span className="text-xs font-bold text-brand-cyan hover:underline">&rarr;</span>
              </div>
              <div>
                <h3 className="text-sm font-bold text-text-main">{card.title}</h3>
                <p className="text-xs text-muted mt-0.5 line-clamp-2">{card.desc}</p>
              </div>
            </button>
          );
        })}
      </div>

      {/* Directory & Runtime Footer Banner */}
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm flex items-center gap-3.5">
        <Folder size={20} className="text-faint shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-muted">{t("dataDir")}</div>
          <div className="text-xs font-mono text-text-main truncate text-start">
            {stats?.dataDir || "..."}
          </div>
        </div>
      </div>
    </div>
  );
};
