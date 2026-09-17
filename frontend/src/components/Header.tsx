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
    <header className="h-16 sticky top-0 z-30 flex items-center justify-between px-4 md:px-6 bg-panel/85 backdrop-blur-md border-b border-line">
      <div className="flex items-center gap-3 min-w-0">
        <button
          type="button"
          onClick={onToggleMobileMenu}
          className="inline-flex md:hidden items-center justify-center w-11 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          id="mobile-menu-btn"
          aria-label="Open navigation menu"
        >
          <Menu size={20} />
        </button>
        <h1
          className="text-lg md:text-xl font-bold tracking-tight text-text-main truncate"
          title={title}
        >
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-2 md:gap-3">
        {/* Language switch */}
        <button
          type="button"
          onClick={handleLanguageToggle}
          className="inline-flex items-center gap-2 px-3.5 py-2 min-h-[44px] rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs md:text-sm transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          title={language === "ar" ? "Switch to English" : "التبديل إلى العربية"}
          aria-label="Switch language"
          id="btn-header-lang"
        >
          <Globe size={18} className="text-brand-cyan shrink-0" />
          <span>{language === "ar" ? "English" : "العربية"}</span>
        </button>

        {/* Theme toggle */}
        <button
          type="button"
          onClick={handleThemeToggle}
          className="inline-flex items-center justify-center w-11 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
          title="Toggle Theme"
          aria-label="Toggle dark/light theme"
        >
          {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
        </button>

        {/* Logout */}
        <form action="/logout" method="POST" className="m-0">
          <button
            type="submit"
            className="inline-flex items-center justify-center w-11 h-11 rounded-xl border border-line bg-panel-raised hover:bg-danger/15 hover:border-danger/40 hover:text-danger text-text-main transition-colors focus-visible:ring-2 focus-visible:ring-danger/50"
            title={t("logout")}
            aria-label="Sign out"
          >
            <LogOut size={18} className="rtl:-scale-x-100 transition-transform" />
          </button>
        </form>
      </div>
    </header>
  );
};
