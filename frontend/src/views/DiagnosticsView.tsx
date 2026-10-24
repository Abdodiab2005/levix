// file: frontend/src/views/DiagnosticsView.tsx
import { AlertTriangle, CheckCircle2, ChevronDown, FileText, Send, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../api/client";
import { DebugLogPreview } from "../components/DebugLogPreview";
import { useToast } from "../components/Toasts";
import {
  Badge,
  Button,
  Card,
  CardHeader,
  ConfirmDialog,
  EmptyState,
  IconButton,
  LoadingState,
  MenuItem,
  OverflowMenu,
  RelativeTime,
} from "../components/ui";
import { useI18n } from "../context/I18nContext";
import type { CrashReportItem, SentCrashReportItem } from "../types";

export const DiagnosticsView: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();

  const [reports, setReports] = useState<CrashReportItem[]>([]);
  const [sent, setSent] = useState<SentCrashReportItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sendingId, setSendingId] = useState<string | null>(null);
  const [reportToDelete, setReportToDelete] = useState<string | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);

  const loadReports = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getCrashReports();
      if (res) {
        setReports(res.reports || []);
        setSent(res.sent || []);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to load crash reports");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadReports();
  }, [loadReports]);

  const handleSend = async (id: string) => {
    setSendingId(id);
    try {
      await api.sendCrashReport(id);
      toast(t("reportSentSuccess"), "success");
      await loadReports();
    } catch (err: any) {
      toast(err?.message || "Send failed", "error");
      await loadReports();
    } finally {
      setSendingId(null);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await api.deleteCrashReport(id);
      toast(t("reportDeleteSuccess"), "success");
      await loadReports();
    } catch (err: any) {
      toast(err?.message || "Delete failed", "error");
    } finally {
      setReportToDelete(null);
    }
  };

  const handleDeleteAll = async () => {
    try {
      await api.deleteAllCrashReports();
      toast(t("allReportsDeleted"), "success");
      await loadReports();
    } catch (err: any) {
      toast(err?.message || "Delete all failed", "error");
    } finally {
      setConfirmDeleteAll(false);
    }
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="flex flex-col gap-5">
        <CardHeader
          icon={<FileText size={22} />}
          title={t("diagnosticsTitle")}
          description={t("diagnosticsDesc")}
          actions={
            reports.length > 0 ? (
              <OverflowMenu label={t("more")}>
                <MenuItem
                  danger
                  icon={<Trash2 size={16} />}
                  onSelect={() => setConfirmDeleteAll(true)}
                >
                  {t("deleteAllReports")}
                </MenuItem>
              </OverflowMenu>
            ) : undefined
          }
        />

        <div className="flex flex-col gap-3">
          <h3 className="text-sm font-bold text-text-main flex items-center gap-2">
            <span>{t("pendingReports")}</span>
            {reports.length > 0 && (
              <Badge tone="info" className="tabular-nums">
                {reports.length}
              </Badge>
            )}
          </h3>

          {loading ? (
            <LoadingState text={t("loading")} />
          ) : error ? (
            <EmptyState
              kind="error"
              title={error}
              action={
                <Button variant="secondary" onClick={loadReports}>
                  {t("retry")}
                </Button>
              }
            />
          ) : reports.length === 0 ? (
            <EmptyState
              kind="empty"
              icon={<CheckCircle2 size={32} className="text-ok" />}
              title={t("noPendingReports")}
            />
          ) : (
            <div className="flex flex-col gap-3">
              {reports.map((report) => {
                const {
                  status: _status,
                  lastError: _lastError,
                  debugLog,
                  ...previewObj
                } = report;
                return (
                  <div
                    key={report.id}
                    className="flex flex-col gap-3 rounded-xl border border-line bg-panel-raised p-4 transition-colors"
                  >
                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-3">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        <Badge tone="neutral">{report.category}</Badge>
                        <span className="font-mono text-xs sm:text-sm font-bold text-text-main truncate">
                          {report.error.type}
                        </span>
                        <RelativeTime value={report.createdAt} className="text-xs text-muted" />
                      </div>
                      <div className="flex items-center gap-2 self-end sm:self-auto shrink-0">
                        <Button
                          variant="primary"
                          size="sm"
                          loading={sendingId === report.id}
                          disabled={sendingId !== null}
                          onClick={() => handleSend(report.id)}
                          icon={<Send size={14} />}
                        >
                          {sendingId === report.id ? t("sendingReport") : t("sendReport")}
                        </Button>
                        <IconButton
                          label={t("deleteReport")}
                          icon={<Trash2 size={16} />}
                          variant="ghost"
                          onClick={() => setReportToDelete(report.id)}
                        />
                      </div>
                    </div>

                    <p className="text-xs leading-relaxed text-muted select-text">
                      {report.error.message}
                    </p>

                    {report.lastError && (
                      <div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-xs text-danger">
                        <AlertTriangle size={15} className="shrink-0 mt-0.5" />
                        <div className="min-w-0 flex-1">
                          <span className="font-semibold">{t("reportLastError")}: </span>
                          <span>{report.lastError}</span>
                        </div>
                      </div>
                    )}

                    <details className="group rounded-xl border border-line bg-panel mt-1">
                      <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-semibold text-muted select-none hover:text-text-main [&::-webkit-details-marker]:hidden">
                        <span className="flex-1">{t("crashReportPreview")}</span>
                        <ChevronDown
                          size={14}
                          aria-hidden
                          className="shrink-0 transition-transform group-open:rotate-180"
                        />
                      </summary>
                      <div className="border-t border-line p-3">
                        <pre
                          dir="ltr"
                          className="overflow-x-auto rounded-lg bg-panel-raised p-2.5 font-mono text-[11px] leading-relaxed text-text-main border border-line select-text"
                        >
                          {JSON.stringify(previewObj, null, 2)}
                        </pre>
                        <div className="mt-2">
                          <DebugLogPreview debugLog={debugLog} />
                        </div>
                      </div>
                    </details>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-line pt-4">
          <h3 className="text-sm font-bold text-text-main flex items-center gap-2">
            <span>{t("sentReports")}</span>
            {sent.length > 0 && (
              <Badge tone="neutral" className="tabular-nums">
                {sent.length}
              </Badge>
            )}
          </h3>

          {sent.length === 0 ? (
            <p className="text-xs text-muted py-2">{t("noSentReports")}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {sent.map((item) => (
                <div
                  key={item.id}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 rounded-xl border border-line bg-panel-raised p-3 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <Badge tone="neutral" className="shrink-0">
                      {item.category}
                    </Badge>
                    <span className="font-mono font-semibold text-text-main select-all">
                      {item.id}
                    </span>
                    <span className="text-muted truncate">{item.type}</span>
                  </div>
                  <RelativeTime value={item.sentAt} className="text-muted shrink-0" />
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      <ConfirmDialog
        isOpen={reportToDelete !== null}
        onClose={() => setReportToDelete(null)}
        onConfirm={() => reportToDelete && handleDelete(reportToDelete)}
        title={t("confirmDeleteReport")}
        description={t("confirmDeleteReportDesc")}
        confirmLabel={t("deleteReport")}
        cancelLabel={t("cancel")}
        variant="danger"
      />

      <ConfirmDialog
        isOpen={confirmDeleteAll}
        onClose={() => setConfirmDeleteAll(false)}
        onConfirm={handleDeleteAll}
        title={t("confirmDeleteAllReports")}
        description={t("confirmDeleteAllDesc")}
        confirmLabel={t("deleteAllReports")}
        cancelLabel={t("cancel")}
        variant="danger"
      />
    </div>
  );
};
