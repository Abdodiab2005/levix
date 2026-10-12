import { RotateCcw, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import {
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  FilterButton,
  MenuItem,
  OverflowMenu,
  Pagination,
  RelativeTime,
  Select,
  Skeleton,
  Toolbar,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { AutoDeleteLogEntry, AutoDeleteRule } from "../../types";
import { peerDir, peerLabel, ruleLabel } from "../../utils/autoDelete";
import { fill } from "../../utils/fill";

const PAGE = 20;

interface CopiesPanelProps {
  rules: AutoDeleteRule[];
  names: ReadonlyMap<string, string>;
  ruleId: string;
  onRuleIdChange: (ruleId: string) => void;
}

function failureMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError && err.message ? err.message : fallback;
}

export const CopiesPanel: React.FC<CopiesPanelProps> = ({
  rules,
  names,
  ruleId,
  onRuleIdChange,
}) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [entries, setEntries] = useState<AutoDeleteLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirm, setConfirm] = useState<"all" | "rule" | null>(null);
  const [clearing, setClearing] = useState(false);
  const seq = useRef(0);

  // A changed rule or a cleared list returns to the first page before the
  // fetch effect below runs, so there is no wasted page for the old offset.
  const resetKey = `${ruleId}|${reloadToken}`;
  const [activeKey, setActiveKey] = useState(resetKey);
  if (activeKey !== resetKey) {
    setActiveKey(resetKey);
    setPage(1);
  }

  useEffect(() => {
    const token = ++seq.current;
    setLoading(true);
    setError(null);
    api
      .listAutoDeleteLog({ ruleId: ruleId || undefined, limit: PAGE, offset: (page - 1) * PAGE })
      .then((res) => {
        if (seq.current !== token) return;
        setEntries(res.log);
        setTotal(res.total);
      })
      .catch((err) => {
        if (seq.current !== token) return;
        const message = failureMessage(err, t("copiesLoadFailed"));
        setError(message);
        toast(message, "error");
      })
      .finally(() => {
        if (seq.current === token) setLoading(false);
      });
  }, [ruleId, reloadToken, page, t, toast]);

  const clear = async () => {
    setClearing(true);
    try {
      await api.clearAutoDeleteLog(confirm === "rule" ? ruleId : undefined);
      toast(t("copiesCleared"), "success");
      setConfirm(null);
      setReloadToken((value) => value + 1);
    } catch (err) {
      toast(failureMessage(err, t("copiesLoadFailed")), "error");
    } finally {
      setClearing(false);
    }
  };

  const mediaLabel = useCallback(
    (type: string) => {
      if (!type) return t("mediaText");
      const labels: Record<
        string,
        "mediaImage" | "mediaVideo" | "mediaAudio" | "mediaSticker" | "mediaDocument"
      > = {
        image: "mediaImage",
        video: "mediaVideo",
        audio: "mediaAudio",
        sticker: "mediaSticker",
        document: "mediaDocument",
      };
      const key = labels[type];
      return key ? t(key) : type;
    },
    [t],
  );

  const selected = rules.find((rule) => String(rule.id) === ruleId);
  const pageCount = Math.max(1, Math.ceil(total / PAGE));
  const safePage = Math.min(page, pageCount);

  return (
    <div className="flex flex-col gap-3">
      <Toolbar>
        <FilterButton
          label={t("filter")}
          resetLabel={t("reset")}
          activeCount={ruleId ? 1 : 0}
          onReset={() => onRuleIdChange("")}
        >
          <Field label={t("filterByRule")}>
            <Select
              aria-label={t("filterByRule")}
              value={ruleId}
              onChange={(event) => onRuleIdChange(event.target.value)}
            >
              <option value="">{t("allRules")}</option>
              {rules.map((rule) => (
                <option key={rule.id} value={String(rule.id)}>
                  {ruleLabel(rule)}
                </option>
              ))}
            </Select>
          </Field>
        </FilterButton>
        <span className="ms-auto">
          <OverflowMenu label={t("more")}>
            {ruleId && (
              <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => setConfirm("rule")}>
                {t("clearCopiesForRule")}
              </MenuItem>
            )}
            <MenuItem danger icon={<Trash2 size={16} />} onSelect={() => setConfirm("all")}>
              {t("clearCopies")}
            </MenuItem>
          </OverflowMenu>
        </span>
      </Toolbar>

      {loading && (
        <div className="flex flex-col gap-3" aria-busy="true">
          {["s1", "s2", "s3"].map((id) => (
            <Card key={id} className="flex flex-col gap-3">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-5 w-24" />
            </Card>
          ))}
        </div>
      )}

      {!loading && error && (
        <EmptyState
          kind="error"
          icon={<RotateCcw size={28} />}
          description={error}
          action={
            <Button
              variant="secondary"
              icon={<RotateCcw size={16} />}
              onClick={() => setReloadToken((value) => value + 1)}
            >
              {t("retryLoad")}
            </Button>
          }
        />
      )}

      {!loading && !error && entries.length === 0 && ruleId && (
        <EmptyState
          kind="no-results"
          description={t("noCopiesForRule")}
          action={
            <Button variant="secondary" onClick={() => onRuleIdChange("")}>
              {t("clearFilters")}
            </Button>
          }
        />
      )}

      {!loading && !error && entries.length === 0 && !ruleId && (
        <EmptyState kind="empty" title={t("noCopiesTitle")} description={t("noCopiesBody")} />
      )}

      {!loading && !error && entries.length > 0 && (
        <>
          <div className="flex flex-col gap-3">
            {entries.map((entry) => {
              const chat = peerLabel(entry.chatJid, names) || "—";
              const sender = peerLabel(entry.sender, names) || "—";
              const modeLabel =
                entry.mode === "revoke"
                  ? t("modeRevoke")
                  : entry.mode === "deleteForMe"
                    ? t("modeForMe")
                    : entry.mode;
              return (
                <Card key={entry.id} className="flex flex-col gap-2">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold text-faint">{t("copyChat")}</p>
                      <p
                        dir={peerDir(entry.chatJid, names)}
                        className="truncate text-sm font-semibold"
                      >
                        {chat}
                      </p>
                    </div>
                    <div className="min-w-0">
                      <p className="text-[11px] font-bold text-faint">{t("copySender")}</p>
                      <p dir={peerDir(entry.sender, names)} className="truncate text-sm">
                        {sender}
                      </p>
                    </div>
                    <RelativeTime value={entry.createdAt} className="ms-auto text-xs text-muted" />
                  </div>
                  <p dir="auto" className="whitespace-pre-wrap break-words text-sm text-text-main">
                    {entry.text || "—"}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <Badge>{mediaLabel(entry.mediaType)}</Badge>
                    <Badge tone={entry.mode === "revoke" ? "info" : "neutral"}>{modeLabel}</Badge>
                  </div>
                </Card>
              );
            })}
          </div>
          <Pagination page={safePage} pageCount={pageCount} total={total} onPageChange={setPage} />
        </>
      )}

      <ConfirmDialog
        isOpen={confirm !== null}
        onClose={() => setConfirm(null)}
        onConfirm={() => void clear()}
        title={t("clearCopiesTitle")}
        description={
          confirm === "rule"
            ? fill(t("clearCopiesRuleBody"), { name: selected ? ruleLabel(selected) : "" })
            : t("clearCopiesBody")
        }
        confirmLabel={t("clearCopies")}
        cancelLabel={t("cancel")}
        loading={clearing}
      />
    </div>
  );
};
