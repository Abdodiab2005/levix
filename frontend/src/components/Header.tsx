// file: frontend/src/components/Header.tsx

import { Globe, Menu as MenuIcon, Moon, Sun } from "lucide-react";
import { type FC, useState } from "react";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";
import { IconButton, Menu, MenuItem, MenuLabel } from "./ui";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  title: string;
  status: SessionStatus | null;
}

export const Header: FC<HeaderProps> = ({ onToggleMobileMenu, title, status: _status }) => {
  const { language, setLanguage, t } = useI18n();
  const [theme, setTheme] = useState<"dark" | "light">(() => {
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

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-line bg-panel/85 px-4 backdrop-blur-md md:px-6">
      <div className="flex min-w-0 items-center gap-3">
        <IconButton
          id="mobile-menu-btn"
          className="md:hidden"
          label={t("openNavigation")}
          icon={<MenuIcon size={20} />}
          onClick={onToggleMobileMenu}
        />
        <h1
          className="truncate text-lg font-bold tracking-tight text-text-main md:text-xl"
          title={title}
        >
          {title}
        </h1>
      </div>

      <div className="flex items-center gap-2 md:gap-3">
        <Menu
          label={t("chooseLanguage")}
          trigger={
            <IconButton
              id="btn-header-lang"
              label={t("chooseLanguage")}
              icon={<Globe size={18} className="text-brand-cyan" />}
            />
          }
        >
          <MenuLabel>{t("chooseLanguage")}</MenuLabel>
          <MenuItem checked={language === "ar"} onSelect={() => setLanguage("ar")}>
            العربية
          </MenuItem>
          <MenuItem checked={language === "en"} onSelect={() => setLanguage("en")}>
            English
          </MenuItem>
        </Menu>

        <IconButton
          id="btn-header-theme"
          label={theme === "dark" ? t("lightMode") : t("darkMode")}
          icon={
            theme === "dark" ? (
              <Sun size={18} className="text-brand-cyan" />
            ) : (
              <Moon size={18} className="text-brand-cyan" />
            )
          }
          onClick={handleThemeToggle}
        />
      </div>
    </header>
  );
};
