import { Trash2 } from "lucide-react";
import type React from "react";
import {
  Button,
  Checkbox,
  FieldLabel,
  IconButton,
  Input,
  SegmentedControl,
} from "../../components/ui";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { EMOJI_PALETTE, type OverlayLayer } from "./overlay";

interface LayerEditorProps {
  layers: OverlayLayer[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (id: string, patch: Partial<OverlayLayer>) => void;
  onDelete: (id: string) => void;
  onAddText: () => void;
  onAddEmoji: (emoji: string) => void;
}

export const LayerEditor: React.FC<LayerEditorProps> = ({
  layers,
  selectedId,
  onSelect,
  onChange,
  onDelete,
  onAddText,
  onAddEmoji,
}) => {
  const { t } = useI18n();
  const selected = layers.find((layer) => layer.id === selectedId) || null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Button onClick={onAddText}>{t("addText")}</Button>
        <Button onClick={() => onAddEmoji("😀")}>{t("addEmoji")}</Button>
      </div>
      <div>
        <FieldLabel>{t("emojiPaletteLabel")}</FieldLabel>
        <div className="flex flex-wrap gap-1">
          {EMOJI_PALETTE.map((emoji) => (
            <IconButton
              key={emoji}
              label={emoji}
              variant="secondary"
              onClick={() => onAddEmoji(emoji)}
            >
              <span className="text-lg leading-none">{emoji}</span>
            </IconButton>
          ))}
        </div>
        <FieldLabel htmlFor="emoji-free">{t("customEmoji")}</FieldLabel>
        <Input
          id="emoji-free"
          className="mt-1"
          placeholder={t("emojiInputLabel")}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              const value = event.currentTarget.value.trim();
              if (value) {
                onAddEmoji(value);
                event.currentTarget.value = "";
              }
            }
          }}
        />
      </div>
      {layers.length === 0 && <p className="text-xs text-muted">{t("noLayers")}</p>}
      {layers.length > 0 && (
        <div className="flex flex-col gap-1">
          {layers.map((layer) => {
            const active = layer.id === selectedId;
            return (
              <Button
                key={layer.id}
                variant={active ? "secondary" : "ghost"}
                aria-pressed={active}
                onClick={() => onSelect(layer.id)}
                className={cn(
                  "h-auto w-full justify-start",
                  active && "border-brand-blue bg-brand-blue/10",
                )}
              >
                <span className="truncate">{layer.text || t("textPlaceholder")}</span>
              </Button>
            );
          })}
        </div>
      )}
      {selected && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-xs font-bold">{t("layerSelected")}</p>
          <FieldLabel htmlFor="layer-text">{t("textContent")}</FieldLabel>
          <Input
            id="layer-text"
            value={selected.text}
            onChange={(event) => onChange(selected.id, { text: event.target.value })}
          />
          <label className="text-xs font-bold" htmlFor="layer-size">
            {t("textSize")}
          </label>
          <input
            id="layer-size"
            type="range"
            min={16}
            max={200}
            value={selected.fontSize}
            onChange={(event) => onChange(selected.id, { fontSize: Number(event.target.value) })}
            className="w-full accent-brand-blue"
          />
          <label className="text-xs font-bold" htmlFor="layer-color">
            {t("textColor")}
          </label>
          <input
            id="layer-color"
            type="color"
            value={/^#[0-9a-f]{6}$/i.test(selected.color) ? selected.color : "#ffffff"}
            onChange={(event) => onChange(selected.id, { color: event.target.value })}
            className="h-10 w-full rounded-xl border border-line bg-panel-raised"
          />
          <SegmentedControl
            aria-label={t("textAlignment")}
            value={selected.align}
            onChange={(align) => onChange(selected.id, { align })}
            options={[
              { value: "start", label: t("stickerAlignmentStart") },
              { value: "center", label: t("stickerAlignmentCenter") },
              { value: "end", label: t("stickerAlignmentEnd") },
            ]}
          />
          <label className="text-xs font-bold" htmlFor="layer-rotate">
            {t("layerRotation")}
          </label>
          <input
            id="layer-rotate"
            type="range"
            min={-180}
            max={180}
            value={selected.rotate}
            onChange={(event) => onChange(selected.id, { rotate: Number(event.target.value) })}
            className="w-full accent-brand-blue"
          />
          <Checkbox
            checked={selected.outline}
            onChange={(event) => onChange(selected.id, { outline: event.target.checked })}
            label={t("textOutline")}
          />
          <Checkbox
            checked={selected.background}
            onChange={(event) => onChange(selected.id, { background: event.target.checked })}
            label={t("textBackground")}
          />
          <Button
            variant="danger"
            onClick={() => onDelete(selected.id)}
            icon={<Trash2 size={16} />}
          >
            {t("deleteLayer")}
          </Button>
        </div>
      )}
    </div>
  );
};
