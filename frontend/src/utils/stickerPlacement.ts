// Source of truth: src/stickers/options.cjs — placement()

export const CANVAS = 512;

export interface PlacementResult {
  width: number;
  height: number;
  x: number;
  y: number;
}

export function placement(
  width: number,
  height: number,
  options: {
    fit?: "contain" | "cover";
    zoom?: number;
    panX?: number;
    panY?: number;
    rotate?: number;
  },
): PlacementResult {
  const fit = options.fit || "contain";
  const zoom = options.zoom ?? 1;
  const panX = options.panX ?? 0;
  const panY = options.panY ?? 0;
  const rotate = options.rotate ?? 0;
  const quarter = rotate === 90 || rotate === 270;
  const w = quarter ? height : width;
  const h = quarter ? width : height;
  const base = fit === "cover" ? CANVAS / Math.min(w, h) : CANVAS / Math.max(w, h);
  const scale = base * zoom;
  const W = Math.max(1, Math.round(w * scale));
  const H = Math.max(1, Math.round(h * scale));
  const x = Math.round((CANVAS - W) / 2 + (panX * Math.abs(CANVAS - W)) / 2);
  const y = Math.round((CANVAS - H) / 2 + (panY * Math.abs(CANVAS - H)) / 2);
  return { width: W, height: H, x, y };
}
