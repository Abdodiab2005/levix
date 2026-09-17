// file: frontend/src/components/Modal.tsx

import { X } from "lucide-react";
import type React from "react";
import { useEffect } from "react";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  footer,
  maxWidth,
}) => {
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) {
      document.addEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "hidden";
    }
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.body.style.overflow = "auto";
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 overflow-y-auto">
      {/* Backdrop */}
      <button
        type="button"
        className="fixed inset-0 bg-black/65 backdrop-blur-sm border-0 p-0 cursor-default"
        onClick={onClose}
        aria-label="Close modal backdrop"
      />

      {/* Dialog container */}
      <div
        className="relative w-full rounded-2xl border border-line bg-panel shadow-2xl overflow-hidden my-auto z-10 animate-in fade-in zoom-in-95 duration-150"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={maxWidth ? { maxWidth } : { maxWidth: "520px" }}
      >
        <div className="flex items-center justify-between p-5 border-b border-line">
          <h3 className="text-base md:text-lg font-bold text-text-main">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center justify-center w-8 h-8 rounded-lg border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors"
            aria-label="Close modal"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-5 overflow-y-auto max-h-[75vh]">{children}</div>

        {footer && (
          <div className="flex items-center justify-end gap-3 p-4 border-t border-line bg-panel-raised/50">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
};
