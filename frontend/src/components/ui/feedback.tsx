// file: frontend/src/components/ui/feedback.tsx
import type { ReactNode } from "react";
import { useI18n } from "../../context/I18nContext";
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

export interface EmptyStateProps {
  /** empty: no records yet; no-results: filters matched nothing; error: load failed. */
  kind?: "empty" | "no-results" | "error";
  icon?: ReactNode;
  title?: ReactNode;
  /** Single muted line. Kept so existing call sites (`text=`) stay valid. */
  text?: ReactNode;
  description?: ReactNode;
  /** One CTA, such as Create, Clear filters, or Retry. */
  action?: ReactNode;
  className?: string;
}

export function EmptyState({
  kind,
  icon,
  title,
  text,
  description,
  action,
  className,
}: EmptyStateProps) {
  const { t } = useI18n();
  const defaultTitle =
    kind === "empty"
      ? t("emptyRecords")
      : kind === "no-results"
        ? t("emptyMatches")
        : kind === "error"
          ? t("loadError")
          : null;
  return (
    <div
      role={kind === "error" ? "alert" : undefined}
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-4 py-12 text-center sm:py-16",
        className,
      )}
    >
      {icon && <div className="text-muted">{icon}</div>}
      {(title || defaultTitle) && (
        <p className="text-base font-bold text-text-main">{title ?? defaultTitle}</p>
      )}
      {(text || description) && (
        <p className="max-w-md text-sm text-muted">{description ?? text}</p>
      )}
      {action}
    </div>
  );
}
