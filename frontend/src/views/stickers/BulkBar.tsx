import {
  ArrowRight,
  Download,
  Heart,
  HeartOff,
  Image,
  Send,
  Share2,
  Trash2,
  X,
} from "lucide-react";
import type React from "react";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";
import { Button, IconButton } from "./ui";

interface BulkBarProps {
  count: number;
  animatedSelected: boolean;
  canRemove: boolean;
  sendReason: string | null;
  exportReason: string | null;
  onSelectAll: () => void;
  onClear: () => void;
  onFavorite: () => void;
  onUnfavorite: () => void;
  onAdd: () => void;
  onMove: () => void;
  onRemove: () => void;
  onDownload: () => void;
  onConvert: () => void;
  onShare: () => void;
  onSend: () => void;
  onDelete: () => void;
}

export const BulkBar: React.FC<BulkBarProps> = ({
  count,
  animatedSelected,
  canRemove,
  sendReason,
  exportReason,
  onSelectAll,
  onClear,
  onFavorite,
  onUnfavorite,
  onAdd,
  onMove,
  onRemove,
  onDownload,
  onConvert,
  onShare,
  onSend,
  onDelete,
}) => {
  const { t } = useI18n();
  if (count === 0) return null;

  return (
    <div className="rounded-xl border border-brand-blue/30 bg-brand-blue/10 p-3 flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-bold text-text-main">
          {fill(t("nSelected"), { n: count })}
        </span>
        <Button variant="quiet" className="h-8 px-2" onClick={onSelectAll}>
          {t("selectVisible")}
        </Button>
        <Button variant="quiet" className="h-8 px-2" onClick={onClear}>
          {t("clearSelection")}
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <IconButton label={t("favorite")} onClick={onFavorite}>
          <Heart size={14} />
        </IconButton>
        <IconButton label={t("unfavorite")} onClick={onUnfavorite}>
          <HeartOff size={14} />
        </IconButton>
        <IconButton label={t("addToPack")} onClick={onAdd}>
          <span className="text-[11px] font-bold">+</span>
        </IconButton>
        <IconButton label={t("moveToPack")} onClick={onMove}>
          <ArrowRight size={14} className="rtl:-scale-x-100" />
        </IconButton>
        {canRemove && (
          <IconButton label={t("removeFromPack")} onClick={onRemove}>
            <X size={14} />
          </IconButton>
        )}
        <IconButton
          label={count > 1 ? t("downloadZip") : t("download")}
          onClick={onDownload}
          disabled={!!exportReason}
        >
          <Download size={14} />
        </IconButton>
        <IconButton label={t("convertToImage")} onClick={onConvert} disabled={!!exportReason}>
          <Image size={14} />
        </IconButton>
        <IconButton label={t("shareSticker")} onClick={onShare}>
          <Share2 size={14} />
        </IconButton>
        <IconButton label={t("sendViaWhatsapp")} onClick={onSend} disabled={!!sendReason}>
          <Send size={14} className="rtl:-scale-x-100" />
        </IconButton>
        <IconButton label={t("delete")} onClick={onDelete} danger>
          <Trash2 size={14} />
        </IconButton>
      </div>
      {sendReason && <p className="text-xs text-muted">{sendReason}</p>}
      {exportReason && <p className="text-xs text-muted">{exportReason}</p>}
      {animatedSelected && <p className="text-xs text-muted">{t("firstFrameHint")}</p>}
    </div>
  );
};
