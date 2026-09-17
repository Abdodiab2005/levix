// file: frontend/src/components/Header.tsx

import { Globe, LogOut, Menu, Moon, Sun } from "lucide-react";
import React from "react";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  title: string;
  status: SessionStatus | null;
}

export const Header: React.FC<HeaderProps> = ({ onToggleMobileMenu, title, status }) => {
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

  return (
    <header className="top-header">
      <div className="header-left">
        <button
          onClick={onToggleMobileMenu}
          className="btn btn-secondary btn-icon"
          id="mobile-menu-btn"
          aria-label="Open navigation menu"
          style={{ display: "none" }}
        >
          <Menu size={19} />
        </button>
        <h1 className="header-title" title={title}>
          {title}
        </h1>
      </div>

      <div className="header-right">
        {/* Language switch */}
        <button
          onClick={handleLanguageToggle}
          className="btn btn-secondary btn-sm"
          title={language === "ar" ? "Switch to English" : "التبديل إلى العربية"}
          aria-label="Switch language"
          id="btn-header-lang"
          style={{ gap: "6px", padding: "6px 12px", minHeight: "34px", fontWeight: 700 }}
        >
          <Globe size={16} color="var(--cyan)" />
          <span style={{ fontSize: "0.82rem" }}>{language === "ar" ? "English" : "العربية"}</span>
        </button>

        {/* Theme toggle */}
        <button
          onClick={handleThemeToggle}
          className="btn btn-secondary btn-icon"
          title="Toggle Theme"
          aria-label="Toggle dark/light theme"
        >
          {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>

        {/* Logout */}
        <form action="/logout" method="POST" style={{ margin: 0 }}>
          <button
            type="submit"
            className="btn btn-secondary btn-icon"
            title={t("logout")}
            aria-label="Sign out"
          >
            <LogOut size={15} className="icon-flip" />
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
