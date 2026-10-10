// file: frontend/src/components/ui/focus.ts
import { type RefObject, useLayoutEffect, useRef } from "react";

export const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbables(root: HTMLElement) {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => {
    if (el.tabIndex < 0) return false;
    if (el.closest("[aria-hidden='true']")) return false;
    return true;
  });
}

/**
 * Cycle Tab inside `ref` while `active`. Escape is left to the caller so a
 * nested popover can close first (it listens in the capture phase and marks
 * the event defaultPrevented). Focus returns to whatever was focused before.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  active: boolean,
  onEscape?: () => void,
) {
  const onEscapeRef = useRef(onEscape);
  onEscapeRef.current = onEscape;

  useLayoutEffect(() => {
    if (!active) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    // Focus the container, not the first control. A menu inside focuses its own item afterwards.
    if (
      root &&
      (!(document.activeElement instanceof Node) || !root.contains(document.activeElement))
    ) {
      root.focus();
    }

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (event.defaultPrevented) return;
        const root = ref.current;
        if (root) {
          const overlays = document.querySelectorAll("[data-overlay]");
          const top = overlays.item(overlays.length - 1);
          // A contact picker (or confirm) stacked on another dialog handles Escape alone.
          if (top && top !== root) return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        onEscapeRef.current?.();
        return;
      }
      if (event.key !== "Tab" || !ref.current) return;
      const activeEl = document.activeElement;
      // A portaled popover/sheet sits outside this node. Leave its own trap in charge.
      if (activeEl instanceof Element && activeEl.closest("[data-overlay='popover']")) return;
      if (ref.current.dataset.overlay === "dialog" && activeEl instanceof Element) {
        const foreign = activeEl.closest("[data-overlay]");
        if (foreign && foreign !== ref.current) return;
      }
      const items = tabbables(ref.current);
      if (items.length === 0) {
        event.preventDefault();
        ref.current.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = activeEl instanceof Node && ref.current.contains(activeEl);
      if (event.shiftKey && (!inside || activeEl === first)) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && (!inside || activeEl === last)) {
        event.preventDefault();
        first?.focus();
      }
    };

    document.addEventListener("keydown", onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [active, ref]);
}
