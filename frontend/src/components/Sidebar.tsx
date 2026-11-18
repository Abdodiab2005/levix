// file: frontend/src/components/Sidebar.tsx

import {
  ArrowLeft,
  Bot,
  Calendar,
  FileText,
  LayoutGrid,
  LogOut,
  MessageSquareX,
  Radio,
  Settings,
  Shield,
  SmilePlus,
  Sticker,
  Terminal,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import type React from "react";
import { useI18n } from "../context/I18nContext";
import { usePlusStatus } from "../hooks/usePlusStatus";
import { cn } from "../utils/cn";
import { officialLinks, openOfficialLink } from "../utils/officialLinks";
import { accessFromStatus } from "../utils/plusAccess";
import { Button, CrownIcon, IconButton, PlusBadge } from "./ui";

export type ViewTab =
  | "overview"
  | "connection"
  | "commands"
  | "ai"
  | "groups"
  | "autodelete"
  | "reactions"
  | "schedules"
  | "plus"
  | "settings"
  | "logs"
  | "stickers";

// One entry: a link, a group heading, or the Levix Plus group.
interface NavItem {
  id?: ViewTab;
  label?: string;
  icon?: LucideIcon;
  labelCategory?: string;
  plusItem?: boolean;
}

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
  const { available: plusAvailable, status: plusStatus } = usePlusStatus();
  const plusActive = accessFromStatus(plusStatus, plusAvailable) === "active";

  const isInApp = typeof (window as any).LevixHost?.closePanel === "function";

  const brand = (window as any).__BRAND__ || {
    name: "Levix",
    tagline: "Private control room",
    version: "",
    developer: "Abdelrhman Diab",
    studio: "Leviro",
    developerSite: "https://github.com/Abdodiab2005",
    studioSite: "https://leviro.net",
  };

  const navItems: NavItem[] = [
    { id: "overview", label: t("overview"), icon: LayoutGrid },
    { id: "connection", label: t("connection"), icon: Radio },
    { labelCategory: t("control") },
    { id: "commands", label: t("commands"), icon: Terminal },
    { id: "ai", label: t("ai"), icon: Bot },
    { id: "groups", label: t("groups"), icon: Users },
    { id: "autodelete", label: t("autoDelete"), icon: MessageSquareX },
    { id: "reactions", label: t("reaction"), icon: SmilePlus },
    { id: "schedules", label: t("schedules"), icon: Calendar },
    { id: "stickers", label: t("stickers"), icon: Sticker },
    ...(plusAvailable === true ? [{ plusItem: true }] : []),
    { labelCategory: t("settings") },
    { id: "settings", label: t("settings"), icon: Settings },
    { id: "logs", label: t("logs"), icon: FileText },
  ];

  return (
    <>
      {isOpenMobile && (
        <button
          type="button"
          className="fixed inset-0 z-40 cursor-default border-0 bg-black/60 p-0 backdrop-blur-sm md:hidden"
          onClick={onCloseMobile}
          aria-label={t("closeNavigation")}
        />
      )}
      <aside
        className={cn(
          "fixed start-0 top-0 bottom-0 z-50 flex w-72 flex-col border-e border-line bg-panel transition-transform duration-200 ease-out md:static md:z-auto md:w-64",
          isOpenMobile ? "translate-x-0" : "max-md:-translate-x-full rtl:max-md:translate-x-full",
        )}
        aria-label="Main Navigation"
      >
        <div className="flex items-center justify-between border-b border-line p-4">
          <div className="flex min-w-0 items-center gap-3">
            <div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-panel-raised shadow-md">
              <img src="/brand/mark.svg" alt={brand.name} className="size-6" />
              {plusActive && (
                <span
                  role="img"
                  aria-label={t("navPlusActiveLabel")}
                  title={t("navPlusActiveLabel")}
                  className="absolute -top-1.5 -end-1.5 flex size-5 items-center justify-center rounded-full border border-line bg-panel text-brand-purple shadow-sm"
                >
                  <CrownIcon size={12} />
                </span>
              )}
            </div>
            <div className="min-w-0">
              <div className="truncate text-base font-extrabold leading-tight tracking-tight text-text-main">
                {brand.name}
              </div>
              <div className="mt-0.5 truncate text-xs leading-none text-muted">{brand.tagline}</div>
            </div>
          </div>
          <IconButton
            className="md:hidden"
            label={t("closeNavigation")}
            icon={<X size={18} />}
            onClick={onCloseMobile}
          />
        </div>

        <nav className="flex-1 space-y-1 overflow-y-auto p-3" data-tour="sidebar-nav">
          {navItems.map((item) => {
            if (item.plusItem) {
              const isPlusView = currentView === "plus";
              return (
                <div key="plus-group" className="mt-2 border-t border-line pt-2">
                  <Button
                    variant={isPlusView ? "primary" : "ghost"}
                    className="w-full justify-start"
                    icon={<CrownIcon size={20} />}
                    aria-current={isPlusView ? "page" : undefined}
                    onClick={() => {
                      onSelectView("plus");
                      onCloseMobile();
                    }}
                  >
                    <span className="truncate">{t("plusTitle")}</span>
                    {plusActive && (
                      <PlusBadge className="ms-auto shrink-0">{t("plusStateActive")}</PlusBadge>
                    )}
                  </Button>
                </div>
              );
            }
            if (item.labelCategory) {
              return (
                <div
                  key={`cat-${item.labelCategory}`}
                  className="px-3 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-faint"
                >
                  {item.labelCategory}
                </div>
              );
            }
            const id = item.id;
            if (!item.icon || !id) return null;
            const Icon = item.icon;
            const isActive = currentView === id;
            return (
              <Button
                key={id}
                variant={isActive ? "primary" : "ghost"}
                className="w-full justify-start"
                icon={<Icon size={20} />}
                onClick={() => {
                  onSelectView(id);
                  onCloseMobile();
                }}
              >
                <span className="truncate">{item.label}</span>
              </Button>
            );
          })}
        </nav>

        <div className="flex flex-col gap-1 border-t border-line p-3">
          {isInApp && (
            <Button
              variant="ghost"
              className="w-full justify-start"
              icon={<ArrowLeft size={20} className="rtl:-scale-x-100" />}
              onClick={() => (window as any).LevixHost.closePanel()}
            >
              <span className="truncate">{t("backToApp")}</span>
            </Button>
          )}
          <form action="/logout" method="POST" className="m-0">
            <Button
              type="submit"
              variant="ghost"
              className="w-full justify-start text-danger hover:bg-danger/10 hover:text-danger"
              icon={<LogOut size={20} className="rtl:-scale-x-100" />}
            >
              <span className="truncate">{t("logout")}</span>
            </Button>
          </form>
        </div>

        <div className="flex flex-col gap-2.5 border-t border-line p-4 text-xs text-faint">
          <div className="flex items-center justify-between text-[11px] text-muted">
            <span className="font-mono">{brand.version ? `v${brand.version}` : ""}</span>
            <span className="flex items-center gap-1.5">
              <Shield size={14} className="text-brand-cyan" /> Local-first
            </span>
          </div>
          <div className="truncate text-[11px] text-muted">
            &copy; {brand.copyrightYear || 2026}{" "}
            <a
              href={officialLinks.portfolio}
              onClick={(event) => {
                event.preventDefault();
                openOfficialLink(officialLinks.portfolio);
              }}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-cyan hover:underline"
            >
              {brand.developer}
            </a>{" "}
            (
            <a
              href={officialLinks.studio}
              onClick={(event) => {
                event.preventDefault();
                openOfficialLink(officialLinks.studio);
              }}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-cyan hover:underline"
            >
              {brand.studio}
            </a>
            )
          </div>
        </div>
      </aside>
    </>
  );
};
