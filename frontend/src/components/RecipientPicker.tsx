import { userErrorMessage } from "../utils/userError";
import { Check, Search, User, Users } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import type { MessageKey } from "../i18n/translations";
import type { DashboardRecipient } from "../types";
import { fill } from "../utils/fill";
import { bidiRuns, labelRecipients, recipientMatches, type RecipientParts } from "../utils/recipientLabel";
import { explainError, stickerErrorKey } from "../utils/stickerErrors";
import { Button, Dialog, Input, LoadingState, UserText } from "./ui";

export type Recipient = DashboardRecipient;

interface RecipientPickerProps {
  open: boolean;
  busy?: boolean;
  onClose: () => void;
  onPick: (jid: string) => void;
  /** Defaults to the sticker "send via WhatsApp" title. */
  title?: string;
  /** Stickers offer groups. Auto-delete passes false and keeps contacts only. */
  includeGroups?: boolean;
  /** Already chosen ids stay visible and are not offered again. */
  selectedIds?: readonly string[];
  emptyText?: string;
}

export function BidiText({ text, className }: { text: string; className?: string }) {
  const runs = bidiRuns(text);
  return (
    <span dir="auto" className={className}>
      {runs.map((run) =>
        run.ltr ? (
          <bdi key={`ltr:${run.text}`} dir="ltr">
            {run.text}
          </bdi>
        ) : (
          <span key={`txt:${run.text}`}>{run.text}</span>
        ),
      )}
    </span>
  );
}

function KindIcon({ kind }: { kind: RecipientParts["kind"] }) {
  const Icon = kind === "group" ? Users : User;
  const tone = kind === "group" ? "bg-brand-blue/10 text-brand-cyan" : "bg-ok/10 text-ok";
  return (
    <span
      className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${tone}`}
      aria-hidden
    >
      <Icon size={18} />
    </span>
  );
}

export const RecipientPicker: React.FC<RecipientPickerProps> = ({
  open,
  busy = false,
  onClose,
  onPick,
  title,
  includeGroups = true,
  selectedIds,
  emptyText,
}) => {
  const { t, language } = useI18n();
  const [items, setItems] = useState<Recipient[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getRecipients()
      .then((res) => {
        if (!cancelled) setItems(res.recipients);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && stickerErrorKey(err.code)) {
          setError(explainError(t, err));
        } else {
          setError(userErrorMessage(t, err, "recipientsLoadFailed"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const shown = useMemo(() => {
    const pool = includeGroups ? items : items.filter((item) => item.type === "contact");
    const needle = query.trim();
    if (!needle) return pool;
    return pool.filter((item) => recipientMatches(item, needle));
  }, [includeGroups, items, query]);

  const parts = useMemo(
    () => labelRecipients(shown, (key) => t(key as MessageKey), language),
    [shown, language, t],
  );

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title={title ?? t("sendViaWhatsapp")}
      footer={
        <Button onClick={onClose} disabled={busy}>
          {t("cancel")}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={16} className="pointer-events-none absolute start-3 top-3 text-muted" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("searchRecipients")}
            aria-label={t("searchRecipients")}
            className="ps-9"
          />
        </div>
        {loading && <LoadingState text={t("loading")} />}
        {error && (
          <p className="text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && shown.length === 0 && (
          <p className="text-sm text-muted">{emptyText ?? t("noRecipients")}</p>
        )}
        {!loading && !error && shown.length > 0 && (
          <p className="text-xs text-muted" aria-live="polite">
            {fill(t("recipientResultCount"), { count: shown.length })}
          </p>
        )}
        <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
          {shown.map((item, index) => {
            const row = parts[index];
            const selected = selectedIds?.includes(item.id) ?? false;
            return (
              <Button
                key={item.id}
                variant="secondary"
                disabled={busy || selected}
                aria-pressed={selected}
                onClick={() => onPick(item.id)}
                className={`h-auto min-h-14 w-full items-center justify-start gap-3 px-3 py-1.5 text-start ${
                  selected ? "border-brand-blue/40 bg-brand-blue/10" : ""
                }`}
              >
                <KindIcon kind={row.kind} />
                <span className="min-w-0 flex-1">
                  <UserText lines={1} className="block text-sm font-semibold text-text-main">
                    {row.title}
                  </UserText>
                  {row.subtitle ? (
                    <BidiText
                      text={row.subtitle}
                      className="block truncate text-[11px] text-muted"
                    />
                  ) : null}
                </span>
                {selected && (
                  <span className="inline-flex shrink-0 items-center text-brand-blue">
                    <Check size={18} aria-hidden />
                    <span className="sr-only">{t("contactAdded")}</span>
                  </span>
                )}
              </Button>
            );
          })}
        </div>
        {busy && <p className="text-xs text-muted">{t("sending")}</p>}
      </div>
    </Dialog>
  );
};
