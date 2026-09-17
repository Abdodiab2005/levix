// file: frontend/src/components/Toggle.tsx
import type React from "react";
import { cn } from "../utils/cn";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
  description?: string;
}

export const Toggle: React.FC<ToggleProps> = ({
  checked,
  onChange,
  disabled = false,
  id,
  label,
  description,
}) => {
  const toggleId = id || `toggle-${Math.random().toString(36).slice(2, 8)}`;

  return (
    <div className="flex items-center justify-between gap-4">
      {(label || description) && (
        <div className="min-w-0 flex-1">
          {label && (
            <label
              htmlFor={toggleId}
              className="font-semibold text-sm cursor-pointer block text-text-main"
            >
              {label}
            </label>
          )}
          {description && <p className="text-xs text-muted mt-0.5">{description}</p>}
        </div>
      )}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        id={toggleId}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cn(
          "relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/50 disabled:opacity-50 disabled:cursor-not-allowed",
          checked ? "bg-brand-blue" : "bg-panel-hover border border-line",
        )}
      >
        <span
          className={cn(
            "pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out",
            checked ? "translate-x-5 rtl:-translate-x-5" : "translate-x-0",
          )}
        />
      </button>
    </div>
  );
};
