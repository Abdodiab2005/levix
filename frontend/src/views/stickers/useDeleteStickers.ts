import { useState } from "react";
import { ApiError, api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { explainError } from "../../utils/stickerErrors";

export interface NamedPack {
  id: string;
  name: string;
}

type Phase =
  | { kind: "ask"; ids: string[] }
  | { kind: "inUse"; ids: string[]; packs: NamedPack[]; otherSkipped: number };

/**
 * Delete always asks first. In-pack stickers come back as IN_USE and are
 * deleted only when the user confirms, and only those ids are sent again.
 */
export function useDeleteStickers(onDone: () => void) {
  const { t } = useI18n();
  const { toast } = useToast();
  const [phase, setPhase] = useState<Phase | null>(null);
  const [busy, setBusy] = useState(false);

  const requestDelete = (ids: string[]) => {
    if (ids.length) setPhase({ kind: "ask", ids });
  };

  const close = () => {
    if (!busy) setPhase(null);
  };

  const run = async (ids: string[], confirm: boolean) => {
    setBusy(true);
    try {
      if (ids.length === 1 && !confirm) {
        try {
          await api.deleteSticker(ids[0], false);
          toast(t("deleted"), "success");
          setPhase(null);
          onDone();
        } catch (err) {
          if (err instanceof ApiError && err.code === "IN_USE") {
            const packs = Array.isArray(err.data?.packs) ? (err.data.packs as NamedPack[]) : [];
            setPhase({ kind: "inUse", ids, packs, otherSkipped: 0 });
          } else {
            toast(explainError(t, err), "error");
          }
        }
        return;
      }
      const res = await api.bulkStickers({ action: "delete", ids, confirm });
      const inUse = res.skipped.filter((item) => item.code === "IN_USE").map((item) => item.id);
      const other = res.skipped.length - inUse.length;
      if (!confirm && inUse.length > 0) {
        setPhase({ kind: "inUse", ids: inUse, packs: [], otherSkipped: other });
        return;
      }
      if (other > 0) toast(t("skippedOther"), "warning");
      else toast(t("deleted"), "success");
      setPhase(null);
      onDone();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      setBusy(false);
    }
  };

  return { phase, busy, requestDelete, run, close };
}

export function packsForStickers(
  ids: string[],
  stickers: Sticker[],
  packs: NamedPack[],
): NamedPack[] {
  const names = new Map(packs.map((pack) => [pack.id, pack.name]));
  const found = new Map<string, string>();
  for (const id of ids) {
    const sticker = stickers.find((item) => item.id === id);
    for (const packId of sticker?.packIds ?? []) {
      found.set(packId, names.get(packId) || packId);
    }
  }
  return [...found].map(([id, name]) => ({ id, name }));
}
