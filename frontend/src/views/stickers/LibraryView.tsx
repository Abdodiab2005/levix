import type React from "react";
import { useEffect, useRef } from "react";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { BulkBar } from "./BulkBar";
import { StickerGrid } from "./StickerGrid";
import { useStickerCommands } from "./StickerCommands";
import { Button, fieldClass } from "./ui";
import { useSelection } from "./useSelection";
import { useStickerList, type StickerFilter, type StickerSort } from "./useStickerList";

interface LibraryViewProps {
  preset: StickerFilter;
  isConnected: boolean;
  gifEnabled: boolean;
  refreshKey: number;
  onOpenInCreate: (sticker: Sticker) => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  preset,
  isConnected,
  gifEnabled,
  refreshKey,
  onOpenInCreate,
}) => {
  const { t } = useI18n();
  const list = useStickerList(preset);
  const ids = list.items.map((item) => item.id);
  const selection = useSelection(ids);
  const selectedIds = [...selection.selected];
  const fromPackId = list.pack && list.pack !== "none" ? list.pack : undefined;
  const reloadRef = useRef(list.reload);
  reloadRef.current = list.reload;

  useEffect(() => {
    if (refreshKey === 0) return;
    reloadRef.current();
  }, [refreshKey]);

  const commands = useStickerCommands({
    items: list.items,
    packs: list.packs,
    selectedIds,
    clearSelection: selection.clear,
    reload: list.reload,
    fromPackId,
    isConnected,
    gifEnabled,
    onOpenInCreate,
    onPackCreated: list.loadPacks,
  });

  const emptyText =
    list.q || list.pack || (!list.lockedFilter && list.filter !== "all")
      ? t("noResults")
      : preset === "favorites"
        ? t("favoritesEmpty")
        : preset === "recent"
          ? t("recentEmpty")
          : t("emptyLibrary");

  const animatedSelected = list.items.some(
    (item) => selection.selected.has(item.id) && item.animated,
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        <input
          type="search"
          value={list.q}
          onChange={(event) => list.setQ(event.target.value)}
          placeholder={t("searchStickers")}
          aria-label={t("searchStickers")}
          className={fieldClass}
        />
        <select
          aria-label={t("sortBy")}
          value={list.sort}
          onChange={(event) => list.setSort(event.target.value as StickerSort)}
          className={fieldClass}
        >
          <option value="newest">{t("sortNewest")}</option>
          <option value="oldest">{t("sortOldest")}</option>
          <option value="name">{t("sortName")}</option>
          <option value="recent">{t("sortRecent")}</option>
        </select>
        {!list.lockedFilter && (
          <select
            aria-label={t("filterBy")}
            value={list.filter}
            onChange={(event) => list.setFilter(event.target.value as StickerFilter)}
            className={fieldClass}
          >
            <option value="all">{t("allStickers")}</option>
            <option value="favorites">{t("favorites")}</option>
            <option value="recent">{t("recent")}</option>
            <option value="animated">{t("animated")}</option>
            <option value="static">{t("static")}</option>
          </select>
        )}
        <select
          aria-label={t("packFilter")}
          value={list.pack}
          onChange={(event) => list.setPack(event.target.value)}
          className={fieldClass}
        >
          <option value="">{t("anyPack")}</option>
          <option value="none">{t("noPack")}</option>
          {list.packs.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.name}
            </option>
          ))}
        </select>
      </div>

      {list.items.length > 0 && selectedIds.length === 0 && (
        <div>
          <Button variant="quiet" className="h-8 px-2" onClick={selection.selectAll}>
            {t("selectAll")}
          </Button>
        </div>
      )}

      <BulkBar
        count={selectedIds.length}
        animatedSelected={animatedSelected}
        canRemove={Boolean(fromPackId)}
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

      <StickerGrid
        items={list.items}
        total={list.total}
        loading={list.loading}
        loadingMore={list.loadingMore}
        error={list.error}
        hasMore={list.hasMore}
        emptyText={emptyText}
        selected={selection.selected}
        onToggle={selection.toggle}
        onOpen={commands.openDetail}
        onFavorite={commands.toggleFavorite}
        onLoadMore={list.loadMore}
        onRetry={list.reload}
      />
      {commands.dialogs}
    </div>
  );
};
