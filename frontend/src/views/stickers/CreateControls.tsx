import type React from "react";
import { useI18n } from "../../context/I18nContext";
import type { Capabilities, EditOptions, Pack } from "../../types";
import { STICKER_NAME_MAX } from "../../utils/stickerLimits";
import { Button, FieldLabel, fieldClass } from "./ui";

interface CreateControlsProps {
  options: EditOptions;
  onChange: (patch: Partial<EditOptions>) => void;
  canRemoveBackground: boolean;
  name: string;
  onName: (value: string) => void;
  packId: string;
  onPack: (value: string) => void;
  packs: Pack[];
}

function choice(background: string | undefined): "transparent" | "white" | "black" | "custom" {
  if (!background || background === "transparent") return "transparent";
  if (background === "#ffffff") return "white";
  if (background === "#000000") return "black";
  return "custom";
}

export const CreateControls: React.FC<CreateControlsProps> = ({
  options,
  onChange,
  canRemoveBackground,
  name,
  onName,
  packId,
  onPack,
  packs,
}) => {
  const { t } = useI18n();
  const background = choice(options.background);
  const tolerance = options.removeBackground?.tolerance ?? 0.15;
  const rotate = options.rotate ?? 0;

  return (
    <div className="flex flex-col gap-3">
      <div>
        <FieldLabel htmlFor="sticker-fit">{t("fit")}</FieldLabel>
        <select
          id="sticker-fit"
          className={fieldClass}
          value={options.fit || "contain"}
          onChange={(event) =>
            onChange({ fit: event.target.value === "cover" ? "cover" : "contain" })
          }
        >
          <option value="contain">{t("contain")}</option>
          <option value="cover">{t("cover")}</option>
        </select>
      </div>

      <label className="text-xs font-bold" htmlFor="sticker-zoom">
        {t("zoom")} ({(options.zoom ?? 1).toFixed(2)})
      </label>
      <input
        id="sticker-zoom"
        type="range"
        min={1}
        max={4}
        step={0.01}
        value={options.zoom ?? 1}
        onChange={(event) => onChange({ zoom: Number(event.target.value) })}
      />

      <label className="text-xs font-bold" htmlFor="sticker-pan-x">
        {t("panX")} ({(options.panX ?? 0).toFixed(2)})
      </label>
      <input
        id="sticker-pan-x"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={options.panX ?? 0}
        onChange={(event) => onChange({ panX: Number(event.target.value) })}
      />

      <label className="text-xs font-bold" htmlFor="sticker-pan-y">
        {t("panY")} ({(options.panY ?? 0).toFixed(2)})
      </label>
      <input
        id="sticker-pan-y"
        type="range"
        min={-1}
        max={1}
        step={0.01}
        value={options.panY ?? 0}
        onChange={(event) => onChange({ panY: Number(event.target.value) })}
      />

      <div className="flex flex-wrap gap-2">
        <Button onClick={() => onChange({ panX: 0, panY: 0, zoom: 1 })}>{t("resetPan")}</Button>
        <Button
          onClick={() => {
            const next = ((rotate + 90) % 360) as 0 | 90 | 180 | 270;
            onChange({ rotate: next });
          }}
        >
          {t("rotateQuarter")} ({rotate}°)
        </Button>
      </div>

      <p className="text-xs font-bold">{t("background")}</p>
      <div className="flex flex-wrap gap-1">
        {(
          [
            ["transparent", t("transparent")],
            ["white", t("white")],
            ["black", t("black")],
            ["custom", t("customColor")],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            variant={background === id ? "primary" : "ghost"}
            onClick={() => {
              if (id === "transparent") onChange({ background: "transparent" });
              else if (id === "white") onChange({ background: "#ffffff" });
              else if (id === "black") onChange({ background: "#000000" });
              else onChange({ background: "#3366ff" });
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      {background === "custom" && (
        <input
          type="color"
          aria-label={t("customColor")}
          value={/^#[0-9a-f]{6}$/i.test(options.background || "") ? options.background : "#3366ff"}
          onChange={(event) => onChange({ background: event.target.value.toLowerCase() })}
          className="h-10 w-full rounded-xl border border-line bg-panel-raised"
        />
      )}

      {canRemoveBackground && (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={options.removeBackground?.mode === "plain"}
              onChange={(event) =>
                onChange({
                  removeBackground: event.target.checked
                    ? { mode: "plain", tolerance: 0.15 }
                    : null,
                })
              }
            />
            {t("removePlainBackground")}
          </label>
          <p className="text-xs text-muted">{t("stickerRemoveHint")}</p>
          {options.removeBackground?.mode === "plain" && (
            <>
              <label className="text-xs font-bold" htmlFor="sticker-tolerance">
                {t("tolerance")} ({tolerance.toFixed(2)})
              </label>
              <input
                id="sticker-tolerance"
                type="range"
                min={0.02}
                max={0.6}
                step={0.01}
                value={tolerance}
                onChange={(event) =>
                  onChange({
                    removeBackground: { mode: "plain", tolerance: Number(event.target.value) },
                  })
                }
              />
            </>
          )}
        </div>
      )}

      <div>
        <FieldLabel htmlFor="sticker-name">{t("stickerName")}</FieldLabel>
        <input
          id="sticker-name"
          value={name}
          maxLength={STICKER_NAME_MAX}
          onChange={(event) => onName(event.target.value)}
          placeholder={t("stickerNamePlaceholder")}
          className={fieldClass}
        />
      </div>
      <div>
        <FieldLabel htmlFor="sticker-pack">{t("targetPack")}</FieldLabel>
        <select
          id="sticker-pack"
          value={packId}
          onChange={(event) => onPack(event.target.value)}
          className={fieldClass}
        >
          <option value="">{t("noPack")}</option>
          {packs.map((pack) => (
            <option key={pack.id} value={pack.id}>
              {pack.name}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};

/**
 * The trim timeline lives directly under the video preview, not in the
 * sidebar, so the ranges being edited sit next to the media they cut.
 */
export const TrimControls: React.FC<{
  options: EditOptions;
  onChange: (patch: Partial<EditOptions>) => void;
  kind: string;
  durationMs: number;
  limits: Capabilities["limits"];
  animatedOk: boolean;
}> = ({ options, onChange, kind, durationMs, limits, animatedOk }) => {
  const { t } = useI18n();
  const trimmable = kind === "video" || kind === "gif";
  if (!trimmable) return null;
  const mediaSeconds = durationMs > 0 ? durationMs / 1000 : limits.videoSeconds;
  const maxStart = Math.min(limits.videoSeconds, Math.max(0, mediaSeconds));
  const setTrim = (start: number, duration: number) => {
    const safeStart = Math.min(maxStart, Math.max(0, start));
    const safeDuration = Math.min(limits.stickerSeconds, Math.max(0.5, duration));
    onChange({ trim: { start: safeStart, duration: safeDuration } });
  };
  return (
    <div className="rounded-2xl border border-line bg-panel p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="flex items-center gap-2 text-sm font-bold">
          <input
            type="checkbox"
            checked={Boolean(options.trim)}
            onChange={(event) => {
              if (!event.target.checked) onChange({ trim: null });
              else setTrim(0, Math.min(limits.stickerSeconds, Math.max(0.5, mediaSeconds)));
            }}
          />
          {t("trim")}
        </label>
        {options.trim && (
          <span className="text-xs font-mono text-muted" dir="ltr">
            {options.trim.start.toFixed(1)}s →{" "}
            {(options.trim.start + options.trim.duration).toFixed(1)}s
          </span>
        )}
      </div>
      {!animatedOk && <p className="text-xs text-warn">{t("animatedUnavailable")}</p>}
      <p className="text-xs text-muted">{kind === "gif" ? t("gifTrimNote") : t("trimApplied")}</p>
      {options.trim && (
        <>
          <label className="text-xs font-bold" htmlFor="trim-start">
            {t("trimStart")} ({options.trim.start.toFixed(1)} {t("trimSeconds")})
          </label>
          <input
            id="trim-start"
            type="range"
            min={0}
            max={maxStart}
            step={0.1}
            value={options.trim.start}
            onChange={(event) => setTrim(Number(event.target.value), options.trim?.duration ?? 0.5)}
          />
          <label className="text-xs font-bold" htmlFor="trim-duration">
            {t("trimDuration")} ({options.trim.duration.toFixed(1)} {t("trimSeconds")})
          </label>
          <input
            id="trim-duration"
            type="range"
            min={0.5}
            max={limits.stickerSeconds}
            step={0.1}
            value={options.trim.duration}
            onChange={(event) => setTrim(options.trim?.start ?? 0, Number(event.target.value))}
          />
        </>
      )}
    </div>
  );
};
