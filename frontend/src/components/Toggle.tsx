// file: frontend/src/components/Toggle.tsx
import type React from "react";

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
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "16px",
      }}
    >
      {(label || description) && (
        <div>
          {label && (
            <label
              htmlFor={toggleId}
              style={{ fontWeight: 600, fontSize: "0.92rem", cursor: "pointer", display: "block" }}
            >
              {label}
            </label>
          )}
          {description && (
            <p style={{ fontSize: "0.8rem", color: "var(--muted)", marginTop: "3px" }}>
              {description}
            </p>
          )}
        </div>
      )}
      <label className="toggle-switch" htmlFor={toggleId}>
        <input
          type="checkbox"
          id={toggleId}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="toggle-slider" />
      </label>
    </div>
  );
};
