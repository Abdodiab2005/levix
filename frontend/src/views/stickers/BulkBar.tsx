import { Download, Send, Share2 } from "lucide-react";
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
    <Card className="border-brand-blue/30 bg-brand-blue/10">
      <div className="flex items-center gap-2">
        <span className="me-auto text-sm font-bold text-text-main">
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
          <MenuItem onSelect={onSelectAll}>{t("selectVisible")}</MenuItem>
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
      </div>
      {sendReason && <p className="mt-2 text-xs text-muted">{sendReason}</p>}
      {exportReason && <p className="mt-2 text-xs text-muted">{exportReason}</p>}
      {animatedSelected && <p className="mt-2 text-xs text-muted">{t("firstFrameHint")}</p>}
    </Card>
  );
};
