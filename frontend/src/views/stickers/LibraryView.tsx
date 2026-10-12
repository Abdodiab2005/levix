import type React from "react";
import { useEffect, useRef } from "react";
import { Button, FilterButton, Input, Select, SortMenu, Toolbar } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { cn } from "../../utils/cn";
import { BulkBar } from "./BulkBar";
import { useStickerCommands } from "./StickerCommands";
import { StickerGrid } from "./StickerGrid";
import { useSelection } from "./useSelection";
import { type StickerFilter, type StickerSort, useStickerList } from "./useStickerList";

interface LibraryViewProps {
  preset: StickerFilter;
  isConnected: boolean;
  gifEnabled: boolean;
  refreshKey: number;
  onOpenInCreate: (sticker: Sticker) => void;
  onGoCreate?: () => void;
}

export const LibraryView: React.FC<LibraryViewProps> = ({
  preset,
  isConnected,
  gifEnabled,
  refreshKey,
  onOpenInCreate,
  onGoCreate,
}) => {
  const { t } = useI18n();
  const list = useStickerList(preset);
  const ids = list.items.map((item) => item.id);
  const resetKey = `${list.q}|${list.filter}|${list.sort}|${list.pack}`;
  const selection = useSelection(ids, resetKey);
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

  const isFiltered = Boolean(list.q || list.pack || (!list.lockedFilter && list.filter !== "all"));

  const emptyText = isFiltered
    ? t("noResults")
    : preset === "favorites"
      ? t("favoritesEmpty")
      : preset === "recent"
        ? t("recentEmpty")
        : t("emptyLibrary");

  const animatedSelected = list.items.some(
    (item) => selection.selected.has(item.id) && item.animated,
  );

  const filterCount = (list.lockedFilter || list.filter === "all" ? 0 : 1) + (list.pack ? 1 : 0);

  const clearFilters = () => {
    list.setQ("");
    if (!list.lockedFilter) list.setFilter("all");
    list.setPack("");
  };

  return (
    <div className={cn("flex flex-col gap-3 min-w-0", selectedIds.length > 0 && "pb-16 sm:pb-0")}>
      <Toolbar>
        <Input
          type="search"
          value={list.q}
          onChange={(event) => list.setQ(event.target.value)}
          placeholder={t("searchStickers")}
          aria-label={t("searchStickers")}
          className="min-w-48 flex-1"
        />
        <FilterButton
          label={t("filter")}
          resetLabel={t("reset")}
          activeCount={filterCount}
          onReset={() => {
            if (!list.lockedFilter) list.setFilter("all");
            list.setPack("");
          }}
        >
          {!list.lockedFilter && (
            <Select
              aria-label={t("filterBy")}
              value={list.filter}
              onChange={(event) => list.setFilter(event.target.value as StickerFilter)}
            >
              <option value="all">{t("allStickers")}</option>
              <option value="favorites">{t("favorites")}</option>
              <option value="recent">{t("recent")}</option>
              <option value="animated">{t("animated")}</option>
              <option value="static">{t("static")}</option>
            </Select>
          )}
          <Select
            aria-label={t("packFilter")}
            value={list.pack}
            onChange={(event) => list.setPack(event.target.value)}
          >
            <option value="">{t("anyPack")}</option>
            <option value="none">{t("noPack")}</option>
            {list.packs.map((pack) => (
              <option key={pack.id} value={pack.id}>
                {pack.name}
              </option>
            ))}
          </Select>
        </FilterButton>
        <SortMenu
          label={t("sort")}
          value={list.sort}
          onChange={(value) => list.setSort(value as StickerSort)}
          options={[
            { value: "newest", label: t("sortNewest") },
            { value: "oldest", label: t("sortOldest") },
            { value: "name", label: t("sortName") },
            { value: "recent", label: t("sortRecent") },
          ]}
        />
      </Toolbar>

      <div className="flex items-center justify-between gap-2 px-0.5 text-xs text-muted">
        <span>{t("resultCount").replace("{n}", String(list.total))}</span>
        {list.items.length > 0 && (
          <Button variant="ghost" size="sm" onClick={selection.selectAll}>
            {t("selectCurrentPage")}
          </Button>
        )}
      </div>

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
        page={list.page}
        pageCount={list.pageCount}
        loading={list.loading}
        error={list.error}
        emptyText={emptyText}
        isFiltered={isFiltered}
        selected={selection.selected}
        onToggle={selection.toggle}
        onOpen={commands.openDetail}
        onFavorite={commands.toggleFavorite}
        onPageChange={list.setPage}
        onRetry={list.reload}
        onClearFilters={isFiltered ? clearFilters : undefined}
        onGoCreate={preset === "all" && !isFiltered ? onGoCreate : undefined}
      />
      {commands.dialogs}
    </div>
  );
};
