import { type ReactNode, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./button";

export interface InfoTipProps {
  /** Accessible name for the icon trigger. */
  label: string;
  /** Short translated explanation. */
  content: ReactNode;
  children: ReactNode;
  className?: string;
}

export function InfoTip({ label, content, children, className }: InfoTipProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const touchRef = useRef(false);
  const id = useId();

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = triggerRef.current?.getBoundingClientRect();
      const tip = tipRef.current?.getBoundingClientRect();
      if (!anchor || !tip) return;
      const margin = 8;
      const left = Math.max(
        margin,
        Math.min(
          anchor.left + anchor.width / 2 - tip.width / 2,
          window.innerWidth - margin - tip.width,
        ),
      );
      const preferredTop =
        anchor.top >= tip.height + margin + 6 ? anchor.top - tip.height - 6 : anchor.bottom + 6;
      const top = Math.max(
        margin,
        Math.min(preferredTop, window.innerHeight - margin - tip.height),
      );
      setPosition({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !triggerRef.current?.contains(event.target) &&
        !tipRef.current?.contains(event.target)
      )
        setOpen(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open]);

  return (
    <>
      <IconButton
        ref={triggerRef}
        label={label}
        title=""
        icon={children}
        variant="ghost"
        className={className}
        aria-describedby={open ? id : undefined}
        onPointerDown={(event) => {
          touchRef.current = event.pointerType === "touch";
        }}
        onPointerEnter={(event) => {
          if (event.pointerType === "mouse") setOpen(true);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse" && document.activeElement !== triggerRef.current)
            setOpen(false);
        }}
        onFocus={() => {
          if (!touchRef.current) setOpen(true);
        }}
        onBlur={() => {
          touchRef.current = false;
          setOpen(false);
        }}
        onClick={() => {
          if (touchRef.current) setOpen((current) => !current);
        }}
      />
      {open &&
        createPortal(
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            className="fixed z-[80] max-h-[calc(100dvh-1rem)] w-max max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-line bg-panel-solid px-3 py-2 text-xs leading-relaxed text-text-main shadow-lg"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? "visible" : "hidden",
            }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
