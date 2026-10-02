import { Merge, Package, Pencil, Plus, Trash2 } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { Modal } from "../../components/Modal";
import { useToast } from "../../components/Toasts";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { fill } from "../../utils/fill";
import { explainError } from "../../utils/stickerErrors";
import { PACK_NAME_MAX, packNameLengthError } from "../../utils/stickerLimits";
import { PackDetail } from "./PackDetail";
import { Button, EmptyState, fieldClass, LoadingState } from "./ui";

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
      <div className="flex flex-col sm:flex-row gap-2">
        <input
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
          className={fieldClass}
        />
        <Button variant="primary" onClick={() => void create()} disabled={busy}>
          <Plus size={16} />
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
        <EmptyState icon={<Package size={28} className="text-muted/40" />} text={t("noPacks")} />
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {packs.map((pack) => (
          <div
            key={pack.id}
            className="rounded-2xl border border-line bg-panel p-3 flex items-center gap-3"
          >
            <button
              type="button"
              onClick={() => setOpenId(pack.id)}
              className="flex items-center gap-3 flex-1 min-w-0 text-start focus-visible:ring-2 focus-visible:ring-brand-blue/50 rounded-xl"
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
            </button>
            <div className="flex flex-col gap-1">
              <Button
                className="h-8 px-2"
                title={t("renamePack")}
                onClick={() => {
                  setRenameTarget(pack);
                  setRenameValue(pack.name);
                }}
              >
                <Pencil size={14} />
                <span className="sr-only">{t("renamePack")}</span>
              </Button>
              <Button
                className="h-8 px-2"
                title={t("mergeInto")}
                onClick={() => {
                  setMergeTarget(pack);
                  setIntoPackId("");
                }}
              >
                <Merge size={14} />
                <span className="sr-only">{t("merge")}</span>
              </Button>
              <Button
                className="h-8 px-2"
                variant="danger"
                title={t("deletePack")}
                onClick={() => {
                  setDeleteTarget(pack);
                  setDeleteStickers(false);
                }}
              >
                <Trash2 size={14} />
                <span className="sr-only">{t("deletePack")}</span>
              </Button>
            </div>
          </div>
        ))}
      </div>

      <Modal
        isOpen={renameTarget !== null}
        onClose={() => setRenameTarget(null)}
        title={t("renamePack")}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button onClick={() => setRenameTarget(null)}>{t("cancel")}</Button>
            <Button variant="primary" onClick={() => void rename()} disabled={busy}>
              {t("save")}
            </Button>
          </div>
        }
      >
        <input
          value={renameValue}
          onChange={(event) => setRenameValue(event.target.value)}
          aria-label={t("packName")}
          className={fieldClass}
        />
      </Modal>

      <Modal
        isOpen={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title={t("deletePackTitle")}
        footer={
          <div className="flex justify-end gap-2 w-full">
            <Button onClick={() => setDeleteTarget(null)}>{t("cancel")}</Button>
            <Button variant="danger" onClick={() => void remove()} disabled={busy}>
              {t("delete")}
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-2">
          <button
            type="button"
            aria-pressed={!deleteStickers}
            onClick={() => setDeleteStickers(false)}
            className="text-start px-3 py-3 rounded-xl border border-line hover:bg-panel-hover aria-pressed:border-brand-blue"
          >
            <span className="block text-sm font-bold">{t("deleteKeepStickers")}</span>
          </button>
          <button
            type="button"
            aria-pressed={deleteStickers}
            onClick={() => setDeleteStickers(true)}
            className="text-start px-3 py-3 rounded-xl border border-line hover:bg-panel-hover aria-pressed:border-danger"
          >
            <span className="block text-sm font-bold">{t("deletePackAndStickers")}</span>
          </button>
        </div>
      </Modal>

      <Modal
        isOpen={mergeTarget !== null}
        onClose={() => setMergeTarget(null)}
        title={t("mergeTitle")}
        footer={
          <div className="flex justify-end gap-2 w-full">
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
          <select
            id="merge-into"
            value={intoPackId}
            onChange={(event) => setIntoPackId(event.target.value)}
            className={fieldClass}
          >
            <option value="">{t("selectPack")}</option>
            {packs
              .filter((pack) => pack.id !== mergeTarget?.id)
              .map((pack) => (
                <option key={pack.id} value={pack.id}>
                  {pack.name}
                </option>
              ))}
          </select>
        </div>
      </Modal>
    </div>
  );
};
