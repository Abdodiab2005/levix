// file: frontend/src/components/ui/tabs.tsx
import type { ReactNode } from "react";
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

export function SegmentedControl<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
}: TabBarProps<T>) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={cn("inline-flex rounded-xl border border-line bg-panel-raised p-1", className)}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-xs font-semibold transition-colors",
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

/** Separate pills for a scrolling tab strip (Sticker Studio). */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  "aria-label": ariaLabel,
  className,
}: TabBarProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className={cn("flex items-center gap-2", className)}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="tab"
            aria-selected={selected}
            onClick={() => onChange(option.value)}
            className={cn(
              "inline-flex min-h-10 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-4 text-sm font-bold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50",
              selected
                ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25"
                : "text-muted hover:bg-panel-hover hover:text-text-main",
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
