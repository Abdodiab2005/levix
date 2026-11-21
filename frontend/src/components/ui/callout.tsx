// file: frontend/src/components/ui/callout.tsx
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "../../utils/cn";

export type CalloutTone = "ok" | "warn" | "danger" | "info";

const CALLOUT_TONES: Record<
  CalloutTone,
  {
    container: string;
    icon: string;
  }
> = {
  ok: {
    container: "border-ok/30 bg-ok/10",
    icon: "text-ok",
  },
  warn: {
    container: "border-warn/30 bg-warn/10",
    icon: "text-warn",
  },
  danger: {
    container: "border-danger/30 bg-danger/10",
    icon: "text-danger",
  },
  info: {
    container: "border-info/30 bg-info/10",
    icon: "text-info",
  },
};

export interface CalloutProps extends Omit<ComponentPropsWithoutRef<"div">, "title"> {
  tone?: CalloutTone;
  icon?: ReactNode;
  title?: ReactNode;
  action?: ReactNode;
}

export function Callout({
  tone = "info",
  icon,
  title,
  action,
  children,
  role,
  className,
  ...props
}: CalloutProps) {
  const styles = CALLOUT_TONES[tone];
  const defaultIcon =
    tone === "ok" ? (
      <CheckCircle2 size={18} />
    ) : tone === "warn" ? (
      <AlertTriangle size={18} />
    ) : tone === "danger" ? (
      <AlertCircle size={18} />
    ) : (
      <Info size={18} />
    );

  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3.5 sm:flex-row sm:items-start sm:gap-3",
        styles.container,
        className,
      )}
      {...props}
    >
      <div className={cn("shrink-0 pt-0.5", styles.icon)} aria-hidden="true">
        {icon ?? defaultIcon}
      </div>
      <div className="min-w-0 flex-1">
        {title && <p className="text-sm font-bold text-text-main">{title}</p>}
        {children && (
          <div className={cn("text-xs leading-relaxed text-muted", title && "mt-1")}>
            {children}
          </div>
        )}
      </div>
      {action && <div className="shrink-0 pt-0.5 sm:self-center">{action}</div>}
    </div>
  );
}
