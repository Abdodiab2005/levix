// file: frontend/src/components/ui/feedback.tsx
import type { ReactNode } from "react";
import { cn } from "../../utils/cn";

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return (
    <span
      role={label ? "status" : undefined}
      className={cn("inline-flex items-center gap-2", label && "text-muted")}
    >
      <span
        aria-hidden
        className={cn(
          "size-4 shrink-0 rounded-full border-2 border-brand-blue border-t-transparent animate-spin",
          className,
        )}
      />
      {label && <span className="text-xs">{label}</span>}
    </span>
  );
}

export function LoadingState({ text }: { text?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16">
      <Spinner className="size-6" label={text} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-lg bg-panel-hover", className)} />;
}

export function EmptyState({
  icon,
  title,
  text,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title?: ReactNode;
  /** Single muted line. Kept so existing call sites (`text=`) stay valid. */
  text?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-16 text-center",
        className,
      )}
    >
      {icon && <div className="text-muted">{icon}</div>}
      {title && <p className="text-sm font-bold text-text-main">{title}</p>}
      {(text || description) && (
        <p className="max-w-md text-xs text-muted sm:text-sm">{description ?? text}</p>
      )}
      {action}
    </div>
  );
}
