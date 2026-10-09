import type React from "react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { Button, Dialog, FieldLabel, Input } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Pack } from "../../types";
import { explainError } from "../../utils/stickerErrors";
import { packNameLengthError } from "../../utils/stickerLimits";

interface PackPickerProps {
  open: boolean;
  title: string;
  packs: Pack[];
  onClose: () => void;
  onPick: (packId: string) => void;
  onCreated: (pack: Pack) => void;
}

export const PackPicker: React.FC<PackPickerProps> = ({
  open,
  title,
  packs,
  onClose,
  onPick,
  onCreated,
}) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) return;
    setName("");
    setError(null);
  }, [open]);

  const create = async () => {
    const problem = packNameLengthError(name);
    if (problem) {
      setError(t("packNameLength"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const pack = await api.createPack(name.trim());
      setName("");
      onCreated(pack);
      onPick(pack.id);
      toast(t("packCreated"), "success");
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title={title}
      footer={<Button onClick={onClose}>{t("close")}</Button>}
    >
      <div className="flex flex-col gap-3">
        {packs.length === 0 ? (
          <p className="text-sm text-muted">{t("noPacks")}</p>
        ) : (
          <div className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
            {packs.map((pack) => (
              <Button
                key={pack.id}
                variant="ghost"
                onClick={() => onPick(pack.id)}
                className="h-auto w-full justify-start px-3 py-2.5"
              >
                {pack.name}
                <span className="ms-2 font-medium text-muted">{pack.count}</span>
              </Button>
            ))}
          </div>
        )}
        <div className="flex flex-col gap-1.5 border-t border-line pt-3">
          <FieldLabel htmlFor="new-pack-name">{t("newPack")}</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="new-pack-name"
              value={name}
              onChange={(event) => {
                const next = event.target.value;
                setName(next);
                if (error) setError(packNameLengthError(next) ? t("packNameLength") : null);
              }}
              placeholder={t("newPackPlaceholder")}
              maxLength={80}
            />
            <Button variant="primary" onClick={create} disabled={busy}>
              {t("createPack")}
            </Button>
          </div>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
      </div>
    </Dialog>
  );
};
