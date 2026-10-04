// file: frontend/src/components/Header.tsx

import { ArrowLeft, Check, Globe, LogOut, Menu, Moon, MoreVertical, Sun } from "lucide-react";
import React from "react";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  title: string;
  status: SessionStatus | null;
}

export const Header: React.FC<HeaderProps> = ({ onToggleMobileMenu, title, status: _status }) => {
  const { language, setLanguage, t } = useI18n();
  const [langMenuOpen, setLangMenuOpen] = React.useState(false);
  const [moreMenuOpen, setMoreMenuOpen] = React.useState(false);
  const langMenuRef = React.useRef<HTMLDivElement>(null);
  const moreMenuRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!langMenuOpen && !moreMenuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setLangMenuOpen(false);
      }
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLangMenuOpen(false);
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [langMenuOpen, moreMenuOpen]);

  const [theme, setTheme] = React.useState<"dark" | "light">(() => {
    const saved = localStorage.getItem("levix_theme") as "dark" | "light" | null;
    if (saved) {
      document.documentElement.setAttribute("data-theme", saved);
      return saved;
    }
    return (document.documentElement.getAttribute("data-theme") as "dark" | "light") || "dark";
  });

  const handleThemeToggle = () => {
    const nextTheme = theme === "dark" ? "light" : "dark";
    setTheme(nextTheme);
    document.documentElement.setAttribute("data-theme", nextTheme);
    localStorage.setItem("levix_theme", nextTheme);
  };

  const isInApp = typeof (window as any).LevixHost?.closePanel === "function";

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
        {/* Language selector */}
        <div className="relative" ref={langMenuRef}>
          <button
            type="button"
            onClick={() => setLangMenuOpen((prev) => !prev)}
            className="inline-flex items-center justify-center w-11 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            title={t("chooseLanguage", "Choose Language")}
            aria-label={t("chooseLanguage", "Choose Language")}
            aria-expanded={langMenuOpen}
            aria-haspopup="true"
            id="btn-header-lang"
          >
            <Globe size={18} className="text-brand-cyan" />
          </button>

          {langMenuOpen && (
            <div
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="btn-header-lang"
              className="absolute end-0 mt-2 w-48 rounded-2xl border border-line bg-panel-solid shadow-2xl p-1.5 z-50 ring-1 ring-black/10 animate-in fade-in zoom-in-95 duration-150"
            >
              <div className="px-2.5 py-1.5 text-[11px] font-semibold text-text-muted uppercase tracking-wider">
                {t("chooseLanguage", "Choose Language")}
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setLanguage("ar");
                  setLangMenuOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs md:text-sm font-medium rounded-lg transition-colors ${
                  language === "ar"
                    ? "bg-brand-blue/15 text-brand-cyan font-bold"
                    : "text-text-main hover:bg-panel-hover"
                }`}
              >
                <span>العربية</span>
                {language === "ar" && <Check size={16} className="text-brand-cyan" />}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setLanguage("en");
                  setLangMenuOpen(false);
                }}
                className={`w-full flex items-center justify-between px-3 py-2 text-xs md:text-sm font-medium rounded-lg transition-colors ${
                  language === "en"
                    ? "bg-brand-blue/15 text-brand-cyan font-bold"
                    : "text-text-main hover:bg-panel-hover"
                }`}
              >
                <span>English</span>
                {language === "en" && <Check size={16} className="text-brand-cyan" />}
              </button>
            </div>
          )}
        </div>

        {/* Overflow menu: back-to-app, theme and sign-out live here so the
            bar itself stays to the two controls that matter */}
        <div className="relative" ref={moreMenuRef}>
          <button
            type="button"
            onClick={() => setMoreMenuOpen((prev) => !prev)}
            className="inline-flex items-center justify-center w-11 h-11 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            title={t("moreActions", "More actions")}
            aria-label={t("moreActions", "More actions")}
            aria-expanded={moreMenuOpen}
            aria-haspopup="true"
            id="btn-header-more"
          >
            <MoreVertical size={18} />
          </button>

          {moreMenuOpen && (
            <div
              role="menu"
              aria-orientation="vertical"
              aria-labelledby="btn-header-more"
              className="absolute end-0 mt-2 w-52 rounded-2xl border border-line bg-panel-solid shadow-2xl p-1.5 z-50 ring-1 ring-black/10 animate-in fade-in zoom-in-95 duration-150"
            >
              {isInApp && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMoreMenuOpen(false);
                    (window as any).LevixHost.closePanel();
                  }}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs md:text-sm font-medium rounded-lg text-text-main hover:bg-panel-hover transition-colors"
                >
                  <ArrowLeft size={16} className="rtl:-scale-x-100 text-brand-cyan" />
                  <span>{t("backToApp")}</span>
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  handleThemeToggle();
                  setMoreMenuOpen(false);
                }}
                className="w-full flex items-center gap-2.5 px-3 py-2 text-xs md:text-sm font-medium rounded-lg text-text-main hover:bg-panel-hover transition-colors"
              >
                {theme === "dark" ? (
                  <Sun size={16} className="text-brand-cyan" />
                ) : (
                  <Moon size={16} className="text-brand-cyan" />
                )}
                <span>{theme === "dark" ? t("lightMode") : t("darkMode")}</span>
              </button>
              <div className="my-1 border-t border-line" />
              <form action="/logout" method="POST" className="m-0">
                <button
                  type="submit"
                  role="menuitem"
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs md:text-sm font-medium rounded-lg text-danger hover:bg-danger/10 transition-colors"
                >
                  <LogOut size={16} className="rtl:-scale-x-100" />
                  <span>{t("logout")}</span>
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    </header>
  );
};
