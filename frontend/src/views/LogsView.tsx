// file: frontend/src/views/LogsView.tsx

import { ArrowDown, Filter, Share2, Smartphone, Terminal, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import type { LogItem } from "../types";

interface LogsViewProps {
  socket: Socket | null;
}

type LogSource = "bot" | "host";

const hasHostLog = typeof (window as any).LevixHost?.hostLog === "function";

export const LogsView: React.FC<LogsViewProps> = ({ socket }) => {
  const { t, language } = useI18n();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [source, setSource] = useState<LogSource>("bot");
  const [hostLines, setHostLines] = useState<string[]>([]);

  // ── Bot logs ─────────────────────────────────────────────
  useEffect(() => {
    if (source !== "bot") return;
    api
      .getLogs()
      .then((res) => {
        if (res?.logs) setLogs(res.logs);
      })
      .catch(() => {});
  }, [source]);

  useEffect(() => {
    if (source !== "bot" || !socket) return;
    const handleLog = (entry: LogItem) => {
      setLogs((prev) => [...prev.slice(-400), entry]);
    };
    socket.on("log", handleLog);
    return () => {
      socket.off("log", handleLog);
    };
  }, [socket, source]);

  // ── Host logs (poll every ~3s only while visible) ────────
  const fetchHostLog = useCallback(() => {
    try {
      const text = (window as any).LevixHost?.hostLog(500) ?? "";
      if (text) {
        setHostLines(text.split("\n").filter(Boolean));
      } else {
        setHostLines([]);
      }
    } catch {
      setHostLines([]);
    }
  }, []);

  useEffect(() => {
    if (source !== "host" || !hasHostLog) return;
    fetchHostLog();
    const timer = setInterval(fetchHostLog, 3000);
    return () => clearInterval(timer);
  }, [source, fetchHostLog]);

  // ── Auto-scroll ──────────────────────────────────────────
  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, hostLines, autoScroll]);

  const filtered = logs.filter((l) => {
    if (filter === "all") return true;
    return l.level === filter;
  });

  const displayCount = source === "bot" ? filtered.length : hostLines.length;

  return (
    <div className="flex flex-col gap-5">
      {/* Controls Header */}
      <div className="rounded-2xl border border-line bg-panel p-4 md:p-5 shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-cyan/10 text-brand-cyan flex items-center justify-center shrink-0">
            <Terminal size={20} />
          </div>
          <div>
            <div className="flex items-center gap-2.5">
              <h2 className="text-base md:text-lg font-bold text-text-main">
                {t("liveServerLogs")}
              </h2>
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono font-bold bg-panel-raised border border-line text-muted">
                {displayCount}
              </span>
            </div>
            <p className="text-xs text-muted mt-0.5">
              {language === "ar"
                ? "سجل أحداث النظام واتصالات واتساب واستدعاءات الذكاء الاصطناعي في الوقت الفعلي"
                : "Real-time streaming console for WhatsApp socket, AI calls, and bot commands"}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap sm:flex-nowrap">
          {/* Source switch — only when inside the Android app */}
          {hasHostLog && (
            <div className="flex rounded-xl border border-line overflow-hidden">
              <button
                type="button"
                onClick={() => setSource("bot")}
                className={`px-3 h-10 text-xs font-semibold transition-colors ${
                  source === "bot"
                    ? "bg-brand-cyan/15 text-brand-cyan"
                    : "bg-panel-raised text-muted hover:text-text-main"
                }`}
              >
                {t("logSourceBot")}
              </button>
              <button
                type="button"
                onClick={() => setSource("host")}
                className={`px-3 h-10 text-xs font-semibold transition-colors border-s border-line flex items-center gap-1.5 ${
                  source === "host"
                    ? "bg-brand-cyan/15 text-brand-cyan"
                    : "bg-panel-raised text-muted hover:text-text-main"
                }`}
              >
                <Smartphone size={13} />
                {t("logSourceHost")}
              </button>
            </div>
          )}

          {/* Level Filter — bot source only */}
          {source === "bot" && (
            <div className="relative flex items-center">
              <Filter size={15} className="absolute start-3 text-muted pointer-events-none" />
              <select
                className="h-10 ps-9 pe-8 rounded-xl border border-line bg-panel-raised text-text-main text-xs font-semibold focus:outline-none focus:ring-2 focus:ring-brand-blue/50"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              >
                <option value="all">{t("allLogs")}</option>
                <option value="info">INFO</option>
                <option value="warn">WARN</option>
                <option value="error">ERROR</option>
              </select>
            </div>
          )}

          {/* Share host logs — host source only */}
          {source === "host" && hasHostLog && (
            <button
              type="button"
              onClick={() => {
                try {
                  (window as any).LevixHost?.shareHostLogs();
                } catch {}
              }}
              className="inline-flex items-center gap-1.5 px-3 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-muted hover:text-brand-cyan text-xs font-semibold transition-colors"
              title={t("shareLogs")}
            >
              <Share2 size={14} />
              <span>{t("share")}</span>
            </button>
          )}

          {/* Auto-scroll Toggle */}
          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            className={`inline-flex items-center gap-1.5 px-3 h-10 rounded-xl border text-xs font-semibold transition-colors ${
              autoScroll
                ? "bg-brand-cyan/15 text-brand-cyan border-brand-cyan/30"
                : "bg-panel-raised text-muted border-line hover:text-text-main"
            }`}
            title="Auto-scroll to latest log entry"
          >
            <ArrowDown size={14} className={autoScroll ? "animate-bounce" : ""} />
            <span>{autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}</span>
          </button>

          {/* Clear View */}
          <button
            type="button"
            onClick={() => {
              if (source === "bot") setLogs([]);
              else setHostLines([]);
            }}
            className="inline-flex items-center gap-1.5 px-3 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-muted hover:text-danger text-xs font-semibold transition-colors"
            title="Clear logs view"
          >
            <Trash2 size={14} />
            <span>{t("clearLogs")}</span>
          </button>
        </div>
      </div>

      {/* Terminal Display */}
      <div
        className="rounded-2xl border border-line bg-[#030712] p-4 md:p-5 shadow-2xl h-[65vh] overflow-y-auto font-mono text-xs leading-relaxed flex flex-col gap-1.5 text-slate-300"
        dir="ltr"
      >
        {source === "bot" ? (
          filtered.length === 0 ? (
            <div className="m-auto text-center py-16 text-muted text-xs flex flex-col items-center gap-2">
              <Terminal size={24} className="opacity-40" />
              <span>{t("noLogs")}</span>
            </div>
          ) : (
            filtered.map((l, i) => {
              const levelClass =
                l.level === "error"
                  ? "text-red-400 bg-red-500/10 border-red-500/20"
                  : l.level === "warn"
                    ? "text-amber-300 bg-amber-500/10 border-amber-500/20"
                    : "text-cyan-400 bg-cyan-500/10 border-cyan-500/20";

              return (
                <div
                  key={i}
                  className="flex items-baseline gap-2.5 py-0.5 hover:bg-white/[0.03] px-1 rounded transition-colors"
                >
                  <span className="text-slate-500 shrink-0 select-none text-[11px]">
                    {l.time || new Date().toLocaleTimeString()}
                  </span>
                  <span
                    className={`inline-flex items-center px-1.5 py-0.2 rounded border font-mono font-bold text-[10px] shrink-0 ${levelClass}`}
                  >
                    {(l.level || "info").toUpperCase()}
                  </span>
                  <span className="text-slate-200 break-all font-mono">{l.msg}</span>
                </div>
              );
            })
          )
        ) : hostLines.length === 0 ? (
          <div className="m-auto text-center py-16 text-muted text-xs flex flex-col items-center gap-2">
            <Smartphone size={24} className="opacity-40" />
            <span>{t("noLogs")}</span>
          </div>
        ) : (
          hostLines.map((line, i) => (
            <div
              key={i}
              className="flex items-baseline gap-2.5 py-0.5 hover:bg-white/[0.03] px-1 rounded transition-colors"
            >
              <span className="text-slate-200 break-all font-mono">{line}</span>
            </div>
          ))
        )}
        <div ref={logEndRef} />
      </div>
    </div>
  );
};
