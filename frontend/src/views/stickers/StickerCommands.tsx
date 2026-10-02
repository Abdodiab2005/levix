import { useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { fill } from "../../utils/fill";
import { markUsed, saveOne, saveZip, shareOne, shareZip } from "../../utils/stickerDelivery";
import { explainError } from "../../utils/stickerErrors";
import type { Delivered } from "../../utils/stickerFiles";
import { EXPORT_MAX_IDS, SEND_MAX_IDS, STICKER_NAME_MAX } from "../../utils/stickerLimits";
import { DeleteStickersDialog } from "./DeleteStickersDialog";
import { PackPicker } from "./PackPicker";
import { RecipientPicker } from "./RecipientPicker";
import { StickerDetail } from "./StickerDetail";
import { packsForStickers, useDeleteStickers } from "./useDeleteStickers";

interface StickerCommandsProps {
  items: Sticker[];
  packs: Pack[];
  selectedIds: string[];
  clearSelection: () => void;
  reload: () => void;
  fromPackId?: string;
  isConnected: boolean;
  gifEnabled: boolean;
  onOpenInCreate: (sticker: Sticker) => void;
  onPackCreated: () => void;
}

export function useStickerCommands({
  items,
  packs,
  selectedIds,
  clearSelection,
  reload,
  fromPackId,
  isConnected,
  gifEnabled,
  onOpenInCreate,
  onPackCreated,
}: StickerCommandsProps) {
  const { t } = useI18n();
  const { toast } = useToast();
  const lock = useRef(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [picker, setPicker] = useState<null | "add" | "move">(null);
  const [pickerIds, setPickerIds] = useState<string[]>([]);
  const [sendIds, setSendIds] = useState<string[]>([]);
  const [sendBusy, setSendBusy] = useState(false);
  const deletion = useDeleteStickers(() => {
    setDetailId(null);
    clearSelection();
    reload();
  });

  const detail = items.find((item) => item.id === detailId) || null;
  const exportReason = selectedIds.length > EXPORT_MAX_IDS ? t("stickerExportLimit") : null;
  const sendReason = !isConnected
    ? t("notConnectedHint")
    : selectedIds.length > SEND_MAX_IDS
      ? t("stickerSendLimit")
      : null;
  const shownPacks =
    deletion.phase?.kind === "inUse"
      ? deletion.phase.packs.length
        ? deletion.phase.packs
        : packsForStickers(deletion.phase.ids, items, packs)
      : [];

  const announce = (result: Delivered) => {
    if (!result.ok) return;
    if (result.via === "host") toast(fill(t("stickerShareSaved"), { dir: result.dir }), "success");
    else if (result.via === "share") toast(t("shareDone"), "success");
    else toast(t("downloaded"), "success");
  };

  const guard = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    try {
      await work();
    } catch (err) {
      toast(explainError(t, err), "error");
    } finally {
      lock.current = false;
    }
  };

  const findOne = (id: string) => items.find((item) => item.id === id);

  const deliver = (ids: string[], format: "webp" | "png", share: boolean) =>
    guard(async () => {
      if (!ids.length || ids.length > EXPORT_MAX_IDS) return;
      const single = ids.length === 1 ? findOne(ids[0]) : null;
      if (ids.length === 1 && !single) return;
      const animated = ids.some((id) => findOne(id)?.animated);
      if (format === "png" && animated) toast(t("firstFrameHint"), "info");
      const result =
        ids.length === 1 && single
          ? await (share ? shareOne(single, format) : saveOne(single, format))
          : await (share ? shareZip(ids, format) : saveZip(ids, format));
      announce(result);
      if (result.ok) {
        await markUsed(ids);
        reload();
      }
    });

  const setFavorite = (ids: string[], favorite: boolean) =>
    guard(async () => {
      if (!ids.length) return;
      const res = await api.bulkStickers({
        action: favorite ? "favorite" : "unfavorite",
        ids,
      });
      toast(
        res.skipped.length ? t("skippedOther") : t("saved"),
        res.skipped.length ? "warning" : "success",
      );
      reload();
    });

  const commitPack = (action: "addToPack" | "moveToPack", packId: string, ids: string[]) =>
    guard(async () => {
      if (!ids.length) return;
      const res = await api.bulkStickers({
        action,
        ids,
        packId,
        ...(action === "moveToPack" && fromPackId ? { fromPackId } : {}),
      });
      const ok = action === "addToPack" ? t("addedToPack") : t("movedToPack");
      toast(
        res.skipped.length ? t("skippedOther") : ok,
        res.skipped.length ? "warning" : "success",
      );
      setPicker(null);
      reload();
    });

  return {
    exportReason,
    sendReason,
    openDetail: (sticker: Sticker) => setDetailId(sticker.id),
    toggleFavorite: (sticker: Sticker) => void setFavorite([sticker.id], !sticker.favorite),
    favorite: () => void setFavorite(selectedIds, true),
    unfavorite: () => void setFavorite(selectedIds, false),
    askAdd: () => {
      setPickerIds(selectedIds);
      setPicker("add");
    },
    askMove: () => {
      setPickerIds(selectedIds);
      setPicker("move");
    },
    remove: () => {
      if (!fromPackId || !selectedIds.length) return;
      void guard(async () => {
        const res = await api.bulkStickers({
          action: "removeFromPack",
          ids: selectedIds,
          packId: fromPackId,
        });
        toast(
          res.skipped.length ? t("skippedOther") : t("removedFromPack"),
          res.skipped.length ? "warning" : "success",
        );
        clearSelection();
        reload();
      });
    },
    download: () => void deliver(selectedIds, "webp", false),
    convert: () => void deliver(selectedIds, "png", false),
    share: () => void deliver(selectedIds, "webp", true),
    askSend: () => {
      if (sendReason || !selectedIds.length) return;
      setSendIds(selectedIds);
    },
    askDelete: () => deletion.requestDelete(selectedIds),
    dialogs: (
      <>
        <PackPicker
          open={picker !== null}
          title={picker === "move" ? t("moveToPack") : t("addToPack")}
          packs={packs}
          onClose={() => setPicker(null)}
          onCreated={onPackCreated}
          onPick={(packId) =>
            void commitPack(picker === "move" ? "moveToPack" : "addToPack", packId, pickerIds)
          }
        />
        <RecipientPicker
          open={sendIds.length > 0}
          busy={sendBusy}
          onClose={() => setSendIds([])}
          onPick={(jid) => {
            void guard(async () => {
              setSendBusy(true);
              try {
                const res = await api.sendStickers({ ids: sendIds, jid });
                if (res.sent > 0) {
                  toast(sendIds.length > 1 ? t("stickersSent") : t("stickerSent"), "success");
                  setSendIds([]);
                  reload();
                } else {
                  toast(t("stickerErr_NOT_CONNECTED"), "error");
                }
              } finally {
                setSendBusy(false);
              }
            });
          }}
        />
        <DeleteStickersDialog
          open={deletion.phase !== null}
          busy={deletion.busy}
          count={deletion.phase?.ids.length ?? 0}
          inUse={deletion.phase?.kind === "inUse"}
          packs={shownPacks}
          onClose={deletion.close}
          onConfirm={() => {
            if (deletion.phase) void deletion.run(deletion.phase.ids, false);
          }}
          onConfirmEverywhere={() => {
            if (deletion.phase) void deletion.run(deletion.phase.ids, true);
          }}
        />
        <StickerDetail
          sticker={detail}
          packs={packs}
          isConnected={isConnected}
          gifEnabled={gifEnabled}
          onClose={() => setDetailId(null)}
          onRename={(name) => {
            if (!detail) return;
            if ([...name.trim()].length > STICKER_NAME_MAX) {
              toast(t("stickerNameTooLong"), "warning");
              return;
            }
            void guard(async () => {
              await api.updateSticker(detail.id, { name: name.trim() });
              toast(t("renamed"), "success");
              reload();
            });
          }}
          onFavorite={(favorite) => {
            if (!detail) return;
            void guard(async () => {
              await api.updateSticker(detail.id, { favorite });
              toast(t("saved"), "success");
              reload();
            });
          }}
          onAddToPack={(packId) => {
            if (detail) void commitPack("addToPack", packId, [detail.id]);
          }}
          onRemoveFromPack={(packId) => {
            if (!detail) return;
            void guard(async () => {
              await api.bulkStickers({
                action: "removeFromPack",
                ids: [detail.id],
                packId,
              });
              toast(t("removedFromPack"), "success");
              reload();
            });
          }}
          onDownload={(format) => {
            if (!detail) return;
            if (format === "gif") {
              void guard(async () => {
                const result = await saveOne(detail, "gif");
                announce(result);
                if (result.ok) {
                  await markUsed([detail.id]);
                  reload();
                }
              });
              return;
            }
            void deliver([detail.id], format, false);
          }}
          onShare={() => {
            if (detail) void deliver([detail.id], "webp", true);
          }}
          onSend={() => {
            if (detail && isConnected) setSendIds([detail.id]);
          }}
          onDelete={() => {
            if (detail) deletion.requestDelete([detail.id]);
          }}
          onOpenInCreate={() => {
            if (!detail) return;
            setDetailId(null);
            onOpenInCreate(detail);
          }}
        />
      </>
    ),
  };
}
