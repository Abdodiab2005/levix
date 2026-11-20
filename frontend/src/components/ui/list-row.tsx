// file: frontend/src/components/ui/list-row.tsx
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

const listRowVariants = {
  default: "border-line bg-panel",
  raised: "border-line bg-panel-raised/40",
  ghost: "border-transparent bg-transparent",
} as const;

export type ListRowVariant = keyof typeof listRowVariants;

export interface ListRowProps {
  leading?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** Actions at the end of the row. They stay outside the clickable area. */
  trailing?: ReactNode;
  /** Makes the leading, title and meta area one button. */
  onClick?: () => void;
  /** Makes the leading, title and meta area one link. Ignored when onClick is set. */
  href?: string;
  variant?: ListRowVariant;
  as?: "div" | "li";
  className?: string;
  children?: ReactNode;
}

export function ListRow({
  leading,
  title,
  meta,
  trailing,
  onClick,
  href,
  variant = "default",
  as: Component = "div",
  className,
  children,
}: ListRowProps) {
  const body = (
    <>
      {leading && (
        <span className="flex shrink-0 items-center justify-center" aria-hidden="true">
          {leading}
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        {/* Two lines at most, so a long name stays readable without a tooltip. */}
        <span className="line-clamp-2 break-words text-sm font-semibold text-text-main">
          {title}
        </span>
        {meta && <span className="mt-0.5 line-clamp-2 break-words text-xs text-muted">{meta}</span>}
      </span>
    </>
  );

  const areaClass = "flex min-h-10 min-w-0 flex-1 items-center gap-3 text-start";
  const interactiveClass =
    "-m-1 rounded-lg p-1 transition-colors hover:bg-panel-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50";

  let area: ReactNode;
  if (onClick) {
    area = (
      <button type="button" onClick={onClick} className={cn(areaClass, interactiveClass)}>
        {body}
      </button>
    );
  } else if (href) {
    area = (
      <a href={href} className={cn(areaClass, interactiveClass)}>
        {body}
      </a>
    );
  } else {
    area = <div className={areaClass}>{body}</div>;
  }

  return (
    <Component
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3",
        listRowVariants[variant],
        className,
      )}
    >
      <div className="flex items-center justify-between gap-3">
        {area}
        {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
      </div>
      {children}
    </Component>
  );
}
