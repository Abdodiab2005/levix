// file: frontend/src/components/Toasts.tsx

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import type React from "react";
import { createContext, useCallback, useContext, useState } from "react";

export interface Toast {
  id: string;
  message: string;
  type?: "success" | "warning" | "error" | "info";
  duration?: number;
}

interface ToastContextType {
  toast: (message: string, type?: Toast["type"], duration?: number) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (message: string, type: Toast["type"] = "info", duration = 4000) => {
      const id = Math.random().toString(36).slice(2, 9);
      setToasts((prev) => [...prev, { id, message, type, duration }]);
      setTimeout(() => removeToast(id), duration);
    },
    [removeToast],
  );

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div
        className="fixed bottom-5 end-5 z-50 flex flex-col gap-2.5 max-w-sm w-full px-4 pointer-events-none"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto flex items-center gap-3 px-4 py-3 rounded-xl border bg-panel-raised/95 backdrop-blur-md shadow-xl text-xs md:text-sm text-text-main transition-all ${
              t.type === "success"
                ? "border-ok/35"
                : t.type === "error"
                  ? "border-danger/35"
                  : t.type === "warning"
                    ? "border-warn/35"
                    : "border-line"
            }`}
          >
            {t.type === "success" && <CheckCircle2 size={18} className="text-ok shrink-0" />}
            {t.type === "error" && <XCircle size={18} className="text-danger shrink-0" />}
            {t.type === "warning" && <AlertTriangle size={18} className="text-warn shrink-0" />}
            {t.type === "info" && <Info size={18} className="text-info shrink-0" />}
            <span className="flex-1 font-medium">{t.message}</span>
            <button
              type="button"
              onClick={() => removeToast(t.id)}
              className="inline-flex items-center justify-center w-6 h-6 rounded-lg text-muted hover:text-text-main hover:bg-panel-hover transition-colors shrink-0"
              aria-label="Dismiss notification"
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
};

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within a ToastProvider");
  return ctx;
};
