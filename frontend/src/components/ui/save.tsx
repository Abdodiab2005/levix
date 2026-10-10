// file: frontend/src/components/ui/save.tsx
import { Check, Save } from "lucide-react";
import {
  cloneElement,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../utils/cn";
import { Button, IconButton } from "./button";
import { Field } from "./field";

const SAVED_FLASH_MS = 1500;

export type SaveStatus = "idle" | "saving" | "saved";

function messageOf(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return "";
}

function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => Object.is(left[key], right[key]));
}

function useSavedFlash(
  status: SaveStatus,
  setStatus: (next: SaveStatus | ((current: SaveStatus) => SaveStatus)) => void,
) {
  useEffect(() => {
    if (status !== "saved") return;
    const timer = window.setTimeout(() => {
      setStatus((current) => (current === "saved" ? "idle" : current));
    }, SAVED_FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [status, setStatus]);
}

export function useSavedValue<T>(saved: T) {
  const [value, setValue] = useState(saved);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef(saved);

  useEffect(() => {
    if (status === "saving") return;
    if (sameValue(saved, savedRef.current)) return;
    savedRef.current = saved;
    setValue(saved);
  }, [saved, status]);

  useSavedFlash(status, setStatus);

  const dirty = !sameValue(value, saved);

  const save = useCallback(
    async (persist: (next: T) => Promise<void>) => {
      if (!dirty || status === "saving") return;
      setStatus("saving");
      setError(null);
      try {
        await persist(value);
        setStatus("saved");
      } catch (err) {
        setStatus("idle");
        setError(messageOf(err) || null);
      }
    },
    [dirty, status, value],
  );

  const revert = useCallback(() => {
    setValue(saved);
    setError(null);
    setStatus("idle");
  }, [saved]);

  return { value, setValue, dirty, status, error, save, revert };
}

export function useDirtyForm<T extends Record<string, any>>(saved: T) {
  const [draft, setDraft] = useState(saved);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const savedRef = useRef(saved);

  useEffect(() => {
    if (status === "saving") return;
    if (sameValue(saved, savedRef.current)) return;
    savedRef.current = saved;
    setDraft(saved);
  }, [saved, status]);

  useSavedFlash(status, setStatus);

  const dirty = !sameValue(draft, saved);

  const setField = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(
    async (persist: (next: T) => Promise<void>) => {
      if (!dirty || status === "saving") return;
      setStatus("saving");
      setError(null);
      try {
        await persist(draft);
        setStatus("saved");
      } catch (err) {
        setStatus("idle");
        setError(messageOf(err) || null);
      }
    },
    [dirty, status, draft],
  );

  const revert = useCallback(() => {
    setDraft(saved);
    setError(null);
    setStatus("idle");
  }, [saved]);

  return { draft, setDraft, setField, dirty, status, error, save, revert };
}

export function SaveField({
  label,
  description,
  error,
  htmlFor,
  className,
  dirty,
  saving,
  justSaved,
  onSave,
  onRevert,
  saveLabel,
  savedLabel,
  actions,
  children,
}: {
  label?: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  htmlFor?: string;
  className?: string;
  dirty: boolean;
  saving?: boolean;
  justSaved?: boolean;
  onSave: () => void;
  onRevert: () => void;
  saveLabel: string;
  savedLabel?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const tag = (event.target as HTMLElement | null)?.tagName;
    if (event.key === "Enter" && tag === "INPUT" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (dirty && !saving) onSave();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onRevert();
    }
  };

  const control = isValidElement<{ onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void }>(
    children,
  )
    ? cloneElement(children, {
        onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
          children.props.onKeyDown?.(event);
          onKeyDown(event);
        },
      })
    : children;

  return (
    <Field
      label={label}
      description={description}
      error={error}
      htmlFor={htmlFor}
      className={className}
    >
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">{control}</div>
        {actions}
        <IconButton
          type="button"
          label={justSaved ? (savedLabel ?? saveLabel) : saveLabel}
          icon={justSaved ? <Check size={16} /> : <Save size={16} />}
          loading={saving}
          disabled={(!dirty && !justSaved) || saving}
          onClick={() => {
            if (dirty && !saving) onSave();
          }}
          className={justSaved ? "text-ok" : undefined}
        />
      </div>
    </Field>
  );
}

export function FormActions({
  dirty,
  saving,
  justSaved,
  error,
  onDiscard,
  saveLabel,
  discardLabel,
  unsavedLabel,
  savedLabel,
  className,
}: {
  dirty: boolean;
  saving?: boolean;
  justSaved?: boolean;
  error?: ReactNode;
  onDiscard: () => void;
  saveLabel: string;
  discardLabel: string;
  unsavedLabel: string;
  savedLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <div className="min-w-0 flex-1">
        {error ? (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        ) : dirty ? (
          <p className="text-xs text-warn">{unsavedLabel}</p>
        ) : justSaved && savedLabel ? (
          <p className="text-xs text-ok">{savedLabel}</p>
        ) : null}
      </div>
      <Button type="button" variant="ghost" disabled={!dirty || saving} onClick={onDiscard}>
        {discardLabel}
      </Button>
      <Button
        type="submit"
        variant="primary"
        icon={<Save size={16} />}
        disabled={!dirty}
        loading={saving}
      >
        {saveLabel}
      </Button>
    </div>
  );
}
