import { Merge, Package, Pencil, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import {
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  LoadingState,
  MenuItem,
  MenuSeparator,
  OverflowMenu,
  RadioGroup,
  Select,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { fill } from "../../utils/fill";
import { explainError } from "../../utils/stickerErrors";
import { PACK_NAME_MAX, packNameLengthError } from "../../utils/stickerLimits";
import { PackDetail } from "./PackDetail";

interface PacksViewProps {
  isConnected: boolean;
  gifEnabled: boolean;
  onOpenInCreate: (sticker: Sticker) => void;
}

export const PacksView: React.FC<PacksViewProps> = ({
  isConnected,
  gifEnabled,
  onOpenInCreate,
}) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<Pack | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<Pack | null>(null);
  const [deleteStickers, setDeleteStickers] = useState(false);
  const [mergeTarget, setMergeTarget] = useState<Pack | null>(null);
  const [intoPackId, setIntoPackId] = useState("");

  const load = useCallback(() => {
    setError(null);
    api
      .getPacks()
      .then((res) => setPacks(res.packs))
      .catch((err) => setError(explainError(t, err)))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async () => {
    if (packNameLengthError(name)) {
      setNameError(t("packNameLength"));
      return;
    }
    setBusy(true);
    setNameError(null);
    try {
      await api.createPack(name.trim());
      setName("");
      toast(t("packCreated"), "success");
      load();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const rename = async () => {
    if (!renameTarget) return;
    if (packNameLengthError(renameValue)) {
      toast(t("packNameLength"), "warning");
      return;
    }
    setBusy(true);
    try {
      await api.updatePack(renameTarget.id, renameValue.trim());
      toast(t("packRenamed"), "success");
      setRenameTarget(null);
      load();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    setBusy(true);
    try {
      await api.deletePack(deleteTarget.id, deleteStickers);
      toast(t("packDeleted"), "success");
      setDeleteTarget(null);
      setDeleteStickers(false);
      load();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  const merge = async () => {
    if (!mergeTarget) return;
    if (!intoPackId) {
      toast(t("noDestinationPack"), "warning");
      return;
    }
    setBusy(true);
    try {
      await api.mergePack(mergeTarget.id, intoPackId);
      toast(t("packsMerged"), "success");
      setMergeTarget(null);
      setIntoPackId("");
      load();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  if (openId) {
    return (
      <PackDetail
        packId={openId}
        isConnected={isConnected}
        gifEnabled={gifEnabled}
        onOpenInCreate={onOpenInCreate}
        onBack={() => {
          setOpenId(null);
          load();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={name}
          onChange={(event) => {
            const next = event.target.value;
            setName(next);
            if (nameError) setNameError(packNameLengthError(next) ? t("packNameLength") : null);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void create();
            }
          }}
          placeholder={t("newPackPlaceholder")}
          aria-label={t("packName")}
          maxLength={PACK_NAME_MAX + 20}
        />
        <Button
          variant="primary"
          onClick={() => void create()}
          disabled={busy}
          icon={<Plus size={16} />}
        >
          {t("createPack")}
        </Button>
      </div>
      {nameError && <p className="text-xs text-danger">{nameError}</p>}

      {loading && <LoadingState text={t("loading")} />}
      {error && !loading && (
        <div className="flex flex-col items-center gap-3 py-10">
          <p className="text-sm text-danger">{error}</p>
          <Button onClick={load}>{t("retryLoad")}</Button>
        </div>
      )}
      {!loading && !error && packs.length === 0 && (
        <EmptyState icon={<Package size={28} className="text-muted" />} text={t("noPacks")} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {packs.map((pack) => (
          <Card key={pack.id} className="flex items-center gap-3">
            <Button
              variant="ghost"
              onClick={() => setOpenId(pack.id)}
              className="h-auto min-h-11 flex-1 justify-start gap-3 px-1"
              aria-label={t("openPack")}
            >
              {pack.coverUrl ? (
                <img
                  src={pack.coverUrl}
                  alt=""
                  loading="lazy"
                  className="w-14 h-14 rounded-xl object-cover bg-panel-hover shrink-0"
                />
              ) : (
                <span className="w-14 h-14 rounded-xl bg-panel-hover text-muted flex items-center justify-center shrink-0">
                  <Package size={20} />
                </span>
              )}
              <span className="min-w-0">
                <span className="block font-bold text-text-main truncate">{pack.name}</span>
                <span className="block text-xs text-muted">
                  {fill(t("stickerCount"), { n: pack.count })}
                </span>
              </span>
            </Button>
            <OverflowMenu label={t("moreActions")}>
              <MenuItem
                icon={<Pencil size={16} />}
                onSelect={() => {
                  setRenameTarget(pack);
                  setRenameValue(pack.name);
                }}
              >
                {t("renamePack")}
              </MenuItem>
              <MenuItem
                icon={<Merge size={16} />}
                onSelect={() => {
                  setMergeTarget(pack);
                  setIntoPackId("");
                }}
              >
                {t("merge")}
              </MenuItem>
              <MenuSeparator />
              <MenuItem
                danger
                icon={<Trash2 size={16} />}
                onSelect={() => {
                  setDeleteTarget(pack);
                  setDeleteStickers(false);
                }}
              >
                {t("deletePack")}
              </MenuItem>
            </OverflowMenu>
          </Card>
        ))}
      </div>

      <Dialog
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t("renamePack")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button onClick={() => setRenameTarget(null)}>{t("cancel")}</Button>
            <Button variant="primary" onClick={() => void rename()} disabled={busy}>
              {t("save")}
            </Button>
          </div>
        }
      >
        <Input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          aria-label={t("packName")}
        />
      </Dialog>

      <Dialog
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("deletePackTitle")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button onClick={() => setDeleteTarget(null)}>{t("cancel")}</Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              {t("delete")}
            </Button>
          </div>
        }
      >
        <RadioGroup
          name="delete-pack-mode"
          value={deleteStickers ? "stickers" : "keep"}
          onChange={(value) => setDeleteStickers(value === "stickers")}
          options={[
            { value: "keep", label: t("deleteKeepStickers") },
            { value: "stickers", label: t("deletePackAndStickers") },
          ]}
        />
      </Dialog>

      <Dialog
        isOpen={mergeTarget !== null}
        onClose={() => setMergeTarget(null)}
        title={t("mergeTitle")}
        footer={
          <div className="flex w-full justify-end gap-2">
            <Button onClick={() => setMergeTarget(null)}>{t("cancel")}</Button>
            <Button variant="primary" onClick={() => void merge()} disabled={busy || !intoPackId}>
              {t("confirmMerge")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-main">{t("mergeConfirmBody")}</p>
          <label className="text-xs font-bold" htmlFor="merge-into">
            {t("mergeInto")}
          </label>
          <Select
            id="merge-into"
            value={intoPackId}
            onChange={(event) => setIntoPackId(event.target.value)}
          >
            <option value="">{t("selectPack")}</option>
            {packs
              .filter((pack) => pack.id !== mergeTarget?.id)
              .map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.name}
                </option>
              ))}
          </Select>
        </div>
      </Dialog>
    </div>
  );
};
