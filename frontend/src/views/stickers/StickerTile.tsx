import { Check, Star } from "lucide-react";
import type React from "react";
import { useI18n } from "../../context/I18nContext";
import type { Sticker } from "../../types";
import { cn } from "../../utils/cn";

interface StickerTileProps {
  sticker: Sticker;
  selected: boolean;
  onToggle: (shift: boolean) => void;
  onOpen: () => void;
  onFavorite: () => void;
}

export const StickerTile: React.FC<StickerTileProps> = ({
  sticker,
  selected,
  onToggle,
  onOpen,
  onFavorite,
}) => {
  const { t } = useI18n();
  const label = sticker.name || t("stickerPreview");

  return (
    <div
      className={cn(
        "relative aspect-square rounded-xl border bg-panel overflow-hidden",
        selected ? "border-brand-blue ring-2 ring-brand-blue/50" : "border-line",
      )}
    >
      <button
        type="button"
        onClick={() => onOpen()}
        className="absolute inset-0 focus-visible:ring-2 focus-visible:ring-brand-blue/50"
        aria-label={t("stickerOpen")}
      >
        <img
          src={sticker.thumbUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className="w-full h-full object-contain bg-[repeating-conic-gradient(#2a2a2e_0%_25%,#1c1c20_0%_50%)] bg-[length:16px_16px]"
        />
      </button>
      <button
        type="button"
        aria-pressed={selected}
        aria-label={t("stickerSelect")}
        onClick={(event) => onToggle(event.shiftKey)}
        className={cn(
          "absolute top-1 start-1 z-10 w-7 h-7 rounded-lg border flex items-center justify-center focus-visible:ring-2 focus-visible:ring-brand-blue/50",
          selected
            ? "bg-brand-blue border-brand-blue text-white"
            : "bg-panel/90 border-line text-transparent hover:text-muted",
        )}
      >
        <Check size={16} strokeWidth={3} />
      </button>
      {sticker.animated && (
        <span className="absolute bottom-1 start-1 z-10 px-1.5 py-0.5 rounded-md bg-black/70 text-white text-[10px] font-bold pointer-events-none">
          {t("gifBadge")}
        </span>
      )}
      <button
        type="button"
        onClick={onFavorite}
        aria-pressed={sticker.favorite}
        aria-label={sticker.favorite ? t("unfavorite") : t("favorite")}
        title={sticker.favorite ? t("favoriteBadge") : t("favorite")}
        className="absolute top-1 end-1 z-10 w-7 h-7 rounded-lg bg-panel/90 border border-line flex items-center justify-center focus-visible:ring-2 focus-visible:ring-brand-blue/50"
      >
        <Star size={14} className={sticker.favorite ? "fill-warn text-warn" : "text-muted"} />
      </button>
      <span className="sr-only">{label}</span>
    </div>
  );
};
