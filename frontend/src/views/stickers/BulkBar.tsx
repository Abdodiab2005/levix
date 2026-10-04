import { Download, MoreVertical, Send, Share2, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
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

/** Icon-only bulk action: the label rides in the tooltip. */
const BulkIcon: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}> = ({ label, onClick, disabled, danger, children }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={label}
    aria-label={label}
    className={`w-9 h-9 rounded-lg border flex items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-40 disabled:cursor-not-allowed ${
      danger
        ? "border-danger/40 text-danger hover:bg-danger/10"
        : "border-line bg-panel-raised text-text-main hover:bg-panel-hover"
    }`}
  >
    {children}
  </button>
);

const BulkMenuItem: React.FC<{
  label: string;
  onClick: () => void;
  disabled?: boolean;
}> = ({ label, onClick, disabled }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    onClick={onClick}
    className="w-full text-start px-3 py-2 text-xs md:text-sm font-medium rounded-lg text-text-main hover:bg-panel-hover transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
  >
    {label}
  </button>
);

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
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [menuOpen]);

  if (count === 0) return null;

  const run = (action: () => void) => () => {
    setMenuOpen(false);
    action();
  };

  return (
    <div className="rounded-xl border border-brand-blue/30 bg-brand-blue/10 p-3 flex flex-col gap-2">
      {/* Only the everyday bulk actions stay inline; everything else folds
          into the overflow menu */}
      <div className="flex items-center gap-2">
        <span className="text-sm font-bold text-text-main me-auto">
          {fill(t("nSelected"), { n: count })}
        </span>
        <BulkIcon
          label={count > 1 ? t("downloadZip") : t("download")}
          onClick={run(onDownload)}
          disabled={!!exportReason}
        >
          <Download size={15} />
        </BulkIcon>
        <BulkIcon label={t("sendViaWhatsapp")} onClick={run(onSend)} disabled={!!sendReason}>
          <Send size={15} className="rtl:-scale-x-100" />
        </BulkIcon>
        <BulkIcon label={t("shareSticker")} onClick={run(onShare)}>
          <Share2 size={15} />
        </BulkIcon>
        <BulkIcon label={t("delete")} onClick={run(onDelete)} danger>
          <Trash2 size={15} />
        </BulkIcon>
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            title={t("moreActions")}
            aria-label={t("moreActions")}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="w-9 h-9 rounded-lg border border-line bg-panel-raised text-text-main hover:bg-panel-hover flex items-center justify-center transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          >
            <MoreVertical size={15} />
          </button>
          {menuOpen && (
            <div
              role="menu"
              className="absolute end-0 mt-1 w-52 rounded-xl border border-line bg-panel-solid shadow-2xl p-1 z-30"
            >
              <BulkMenuItem label={t("selectVisible")} onClick={run(onSelectAll)} />
              <BulkMenuItem label={t("clearSelection")} onClick={run(onClear)} />
              <div className="my-1 border-t border-line" />
              <BulkMenuItem label={t("favorite")} onClick={run(onFavorite)} />
              <BulkMenuItem label={t("unfavorite")} onClick={run(onUnfavorite)} />
              <div className="my-1 border-t border-line" />
              <BulkMenuItem label={t("addToPack")} onClick={run(onAdd)} />
              <BulkMenuItem label={t("moveToPack")} onClick={run(onMove)} />
              {canRemove && <BulkMenuItem label={t("removeFromPack")} onClick={run(onRemove)} />}
              <BulkMenuItem
                label={t("convertToImage")}
                onClick={run(onConvert)}
                disabled={!!exportReason}
              />
            </div>
          )}
        </div>
      </div>
      {sendReason && <p className="text-xs text-muted">{sendReason}</p>}
      {exportReason && <p className="text-xs text-muted">{exportReason}</p>}
      {animatedSelected && <p className="text-xs text-muted">{t("firstFrameHint")}</p>}
    </div>
  );
};
