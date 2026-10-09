// file: frontend/src/components/ui/chip.tsx
import { X } from "lucide-react";
import { type ComponentPropsWithoutRef, forwardRef, type ReactNode, useId, useState } from "react";
import { cn } from "../../utils/cn";
import { IconButton } from "./button";
import { Input, inputClass } from "./field";

export interface ChipProps {
  children: ReactNode;
  /** Accessible name for the remove button. Omit `onRemove` for a static token. */
  removeLabel?: string;
  onRemove?: () => void;
  /** User-entered text should be `auto` so Arabic and English both read correctly. */
  dir?: "auto" | "ltr" | "rtl";
  className?: string;
  disabled?: boolean;
}

export function Chip({
  children,
  removeLabel,
  onRemove,
  dir = "auto",
  className,
  disabled,
}: ChipProps) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-0.5 rounded-full border border-line bg-panel-raised py-0.5 ps-2.5 text-xs font-semibold text-text-main",
        onRemove ? "pe-0.5" : "pe-2.5",
        className,
      )}
    >
      <span dir={dir} className="min-w-0 truncate">
        {children}
      </span>
      {onRemove && removeLabel && (
        <IconButton
          variant="ghost"
          label={removeLabel}
          icon={<X size={14} />}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onRemove}
        />
      )}
    </span>
  );
}

export type ChipRejectReason = "empty" | "long" | "max" | "duplicate";

export interface ChipInputProps
  extends Omit<ComponentPropsWithoutRef<"input">, "value" | "onChange" | "defaultValue"> {
  value: string[];
  onChange: (value: string[]) => void;
  /** Hard cap. A token past this is rejected with `"max"`. */
  max?: number;
  /** Reject a single token longer than this with `"long"`, unless `prepare` handles it. */
  maxLength?: number;
  /**
   * Map a raw token to the stored string. Return `{ error: "empty" | "long" }` to reject it.
   * Used for normalization that has to match a server rule.
   */
  prepare?: (token: string) => { value: string } | { error: "empty" | "long" };
  onReject?: (reason: ChipRejectReason | null) => void;
  /** Accessible name for each chip's remove button. */
  removeLabel: (value: string) => string;
  /** Already-translated counter, for example "3 / 50". */
  countLabel?: ReactNode;
  chipDir?: "auto" | "ltr" | "rtl";
}

function splitTokens(text: string): string[] {
  return text.split(/[,،\n\r]+/);
}

/**
 * Tokens with a text draft. Enter, comma, or an Arabic comma commits.
 * Backspace on an empty draft removes the last chip. A paste of "a, b, c" splits.
 */
export const ChipInput = forwardRef<HTMLInputElement, ChipInputProps>(function ChipInput(
  {
    value,
    onChange,
    max,
    maxLength,
    prepare,
    onReject,
    removeLabel,
    countLabel,
    chipDir = "auto",
    className,
    disabled,
    id,
    placeholder,
    "aria-label": ariaLabel,
    "aria-invalid": ariaInvalid,
    "aria-describedby": ariaDescribedBy,
    ...props
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const [draft, setDraft] = useState("");

  const acceptToken = (
    raw: string,
    next: string[],
  ): { next: string[]; reason: ChipRejectReason | null } => {
    const trimmed = raw.trim();
    if (!trimmed) return { next, reason: null };
    let stored = trimmed;
    if (prepare) {
      const result = prepare(trimmed);
      if ("error" in result) return { next, reason: result.error };
      stored = result.value;
      if (!stored) return { next, reason: "empty" };
    } else if (maxLength !== undefined && stored.length > maxLength) {
      return { next, reason: "long" };
    }
    if (next.includes(stored)) return { next, reason: "duplicate" };
    if (max !== undefined && next.length >= max) return { next, reason: "max" };
    return { next: [...next, stored], reason: null };
  };

  const commit = (text: string) => {
    const parts = splitTokens(text);
    let next = value;
    let reason: ChipRejectReason | null = null;
    let sawToken = false;
    for (const part of parts) {
      if (!part.trim()) continue;
      sawToken = true;
      const outcome = acceptToken(part, next);
      next = outcome.next;
      if (outcome.reason) reason = outcome.reason;
    }
    if (!sawToken && text.trim()) reason = "empty";
    if (next !== value) onChange(next);
    onReject?.(reason);
    setDraft("");
  };

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div
        className={cn(
          inputClass,
          "flex h-auto flex-wrap items-center gap-1.5 py-1.5 focus-within:ring-2 focus-within:ring-brand-blue/50",
        )}
      >
        {value.map((token) => (
          <Chip
            key={token}
            dir={chipDir}
            disabled={disabled}
            removeLabel={removeLabel(token)}
            onRemove={
              disabled
                ? undefined
                : () => {
                    onChange(value.filter((item) => item !== token));
                    onReject?.(null);
                  }
            }
          >
            {token}
          </Chip>
        ))}
        <Input
          {...props}
          ref={ref}
          id={inputId}
          value={draft}
          disabled={disabled}
          placeholder={value.length === 0 ? placeholder : undefined}
          aria-label={ariaLabel}
          aria-invalid={ariaInvalid}
          aria-describedby={ariaDescribedBy}
          className="min-h-10 min-w-24 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0"
          onChange={(event) => {
            const next = event.target.value;
            if (/[,،\n\r]/.test(next)) {
              commit(next);
              return;
            }
            setDraft(next);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter" || event.key === "," || event.key === "،") {
              event.preventDefault();
              commit(draft);
              return;
            }
            if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
              event.preventDefault();
              onChange(value.slice(0, -1));
              onReject?.(null);
            }
          }}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!/[,،\n\r]/.test(text)) return;
            event.preventDefault();
            commit(`${draft}${text}`);
          }}
          onBlur={() => {
            if (draft.trim()) commit(draft);
          }}
        />
      </div>
      {countLabel && <p className="text-xs text-muted tabular-nums">{countLabel}</p>}
    </div>
  );
});
