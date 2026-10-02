// Sticker edit options: the one schema the panel editor, the API, the bot and
// the converter agree on, and the placement formula the editor preview and the
// FFmpeg filter graph both implement — so what the preview shows is what gets
// encoded.
//
//   fit               "contain" (whole picture, padded) | "cover" (fills, cropped)
//   zoom              1..4, on top of the fit
//   panX, panY        -1..1; positive moves the picture right / down
//   rotate            0 | 90 | 180 | 270, clockwise, applied before the fit
//   background        "transparent" | "#rrggbb" — what shows around/behind it
//   removeBackground  null | { mode: "plain", tolerance: 0.02..0.6 }
//                     keys out the colour of the top-left pixel (flat backdrops)
//   trim              null | { start: s >= 0, duration: 0.5..STICKER_MAX_SECONDS }
//                     video and GIF only

const { StickerError } = require("./errors.cjs");
const { CANVAS, STICKER_MAX_SECONDS, VIDEO_MAX_SOURCE_SECONDS } = require("./limits.cjs");

const DEFAULTS = Object.freeze({
  fit: "contain",
  zoom: 1,
  panX: 0,
  panY: 0,
  rotate: 0,
  background: "transparent",
  removeBackground: null,
  trim: null,
});

const FITS = new Set(["contain", "cover"]);
const ROTATIONS = new Set([0, 90, 180, 270]);
const HEX = /^#[0-9a-f]{6}$/;

function invalid(field) {
  return new StickerError("INVALID_OPTIONS", { field });
}

function number(value, field, min, max) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw invalid(field);
  return n;
}

/**
 * Validate and fill in edit options. Unknown keys are dropped; a bad value is
 * an INVALID_OPTIONS error naming the field, never silently replaced.
 * @param {object|null|undefined} raw
 * @returns {typeof DEFAULTS}
 */
function normalizeOptions(raw) {
  if (raw == null) return { ...DEFAULTS };
  if (typeof raw !== "object" || Array.isArray(raw)) throw invalid("options");
  const out = { ...DEFAULTS };

  if (raw.fit !== undefined) {
    if (!FITS.has(raw.fit)) throw invalid("fit");
    out.fit = raw.fit;
  }
  if (raw.zoom !== undefined) out.zoom = number(raw.zoom, "zoom", 1, 4);
  if (raw.panX !== undefined) out.panX = number(raw.panX, "panX", -1, 1);
  if (raw.panY !== undefined) out.panY = number(raw.panY, "panY", -1, 1);
  if (raw.rotate !== undefined) {
    const r = number(raw.rotate, "rotate", 0, 270);
    if (!ROTATIONS.has(r)) throw invalid("rotate");
    out.rotate = r;
  }
  if (raw.background !== undefined) {
    const bg = String(raw.background).toLowerCase();
    if (bg !== "transparent" && !HEX.test(bg)) throw invalid("background");
    out.background = bg;
  }
  if (raw.removeBackground != null) {
    const rb = raw.removeBackground;
    if (typeof rb !== "object" || rb.mode !== "plain") throw invalid("removeBackground");
    out.removeBackground = {
      mode: "plain",
      tolerance:
        rb.tolerance === undefined ? 0.15 : number(rb.tolerance, "removeBackground", 0.02, 0.6),
    };
  }
  if (raw.trim != null) {
    if (typeof raw.trim !== "object") throw invalid("trim");
    out.trim = {
      start: number(raw.trim.start ?? 0, "trim", 0, VIDEO_MAX_SOURCE_SECONDS),
      duration: number(raw.trim.duration ?? STICKER_MAX_SECONDS, "trim", 0.5, STICKER_MAX_SECONDS),
    };
  }
  return out;
}

/** True when the options change nothing — a WebP that already fits can be kept as is. */
function isDefaultOptions(options) {
  const o = normalizeOptions(options);
  return (
    o.fit === "contain" &&
    o.zoom === 1 &&
    o.panX === 0 &&
    o.panY === 0 &&
    o.rotate === 0 &&
    o.background === "transparent" &&
    o.removeBackground === null &&
    o.trim === null
  );
}

/**
 * Where the (rotated) source lands on the CANVAS×CANVAS sticker.
 * @param {number} width  source width before rotation
 * @param {number} height source height before rotation
 * @param {typeof DEFAULTS} options normalized options
 * @returns {{ width: number, height: number, x: number, y: number }}
 *   the scaled picture's size and its top-left corner; x/y may be negative
 *   (the picture overhangs and is cropped)
 */
function placement(width, height, options) {
  const quarter = options.rotate === 90 || options.rotate === 270;
  const w = quarter ? height : width;
  const h = quarter ? width : height;
  const base = options.fit === "cover" ? CANVAS / Math.min(w, h) : CANVAS / Math.max(w, h);
  const scale = base * options.zoom;
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const x = Math.round((CANVAS - W) / 2 + (options.panX * Math.abs(CANVAS - W)) / 2);
  const y = Math.round((CANVAS - H) / 2 + (options.panY * Math.abs(CANVAS - H)) / 2);
  return { width: W, height: H, x, y };
}

module.exports = { DEFAULTS, normalizeOptions, isDefaultOptions, placement };
