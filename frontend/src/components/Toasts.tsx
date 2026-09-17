// file: frontend/src/components/Toasts.tsx
import React, { createContext, useContext, useState, useCallback } from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";

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

  const toast = useCallback((message: string, type: Toast["type"] = "info", duration = 4000) => {
    const id = Math.random().toString(36).slice(2, 9);
    setToasts((prev) => [...prev, { id, message, type, duration }]);
    setTimeout(() => removeToast(id), duration);
  }, [removeToast]);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="toast-container" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className="toast-item"
            style={{
              borderColor:
                t.type === "success"
                  ? "rgba(16, 185, 129, 0.35)"
                  : t.type === "error"
                  ? "rgba(239, 68, 68, 0.35)"
                  : t.type === "warning"
                  ? "rgba(245, 158, 11, 0.35)"
                  : "var(--line)",
            }}
          >
            {t.type === "success" && <CheckCircle2 size={18} color="var(--ok)" />}
            {t.type === "error" && <XCircle size={18} color="var(--danger)" />}
            {t.type === "warning" && <AlertTriangle size={18} color="var(--warn)" />}
            {t.type === "info" && <Info size={18} color="var(--info)" />}
            <span style={{ flex: 1 }}>{t.message}</span>
            <button
              onClick={() => removeToast(t.id)}
              style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer", display: "flex" }}
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
