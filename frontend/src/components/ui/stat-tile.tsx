// file: frontend/src/components/ui/stat-tile.tsx
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../utils/cn";

const statTileVariants = {
  default: "border-line bg-panel",
  raised: "border-line-soft bg-panel-raised",
} as const;

export type StatTileVariant = keyof typeof statTileVariants;

export interface StatTileProps extends Omit<ComponentPropsWithoutRef<"div">, "onClick"> {
  label: ReactNode;
  value: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  trend?: ReactNode;
  onClick?: () => void;
  href?: string;
  variant?: StatTileVariant;
}

export function StatTile({
  label,
  value,
  icon,
  hint,
  trend,
  onClick,
  href,
  variant = "default",
  className,
  ...props
}: StatTileProps) {
  const content = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="line-clamp-2 break-words text-xs font-medium text-muted">{label}</span>
        {icon && (
          <span className="shrink-0 text-muted" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>
      <div className="truncate text-lg font-bold text-text-main sm:text-xl">{value}</div>
      {(hint || trend) && (
        <div className="truncate text-xs text-muted">
          {trend && <span className="me-1 font-semibold">{trend}</span>}
          {hint}
        </div>
      )}
    </>
  );

  const sharedClassName = cn(
    "flex min-w-0 flex-col gap-1 rounded-xl border p-3 text-start transition-colors sm:p-4",
    statTileVariants[variant],
    (onClick || href) &&
      "cursor-pointer hover:border-line hover:bg-panel-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue",
    className,
  );

  if (href) {
    return (
      <a href={href} className={sharedClassName} {...(props as ComponentPropsWithoutRef<"a">)}>
        {content}
      </a>
    );
  }

  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={sharedClassName}
        {...(props as ComponentPropsWithoutRef<"button">)}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={sharedClassName} {...props}>
      {content}
    </div>
  );
}
