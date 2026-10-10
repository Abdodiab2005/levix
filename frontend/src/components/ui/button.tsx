// file: frontend/src/components/ui/button.tsx
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode } from "react";
import { cn } from "../../utils/cn";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

/** Shared look. Specialised controls compose these classes; they do not restyle a raw <button>. */
export const buttonVariants = {
  base: "inline-flex shrink-0 items-center justify-center gap-2 font-bold transition-colors select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:cursor-not-allowed disabled:opacity-50",
  variant: {
    primary: "bg-brand-blue text-white shadow-md shadow-brand-blue/20 hover:bg-brand-blue-deep",
    secondary: "border border-line bg-panel-raised text-text-main hover:bg-panel-hover",
    ghost: "text-muted hover:bg-panel-hover hover:text-text-main",
    danger: "bg-danger text-white shadow-md shadow-danger/20 hover:bg-danger/90",
  },
  size: {
    sm: "h-10 min-h-10 rounded-lg px-3 text-xs",
    md: "h-11 min-h-11 rounded-xl px-4 text-sm",
    lg: "h-12 min-h-12 rounded-xl px-5 text-sm",
  },
  icon: {
    sm: "size-10 min-h-10 min-w-10 rounded-lg p-0",
    md: "size-11 min-h-11 min-w-11 rounded-xl p-0",
    lg: "size-12 min-h-12 min-w-12 rounded-xl p-0",
  },
} as const;

export interface ButtonProps extends ComponentPropsWithoutRef<"button"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Optional leading icon. The label stays in `children`. */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    loading = false,
    icon,
    className,
    type = "button",
    disabled,
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        buttonVariants.base,
        buttonVariants.variant[variant],
        buttonVariants.size[size],
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-4 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : (
        icon && (
          <span aria-hidden className="shrink-0">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  );
});

export interface IconButtonProps
  extends Omit<ComponentPropsWithoutRef<"button">, "children" | "aria-label"> {
  /** Required. Used as aria-label and as the tooltip. */
  label: string;
  icon?: ReactNode;
  /** Icon element. Prefer `icon`; `children` is accepted so callers can nest the glyph. */
  children?: ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  /** Toggle-style icon buttons (auto-scroll, active filter). Sets aria-pressed. */
  pressed?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    label,
    icon,
    children,
    variant = "secondary",
    size = "sm",
    loading = false,
    pressed,
    className,
    type = "button",
    disabled,
    ...props
  },
  ref,
) {
  const glyph = icon ?? children;
  return (
    <button
      ref={ref}
      type={type}
      title={label}
      aria-label={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        buttonVariants.base,
        buttonVariants.variant[variant],
        buttonVariants.icon[size],
        pressed && "border-brand-blue/40 bg-brand-blue/15 text-brand-blue",
        className,
      )}
      {...props}
    >
      {loading ? (
        <span
          aria-hidden
          className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin"
        />
      ) : (
        <span aria-hidden className="shrink-0">
          {glyph}
        </span>
      )}
    </button>
  );
});
