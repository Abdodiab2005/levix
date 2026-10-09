import { Search } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import { useI18n } from "../context/I18nContext";
import { explainError, stickerErrorKey } from "../utils/stickerErrors";
import { Badge, Button, Dialog, Input, LoadingState } from "./ui";

export interface Recipient {
  id: string;
  name: string;
  type: "group" | "contact";
  phone?: string | null;
}

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
  const { t } = useI18n();
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
        if (err instanceof ApiError && !stickerErrorKey(err.code)) {
          setError(err.message || t("recipientsLoadFailed"));
        } else {
          setError(explainError(t, err));
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
    const needle = query.trim().toLowerCase();
    if (!needle) return pool;
    return pool.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        (item.phone || "").toLowerCase().includes(needle),
    );
  }, [includeGroups, items, query]);

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
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {shown.map((item) => {
            const selected = selectedIds?.includes(item.id) ?? false;
            return (
              <Button
                key={item.id}
                variant="secondary"
                disabled={busy || selected}
                onClick={() => onPick(item.id)}
                className="h-auto w-full flex-col items-start px-3 py-2.5"
              >
                <span className="flex w-full items-center gap-2">
                  <span dir="auto" className="block min-w-0 flex-1 truncate text-sm font-semibold">
                    {item.name}
                  </span>
                  {selected && <Badge tone="info">{t("contactAdded")}</Badge>}
                </span>
                <span className="block w-full text-[11px] font-medium text-muted">
                  {item.type === "group" ? t("recipientGroup") : t("recipientContact")}
                  {item.phone ? (
                    <span dir="ltr" className="ms-2">
                      {item.phone}
                    </span>
                  ) : null}
                </span>
              </Button>
            );
          })}
        </div>
        {busy && <p className="text-xs text-muted">{t("sending")}</p>}
      </div>
    </Dialog>
  );
};
