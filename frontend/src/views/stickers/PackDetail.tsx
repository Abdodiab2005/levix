import { ChevronDown, ChevronLeft, ChevronUp, GripVertical } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { useToast } from "../../components/Toasts";
import { Button, EmptyState, IconButton, LoadingState } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { fill } from "../../utils/fill";
import { explainError } from "../../utils/stickerErrors";
import { BulkBar } from "./BulkBar";
import { useStickerCommands } from "./StickerCommands";
import { StickerTile } from "./StickerTile";
import { useSelection } from "./useSelection";

interface PackDetailProps {
  packId: string;
  isConnected: boolean;
  gifEnabled: boolean;
  onBack: () => void;
  onOpenInCreate: (sticker: Sticker) => void;
}

export const PackDetail: React.FC<PackDetailProps> = ({
  packId,
  isConnected,
  gifEnabled,
  onBack,
  onOpenInCreate,
}) => {
  const { t } = useI18n();
  const { toast } = useToast();
  const [pack, setPack] = useState<Pack | null>(null);
  const [items, setItems] = useState<Sticker[]>([]);
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [orderBusy, setOrderBusy] = useState(false);
  const dragId = useRef("");
  const ids = items.map((item) => item.id);
  const selection = useSelection(ids);
  const selectedIds = [...selection.selected];

  useEffect(() => {
    if (tick < 0) return;
    let live = true;
    setError(null);
    Promise.all([api.getPack(packId), api.getPacks()])
      .then(([packRes, packsRes]) => {
        if (!live) return;
        setPack(packRes.pack);
        setItems(packRes.items);
        setPacks(packsRes.packs);
      })
      .catch((err) => {
        if (!live) return;
        setError(explainError(t, err));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [packId, tick, t]);

  const reload = () => {
    setLoading(items.length === 0);
    setTick((value) => value + 1);
  };

  const commands = useStickerCommands({
    items,
    packs,
    selectedIds,
    clearSelection: selection.clear,
    reload,
    fromPackId: packId,
    isConnected,
    gifEnabled,
    onOpenInCreate,
    onPackCreated: reload,
  });

  const persist = async (next: Sticker[]) => {
    const previous = items;
    setItems(next);
    setOrderBusy(true);
    try {
      await api.reorderPack(
        packId,
        next.map((item) => item.id),
      );
    } catch (err) {
      setItems(previous);
      toast(explainError(t, err), "error");
    } finally {
      setOrderBusy(false);
    }
  };

  const shift = (index: number, delta: number) => {
    const target = index + delta;
    if (orderBusy || target < 0 || target >= items.length) return;
    const next = items.slice();
    const [row] = next.splice(index, 1);
    if (!row) return;
    next.splice(target, 0, row);
    void persist(next);
  };

  const dropOn = (overId: string) => {
    const from = items.findIndex((item) => item.id === dragId.current);
    const to = items.findIndex((item) => item.id === overId);
    dragId.current = "";
    if (orderBusy || from < 0 || to < 0 || from === to) return;
    const next = items.slice();
    const [row] = next.splice(from, 1);
    if (!row) return;
    next.splice(to, 0, row);
    void persist(next);
  };

  const animatedSelected = items.some((item) => selection.selected.has(item.id) && item.animated);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={onBack}>
          <ChevronLeft size={16} className="rtl:-scale-x-100" />
          {t("backToPacks")}
        </Button>
        {pack && (
          <div className="min-w-0">
            <h3 className="text-base font-bold text-text-main truncate">{pack.name}</h3>
            <p className="text-xs text-muted">{fill(t("stickerCount"), { n: pack.count })}</p>
          </div>
        )}
      </div>

      {loading && items.length === 0 && <LoadingState text={t("loading")} />}
      {error && items.length === 0 && (
        <div className="flex flex-col items-center gap-3 py-16">
          <p className="text-sm text-danger">{error}</p>
          <Button onClick={reload}>{t("retryLoad")}</Button>
        </div>
      )}
      {!loading && !error && items.length === 0 && (
        <EmptyState
          icon={<GripVertical size={28} className="text-muted" />}
          text={t("packEmpty")}
        />
      )}

      {items.length > 0 && (
        <>
          {selectedIds.length === 0 && (
            <div>
              <Button variant="ghost" size="sm" onClick={selection.selectAll}>
                {t("selectAll")}
              </Button>
            </div>
          )}
          <BulkBar
            count={selectedIds.length}
            animatedSelected={animatedSelected}
            canRemove
            sendReason={selectedIds.length ? commands.sendReason : null}
            exportReason={selectedIds.length ? commands.exportReason : null}
            onSelectAll={selection.selectAll}
            onClear={selection.clear}
            onFavorite={commands.favorite}
            onUnfavorite={commands.unfavorite}
            onAdd={commands.askAdd}
            onMove={commands.askMove}
            onRemove={commands.remove}
            onDownload={commands.download}
            onConvert={commands.convert}
            onShare={commands.share}
            onSend={commands.askSend}
            onDelete={commands.askDelete}
          />
          <ul className="flex flex-col gap-2">
            {items.map((item, index) => (
              <li
                key={item.id}
                className="flex items-center gap-2 rounded-xl border border-line bg-panel p-2"
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  event.preventDefault();
                  dropOn(item.id);
                }}
              >
                <div className="w-16 shrink-0">
                  <StickerTile
                    sticker={item}
                    selected={selection.selected.has(item.id)}
                    onToggle={(shiftKey) => selection.toggle(index, shiftKey)}
                    onOpen={() => commands.openDetail(item)}
                    onFavorite={() => commands.toggleFavorite(item)}
                  />
                </div>
                <p className="flex-1 min-w-0 text-sm font-semibold truncate">
                  {item.name || t("stickerPreview")}
                </p>
                <IconButton
                  label={t("reorderUp")}
                  disabled={orderBusy || index === 0}
                  onClick={() => shift(index, -1)}
                >
                  <ChevronUp size={14} />
                </IconButton>
                <IconButton
                  label={t("reorderDown")}
                  disabled={orderBusy || index === items.length - 1}
                  onClick={() => shift(index, 1)}
                >
                  <ChevronDown size={14} />
                </IconButton>
                <IconButton
                  label={t("reorderDragHint")}
                  variant="ghost"
                  className="cursor-grab"
                  draggable={!orderBusy}
                  onDragStart={(event) => {
                    dragId.current = item.id;
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", item.id);
                  }}
                  icon={<GripVertical size={16} />}
                />
              </li>
            ))}
          </ul>
        </>
      )}
      {commands.dialogs}
    </div>
  );
};
