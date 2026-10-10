// file: frontend/src/components/Toasts.tsx

import { AlertTriangle, CheckCircle2, Info, X, XCircle } from "lucide-react";
import type React from "react";
import { createContext, useCallback, useContext, useState } from "react";
import { useI18n } from "../context/I18nContext";
import { IconButton } from "./ui";

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
  const { t } = useI18n();
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
        {toasts.map((item) => (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-center gap-3 rounded-xl border bg-panel-raised/95 px-4 py-3 text-xs text-text-main shadow-xl backdrop-blur-md md:text-sm ${
              item.type === "success"
                ? "border-ok/35"
                : item.type === "error"
                  ? "border-danger/35"
                  : item.type === "warning"
                    ? "border-warn/35"
                    : "border-line"
            }`}
          >
            {item.type === "success" && <CheckCircle2 size={18} className="shrink-0 text-ok" />}
            {item.type === "error" && <XCircle size={18} className="shrink-0 text-danger" />}
            {item.type === "warning" && <AlertTriangle size={18} className="shrink-0 text-warn" />}
            {item.type === "info" && <Info size={18} className="shrink-0 text-info" />}
            <span className="flex-1 font-medium">{item.message}</span>
            <IconButton
              variant="ghost"
              label={t("dismiss")}
              icon={<X size={16} />}
              onClick={() => removeToast(item.id)}
            />
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
