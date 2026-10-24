// file: frontend/src/components/ui/tour.tsx

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { Button, IconButton } from "./button";
import { useFocusTrap } from "./focus";

export interface TourStep {
  /** Value of the `data-tour` attribute of the element to spotlight. */
  target: string;
  title: string;
  /** One to three short sentences, already translated. */
  body: string;
}

export interface TourLabels {
  back: string;
  next: string;
  done: string;
  skip: string;
  /** Already formatted, for example "Step 2 of 5". */
  stepOf: string;
}

export interface TourProps {
  open: boolean;
  steps: TourStep[];
  index: number;
  /** Next (or automatic skip of a missing target, or the final Done). */
  onAdvance: () => void;
  onBack: () => void;
  /** Skip, Escape, or closing the tour. */
  onClose: () => void;
  labels: TourLabels;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
  bottom: number;
  right: number;
}

const TARGET_WAIT_MS = 1500;
const TARGET_POLL_MS = 120;
const HOLE_PAD_PX = 8;
const CARD_GAP_PX = 12;
const CARD_WIDTH_PX = 320;
const SHEET_BREAKPOINT = 640;
/** Fully token-colour: panel wash with transparency, on both themes. */
const SPOT_DIM = "color-mix(in srgb, var(--panel-solid) 62%, transparent)";
const SPOT_RING = `0 0 0 1px color-mix(in srgb, var(--brand-cyan) 55%, transparent)`;
const SPOT_GLOW = `0 0 20px 3px color-mix(in srgb, var(--brand-cyan) 30%, transparent)`;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * The dimmed page with a rounded cut-out around the target, plus the soft
 * brand glow ring (pulse disabled under prefers-reduced-motion, see index.css).
 */
export function Spotlight({ rect, pad = HOLE_PAD_PX }: { rect: Rect | null; pad?: number }) {
  if (!rect || (rect.width <= 0 && rect.height <= 0)) {
    return <div className="absolute inset-0" style={{ backgroundColor: SPOT_DIM }} />;
  }
  const box: CSSProperties = {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  };
  return (
    <>
      <div
        className="absolute rounded-2xl transition-[top,left,width,height] duration-150 ease-out"
        style={{ ...box, boxShadow: `0 0 0 9999px ${SPOT_DIM}` }}
      />
      <div
        className="tour-glow absolute rounded-2xl"
        style={{ ...box, boxShadow: `${SPOT_RING}, ${SPOT_GLOW}` }}
      />
    </>
  );
}

