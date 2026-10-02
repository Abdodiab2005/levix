import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../utils/cn";

type Variant = "primary" | "ghost" | "danger" | "quiet";

const VARIANT: Record<Variant, string> = {
  primary: "bg-brand-blue hover:bg-brand-blue/90 text-white shadow-md shadow-brand-blue/20",
  ghost: "border border-line bg-panel-raised hover:bg-panel-hover text-text-main",
  danger: "bg-danger hover:bg-danger/90 text-white shadow-md shadow-danger/25",
  quiet: "text-muted hover:bg-panel-hover hover:text-text-main",
};

export function Button({
  variant = "ghost",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      {...props}
      type="button"
      className={cn(
        "inline-flex items-center justify-center gap-1.5 px-3 h-10 rounded-xl font-bold text-xs sm:text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50",
        VARIANT[variant],
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({
  label,
  danger,
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; danger?: boolean }) {
  return (
    <button
      {...props}
      type="button"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center gap-1.5 px-2.5 min-h-9 rounded-lg border text-xs font-bold transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50",
        danger
          ? "border-danger/40 text-danger hover:bg-danger/10"
          : "border-line bg-panel-raised text-text-main hover:bg-panel-hover",
        className,
      )}
    >
      {children}
      <span className="hidden md:inline">{label}</span>
    </button>
  );
}

export const fieldClass =
  "w-full h-10 px-3 rounded-xl border border-line bg-panel-raised text-text-main text-xs sm:text-sm focus:outline-none focus:ring-2 focus:ring-brand-blue/50";

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="block text-xs font-bold text-text-main mb-1">
      {children}
    </label>
  );
}

export function EmptyState({ icon, text }: { icon: ReactNode; text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted">
      {icon}
      <span className="text-xs sm:text-sm text-center">{text}</span>
    </div>
  );
}

export function LoadingState({ text }: { text: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 gap-2 text-muted">
      <div className="w-6 h-6 border-2 border-brand-cyan border-t-transparent rounded-full animate-spin" />
      <span className="text-xs">{text}</span>
    </div>
  );
}
