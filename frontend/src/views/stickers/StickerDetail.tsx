import { Download, MoreVertical, Send, Share2, Star, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import { Modal } from "../../components/Modal";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { STICKER_NAME_MAX } from "../../utils/stickerLimits";
import { Button, fieldClass } from "./ui";

interface StickerDetailProps {
  sticker: Sticker | null;
  packs: Pack[];
  isConnected: boolean;
  gifEnabled: boolean;
  onClose: () => void;
  onRename: (name: string) => void;
  onFavorite: (favorite: boolean) => void;
  onAddToPack: (packId: string) => void;
  onRemoveFromPack: (packId: string) => void;
  onDownload: (format: "webp" | "png" | "gif") => void;
  onShare: () => void;
  onSend: () => void;
  onDelete: () => void;
  onOpenInCreate: () => void;
}

/** The round icon that sits on the sticker's corner — share, download. */
const CornerButton: React.FC<{
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ label, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    title={label}
    aria-label={label}
    className="w-9 h-9 rounded-full bg-black/55 hover:bg-black/75 border border-white/15 text-white flex items-center justify-center backdrop-blur-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand-cyan/60"
  >
    {children}
  </button>
);

const MenuItem: React.FC<{
  label: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}> = ({ label, danger, disabled, title, onClick }) => (
  <button
    type="button"
    role="menuitem"
    disabled={disabled}
    title={title}
    onClick={onClick}
    className={`w-full text-start px-3 py-2 text-xs md:text-sm font-medium rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
      danger ? "text-danger hover:bg-danger/10" : "text-text-main hover:bg-panel-hover"
    }`}
  >
    {label}
  </button>
);

export const StickerDetail: React.FC<StickerDetailProps> = ({
  sticker,
  packs,
  isConnected,
  gifEnabled,
  onClose,
  onRename,
  onFavorite,
  onAddToPack,
  onRemoveFromPack,
  onDownload,
  onShare,
  onSend,
  onDelete,
  onOpenInCreate,
}) => {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [packId, setPackId] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setName(sticker?.name || "");
    setPackId("");
    setMenuOpen(false);
  }, [sticker]);

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

  if (!sticker) return null;
  const member = packs.filter((pack) => sticker.packIds.includes(pack.id));
  const available = packs.filter((pack) => !sticker.packIds.includes(pack.id));

  return (
    <Modal
      isOpen={!!sticker}
      onClose={onClose}
      title={sticker.name || t("stickerPreview")}
      maxWidth="680px"
      footer={
        <div className="flex justify-end gap-2 w-full">
          <Button onClick={onClose}>{t("close")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="relative mx-auto w-full max-w-[280px] aspect-square rounded-2xl border border-line overflow-hidden bg-[repeating-conic-gradient(#2a2a2e_0%_25%,#1c1c20_0%_50%)] bg-[length:20px_20px]">
          <img
            src={sticker.url}
            alt={sticker.name || t("stickerPreview")}
            className="w-full h-full object-contain"
          />
          {/* The everyday actions ride on the image's corner instead of a row
              of labelled buttons under it */}
          <div className="absolute top-2 end-2 flex flex-col gap-1.5">
            <CornerButton
              label={sticker.animated && gifEnabled ? t("downloadGif") : t("downloadWebp")}
              onClick={() => onDownload(sticker.animated && gifEnabled ? "gif" : "webp")}
            >
              <Download size={16} />
            </CornerButton>
            <CornerButton label={t("shareSticker")} onClick={onShare}>
              <Share2 size={16} />
            </CornerButton>
          </div>
        </div>

        {/* One compact row for the actions that stay out of the menu */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={onSend}
            disabled={!isConnected}
            title={isConnected ? undefined : t("notConnectedHint")}
          >
            <Send size={14} className="rtl:-scale-x-100" />
            {t("sendViaWhatsapp")}
          </Button>
          <Button onClick={() => onFavorite(!sticker.favorite)}>
            <Star size={14} className={sticker.favorite ? "fill-warn text-warn" : ""} />
            {sticker.favorite ? t("unfavorite") : t("favorite")}
          </Button>
          <div className="relative ms-auto" ref={menuRef}>
            <Button
              onClick={() => setMenuOpen((open) => !open)}
              className="px-2.5"
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              title={t("moreActions")}
            >
              <MoreVertical size={16} />
            </Button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute end-0 mt-1 w-52 rounded-xl border border-line bg-panel-solid shadow-2xl p-1 z-30"
              >
                <MenuItem
                  label={t("downloadWebp")}
                  onClick={() => {
                    setMenuOpen(false);
                    onDownload("webp");
                  }}
                />
                <MenuItem
                  label={t("downloadPng")}
                  title={sticker.animated ? t("firstFrameHint") : undefined}
                  onClick={() => {
                    setMenuOpen(false);
                    onDownload("png");
                  }}
                />
                {sticker.animated && (
                  <MenuItem
                    label={t("downloadGif")}
                    disabled={!gifEnabled}
                    title={t("gifOnlyAnimated")}
                    onClick={() => {
                      setMenuOpen(false);
                      onDownload("gif");
                    }}
                  />
                )}
                <MenuItem
                  label={t("openInCreate")}
                  onClick={() => {
                    setMenuOpen(false);
                    onOpenInCreate();
                  }}
                />
                <div className="my-1 border-t border-line" />
                <MenuItem
                  label={t("delete")}
                  danger
                  onClick={() => {
                    setMenuOpen(false);
                    onDelete();
                  }}
                />
              </div>
            )}
          </div>
        </div>
        {sticker.animated && <p className="text-xs text-muted">{t("firstFrameHint")}</p>}
        {!isConnected && <p className="text-xs text-muted">{t("notConnectedHint")}</p>}

        <div className="flex gap-2">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={STICKER_NAME_MAX}
            aria-label={t("stickerName")}
            placeholder={t("stickerNamePlaceholder")}
            className={fieldClass}
          />
          <Button variant="primary" onClick={() => onRename(name.trim())}>
            {t("rename")}
          </Button>
        </div>

        <div>
          <p className="text-xs font-bold text-text-main mb-1.5">{t("inUsePacksLabel")}</p>
          {member.length === 0 ? (
            <p className="text-xs text-muted">{t("notInPack")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {member.map((pack) => (
                <li key={pack.id} className="flex items-center justify-between gap-2">
                  <span className="text-sm truncate">{pack.name}</span>
                  <Button className="h-8" onClick={() => onRemoveFromPack(pack.id)}>
                    {t("removeFromPack")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          {available.length > 0 && (
            <div className="flex gap-2 mt-2">
              <select
                value={packId}
                onChange={(event) => setPackId(event.target.value)}
                aria-label={t("addToPack")}
                className={fieldClass}
              >
                <option value="">{t("selectPack")}</option>
                {available.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name}
                  </option>
                ))}
              </select>
              <Button
                variant="primary"
                disabled={!packId}
                onClick={() => packId && onAddToPack(packId)}
              >
                {t("addToPack")}
              </Button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
};
