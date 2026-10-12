import { Download, Send, Share2, X } from "lucide-react";
import type React from "react";
import { Card, IconButton, MenuItem, MenuSeparator, OverflowMenu } from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { fill } from "../../utils/fill";

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
    <div className="sticky bottom-2 z-20 pb-[max(0.25rem,env(safe-area-inset-bottom))] sm:static sm:pb-0">
      <Card className="border-brand-blue/40 bg-panel/95 backdrop-blur-md shadow-lg shadow-black/15 p-2 sm:p-2.5">
        <div className="flex items-center gap-1.5 sm:gap-2">
          <span className="me-auto min-w-0 truncate text-xs sm:text-sm font-bold text-text-main">
            {fill(t("nSelected"), { n: count })}
          </span>
          <IconButton
            label={count > 1 ? t("downloadZip") : t("download")}
            icon={<Download size={16} />}
            onClick={onDownload}
            disabled={!!exportReason}
          />
          <IconButton
            label={t("sendViaWhatsapp")}
            icon={<Send size={16} className="rtl:-scale-x-100" />}
            onClick={onSend}
            disabled={!!sendReason}
          />
          <IconButton label={t("shareSticker")} icon={<Share2 size={16} />} onClick={onShare} />
          <OverflowMenu label={t("moreActions")}>
            <MenuItem onSelect={onSelectAll}>{t("selectCurrentPage")}</MenuItem>
            <MenuItem onSelect={onClear}>{t("clearSelection")}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={onFavorite}>{t("favorite")}</MenuItem>
            <MenuItem onSelect={onUnfavorite}>{t("unfavorite")}</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={onAdd}>{t("addToPack")}</MenuItem>
            <MenuItem onSelect={onMove}>{t("moveToPack")}</MenuItem>
            {canRemove && <MenuItem onSelect={onRemove}>{t("removeFromPack")}</MenuItem>}
            <MenuItem onSelect={onConvert} disabled={!!exportReason}>
              {t("convertToImage")}
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger onSelect={onDelete}>
              {t("delete")}
            </MenuItem>
          </OverflowMenu>
          <IconButton
            variant="ghost"
            label={t("clearSelection")}
            icon={<X size={16} />}
            onClick={onClear}
          />
        </div>
        {(sendReason || exportReason || animatedSelected) && (
          <div className="mt-1.5 space-y-0.5 border-t border-line/50 pt-1 text-xs text-muted">
            {sendReason && <p>{sendReason}</p>}
            {exportReason && <p>{exportReason}</p>}
            {animatedSelected && <p>{t("firstFrameHint")}</p>}
          </div>
        )}
      </Card>
    </div>
  );
};
