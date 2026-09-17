// file: frontend/src/components/Header.tsx
import React from "react";
import { Menu, Globe, LogOut, Sun, Moon } from "lucide-react";
import { useI18n } from "../context/I18nContext";
import { SessionStatus } from "../types";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  title: string;
  status: SessionStatus | null;
}

export const Header: React.FC<HeaderProps> = ({
  onToggleMobileMenu,
  title,
  status,
}) => {
  const { language, setLanguage, t } = useI18n();

  const handleLanguageToggle = () => {
    setLanguage(language === "ar" ? "en" : "ar");
  };

  const [theme, setTheme] = React.useState<"dark" | "light">(() => {
    return (document.documentElement.getAttribute("data-theme") as "dark" | "light") || "dark";
  });

  const handleThemeToggle = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("levix_theme", nextTheme);
  };

  const state = status?.state || "idle";
  const stateClass =
    state === "connected"
      ? "badge-ok"
      : state === "starting" || state === "linking" || state === "waiting_for_qr"
      ? "badge-warn"
      : state === "error" || state === "logged_out"
      ? "badge-danger"
      : "badge-info";

  return (
    <header className="top-header">
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <button
          onClick={onToggleMobileMenu}
          className="btn btn-secondary btn-sm"
          style={{ display: "none" }}
          id="mobile-menu-btn"
          aria-label="Open menu"
        >
          <Menu size={20} />
        </button>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, letterSpacing: "-0.01em" }}>
          {title}
        </h1>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
        {/* Status indicator */}
        <div className={`badge ${stateClass}`}>
          <span className="pulse-dot" />
          <span>{t(state as any, state)}</span>
        </div>

        {/* Language switch */}
        <button
          onClick={handleLanguageToggle}
          className="btn btn-secondary btn-sm"
          title="Switch Language (AR / EN)"
          style={{ minWidth: "75px" }}
        >
          <Globe size={15} />
          <span>{language === "ar" ? "English" : "العربية"}</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={handleThemeToggle}
          className="btn btn-secondary btn-sm"
          title="Toggle Theme"
          aria-label="Toggle dark/light theme"
        >
          {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>

        {/* Logout */}
        <form action="/logout" method="POST" style={{ margin: 0 }}>
          <button
            type="submit"
            className="btn btn-secondary btn-sm"
            title={t("logout")}
            aria-label="Sign out"
          >
            <LogOut size={16} />
          </button>
        </form>
      </div>

      <style>{`
        @media (max-width: 900px) {
          #mobile-menu-btn { display: inline-flex !important; }
        }
      `}</style>
    </header>
  );
};
