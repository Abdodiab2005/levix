import { Download, Send, Share2, Star, Trash2 } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
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

  useEffect(() => {
    setName(sticker?.name || "");
    setPackId("");
  }, [sticker]);

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
        <div className="flex flex-wrap justify-end gap-2 w-full">
          <Button onClick={onClose}>{t("close")}</Button>
          <Button variant="danger" onClick={onDelete}>
            <Trash2 size={14} />
            {t("delete")}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div className="mx-auto w-full max-w-[280px] aspect-square rounded-2xl border border-line overflow-hidden bg-[repeating-conic-gradient(#2a2a2e_0%_25%,#1c1c20_0%_50%)] bg-[length:20px_20px]">
          <img
            src={sticker.url}
            alt={sticker.name || t("stickerPreview")}
            className="w-full h-full object-contain"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => onDownload("webp")}>
            <Download size={14} />
            {t("downloadWebp")}
          </Button>
          <Button
            onClick={() => onDownload("png")}
            title={sticker.animated ? t("firstFrameHint") : undefined}
          >
            {t("downloadPng")}
          </Button>
          {sticker.animated && (
            <Button
              onClick={() => onDownload("gif")}
              disabled={!gifEnabled}
              title={t("gifOnlyAnimated")}
            >
              {t("downloadGif")}
            </Button>
          )}
          <Button onClick={onShare}>
            <Share2 size={14} />
            {t("shareSticker")}
          </Button>
          <Button
            onClick={onSend}
            disabled={!isConnected}
            title={isConnected ? undefined : t("notConnectedHint")}
          >
            <Send size={14} className="rtl:-scale-x-100" />
            {t("sendViaWhatsapp")}
          </Button>
          <Button onClick={onOpenInCreate}>{t("openInCreate")}</Button>
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

        <Button onClick={() => onFavorite(!sticker.favorite)}>
          <Star size={14} className={sticker.favorite ? "fill-warn text-warn" : ""} />
          {sticker.favorite ? t("unfavorite") : t("favorite")}
        </Button>

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
