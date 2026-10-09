// file: frontend/src/components/Sidebar.tsx

import {
  Bot,
  Calendar,
  FileText,
  LayoutGrid,
  Radio,
  Settings,
  Shield,
  Sticker,
  Terminal,
  Users,
  X,
  Zap,
} from "lucide-react";
import type React from "react";
import { useI18n } from "../context/I18nContext";
import { cn } from "../utils/cn";
import { Button, IconButton } from "./ui";

export type ViewTab =
  | "overview"
  | "connection"
  | "commands"
  | "ai"
  | "groups"
  | "schedules"
  | "settings"
  | "logs"
  | "stickers";

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
    version: "",
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
    { id: "stickers", label: t("stickers"), icon: Sticker },
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
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-brand-blue via-brand-blue to-brand-cyan text-white shadow-md shadow-brand-blue/20">
              <Zap size={20} />
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

        <nav className="flex-1 space-y-1 overflow-y-auto p-3">
          {navItems.map((item) => {
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
            if (!item.icon || !item.id) return null;
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <Button
                key={item.id}
                variant={isActive ? "primary" : "ghost"}
                className="w-full justify-start"
                icon={<Icon size={20} />}
                onClick={() => {
                  onSelectView(item.id as ViewTab);
                  onCloseMobile();
                }}
              >
                <span className="truncate">{item.label}</span>
              </Button>
            );
          })}
        </nav>

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
              href={brand.developerSite || "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-cyan hover:underline"
            >
              {brand.developer}
            </a>{" "}
            (
            <a
              href={brand.studioSite || "#"}
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
