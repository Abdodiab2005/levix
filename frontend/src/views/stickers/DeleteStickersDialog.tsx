import type React from "react";
import { Fragment } from "react";
import { Button, Dialog, UserText } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import type { NamedPack } from "./useDeleteStickers";

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

  return (
    <Dialog
      isOpen={open}
      onClose={onClose}
      title={t("deleteStickersTitle")}
      footer={
        <div className="flex w-full flex-wrap justify-end gap-2">
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
            {packs.length > 0 && (
              <p>
                {t("inUsePacksLabel")}:{" "}
                {packs.map((pack, index) => (
                  <Fragment key={pack.id}>
                    {index > 0 && ", "}
                    <UserText as="bdi">{pack.name}</UserText>
                  </Fragment>
                ))}
              </p>
            )}
            <p className="text-xs text-muted">{t("deleteEverywhereHint")}</p>
          </>
        ) : (
          <p>{t("deleteConfirm")}</p>
        )}
      </div>
    </Dialog>
  );
};
