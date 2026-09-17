// file: frontend/src/views/LogsView.tsx

import { Filter, Terminal, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import type { LogItem } from "../types";

interface LogsViewProps {
  socket: any;
}

export const LogsView: React.FC<LogsViewProps> = ({ socket }) => {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .getLogs()
      .then((res) => {
        if (res?.logs) setLogs(res.logs);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!socket) return;
    const handleLog = (entry: LogItem) => {
      setLogs((prev) => [...prev.slice(-400), entry]);
    };
    socket.on("log", handleLog);
    return () => {
      socket.off("log", handleLog);
    };
  }, [socket]);

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const filtered = logs.filter((l) => {
    if (filter === "all") return true;
    return l.level === filter;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      <div className="card-glass" style={{ padding: "14px 20px" }}>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "14px",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <Terminal size={20} color="var(--cyan)" />
            <h2 style={{ fontSize: "1.1rem", fontWeight: 700 }}>{t("liveServerLogs")}</h2>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Filter size={15} color="var(--muted)" />
              <select
                className="form-select"
                style={{ padding: "6px 10px", fontSize: "0.82rem", width: "auto" }}
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">{t("allLogs")}</option>
                <option value="info">Info</option>
                <option value="warn">Warn</option>
                <option value="error">Error</option>
              </select>
            </div>

            <button
              onClick={() => setLogs([])}
              className="btn btn-secondary btn-sm"
              title="Clear logs view"
            >
              <Trash2 size={14} />
              <span>{t("clearLogs")}</span>
            </button>
          </div>
        </div>
      </div>

      <div
        className="input-technical"
        style={{
          background: "#030712",
          border: "1px solid var(--line)",
          borderRadius: "var(--radius)",
          padding: "16px 20px",
          height: "65vh",
          overflowY: "auto",
          fontFamily: "var(--font-mono)",
          fontSize: "0.82rem",
          lineHeight: "1.6",
          display: "flex",
          flexDirection: "column",
          gap: "4px",
          direction: "ltr",
          textAlign: "left",
        }}
      >
        {filtered.length === 0 ? (
          <div style={{ color: "var(--faint)", textAlign: "center", padding: "40px" }}>
            {t("noLogs")}
          </div>
        ) : (
          filtered.map((l, i) => (
            <div key={i} style={{ display: "flex", gap: "12px", wordBreak: "break-word" }}>
              <span style={{ color: "var(--faint)", flexShrink: 0 }}>
                {l.time || new Date().toLocaleTimeString()}
              </span>
              <span
                style={{
                  color:
                    l.level === "error"
                      ? "var(--danger)"
                      : l.level === "warn"
                        ? "var(--warn)"
                        : "var(--cyan)",
                  fontWeight: 600,
                  flexShrink: 0,
                }}
              >
                [{l.level?.toUpperCase() || "INFO"}]
              </span>
              <span style={{ color: "var(--text)" }}>{l.msg}</span>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};
