import { Search } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../api/client";
import { Button, Dialog, Input, LoadingState } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { explainError } from "../../utils/stickerErrors";

interface Recipient {
  id: string;
  name: string;
  type: "group" | "contact";
  phone?: string | null;
}

interface RecipientPickerProps {
  open: boolean;
  busy: boolean;
  onClose: () => void;
  onPick: (jid: string) => void;
}

export const RecipientPicker: React.FC<RecipientPickerProps> = ({
  open,
  busy,
  onClose,
  onPick,
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
        if (!cancelled) setError(explainError(t, err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, t]);

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (item) =>
        item.name.toLowerCase().includes(needle) ||
        (item.phone || "").toLowerCase().includes(needle),
    );
  }, [items, query]);

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title={t("sendViaWhatsapp")}
      footer={<Button onClick={onClose}>{t("cancel")}</Button>}
    >
      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search size={16} className="absolute start-3 top-3 text-muted" />
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
        {error && <p className="text-sm text-danger">{error}</p>}
        {!loading && !error && shown.length === 0 && (
          <p className="text-sm text-muted">{t("noRecipients")}</p>
        )}
        <div className="flex max-h-72 flex-col gap-1.5 overflow-y-auto">
          {shown.map((item) => (
            <Button
              key={item.id}
              variant="secondary"
              disabled={busy}
              onClick={() => onPick(item.id)}
              className="h-auto w-full flex-col items-start px-3 py-2.5"
            >
              <span className="block w-full truncate text-sm font-semibold">{item.name}</span>
              <span className="block w-full text-[11px] font-medium text-muted">
                {item.type === "group" ? t("recipientGroup") : t("recipientContact")}
                {item.phone ? (
                  <span dir="ltr" className="ms-2">
                    {item.phone}
                  </span>
                ) : null}
              </span>
            </Button>
          ))}
        </div>
        {busy && <p className="text-xs text-muted">{t("sending")}</p>}
      </div>
    </Dialog>
  );
};
