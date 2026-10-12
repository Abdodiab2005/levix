import { Sticker as StickerIcon } from "lucide-react";
import type React from "react";
import { Button, EmptyState, LoadingState, Pagination } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { cn } from "../../utils/cn";
import { StickerTile } from "./StickerTile";

interface StickerGridProps {
  items: Sticker[];
  total: number;
  page: number;
  pageCount: number;
  loading: boolean;
  error: string | null;
  emptyText: string;
  isFiltered: boolean;
  selected: Set<string>;
  onToggle: (index: number, shift: boolean) => void;
  onOpen: (sticker: Sticker) => void;
  onFavorite: (sticker: Sticker) => void;
  onPageChange: (page: number) => void;
  onRetry: () => void;
  onClearFilters?: () => void;
  onGoCreate?: () => void;
}

export const StickerGrid: React.FC<StickerGridProps> = ({
  items,
  total,
  page,
  pageCount,
  loading,
  error,
  emptyText,
  isFiltered,
  selected,
  onToggle,
  onOpen,
  onFavorite,
  onPageChange,
  onRetry,
  onClearFilters,
  onGoCreate,
}) => {
  const { t } = useI18n();

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {loading && items.length === 0 ? (
        <LoadingState text={t("loading")} />
      ) : error ? (
        <EmptyState
          kind="error"
          description={error}
          action={<Button onClick={onRetry}>{t("retryLoad")}</Button>}
        />
      ) : items.length === 0 ? (
        isFiltered ? (
          <EmptyState
            kind="no-results"
            description={emptyText}
            action={
              onClearFilters ? (
                <Button variant="secondary" onClick={onClearFilters}>
                  {t("reset")}
                </Button>
              ) : undefined
            }
          />
        ) : (
          <EmptyState
            kind="empty"
            icon={<StickerIcon size={28} className="text-muted" />}
            description={emptyText}
            action={
              onGoCreate ? (
                <Button variant="primary" onClick={onGoCreate}>
                  {t("createBtn")}
                </Button>
              ) : undefined
            }
          />
        )
      ) : (
        <div
          className={cn(
            "grid grid-cols-3 min-[390px]:grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 xl:grid-cols-10 gap-2 sm:gap-3 transition-opacity",
            loading && "opacity-60 pointer-events-none",
          )}
        >
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
      )}
      {total > 0 && (
        <Pagination
          page={page}
          pageCount={pageCount}
          total={total}
          onPageChange={onPageChange}
          className="pt-1"
        />
      )}
    </div>
  );
};