export function Tour({ open, steps, index, onAdvance, onBack, onClose, labels }: TourProps) {
  const { direction } = useI18n();
  const titleId = useId();
  const step = steps[index];
  const [targetEl, setTargetEl] = useState<HTMLElement | null>(null);
  const [rect, setRect] = useState<Rect | null>(null);
  const [cardHeight, setCardHeight] = useState(0);
  const [sheetUi, setSheetUi] = useState(() => window.innerWidth < SHEET_BREAKPOINT);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;

  // Under 640px the explanation card docks to the bottom, like a sheet.
  useEffect(() => {
    const update = () => setSheetUi(window.innerWidth < SHEET_BREAKPOINT);
    window.addEventListener("resize", update);
    window.addEventListener("orientationchange", update);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("orientationchange", update);
    };
  }, []);

  // Find the current data-tour target: poll while the screen it lives on loads
  // or swaps in (the tour may change the hash right before). A target that
  // never shows up (feature hidden, empty state) skips the step silently.
  useEffect(() => {
    if (!open) return;
    setTargetEl(null);
    setRect(null);
    if (!step) return;
    const selector = `[data-tour="${step.target}"]`;
    let waited = 0;
    const timer = window.setInterval(() => {
      const el = document.querySelector<HTMLElement>(selector);
      const box = el?.getBoundingClientRect();
      if (el && box && (box.width > 0 || box.height > 0)) {
        window.clearInterval(timer);
        el.scrollIntoView({ block: "center", inline: "nearest" });
        setTargetEl(el);
        return;
      }
      waited += TARGET_POLL_MS;
      if (waited >= TARGET_WAIT_MS) {
        window.clearInterval(timer);
        advanceRef.current();
      }
    }, TARGET_POLL_MS);
    return () => window.clearInterval(timer);
  }, [open, step]);

  // Track the target every frame so scroll, resize and the RTL/LTR swap all
  // reposition the cut-out without a listener grid, and keep the card height
  // fresh for the side-anchoring math.
  useEffect(() => {
    if (!open || !targetEl) return;
    let raf = 0;
    let last: Rect | null = null;
    const measure = () => {
      const card = cardRef.current;
      if (card) {
        const height = card.offsetHeight;
        setCardHeight((prev) => (Math.abs(prev - height) > 1 ? height : prev));
      }
      const box = targetEl.getBoundingClientRect();
      const nextRect: Rect = {
        top: box.top,
        left: box.left,
        width: box.width,
        height: box.height,
        bottom: box.bottom,
        right: box.right,
      };
      const moved =
        !last ||
        Math.abs(nextRect.top - last.top) > 0.5 ||
        Math.abs(nextRect.left - last.left) > 0.5 ||
        Math.abs(nextRect.width - last.width) > 0.5 ||
        Math.abs(nextRect.height - last.height) > 0.5;
      if (moved) {
        last = nextRect;
        setRect(nextRect);
      }
      raf = window.requestAnimationFrame(measure);
    };
    raf = window.requestAnimationFrame(measure);
    return () => window.cancelAnimationFrame(raf);
  }, [open, targetEl]);

  useFocusTrap(cardRef, open && Boolean(targetEl), onClose);

  // The explanation card carries focus; Enter then means Next everywhere.
  useEffect(() => {
    if (open && targetEl) nextBtnRef.current?.focus({ preventScroll: true });
  }, [open, targetEl]);

  if (!open || !step) return null;

  const last = index === steps.length - 1;

  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    // Arrow keys follow the reading direction: forward is right in LTR, left in RTL.
    const forwardKey = direction === "rtl" ? "ArrowLeft" : "ArrowRight";
    const backKey = direction === "rtl" ? "ArrowRight" : "ArrowLeft";
    if (event.key === forwardKey) {
      event.preventDefault();
      onAdvance();
    } else if (event.key === backKey) {
      event.preventDefault();
      onBack();
    }
  };

  let cardStyle: CSSProperties;
  let cardClass: string;
  if (sheetUi) {
    cardClass = "fixed inset-x-0 bottom-0 rounded-t-2xl border-t p-4";
    cardStyle = {
      paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
      animation: "modal-enter 150ms ease-out",
    };
  } else if (rect) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cw = Math.min(CARD_WIDTH_PX, vw - 24);
    const ch = cardHeight || 170;
    const gapEnd = vw - rect.left - rect.width;
    const gapStart = rect.left;
    const fitsSide = cw + CARD_GAP_PX + HOLE_PAD_PX;
    let top: number;
    let left: number;
    if (gapEnd >= gapStart && gapEnd >= fitsSide) {
      // Card sits beside the target, on the side of the larger gap.
      top = clamp(rect.top + rect.height / 2 - ch / 2, 8, Math.max(8, vh - ch - 8));
      left = rect.left + rect.width + CARD_GAP_PX;
    } else if (gapStart >= fitsSide) {
      top = clamp(rect.top + rect.height / 2 - ch / 2, 8, Math.max(8, vh - ch - 8));
      left = rect.left - CARD_GAP_PX - cw;
    } else if (rect.bottom + CARD_GAP_PX + ch <= vh - 8) {
      // Neither side fits: below, or above when listening to the viewport edge.
      top = rect.bottom + CARD_GAP_PX;
      left = clamp(rect.left + rect.width / 2 - cw / 2, 8, vw - cw - 8);
    } else {
      top = Math.max(8, rect.top - CARD_GAP_PX - ch);
      left = clamp(rect.left + rect.width / 2 - cw / 2, 8, vw - cw - 8);
    }
    cardClass = "fixed rounded-2xl border p-4";
    cardStyle = {
      top,
      left,
      width: cw,
      maxHeight: `calc(100dvh - ${top}px - 8px)`,
      overflowY: "auto",
      animation: "modal-enter 150ms ease-out",
    };
  } else {
    cardClass = "fixed inset-x-0 bottom-0 rounded-t-2xl border-t p-4";
    cardStyle = {
      paddingBottom: "max(1rem, env(safe-area-inset-bottom))",
      animation: "modal-enter 150ms ease-out",
    };
  }

  return createPortal(
    <>
      {/* Absorb clicks so the page under the spotlight stays inert. */}
      <div className="fixed inset-0 z-50" />
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-50">
        <Spotlight rect={rect} />
      </div>
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-overlay="dialog"
        className={cn(
          "z-50 flex w-full flex-col gap-2 border-line bg-panel shadow-2xl outline-none",
          cardClass,
        )}
        style={cardStyle}
        onKeyDown={keyboard}
      >
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-faint">
            {labels.stepOf}
          </span>
          <span className="ms-auto" />
          <IconButton
            size="sm"
            variant="ghost"
            label={labels.skip}
            icon={<X size={16} />}
            onClick={onClose}
          />
        </div>
        <h2 id={titleId} className="text-base font-bold text-text-main">
          {step.title}
        </h2>
        <p className="text-sm leading-relaxed text-muted">{step.body}</p>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="md"
            disabled={index === 0}
            icon={<ChevronLeft size={16} className="rtl:-scale-x-100" />}
            onClick={onBack}
          >
            {labels.back}
          </Button>
          <Button
            ref={nextBtnRef}
            variant="primary"
            size="md"
            className="ms-auto"
            icon={last ? undefined : <ChevronRight size={16} className="rtl:-scale-x-100" />}
            onClick={onAdvance}
          >
            {last ? labels.done : labels.next}
          </Button>
        </div>
      </div>
    </>,
    document.body,
  );
}
