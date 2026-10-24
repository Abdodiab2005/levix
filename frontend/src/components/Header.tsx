// file: frontend/src/components/Header.tsx

import { CircleHelp, Globe, Menu as MenuIcon, Moon, Sun } from "lucide-react";
import type { FC } from "react";
import { useI18n } from "../context/I18nContext";
import type { SessionStatus } from "../types";
import { useGuidedTour } from "./GuidedTour";
import type { ViewTab } from "./Sidebar";
import { IconButton, Menu, MenuItem, MenuLabel } from "./ui";

interface HeaderProps {
  onToggleMobileMenu: () => void;
  title: string;
  /** The active screen, for the "guide for this screen" action. */
  view: ViewTab;
  status: SessionStatus | null;
}

export const Header: FC<HeaderProps> = ({ onToggleMobileMenu, title, view, status: _status }) => {
  const { language, setLanguage, theme, setTheme, t } = useI18n();
  const guided = useGuidedTour();

  const handleThemeToggle = () => {
    setTheme(theme === "dark" ? "light" : "dark");
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
        {guided?.hasScreenSteps(view) && (
          <IconButton
            id="btn-header-guide"
            label={t("tourScreenHelp")}
            icon={<CircleHelp size={18} className="text-brand-cyan" />}
            onClick={() => guided.startScreenTour(view)}
          />
        )}
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
