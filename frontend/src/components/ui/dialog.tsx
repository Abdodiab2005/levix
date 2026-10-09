// file: frontend/src/components/ui/dialog.tsx
import { X } from "lucide-react";
import { type ReactNode, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../context/I18nContext";
import { cn } from "../../utils/cn";
import { Button, IconButton } from "./button";
import { useFocusTrap } from "./focus";

export interface DialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** CSS length, for example "32rem". Defaults to 32.5rem. */
  maxWidth?: string;
  description?: ReactNode;
  className?: string;
}

export function Dialog({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth,
  description,
  className,
}: DialogProps) {
  const { t } = useI18n();
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useFocusTrap(panelRef, isOpen, onClose);

  if (!isOpen) return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4">
      <button
        type="button"
        className="fixed inset-0 cursor-default border-0 bg-black/65 p-0 backdrop-blur-sm"
        onClick={onClose}
        aria-label={t("close")}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        data-overlay="dialog"
        className={cn(
          "relative z-10 my-auto w-full overflow-hidden rounded-2xl border border-line bg-panel shadow-2xl outline-none",
          className,
        )}
        style={{ maxWidth: maxWidth || "32.5rem", animation: "modal-enter 150ms ease-out" }}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line p-4 md:p-5">
          <h2 id={titleId} className="min-w-0 text-base font-bold text-text-main md:text-lg">
            {title}
          </h2>
          <IconButton label={t("close")} icon={<X size={18} />} onClick={onClose} />
        </div>
        <div className="max-h-[75vh] overflow-y-auto p-4 md:p-5">
          {description && (
            <p id={descriptionId} className="mb-3 text-sm text-muted">
              {description}
            </p>
          )}
          {children}
        </div>
        {footer && (
          <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line bg-panel-raised/50 p-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel: string;
  variant?: "danger" | "primary";
  loading?: boolean;
  children?: ReactNode;
  maxWidth?: string;
}

/** Dialog plus the cancel / confirm pair. Destructive confirms use variant "danger". */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel,
  cancelLabel,
  variant = "danger",
  loading = false,
  children,
  maxWidth,
}: ConfirmDialogProps) {
  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      description={description}
      maxWidth={maxWidth}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "danger" ? "danger" : "primary"}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
