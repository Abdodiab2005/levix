// file: frontend/src/components/ui/badge.tsx
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../utils/cn";

export type BadgeTone = "ok" | "warn" | "danger" | "info" | "neutral";

const TONE: Record<BadgeTone, string> = {
  ok: "border-ok/30 bg-ok/10 text-ok",
  warn: "border-warn/30 bg-warn/10 text-warn",
  danger: "border-danger/30 bg-danger/10 text-danger",
  info: "border-info/30 bg-info/10 text-info",
  neutral: "border-line bg-panel-raised text-muted",
};

export interface BadgeProps extends ComponentPropsWithoutRef<"span"> {
  tone?: BadgeTone;
}

export function Badge({ tone = "neutral", className, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-bold",
        TONE[tone],
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

export function StatusPill({
  dot = false,
  pulse = false,
  children,
  ...props
}: BadgeProps & { dot?: boolean; pulse?: boolean; children?: ReactNode }) {
  return (
    <Badge {...props}>
      {dot && (
        <span className={cn("size-2 shrink-0 rounded-full bg-current", pulse && "pulse-dot")} />
      )}
      {children}
    </Badge>
  );
}
