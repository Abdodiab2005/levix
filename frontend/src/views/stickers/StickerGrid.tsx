import { Sticker as StickerIcon } from "lucide-react";
import type React from "react";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { fill } from "../../utils/fill";
import { Button, EmptyState, LoadingState } from "./ui";
import { StickerTile } from "./StickerTile";

interface StickerGridProps {
  items: Sticker[];
  total: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  hasMore: boolean;
  emptyText: string;
  selected: Set<string>;
  onToggle: (index: number, shift: boolean) => void;
  onOpen: (sticker: Sticker) => void;
  onFavorite: (sticker: Sticker) => void;
  onLoadMore: () => void;
  onRetry: () => void;
}

export const StickerGrid: React.FC<StickerGridProps> = ({
  items,
  total,
  loading,
  loadingMore,
  error,
  hasMore,
  emptyText,
  selected,
  onToggle,
  onOpen,
  onFavorite,
  onLoadMore,
  onRetry,
}) => {
  const { t } = useI18n();

  if (loading && items.length === 0) return <LoadingState text={t("loading")} />;
  if (error && items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <p className="text-sm text-danger">{error}</p>
        <Button onClick={onRetry}>{t("retryLoad")}</Button>
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <EmptyState icon={<StickerIcon size={28} className="text-muted" />} text={emptyText} />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        {fill(t("showingCount"), { shown: items.length, total })}
      </p>
      <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-6 xl:grid-cols-8 gap-2 sm:gap-3">
        {items.map((sticker, index) => (
          <StickerTile
            key={sticker.id}
            sticker={sticker}
            selected={selected.has(sticker.id)}
            onToggle={(shift) => onToggle(index, shift)}
            onOpen={() => onOpen(sticker)}
            onFavorite={() => onFavorite(sticker)}
          />
        ))}
      </div>
      {hasMore && (
        <Button onClick={onLoadMore} disabled={loadingMore} className="self-center">
          {loadingMore ? t("loading") : t("loadMore")}
        </Button>
      )}
    </div>
  );
};
