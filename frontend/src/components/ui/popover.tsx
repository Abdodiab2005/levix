// file: frontend/src/components/ui/popover.tsx
import { X } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";
import { useFocusTrap } from "./focus";

const SHEET_QUERY = "(max-width: 639px)";

function useIsSheet() {
  const [sheet, setSheet] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia(SHEET_QUERY).matches : false,
  );
  useEffect(() => {
    const media = window.matchMedia(SHEET_QUERY);
    const onChange = () => setSheet(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);
  return sheet;
}

type Align = "start" | "end" | "center";

/**
 * `start` / `end` follow the document direction, then the panel is pushed back
 * inside the viewport. If it does not fit under the trigger, it opens above.
 */
function computePosition(anchor: DOMRect, panel: DOMRect, align: Align, dir: "ltr" | "rtl") {
  const gap = 6;
  const margin = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let top = anchor.bottom + gap;
  if (top + panel.height > vh - margin && anchor.top - panel.height - gap >= margin) {
    top = anchor.top - panel.height - gap;
  }
  top = Math.max(margin, Math.min(top, vh - margin - panel.height));

  const startLeft =
    align === "center"
      ? anchor.left + anchor.width / 2 - panel.width / 2
      : align === "start"
        ? dir === "rtl"
          ? anchor.right - panel.width
          : anchor.left
        : dir === "rtl"
          ? anchor.left
          : anchor.right - panel.width;
  const left = Math.max(margin, Math.min(startLeft, vw - margin - panel.width));
  return { top, left };
}

type TriggerProps = {
  onClick?: (event: MouseEvent<HTMLElement>) => void;
};

export interface PopoverProps {
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  trigger: ReactElement;
  children: ReactNode;
  align?: Align;
  label: string;
  /** "menu" for menus, "dialog" for filter panels and other forms. */
  haspopup?: "menu" | "dialog";
  className?: string;
  /** Drawn on the anchor, not inside the button. Use for the filter count. */
  badge?: ReactNode;
}

export function Popover({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  trigger,
  children,
  align = "end",
  label,
  haspopup = "dialog",
  className,
  badge,
}: PopoverProps) {
  const { t } = useI18n();
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const open = openProp ?? uncontrolled;
  const setOpen = useCallback(
    (next: boolean) => {
      if (openProp === undefined) setUncontrolled(next);
      onOpenChange?.(next);
    },
    [onOpenChange, openProp],
  );

  const sheet = useIsSheet();
  const anchorRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const setOpenRef = useRef(setOpen);
  setOpenRef.current = setOpen;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const panel = panelRef.current;
    if (!anchor || !panel) return;
    const dir = document.documentElement.dir === "rtl" ? "rtl" : "ltr";
    setCoords(
      computePosition(anchor.getBoundingClientRect(), panel.getBoundingClientRect(), align, dir),
    );
  }, [align]);

  useLayoutEffect(() => {
    if (!open || sheet) return;
    place();
    const panel = panelRef.current;
    const observer = panel ? new ResizeObserver(() => place()) : null;
    if (panel && observer) observer.observe(panel);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, sheet, place]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (anchorRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      setOpenRef.current(false);
    };
    // Capture so this runs before a dialog's bubble listener and can swallow Escape.
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setOpenRef.current(false);
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // Sheet is modal. Desktop popover traps Tab only while it is open; Escape is handled above.
  useFocusTrap(panelRef as RefObject<HTMLElement | null>, open && sheet, () => setOpen(false));

  const triggerProps = (isValidElement(trigger) ? trigger.props : {}) as TriggerProps;
  const cloned = isValidElement(trigger)
    ? cloneElement(trigger, {
        onClick: (event: MouseEvent<HTMLElement>) => {
          triggerProps.onClick?.(event);
          if (!event.defaultPrevented) setOpen(!open);
        },
        "aria-expanded": open,
        "aria-haspopup": haspopup,
        "aria-controls": panelId,
      } as Partial<TriggerProps>)
    : trigger;

  const panel = (
    <div
      ref={panelRef}
      id={panelId}
      role={haspopup === "menu" ? "presentation" : "dialog"}
      {...(haspopup === "menu" || !label ? {} : { "aria-label": label })}
      tabIndex={-1}
      data-overlay="popover"
      className={cn(
        "z-[70] border border-line bg-panel-solid text-text-main shadow-2xl outline-none",
        className,
        sheet
          ? "relative max-h-[85dvh] w-full max-w-none overflow-y-auto rounded-t-2xl p-4 pb-[max(1rem,env(safe-area-inset-bottom))]"
          : "fixed max-h-[min(24rem,calc(100dvh-1rem))] overflow-y-auto rounded-2xl",
      )}
      style={
        sheet
          ? { animation: "modal-enter 150ms ease-out" }
          : {
              top: coords?.top ?? 0,
              left: coords?.left ?? 0,
              visibility: coords ? "visible" : "hidden",
              animation: "modal-enter 150ms ease-out",
            }
      }
    >
      {sheet && (
        <div className="relative mb-3 flex h-10 items-center justify-center">
          <span className="h-1 w-10 rounded-full bg-line" />
          <IconButton
            label={t("close")}
            icon={<X size={16} />}
            variant="ghost"
            className="absolute end-0"
            onClick={() => setOpen(false)}
          />
        </div>
      )}
      {children}
    </div>
  );

  return (
    <>
      <span ref={anchorRef} className="relative inline-flex">
        {cloned}
        {badge}
      </span>
      {open &&
        createPortal(
          sheet ? (
            <div className="fixed inset-0 z-[70] flex items-end">
              <button
                type="button"
                className="absolute inset-0 cursor-default border-0 bg-black/60 p-0"
                aria-label={t("close")}
                onClick={() => setOpen(false)}
              />
              {panel}
            </div>
          ) : (
            panel
          ),
          document.body,
        )}
    </>
  );
}
