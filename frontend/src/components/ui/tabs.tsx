// file: frontend/src/components/ui/tabs.tsx
import { type KeyboardEvent, type ReactNode, useEffect, useRef } from "react";
import { cn } from "../../utils/cn";

export interface TabOption<T extends string = string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface TabBarProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly TabOption<T>[];
  "aria-label": string;
  className?: string;
}

function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!(event.target instanceof HTMLButtonElement)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(event.target);
  if (index < 0) return;
  const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
  let next: number;
  switch (event.key) {
    case "ArrowRight":
      next = (index + (rtl ? -1 : 1) + tabs.length) % tabs.length;
      break;
    case "ArrowLeft":
      next = (index + (rtl ? 1 : -1) + tabs.length) % tabs.length;
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = tabs.length - 1;
      break;
    default:
      return;
  }
  event.preventDefault();
  tabs[next].focus({ preventScroll: true });
  tabs[next].scrollIntoView?.({ block: "nearest", inline: "nearest" });
  tabs[next].click();
}

function useSelectedTab(value: string) {
  const selectedRef = useRef<HTMLButtonElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: Selection moves the ref to a different button that must be revealed.
  useEffect(() => {
    selectedRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [value]);
  return selectedRef;
}

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
}: TabBarProps<T>) {
  const selectedRef = useSelectedTab(value);
  const focusValue = options.some((option) => option.value === value) ? value : options[0]?.value;
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={navigateTabs}
      className={cn(
        "inline-flex max-w-full flex-nowrap overflow-x-auto rounded-xl border border-line bg-panel-raised p-1",
        className,
      )}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            ref={selected ? selectedRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={option.value === focusValue ? 0 : -1}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-xs font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50",
              selected ? "bg-brand-blue text-white" : "text-muted hover:text-text-main",
            )}
          >
            {option.icon}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Separate pills for a tab strip (Sticker Studio, Settings). Under 640px an
 * inactive tab that has an icon shows the icon only (its label stays the
 * accessible name and the tooltip), so a five or six tab strip fits a phone;
 * the selected tab keeps its label and is scrolled into view.
 */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
}: TabBarProps<T>) {
  const selectedRef = useSelectedTab(value);
  const focusValue = options.some((option) => option.value === value) ? value : options[0]?.value;
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={navigateTabs}
      className={cn("flex items-center gap-1 sm:gap-2", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        const compact = Boolean(option.icon) && !selected;
        return (
          <button
            key={option.value}
            ref={selected ? selectedRef : undefined}
            type="button"
            role="tab"
            aria-selected={selected}
            tabIndex={option.value === focusValue ? 0 : -1}
            title={compact && typeof option.label === "string" ? option.label : undefined}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl text-sm font-bold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50",
              compact ? "px-2.5 sm:px-4" : "px-4",
              selected
                ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
                : "text-muted hover:bg-panel-hover hover:text-text-main",
            )}
          >
            {option.icon}
            <span className={cn(compact && "sr-only sm:not-sr-only")}>{option.label}</span>
          </button>
        );
      })}
    </div>
  );
}
