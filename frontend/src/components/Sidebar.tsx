// file: frontend/src/components/Sidebar.tsx
import React from "react";
import {
  LayoutGrid,
  Radio,
  Terminal,
  Bot,
  Users,
  Calendar,
  Settings,
  FileText,
  Shield,
  Zap,
} from "lucide-react";
import { useI18n } from "../context/I18nContext";

export type ViewTab =
  | "overview"
  | "connection"
  | "commands"
  | "ai"
  | "groups"
  | "schedules"
  | "settings"
  | "logs";

interface SidebarProps {
  currentView: ViewTab;
  onSelectView: (view: ViewTab) => void;
  isOpenMobile: boolean;
  onCloseMobile: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentView,
  onSelectView,
  isOpenMobile,
  onCloseMobile,
}) => {
  const { t } = useI18n();

  const brand = (window as any).__BRAND__ || {
    name: "Levix",
    tagline: "Private control room",
    version: "3.4.0",
  };

  const navItems = [
    { id: "overview", label: t("overview"), icon: LayoutGrid },
    { id: "connection", label: t("connection"), icon: Radio },
    { labelCategory: t("control") },
    { id: "commands", label: t("commands"), icon: Terminal },
    { id: "ai", label: t("ai"), icon: Bot },
    { id: "groups", label: t("groups"), icon: Users },
    { id: "schedules", label: t("schedules"), icon: Calendar },
    { labelCategory: t("settings") },
    { id: "settings", label: t("settings"), icon: Settings },
    { id: "logs", label: t("logs"), icon: FileText },
  ];

  return (
    <>
      {isOpenMobile && (
        <div
          className="modal-backdrop"
          style={{ zIndex: 35 }}
          onClick={onCloseMobile}
        />
      )}
      <aside className={`sidebar ${isOpenMobile ? "open" : ""}`}>
        <div className="brand-box">
          <div className="brand-logo">
            <Zap size={22} color="#fff" />
          </div>
          <div>
            <div className="brand-title">{brand.name}</div>
            <div className="brand-tag">{brand.tagline}</div>
          </div>
        </div>

        <nav className="nav-menu">
          {navItems.map((item, idx) => {
            if (item.labelCategory) {
              return (
                <div key={`cat-${idx}`} className="nav-label">
                  {item.labelCategory}
                </div>
              );
            }
            const Icon = item.icon!;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => {
                  onSelectView(item.id as ViewTab);
                  onCloseMobile();
                }}
                className={`nav-btn ${isActive ? "active" : ""}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div style={{ padding: "16px 20px", borderTop: "1px solid var(--line-soft)", fontSize: "0.76rem", color: "var(--faint)", display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>v{brand.version || "3.4.0"}</span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <Shield size={12} /> Local-first
            </span>
          </div>
          <div style={{ fontSize: "0.72rem", color: "var(--muted)" }}>
            &copy; {brand.copyrightYear || 2026}{" "}
            <a href={brand.developerSite} target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan)", textDecoration: "none" }}>
              {brand.developer}
            </a>{" "}
            (<a href={brand.studioSite} target="_blank" rel="noopener noreferrer" style={{ color: "var(--cyan)", textDecoration: "none" }}>
              {brand.studio}
            </a>)
          </div>
        </div>
      </aside>
    </>
  );
};
