// file: frontend/src/components/Header.tsx

import { CircleHelp, Globe, Menu as MenuIcon, Moon, Sun } from "lucide-react";
import { type FC, useState } from "react";
import { useI18n } from "../context/I18nContext";
import { LOCALES } from "../i18n/translations";
import type { SessionStatus } from "../types";
import { useGuidedTour } from "./GuidedTour";
import { AboutPanel } from "./AboutPanel";
import { officialLinks, openOfficialLink } from "../utils/officialLinks";
import type { ViewTab } from "./Sidebar";
import { Dialog, IconButton, Menu, MenuItem, MenuLabel } from "./ui";

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
  const [aboutOpen, setAboutOpen] = useState(false);

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
        <Menu
          label={t("officialHelp")}
          trigger={
            <IconButton
              id="btn-header-guide"
              label={t("officialHelp")}
              icon={<CircleHelp size={18} className="text-brand-cyan" />}
            />
          }
        >
          {guided?.hasScreenSteps(view) && (
            <MenuItem onSelect={() => guided.startScreenTour(view)}>{t("tourScreenHelp")}</MenuItem>
          )}
          <MenuItem onSelect={() => openOfficialLink(officialLinks.docs)}>
            {t("officialDocs")}
          </MenuItem>
          <MenuItem onSelect={() => openOfficialLink(officialLinks.support)}>
            {t("officialSupport")}
          </MenuItem>
          <MenuItem onSelect={() => setAboutOpen(true)}>{t("aboutLevix")}</MenuItem>
        </Menu>
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
          {LOCALES.map((locale) => (
            <MenuItem
              key={locale.code}
              checked={language === locale.code}
              onSelect={() => setLanguage(locale.code)}
            >
              {locale.name}
            </MenuItem>
          ))}
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
      <Dialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} title={t("aboutLevix")}>
        {aboutOpen && <AboutPanel />}
      </Dialog>
    </header>
  );
};
