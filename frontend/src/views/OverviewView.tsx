// file: frontend/src/views/OverviewView.tsx
import React, { useEffect, useState } from "react";
import { Users, Terminal, Clock, Folder, MessageSquare, Play, Square, Activity } from "lucide-react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../components/Toasts";
import { DashboardStats, SessionStatus } from "../types";

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
    api.getStats()
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
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Hero Session Banner */}
      <div className="card-glass" style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
          <div
            style={{
              width: "48px",
              height: "48px",
              borderRadius: "12px",
              background: isConnected ? "var(--ok-bg)" : "var(--warn-bg)",
              color: isConnected ? "var(--ok)" : "var(--warn)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Activity size={26} />
          </div>
          <div>
            <h2 style={{ fontSize: "1.2rem", fontWeight: 700 }}>
              {isConnected ? t("connected") : t(status?.state as any || "disconnected")}
            </h2>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", marginTop: "4px" }}>
              {isConnected
                ? status?.user?.id ? `+${status.user.id.split("@")[0]}` : "Active and listening to messages"
                : "WhatsApp connection is currently paused or linking"}
            </p>
          </div>
        </div>

        <div style={{ display: "flex", gap: "12px" }}>
          {isConnected ? (
            <button onClick={handleStop} className="btn btn-secondary">
              <Square size={16} />
              <span>{t("stop")}</span>
            </button>
          ) : (
            <button onClick={handleStart} className="btn btn-primary">
              <Play size={16} />
              <span>{t("start")}</span>
            </button>
          )}
          <button onClick={() => onNavigate("connection")} className="btn btn-secondary">
            <span>{t("connection")}</span>
          </button>
        </div>
      </div>

      {/* Stats Grid */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: "20px" }}>
        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ color: "var(--muted)", fontSize: "0.88rem", fontWeight: 600 }}>{t("totalGroups")}</span>
            <Users size={20} color="var(--blue-bright)" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 800 }}>
            {loading ? "—" : stats?.totalGroups ?? 0}
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ color: "var(--muted)", fontSize: "0.88rem", fontWeight: 600 }}>{t("commandCount")}</span>
            <Terminal size={20} color="var(--cyan)" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 800 }}>
            {loading ? "—" : stats?.commandCount ?? 0}
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ color: "var(--muted)", fontSize: "0.88rem", fontWeight: 600 }}>{t("uptime")}</span>
            <Clock size={20} color="var(--ok)" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 800 }}>
            {loading ? "—" : formatUptime(stats?.uptime || 0)}
          </div>
        </div>

        <div className="card">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
            <span style={{ color: "var(--muted)", fontSize: "0.88rem", fontWeight: 600 }}>{t("activeSchedules")}</span>
            <MessageSquare size={20} color="var(--purple)" />
          </div>
          <div style={{ fontSize: "1.8rem", fontWeight: 800 }}>
            {loading ? "—" : stats?.activeSchedules ?? 0}
          </div>
        </div>
      </div>

      {/* Directory & Quick Info */}
      <div className="card" style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <Folder size={22} color="var(--faint)" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: "0.8rem", color: "var(--muted)", fontWeight: 600 }}>{t("dataDir")}</div>
          <div style={{ fontSize: "0.88rem", fontFamily: "var(--font-mono)", color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {stats?.dataDir || "..."}
          </div>
        </div>
      </div>
    </div>
  );
};
