// file: frontend/src/components/ui/filter.tsx
import { Filter } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Badge } from "./badge";
import { Button, IconButton } from "./button";
import { Popover } from "./popover";

export interface FilterButtonProps {
  /** Tooltip and sheet title. */
  label: string;
  resetLabel: string;
  /** How many filters differ from their default. Drives the count badge. */
  activeCount?: number;
  onReset?: () => void;
  children: ReactNode;
}

/**
 * One filter icon. Desktop opens a popover; under 640px Popover becomes a
 * bottom sheet. The choices, and reset, live inside — never as a row of selects.
 */
export function FilterButton({
  label,
  resetLabel,
  activeCount = 0,
  onReset,
  children,
}: FilterButtonProps) {
  const [open, setOpen] = useState(false);
  const countLabel = activeCount > 0 ? `${label} (${activeCount})` : label;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      label={label}
      haspopup="dialog"
      className="w-[min(20rem,calc(100vw-1rem))] p-3"
      badge={
        activeCount > 0 ? (
          <Badge
            tone="info"
            className="pointer-events-none absolute -top-1 -end-1 z-10 h-5 min-w-5 justify-center px-1 tabular-nums"
          >
            {activeCount}
          </Badge>
        ) : null
      }
      trigger={
        <IconButton label={countLabel} icon={<Filter size={18} />} pressed={activeCount > 0} />
      }
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <p className="text-sm font-bold text-text-main">{label}</p>
        {onReset && (
          <Button variant="ghost" size="sm" onClick={onReset} disabled={activeCount === 0}>
            {resetLabel}
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-3">{children}</div>
    </Popover>
  );
}
