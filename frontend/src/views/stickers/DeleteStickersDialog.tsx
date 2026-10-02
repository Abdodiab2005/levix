import type React from "react";
import { Modal } from "../../components/Modal";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import type { NamedPack } from "./useDeleteStickers";
import { Button } from "./ui";

interface DeleteStickersDialogProps {
  open: boolean;
  busy: boolean;
  count: number;
  inUse: boolean;
  packs: NamedPack[];
  onClose: () => void;
  onConfirm: () => void;
  onConfirmEverywhere: () => void;
}

export const DeleteStickersDialog: React.FC<DeleteStickersDialogProps> = ({
  open,
  busy,
  count,
  inUse,
  packs,
  onClose,
  onConfirm,
  onConfirmEverywhere,
}) => {
  const { t } = useI18n();
  const names = packs.map((pack) => pack.name).join(", ");

  return (
    <Modal
      isOpen={open}
      onClose={onClose}
      title={t("deleteStickersTitle")}
      footer={
        <div className="flex flex-wrap justify-end gap-2 w-full">
          <Button onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          {inUse ? (
            <Button variant="danger" onClick={onConfirmEverywhere} disabled={busy}>
              {t("deleteEverywhere")}
            </Button>
          ) : (
            <Button variant="danger" onClick={onConfirm} disabled={busy}>
              {t("delete")}
            </Button>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-2 text-sm text-text-main">
        <p>{fill(t("nSelected"), { n: count })}</p>
        {inUse ? (
          <>
            <p>{count === 1 ? t("inUseBody") : t("inUseBulkBody")}</p>
            {names && (
              <p>
                {t("inUsePacksLabel")}: {names}
              </p>
            )}
            <p className="text-muted text-xs">{t("deleteEverywhereHint")}</p>
          </>
        ) : (
          <p>{t("deleteConfirm")}</p>
        )}
      </div>
    </Modal>
  );
};
