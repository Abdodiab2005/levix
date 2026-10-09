import { Download, Send, Share2, Star, X } from "lucide-react";
import type React from "react";
import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  IconButton,
  Input,
  MenuItem,
  MenuSeparator,
  OverflowMenu,
  Select,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import type { Pack, Sticker } from "../../types";
import { STICKER_NAME_MAX } from "../../utils/stickerLimits";

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

const checker =
  "bg-[repeating-conic-gradient(var(--panel-raised)_0%_25%,var(--bg)_0%_50%)] bg-[length:20px_20px]";

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
  const primaryFormat = sticker.animated && gifEnabled ? "gif" : "webp";

  return (
    <Dialog
      isOpen={!!sticker}
      onClose={onClose}
      title={sticker.name || t("stickerPreview")}
      maxWidth="42.5rem"
      footer={
        <div className="flex w-full justify-end gap-2">
          <Button onClick={onClose}>{t("close")}</Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        <div
          className={`relative mx-auto aspect-square w-full max-w-[280px] overflow-hidden rounded-2xl border border-line ${checker}`}
        >
          <img
            src={sticker.url}
            alt={sticker.name || t("stickerPreview")}
            className="h-full w-full object-contain"
          />
          <div className="absolute top-2 end-2 flex flex-col gap-1.5">
            <IconButton
              label={primaryFormat === "gif" ? t("downloadGif") : t("downloadWebp")}
              icon={<Download size={16} />}
              onClick={() => onDownload(primaryFormat)}
            />
            <IconButton label={t("shareSticker")} icon={<Share2 size={16} />} onClick={onShare} />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="primary"
            onClick={onSend}
            disabled={!isConnected}
            title={isConnected ? undefined : t("notConnectedHint")}
            icon={<Send size={16} className="rtl:-scale-x-100" />}
          >
            {t("sendViaWhatsapp")}
          </Button>
          <IconButton
            label={sticker.favorite ? t("unfavorite") : t("favorite")}
            aria-pressed={sticker.favorite}
            onClick={() => onFavorite(!sticker.favorite)}
            icon={
              <Star size={16} className={sticker.favorite ? "fill-warn text-warn" : undefined} />
            }
          />
          <span className="ms-auto">
            <OverflowMenu label={t("moreActions")} align="end">
              <MenuItem onSelect={() => onDownload("webp")}>{t("downloadWebp")}</MenuItem>
              <MenuItem
                title={sticker.animated ? t("firstFrameHint") : undefined}
                onSelect={() => onDownload("png")}
              >
                {t("downloadPng")}
              </MenuItem>
              {sticker.animated && (
                <MenuItem
                  disabled={!gifEnabled}
                  title={t("gifOnlyAnimated")}
                  onSelect={() => onDownload("gif")}
                >
                  {t("downloadGif")}
                </MenuItem>
              )}
              <MenuItem onSelect={onOpenInCreate}>{t("openInCreate")}</MenuItem>
              <MenuSeparator />
              <MenuItem danger onSelect={onDelete}>
                {t("delete")}
              </MenuItem>
            </OverflowMenu>
          </span>
        </div>
        {sticker.animated && <p className="text-xs text-muted">{t("firstFrameHint")}</p>}
        {!isConnected && <p className="text-xs text-muted">{t("notConnectedHint")}</p>}

        <div className="flex gap-2">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={STICKER_NAME_MAX}
            aria-label={t("stickerName")}
            placeholder={t("stickerNamePlaceholder")}
          />
          <Button variant="primary" onClick={() => onRename(name.trim())}>
            {t("rename")}
          </Button>
        </div>

        <div>
          <p className="mb-1.5 text-xs font-bold text-text-main">{t("inUsePacksLabel")}</p>
          {member.length === 0 ? (
            <p className="text-xs text-muted">{t("notInPack")}</p>
          ) : (
            <ul className="flex flex-col gap-1.5">
              {member.map((pack) => (
                <li key={pack.id} className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm">{pack.name}</span>
                  <IconButton
                    label={t("removeFromPack")}
                    variant="ghost"
                    icon={<X size={16} />}
                    onClick={() => onRemoveFromPack(pack.id)}
                  />
                </li>
              ))}
            </ul>
          )}
          {available.length > 0 && (
            <div className="mt-2 flex gap-2">
              <Select
                value={packId}
                onChange={(event) => setPackId(event.target.value)}
                aria-label={t("addToPack")}
              >
                <option value="">{t("selectPack")}</option>
                {available.map((pack) => (
                  <option key={pack.id} value={pack.id}>
                    {pack.name}
                  </option>
                ))}
              </Select>
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
    </Dialog>
  );
};
