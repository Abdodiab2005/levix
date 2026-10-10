// file: frontend/src/components/ui/field.tsx
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId } from "react";
import { cn } from "../../utils/cn";

export const inputClass =
  "w-full min-h-10 rounded-xl border border-line bg-panel-raised px-3 text-sm text-text-main placeholder:text-faint focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:cursor-not-allowed disabled:opacity-50";

/** Alias kept for call sites that still pass a class instead of the Input primitive. */
export const fieldClass = inputClass;

export function FieldLabel({ children, htmlFor }: { children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} className="mb-1 block text-xs font-bold text-text-main">
      {children}
    </label>
  );
}

export function Field({
  label,
  description,
  error,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && <FieldLabel htmlFor={htmlFor}>{label}</FieldLabel>}
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : (
        description && <p className="text-xs text-muted">{description}</p>
      )}
    </div>
  );
}

export const Input = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(inputClass, className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, ComponentPropsWithoutRef<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        className={cn(inputClass, "h-auto min-h-24 resize-y py-3 leading-relaxed", className)}
        {...props}
      />
    );
  },
);

export const Select = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<"select">>(
  function Select({ className, ...props }, ref) {
    return <select ref={ref} className={cn(inputClass, "pe-8", className)} {...props} />;
  },
);

export interface CheckboxProps extends Omit<ComponentPropsWithoutRef<"input">, "type"> {
  label?: ReactNode;
  description?: ReactNode;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { label, description, className, id, ...props },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  return (
    <label htmlFor={inputId} className="flex min-h-10 cursor-pointer items-center gap-2.5">
      <input
        ref={ref}
        id={inputId}
        type="checkbox"
        className={cn("size-4 shrink-0 accent-brand-blue", className)}
        {...props}
      />
      {(label || description) && (
        <span className="min-w-0">
          {label && <span className="block text-sm text-text-main">{label}</span>}
          {description && <span className="block text-xs text-muted">{description}</span>}
        </span>
      )}
    </label>
  );
});

export interface RadioOption<T extends string = string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
}

export function RadioGroup<T extends string>({
  label,
  name,
  value,
  onChange,
  options,
  orientation = "vertical",
  className,
}: {
  label?: string;
  name: string;
  value: T;
  onChange: (value: T) => void;
  options: readonly RadioOption<T>[];
  orientation?: "vertical" | "horizontal";
  className?: string;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        "flex gap-1",
        orientation === "horizontal" ? "flex-row flex-wrap" : "flex-col",
        className,
      )}
    >
      {label && <p className="mb-1 w-full text-xs font-bold text-text-main">{label}</p>}
      {options.map((option) => (
        <label key={option.value} className="flex min-h-10 cursor-pointer items-center gap-2.5">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
            className="size-4 shrink-0 accent-brand-blue"
          />
          <span className="min-w-0">
            <span className="block text-sm text-text-main">{option.label}</span>
            {option.description && (
              <span className="block text-xs text-muted">{option.description}</span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}

export interface ToggleProps
  extends Omit<ComponentPropsWithoutRef<"button">, "onChange" | "children"> {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: ReactNode;
  description?: ReactNode;
}

export const Toggle = forwardRef<HTMLButtonElement, ToggleProps>(function Toggle(
  { checked, onChange, disabled, id, label, description, className, ...props },
  ref,
) {
  const autoId = useId();
  const toggleId = id || autoId;
  const labelled = Boolean(label || description);
  return (
    <div
      className={cn(
        labelled ? "flex items-center justify-between gap-4" : "inline-flex",
        className,
      )}
    >
      {labelled && (
        <div className="min-w-0 flex-1">
          {label && (
            <label
              htmlFor={toggleId}
              className="block cursor-pointer text-sm font-semibold text-text-main"
            >
              {label}
            </label>
          )}
          {description && <p className="mt-0.5 text-xs text-muted">{description}</p>}
        </div>
      )}
      <button
        ref={ref}
        type="button"
        role="switch"
        aria-checked={checked}
        id={toggleId}
        {...props}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-10 w-16 shrink-0 items-center rounded-full border transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          checked ? "border-brand-blue bg-brand-blue" : "border-line bg-panel-hover",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute top-1 size-7 rounded-full bg-white shadow transition-[inset-inline-start] duration-200",
            checked ? "start-8" : "start-1",
          )}
        />
      </button>
    </div>
  );
});
