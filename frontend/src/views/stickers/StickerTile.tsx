import { Check, Star } from "lucide-react";
import type React from "react";
import { Badge, Button, IconButton } from "../../components/ui";
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

const checker =
  "bg-[repeating-conic-gradient(var(--panel-raised)_0%_25%,var(--bg)_0%_50%)] bg-[length:16px_16px]";

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
        "relative aspect-square overflow-hidden rounded-xl border bg-panel transition-shadow",
        selected ? "border-brand-blue ring-2 ring-brand-blue/50" : "border-line",
      )}
    >
      <Button
        variant="ghost"
        onClick={() => onOpen()}
        aria-label={t("stickerOpen")}
        className="absolute inset-0 h-auto min-h-0 w-full rounded-none p-0 hover:bg-transparent focus-visible:ring-inset"
      >
        <img
          src={sticker.thumbUrl}
          alt=""
          loading="lazy"
          draggable={false}
          className={cn("h-full w-full object-contain", checker)}
        />
      </Button>
      <IconButton
        label={selected ? t("deselectSticker") : t("stickerSelect")}
        role="checkbox"
        aria-checked={selected}
        aria-pressed={selected}
        variant="ghost"
        className="absolute top-0.5 start-0.5 z-10 size-10 min-h-10 min-w-10 p-0 hover:bg-transparent focus-visible:ring-offset-0"
        onClick={(event) => onToggle(event.shiftKey)}
        icon={
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-lg border transition-all shadow-xs",
              selected
                ? "border-brand-blue bg-brand-blue text-white"
                : "border-line/70 bg-panel/85 text-muted backdrop-blur-xs hover:border-line hover:text-text-main",
            )}
          >
            <Check
              size={14}
              strokeWidth={selected ? 3 : 2.5}
              className={selected ? undefined : "opacity-40"}
            />
          </span>
        }
      />
      {sticker.animated && (
        <Badge
          tone="neutral"
          className="pointer-events-none absolute bottom-1 start-1 z-10 px-1.5 py-0.5 text-[10px] font-bold"
        >
          {t("gifBadge")}
        </Badge>
      )}
      <IconButton
        label={sticker.favorite ? t("unfavorite") : t("favorite")}
        aria-pressed={sticker.favorite}
        variant="ghost"
        className="absolute top-0.5 end-0.5 z-10 size-10 min-h-10 min-w-10 p-0 hover:bg-transparent focus-visible:ring-offset-0"
        onClick={onFavorite}
        icon={
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-lg border transition-all shadow-xs",
              sticker.favorite
                ? "border-warn/50 bg-panel/90 text-warn backdrop-blur-xs"
                : "border-line/70 bg-panel/85 text-muted backdrop-blur-xs hover:border-line hover:text-text-main",
            )}
          >
            <Star size={14} className={sticker.favorite ? "fill-warn text-warn" : undefined} />
          </span>
        }
      />
      <span className="sr-only">{label}</span>
    </div>
  );
};
