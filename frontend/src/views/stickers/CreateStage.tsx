import type React from "react";
import { useEffect, useRef } from "react";
import type { EditOptions } from "../../types";
import { CANVAS, placement } from "../../utils/stickerPlacement";
import { hitTest, paintOverlay, type HitBox, type OverlayLayer } from "./overlay";

interface CreateStageProps {
  mediaUrl: string;
  kind: string;
  width: number;
  height: number;
  options: EditOptions;
  layers: OverlayLayer[];
  selectedId: string | null;
  onPan: (panX: number, panY: number) => void;
  onSelect: (id: string | null) => void;
  onMoveLayer: (id: string, x: number, y: number) => void;
  label: string;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

type Drag =
  | {
      kind: "pan";
      x: number;
      y: number;
      panX: number;
      panY: number;
      placeW: number;
      placeH: number;
    }
  | { kind: "layer"; id: string; x: number; y: number; originX: number; originY: number };

export const CreateStage: React.FC<CreateStageProps> = ({
  mediaUrl,
  kind,
  width,
  height,
  options,
  layers,
  selectedId,
  onPan,
  onSelect,
  onMoveLayer,
  label,
}) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hits = useRef<HitBox[]>([]);
  const drag = useRef<Drag | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const scaleRef = useRef(1);

  const rotate = options.rotate ?? 0;
  const place =
    width > 0 && height > 0
      ? placement(width, height, {
          fit: options.fit,
          zoom: options.zoom,
          panX: options.panX,
          panY: options.panY,
          rotate,
        })
      : null;
  const quarter = rotate === 90 || rotate === 270;
  const imgW = place ? (quarter ? place.height : place.width) : 0;
  const imgH = place ? (quarter ? place.width : place.height) : 0;
  const imgLeft = place ? place.x + (place.width - imgW) / 2 : 0;
  const imgTop = place ? place.y + (place.height - imgH) / 2 : 0;
  const background =
    options.background && options.background !== "transparent" ? options.background : null;

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const apply = () => {
      const size = Math.min(wrap.clientWidth, 512);
      scaleRef.current = size > 0 ? size / CANVAS : 1;
      wrap.style.setProperty("--stage-scale", String(scaleRef.current));
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = CANVAS * dpr;
    canvas.height = CANVAS * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, CANVAS, CANVAS);
    hits.current = paintOverlay(ctx, layers, selectedId);
  }, [layers, selectedId]);

  useEffect(() => {
    const video = videoRef.current;
    const trim = options.trim;
    if (!video || !trim || kind !== "video" || !mediaUrl) return;
    const start = trim.start;
    const end = trim.start + trim.duration;
    const jump = () => {
      if (video.currentTime < start - 0.05 || video.currentTime >= end - 0.02) {
        video.currentTime = start;
      }
    };
    video.addEventListener("timeupdate", jump);
    video.addEventListener("ended", jump);
    video.currentTime = start;
    return () => {
      video.removeEventListener("timeupdate", jump);
      video.removeEventListener("ended", jump);
    };
  }, [options.trim, kind, mediaUrl]);

  const point = (event: React.PointerEvent) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * CANVAS,
      y: ((event.clientY - rect.top) / rect.height) * CANVAS,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const p = point(event);
    const id = hitTest(hits.current, p.x, p.y);
    if (id) {
      const layer = layers.find((item) => item.id === id);
      if (!layer) return;
      onSelect(id);
      drag.current = { kind: "layer", id, x: p.x, y: p.y, originX: layer.x, originY: layer.y };
      return;
    }
    onSelect(null);
    if (!place) return;
    drag.current = {
      kind: "pan",
      x: p.x,
      y: p.y,
      panX: options.panX ?? 0,
      panY: options.panY ?? 0,
      placeW: place.width,
      placeH: place.height,
    };
  };

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const current = drag.current;
    if (!current) return;
    const p = point(event);
    if (current.kind === "layer") {
      onMoveLayer(
        current.id,
        clamp(current.originX + (p.x - current.x), 0, CANVAS),
        clamp(current.originY + (p.y - current.y), 0, CANVAS),
      );
      return;
    }
    const spanX = Math.abs(CANVAS - current.placeW);
    const spanY = Math.abs(CANVAS - current.placeH);
    const panX =
      spanX < 1 ? current.panX : clamp(current.panX + ((p.x - current.x) * 2) / spanX, -1, 1);
    const panY =
      spanY < 1 ? current.panY : clamp(current.panY + ((p.y - current.y) * 2) / spanY, -1, 1);
    onPan(panX, panY);
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  const mediaStyle: React.CSSProperties = {
    position: "absolute",
    left: imgLeft,
    top: imgTop,
    width: imgW,
    height: imgH,
    transform: `rotate(${rotate}deg)`,
    transformOrigin: "center center",
    maxWidth: "none",
    pointerEvents: "none",
  };

  return (
    <div ref={wrapRef} className="w-full">
      <div
        className="relative mx-auto overflow-hidden rounded-2xl border border-line"
        style={{
          width: `calc(512px * var(--stage-scale, 1))`,
          height: `calc(512px * var(--stage-scale, 1))`,
        }}
      >
        <div
          role="img"
          aria-label={label}
          className="absolute top-0 start-0 origin-top-left"
          style={{
            width: CANVAS,
            height: CANVAS,
            transform: "scale(var(--stage-scale, 1))",
            backgroundColor: "#1a1a1e",
            backgroundImage:
              "linear-gradient(45deg, #2c2c31 25%, transparent 25%), linear-gradient(-45deg, #2c2c31 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #2c2c31 75%), linear-gradient(-45deg, transparent 75%, #2c2c31 75%)",
            backgroundSize: "32px 32px",
            backgroundPosition: "0 0, 0 16px, 16px -16px, -16px 0",
          }}
        >
          {background && <div className="absolute inset-0" style={{ background }} />}
          {place && kind === "video" ? (
            <video
              ref={videoRef}
              src={mediaUrl}
              muted
              autoPlay
              playsInline
              loop={!options.trim}
              style={mediaStyle}
            />
          ) : (
            place && <img src={mediaUrl} alt="" draggable={false} style={mediaStyle} />
          )}
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full touch-none"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
        </div>
      </div>
    </div>
  );
};
