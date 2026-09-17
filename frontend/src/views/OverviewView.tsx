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
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Hero Session Banner */}
      <div
        className="card-glass"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "16px",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: "14px", minWidth: "260px", flex: 1 }}
        >
          <div
            style={{
              width: "44px",
              height: "44px",
              borderRadius: "12px",
              background: isConnected ? "var(--ok-bg)" : "var(--warn-bg)",
              color: isConnected ? "var(--ok)" : "var(--warn)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Activity size={24} />
          </div>
          <div>
            <h2 style={{ fontSize: "1.15rem", fontWeight: 700 }}>
              {isConnected ? t("connected") : t(status?.state as any, "disconnected")}
            </h2>
            <p style={{ fontSize: "0.82rem", color: "var(--muted)", marginTop: "3px" }}>
              {isConnected
                ? status?.user?.id
                  ? `+${status.user.id.split("@")[0]}`
                  : t("activeListening")
                : t("pausedOrLinking")}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          {isConnected ? (
            <button onClick={handleStop} className="btn btn-secondary">
              <Square size={15} />
              <span>{t("stop")}</span>
            </button>
          ) : (
            <button onClick={handleStart} className="btn btn-primary">
              <Play size={15} />
              <span>{t("start")}</span>
            </button>
          )}
          <button onClick={() => onNavigate("connection")} className="btn btn-secondary">
            <span>{t("connection")}</span>
          </button>
        </div>
      </div>

      {/* Prominent Quick Language & RTL Switcher on Main Interface */}
      <div
        className="card"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "14px",
          flexWrap: "wrap",
          padding: "14px 18px",
          borderInlineStart: "4px solid var(--blue-bright)",
        }}
      >
        <div
          style={{ display: "flex", alignItems: "center", gap: "12px", minWidth: "220px", flex: 1 }}
        >
          <div
            style={{
              width: "38px",
              height: "38px",
              borderRadius: "10px",
              background: "rgba(33, 206, 243, 0.12)",
              color: "var(--cyan)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <Globe size={20} />
          </div>
          <div>
            <div style={{ fontSize: "0.92rem", fontWeight: 700 }}>{t("langCardTitle")}</div>
            <div style={{ fontSize: "0.78rem", color: "var(--muted)", marginTop: "2px" }}>
              {t("langCardDesc")}
            </div>
          </div>
        </div>

        <button
          onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
          className="btn btn-secondary"
          style={{ fontWeight: 700, gap: "8px", minHeight: "36px" }}
          id="btn-switch-lang-overview"
        >
          <Globe size={15} />
          <span>{t("langSwitchBtn")}</span>
        </button>
      </div>

      {/* Responsive 2-Col on Mobile / 4-Col on Desktop Stats Grid */}
      <div className="stats-grid">
        <div className="stat-card">
          <div className="stat-header">
            <div
              className="stat-icon-box"
              style={{ background: "rgba(90, 148, 255, 0.12)", color: "var(--blue-bright)" }}
            >
              <Users size={18} />
            </div>
            <span className="stat-label">{t("totalGroups")}</span>
          </div>
          <div className="stat-value">{loading ? "—" : (stats?.totalGroups ?? 0)}</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <div
              className="stat-icon-box"
              style={{ background: "rgba(33, 206, 243, 0.12)", color: "var(--cyan)" }}
            >
              <Terminal size={18} />
            </div>
            <span className="stat-label">{t("commandCount")}</span>
          </div>
          <div className="stat-value">{loading ? "—" : (stats?.commandCount ?? 0)}</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <div
              className="stat-icon-box"
              style={{ background: "rgba(16, 185, 129, 0.12)", color: "var(--ok)" }}
            >
              <Clock size={18} />
            </div>
            <span className="stat-label">{t("uptime")}</span>
          </div>
          <div className="stat-value">{loading ? "—" : formatUptime(stats?.uptime || 0)}</div>
        </div>

        <div className="stat-card">
          <div className="stat-header">
            <div
              className="stat-icon-box"
              style={{ background: "rgba(168, 85, 247, 0.12)", color: "var(--purple)" }}
            >
              <MessageSquare size={18} />
            </div>
            <span className="stat-label">{t("activeSchedules")}</span>
          </div>
          <div className="stat-value">{loading ? "—" : (stats?.activeSchedules ?? 0)}</div>
        </div>
      </div>

      {/* Directory & Quick Info */}
      <div
        className="card"
        style={{ display: "flex", alignItems: "center", gap: "14px", padding: "14px 18px" }}
      >
        <Folder size={20} color="var(--faint)" style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.75rem", color: "var(--muted)", fontWeight: 600 }}>
            {t("dataDir")}
          </div>
          <div
            style={{
              fontSize: "0.84rem",
              fontFamily: "var(--font-mono)",
              color: "var(--text)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              direction: "ltr",
              textAlign: "start",
            }}
          >
            {stats?.dataDir || "..."}
          </div>
        </div>
      </div>
    </div>
  );
};
