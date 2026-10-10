// Text and emoji drawn on the 512 canvas. The preview and the PNG sent as
// `overlay` both go through paintOverlay, so the font size is the same pixels.

export interface OverlayLayer {
  id: string;
  text: string;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  align: "start" | "center" | "end";
  rotate: number;
  outline: boolean;
  background: boolean;
}

export interface HitBox {
  id: string;
  cx: number;
  cy: number;
  rotate: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const FONT_STACK =
  '"Segoe UI", Tahoma, "Noto Naskh Arabic", "Noto Sans Arabic", "Geeza Pro", Arial, sans-serif';

export function isArabicText(text: string): boolean {
  return /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/.test(text);
}

function outlineColor(hex: string): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return "#000000";
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luma > 0.6 ? "#000000" : "#ffffff";
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
  ctx.fill();
}

/** Where the text box sits relative to the anchor, matching canvas textAlign + direction. */
function boxLeft(align: OverlayLayer["align"], dir: "ltr" | "rtl", width: number, padX: number) {
  const physical =
    align === "center"
      ? "center"
      : align === "start"
        ? dir === "rtl"
          ? "right"
          : "left"
        : dir === "rtl"
          ? "left"
          : "right";
  if (physical === "center") return -width / 2 - padX;
  if (physical === "right") return -width - padX;
  return -padX;
}

export function paintOverlay(
  ctx: CanvasRenderingContext2D,
  layers: OverlayLayer[],
  selectedId: string | null,
): HitBox[] {
  const hits: HitBox[] = [];
  for (const layer of layers) {
    if (!layer.text) continue;
    const dir = isArabicText(layer.text) ? "rtl" : "ltr";
    ctx.save();
    ctx.translate(layer.x, layer.y);
    ctx.rotate((layer.rotate * Math.PI) / 180);
    ctx.direction = dir;
    ctx.font = `${layer.fontSize}px ${FONT_STACK}`;
    ctx.textAlign = layer.align;
    ctx.textBaseline = "middle";
    const width = ctx.measureText(layer.text).width;
    const padX = layer.background ? layer.fontSize * 0.4 : 8;
    const padY = layer.background ? layer.fontSize * 0.22 : 6;
    const boxW = width + padX * 2;
    const boxH = layer.fontSize * 1.25 + padY * 2;
    const left = boxLeft(layer.align, dir, width, padX);
    const top = -boxH / 2;
    if (layer.background) {
      ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
      fillRoundRect(ctx, left, top, boxW, boxH, boxH / 2);
    }
    if (selectedId === layer.id) {
      ctx.strokeStyle = getComputedStyle(document.documentElement)
        .getPropertyValue("--color-brand-cyan")
        .trim();
      ctx.lineWidth = 2;
      ctx.strokeRect(left - 3, top - 3, boxW + 6, boxH + 6);
    }
    if (layer.outline) {
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = Math.max(2, layer.fontSize / 10);
      ctx.strokeStyle = outlineColor(layer.color);
      ctx.strokeText(layer.text, 0, 0);
    }
    ctx.fillStyle = layer.color;
    ctx.fillText(layer.text, 0, 0);
    ctx.restore();
    hits.push({
      id: layer.id,
      cx: layer.x,
      cy: layer.y,
      rotate: layer.rotate,
      left,
      top,
      right: left + boxW,
      bottom: top + boxH,
    });
  }
  return hits;
}

export function hitTest(hits: HitBox[], x: number, y: number): string | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const hit = hits[i];
    const dx = x - hit.cx;
    const dy = y - hit.cy;
    const rad = (-hit.rotate * Math.PI) / 180;
    const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
    if (lx >= hit.left && lx <= hit.right && ly >= hit.top && ly <= hit.bottom) return hit.id;
  }
  return null;
}

/** 512×512 transparent PNG, or undefined when there is nothing to draw. */
export function overlayDataUrl(layers: OverlayLayer[]): string | undefined {
  const visible = layers.filter((layer) => layer.text.trim().length > 0);
  if (!visible.length) return undefined;
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) return undefined;
  paintOverlay(ctx, visible, null);
  return canvas.toDataURL("image/png");
}

export const EMOJI_PALETTE = [
  "😀",
  "😂",
  "❤️",
  "🔥",
  "👍",
  "🎉",
  "✨",
  "💯",
  "🙏",
  "😎",
  "🥳",
  "💀",
  "👀",
  "💪",
  "🌹",
  "⭐",
  "✅",
  "😢",
  "🤔",
  "👋",
];
