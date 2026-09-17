import {
  Activity,
  Clock,
  Folder,
  Globe,
  MessageSquare,
  Play,
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
  const { t, language, setLanguage } = useI18n();
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

  return (
    <div className="flex flex-col gap-5">
      {/* Hero Session Banner */}
      <div className="rounded-2xl border border-line bg-gradient-to-br from-panel-raised to-panel p-5 md:p-6 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <div
            className={`w-11 h-11 rounded-xl flex items-center justify-center shrink-0 ${
              isConnected ? "bg-ok/10 text-ok" : "bg-warn/10 text-warn"
            }`}
          >
            <Activity size={24} />
          </div>
          <div className="min-w-0">
            <h2 className="text-base md:text-lg font-bold text-text-main truncate">
              {isConnected ? t("connected") : t(status?.state as any, "disconnected")}
            </h2>
            <p className="text-xs text-muted truncate mt-0.5">
              {isConnected
                ? status?.user?.id
                  ? `+${status.user.id.split("@")[0]}`
                  : t("activeListening")
                : t("pausedOrLinking")}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          {isConnected ? (
            <button
              type="button"
              onClick={handleStop}
              className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel hover:bg-danger/15 hover:border-danger/30 hover:text-danger text-text-main text-xs md:text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-danger/50"
            >
              <Square size={18} />
              <span>{t("stop")}</span>
            </button>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl bg-brand-blue hover:bg-brand-blue/90 text-white text-xs md:text-sm font-bold shadow-md shadow-brand-blue/20 transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            >
              <Play size={18} />
              <span>{t("start")}</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate("connection")}
            className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel hover:bg-panel-hover text-text-main text-xs md:text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          >
            <span>{t("connection")}</span>
          </button>
        </div>
      </div>

      {/* Prominent Quick Language & RTL Switcher on Main Interface */}
      <div className="rounded-2xl border border-line border-s-4 border-s-brand-cyan bg-panel p-4 md:p-5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3.5 min-w-0 flex-1">
          <div className="w-11 h-11 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
            <Globe size={22} />
          </div>
          <div className="min-w-0">
            <div className="text-sm md:text-base font-bold text-text-main truncate">
              {t("langCardTitle")}
            </div>
            <div className="text-xs text-muted truncate mt-0.5">{t("langCardDesc")}</div>
          </div>
        </div>

        <button
          type="button"
          onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
          className="inline-flex items-center justify-center gap-2 px-4 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main text-xs md:text-sm font-bold transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 shrink-0"
          id="btn-switch-lang-overview"
        >
          <Globe size={18} className="text-brand-cyan" />
          <span>{t("langSwitchBtn")}</span>
        </button>
      </div>

      {/* Responsive Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-line bg-panel p-4 md:p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-500/10 text-brand-blue flex items-center justify-center shrink-0">
              <Users size={20} />
            </div>
            <span className="text-xs font-semibold text-muted">{t("totalGroups")}</span>
          </div>
          <div className="text-2xl font-extrabold text-text-main font-mono">
            {loading ? "—" : (stats?.totalGroups ?? 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-4 md:p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
              <Terminal size={20} />
            </div>
            <span className="text-xs font-semibold text-muted">{t("commandCount")}</span>
          </div>
          <div className="text-2xl font-extrabold text-text-main font-mono">
            {loading ? "—" : (stats?.commandCount ?? 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-4 md:p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-ok/10 text-ok flex items-center justify-center shrink-0">
              <Clock size={20} />
            </div>
            <span className="text-xs font-semibold text-muted">{t("uptime")}</span>
          </div>
          <div className="text-2xl font-extrabold text-text-main font-mono">
            {loading ? "—" : formatUptime(stats?.uptime || 0)}
          </div>
        </div>

        <div className="rounded-2xl border border-line bg-panel p-4 md:p-5 shadow-sm space-y-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center shrink-0">
              <MessageSquare size={20} />
            </div>
            <span className="text-xs font-semibold text-muted">{t("activeSchedules")}</span>
          </div>
          <div className="text-2xl font-extrabold text-text-main font-mono">
            {loading ? "—" : (stats?.activeSchedules ?? 0)}
          </div>
        </div>
      </div>

      {/* Directory & Quick Info */}
      <div className="rounded-2xl border border-line bg-panel p-4 shadow-sm flex items-center gap-3.5">
        <Folder size={20} className="text-faint shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-semibold text-muted">{t("dataDir")}</div>
          <div className="text-xs font-mono text-text-main truncate direction-ltr text-start">
            {stats?.dataDir || "..."}
          </div>
        </div>
      </div>
    </div>
  );
};
