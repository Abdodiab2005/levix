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
        "relative aspect-square overflow-hidden rounded-xl border bg-panel",
        selected ? "border-brand-blue ring-2 ring-brand-blue/50" : "border-line",
      )}
    >
      <Button
        variant="ghost"
        onClick={() => onOpen()}
        aria-label={t("stickerOpen")}
        className="absolute inset-0 h-auto min-h-0 w-full rounded-none p-0 hover:bg-transparent"
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
        label={t("stickerSelect")}
        variant={selected ? "primary" : "secondary"}
        aria-pressed={selected}
        className="absolute top-1 start-1 z-10"
        onClick={(event) => onToggle(event.shiftKey)}
        icon={<Check size={16} strokeWidth={3} className={selected ? undefined : "opacity-40"} />}
      />
      {sticker.animated && (
        <Badge tone="neutral" className="pointer-events-none absolute bottom-1 start-1 z-10">
          {t("gifBadge")}
        </Badge>
      )}
      <IconButton
        label={sticker.favorite ? t("unfavorite") : t("favorite")}
        aria-pressed={sticker.favorite}
        variant="secondary"
        className="absolute top-1 end-1 z-10"
        onClick={onFavorite}
        icon={
          <Star size={16} className={sticker.favorite ? "fill-warn text-warn" : "text-muted"} />
        }
      />
      <span className="sr-only">{label}</span>
    </div>
  );
};
