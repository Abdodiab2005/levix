// file: frontend/src/components/Sidebar.tsx

import {
  Bot,
  Calendar,
  FileText,
  Globe,
  LayoutGrid,
  Radio,
  Settings,
  Shield,
  Terminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import type React from "react";
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
  const { t, language, setLanguage } = useI18n();

  const brand = (window as any).__BRAND__ || {
    name: "Levix",
    tagline: "Private control room",
    version: "3.4.0",
    developer: "Abdelrhman Diab",
    studio: "Leviro",
    developerSite: "https://github.com/Abdodiab2005",
    studioSite: "https://leviro.net",
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
        <div className="sidebar-backdrop" onClick={onCloseMobile} aria-hidden="true" />
      )}
      <aside className={`sidebar ${isOpenMobile ? "open" : ""}`} aria-label="Main Navigation">
        <div className="brand-box">
          <div className="brand-info">
            <div className="brand-logo">
              <Zap size={20} color="#fff" />
            </div>
            <div>
              <div className="brand-title">{brand.name}</div>
              <div className="brand-tag">{brand.tagline}</div>
            </div>
          </div>

          <button
            onClick={onCloseMobile}
            className="btn btn-secondary btn-icon mobile-close-btn"
            style={{ display: "none" }}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
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

        <div
          style={{
            padding: "14px 18px",
            borderTop: "1px solid var(--line-soft)",
            fontSize: "0.75rem",
            color: "var(--faint)",
            display: "flex",
            flexDirection: "column",
            gap: "10px",
          }}
        >
          <button
            onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
            className="btn btn-secondary btn-sm"
            style={{
              width: "100%",
              justifyContent: "center",
              gap: "8px",
              fontWeight: 700,
              padding: "7px 10px",
            }}
            id="btn-sidebar-lang"
          >
            <Globe size={14} color="var(--cyan)" />
            <span>{language === "ar" ? "English" : "العربية"}</span>
          </button>

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>v{brand.version || "3.4.0"}</span>
            <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
              <Shield size={12} /> Local-first
            </span>
          </div>
          <div style={{ fontSize: "0.7rem", color: "var(--muted)" }}>
            &copy; {brand.copyrightYear || 2026}{" "}
            <a
              href={brand.developerSite || "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--cyan)", textDecoration: "none" }}
            >
              {brand.developer}
            </a>{" "}
            (
            <a
              href={brand.studioSite || "#"}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--cyan)", textDecoration: "none" }}
            >
              {brand.studio}
            </a>
            )
          </div>
        </div>

        <style>{`
          @media (max-width: 900px) {
            .mobile-close-btn { display: inline-flex !important; }
          }
        `}</style>
      </aside>
    </>
  );
};
