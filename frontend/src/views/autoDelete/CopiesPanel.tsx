import { Trash2 } from "lucide-react";
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
  RelativeTime,
  Select,
  Skeleton,
  Toolbar,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { AutoDeleteLogEntry, AutoDeleteRule } from "../../types";
import { peerDir, peerLabel, ruleLabel } from "../../utils/autoDelete";
import { fill } from "../../utils/fill";

const PAGE = 50;

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
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [confirm, setConfirm] = useState<"all" | "rule" | null>(null);
  const [clearing, setClearing] = useState(false);
  const seq = useRef(0);

  useEffect(() => {
    const token = ++seq.current;
    // Read so clearing copies (reloadToken) retriggers this effect.
    void reloadToken;
    setLoading(true);
    setError(null);
    api
      .listAutoDeleteLog({ ruleId: ruleId || undefined, limit: PAGE, offset: 0 })
      .then((res) => {
        if (seq.current !== token) return;
        setEntries(res.log);
        setHasMore(res.log.length === PAGE);
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
  }, [ruleId, reloadToken, t, toast]);

  const loadMore = async () => {
    const token = seq.current;
    setLoadingMore(true);
    try {
      const res = await api.listAutoDeleteLog({
        ruleId: ruleId || undefined,
        limit: PAGE,
        offset: entries.length,
      });
      if (seq.current !== token) return;
      setEntries((prev) => [...prev, ...res.log]);
      setHasMore(res.log.length === PAGE);
    } catch (err) {
      if (seq.current !== token) return;
      toast(failureMessage(err, t("copiesLoadFailed")), "error");
    } finally {
      if (seq.current === token) setLoadingMore(false);
    }
  };

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
        <div className="flex flex-col items-center gap-3 py-10">
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Button onClick={() => setReloadToken((value) => value + 1)}>{t("retryLoad")}</Button>
        </div>
      )}

      {!loading && !error && entries.length === 0 && (
        <EmptyState
          title={ruleId ? t("noCopiesForRule") : t("noCopiesTitle")}
          description={t("noCopiesBody")}
        />
      )}

      {!loading && !error && entries.length > 0 && (
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
          {hasMore && (
            <Button
              variant="secondary"
              className="self-center"
              loading={loadingMore}
              onClick={() => void loadMore()}
            >
              {t("loadMore")}
            </Button>
          )}
        </div>
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
