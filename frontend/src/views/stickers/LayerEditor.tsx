import { Trash2 } from "lucide-react";
import type React from "react";
import { useI18n } from "../../context/I18nContext";
import { EMOJI_PALETTE, type OverlayLayer } from "./overlay";
import { Button, FieldLabel, fieldClass } from "./ui";

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
            <button
              key={emoji}
              type="button"
              className="w-9 h-9 rounded-lg border border-line hover:bg-panel-hover text-lg"
              onClick={() => onAddEmoji(emoji)}
              aria-label={emoji}
            >
              {emoji}
            </button>
          ))}
        </div>
        <label className="block mt-2 text-xs font-bold text-text-main" htmlFor="emoji-free">
          {t("customEmoji")}
        </label>
        <input
          id="emoji-free"
          className={`${fieldClass} mt-1`}
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
          {layers.map((layer) => (
            <button
              key={layer.id}
              type="button"
              aria-pressed={layer.id === selectedId}
              onClick={() => onSelect(layer.id)}
              className={`text-start px-3 py-2 rounded-lg border text-sm truncate ${
                layer.id === selectedId ? "border-brand-blue bg-brand-blue/10" : "border-line"
              }`}
            >
              {layer.text || t("textPlaceholder")}
            </button>
          ))}
        </div>
      )}
      {selected && (
        <div className="flex flex-col gap-2 rounded-xl border border-line p-3">
          <p className="text-xs font-bold">{t("layerSelected")}</p>
          <label className="text-xs font-bold" htmlFor="layer-text">
            {t("textContent")}
          </label>
          <input
            id="layer-text"
            value={selected.text}
            onChange={(event) => onChange(selected.id, { text: event.target.value })}
            className={fieldClass}
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
          <p className="text-xs font-bold">{t("textAlignment")}</p>
          <div className="flex gap-1">
            {(["start", "center", "end"] as const).map((align) => (
              <Button
                key={align}
                className="flex-1"
                variant={selected.align === align ? "primary" : "ghost"}
                onClick={() => onChange(selected.id, { align })}
              >
                {align === "start"
                  ? t("stickerAlignmentStart")
                  : align === "center"
                    ? t("stickerAlignmentCenter")
                    : t("stickerAlignmentEnd")}
              </Button>
            ))}
          </div>
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
          />
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.outline}
              onChange={(event) => onChange(selected.id, { outline: event.target.checked })}
            />
            {t("textOutline")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selected.background}
              onChange={(event) => onChange(selected.id, { background: event.target.checked })}
            />
            {t("textBackground")}
          </label>
          <Button variant="danger" onClick={() => onDelete(selected.id)}>
            <Trash2 size={14} />
            {t("deleteLayer")}
          </Button>
        </div>
      )}
    </div>
  );
};
