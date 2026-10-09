// file: frontend/src/views/LogsView.tsx

import { ArrowDown, Share2, Smartphone, Terminal, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Socket } from "socket.io-client";
import { api } from "../api/client";
import {
  Badge,
  Card,
  EmptyState,
  FilterButton,
  IconButton,
  PageHeader,
  RadioGroup,
  SegmentedControl,
  Toolbar,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { LogItem } from "../types";

interface LogsViewProps {
  socket: Socket | null;
}

type LogSource = "bot" | "host";

const hasHostLog = typeof (window as any).LevixHost?.hostLog === "function";

export const LogsView: React.FC<LogsViewProps> = ({ socket }) => {
  const { t } = useI18n();
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const logEndRef = useRef<HTMLDivElement>(null);

  const [source, setSource] = useState<LogSource>("bot");
  const [hostLines, setHostLines] = useState<string[]>([]);

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

  const fetchHostLog = useCallback(() => {
    try {
      const text = (window as any).LevixHost?.hostLog(500) ?? "";
      setHostLines(text ? text.split("\n").filter(Boolean) : []);
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

  useEffect(() => {
    if (autoScroll && logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, hostLines, autoScroll]);

  const filtered = logs.filter((l) => (filter === "all" ? true : l.level === filter));
  const displayCount = source === "bot" ? filtered.length : hostLines.length;

  const levelClass = (level: string) =>
    level === "error"
      ? "border-danger/30 bg-danger/10 text-danger"
      : level === "warn"
        ? "border-warn/30 bg-warn/10 text-warn"
        : "border-info/30 bg-info/10 text-info";

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        icon={<Terminal size={20} />}
        title={
          <span className="inline-flex items-center gap-2">
            {t("liveServerLogs")}
            <Badge tone="neutral" className="font-mono">
              {displayCount}
            </Badge>
          </span>
        }
        description={t("logsSubtitle")}
        actions={
          <Toolbar>
            {hasHostLog && (
              <SegmentedControl
                aria-label={t("logs")}
                value={source}
                onChange={setSource}
                options={[
                  { value: "bot", label: t("logSourceBot") },
                  { value: "host", label: t("logSourceHost"), icon: <Smartphone size={14} /> },
                ]}
              />
            )}
            {source === "bot" && (
              <FilterButton
                label={t("filter")}
                resetLabel={t("reset")}
                activeCount={filter === "all" ? 0 : 1}
                onReset={() => setFilter("all")}
              >
                <RadioGroup
                  name="log-level"
                  label={t("allLogs")}
                  value={filter}
                  onChange={setFilter}
                  options={[
                    { value: "all", label: t("allLogs") },
                    { value: "info", label: "INFO" },
                    { value: "warn", label: "WARN" },
                    { value: "error", label: "ERROR" },
                  ]}
                />
              </FilterButton>
            )}
            {source === "host" && hasHostLog && (
              <IconButton
                label={t("shareLogs")}
                icon={<Share2 size={18} />}
                onClick={() => {
                  try {
                    (window as any).LevixHost?.shareHostLogs();
                  } catch {
                    /* host bridge missing */
                  }
                }}
              />
            )}
            <IconButton
              label={t("autoScroll")}
              pressed={autoScroll}
              icon={<ArrowDown size={18} className={autoScroll ? "animate-bounce" : ""} />}
              onClick={() => setAutoScroll((on) => !on)}
            />
            <IconButton
              label={t("clearLogs")}
              variant="ghost"
              icon={<Trash2 size={18} />}
              onClick={() => {
                if (source === "bot") setLogs([]);
                else setHostLines([]);
              }}
            />
          </Toolbar>
        }
      />

      <Card
        padded={false}
        className="h-[65vh] overflow-y-auto bg-bg p-4 font-mono text-xs leading-relaxed text-muted shadow-2xl md:p-5"
        dir="ltr"
      >
        {source === "bot" ? (
          filtered.length === 0 ? (
            <EmptyState icon={<Terminal size={24} />} text={t("noLogs")} />
          ) : (
            <div className="flex flex-col gap-1.5">
              {filtered.map((l, i) => (
                <div
                  key={i}
                  className="flex items-baseline gap-2.5 rounded px-1 py-0.5 hover:bg-panel-hover/40"
                >
                  <span className="shrink-0 select-none text-[11px] text-faint">
                    {l.time || new Date().toLocaleTimeString()}
                  </span>
                  <span
                    className={`inline-flex shrink-0 items-center rounded border px-1.5 font-mono text-[10px] font-bold ${levelClass(l.level || "info")}`}
                  >
                    {(l.level || "info").toUpperCase()}
                  </span>
                  <span className="break-all font-mono text-text-main">{l.msg}</span>
                </div>
              ))}
            </div>
          )
        ) : hostLines.length === 0 ? (
          <EmptyState icon={<Smartphone size={24} />} text={t("noLogs")} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {hostLines.map((line, i) => (
              <div key={i} className="rounded px-1 py-0.5 hover:bg-panel-hover/40">
                <span className="break-all font-mono text-text-main">{line}</span>
              </div>
            ))}
          </div>
        )}
        <div ref={logEndRef} />
      </Card>
    </div>
  );
};
