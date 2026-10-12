// file: frontend/src/components/CrashBanner.tsx
import { AlertTriangle, Trash2, Wrench } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { useToast } from "./Toasts";
import { Button, Card, ConfirmDialog } from "./ui";

let hasCheckedThisPageLoad = false;

export const CrashBanner: React.FC = () => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [visible, setVisible] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // Inside Android app (window.LevixHost), do not show banner; the native app prompts.
    if ((window as unknown as { LevixHost?: unknown }).LevixHost) return;
    if (hasCheckedThisPageLoad) return;
    hasCheckedThisPageLoad = true;

    api
      .getCrashReports()
      .then((res) => {
        if (res?.reports && res.reports.length > 0) {
          setVisible(true);
        }
      })
      .catch(() => {
        // ignore
      });
  }, []);

  if (!visible) return null;

  const handleReview = () => {
    setVisible(false);
    window.location.hash = "settings/diagnostics";
  };

  const handleDeleteAll = async () => {
    setDeleting(true);
    try {
      await api.deleteAllCrashReports();
      toast(t("allReportsDeleted"), "success");
      setVisible(false);
    } catch (err: any) {
      toast(err?.message || "Delete failed", "error");
    } finally {
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  return (
    <>
      <div className="mb-4">
        <Card className="border-warn/30 bg-warn/5 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-warn/15 text-warn">
                <AlertTriangle size={18} />
              </div>
              <div className="flex flex-col gap-0.5">
                <h4 className="text-sm font-bold text-text-main">{t("crashBannerTitle")}</h4>
                <p className="text-xs leading-relaxed text-muted">{t("crashBannerDesc")}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 self-end sm:self-auto shrink-0">
              <Button
                variant="primary"
                size="sm"
                onClick={handleReview}
                icon={<Wrench size={14} />}
              >
                {t("crashBannerReview")}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setVisible(false)}>
                {t("crashBannerNotNow")}
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => setConfirmDelete(true)}
                icon={<Trash2 size={14} />}
              >
                {t("crashBannerDelete")}
              </Button>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        isOpen={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={handleDeleteAll}
        loading={deleting}
        title={t("confirmDeleteAllReports")}
        description={t("confirmDeleteAllDesc")}
        confirmLabel={t("deleteAllReports")}
        cancelLabel={t("cancel")}
        variant="danger"
      />
    </>
  );
};
