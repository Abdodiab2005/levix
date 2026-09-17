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
import { cn } from "../utils/cn";

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
        <button
          type="button"
          className="fixed inset-0 bg-black/60 backdrop-blur-sm z-40 md:hidden border-0 p-0 cursor-default"
          onClick={onCloseMobile}
          aria-label="Close mobile sidebar backdrop"
        />
      )}
      <aside
        className={cn(
          "fixed top-0 bottom-0 start-0 z-50 w-64 md:static md:z-auto bg-panel border-e border-line flex flex-col transition-transform duration-200 ease-out",
          isOpenMobile ? "translate-x-0" : "max-md:-translate-x-full rtl:max-md:translate-x-full",
        )}
        aria-label="Main Navigation"
      >
        <div className="p-4 flex items-center justify-between border-b border-line">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-brand-blue via-brand-blue to-brand-cyan flex items-center justify-center shadow-md shadow-brand-blue/20 shrink-0 text-white">
              <Zap size={20} />
            </div>
            <div className="min-w-0">
              <div className="font-extrabold text-base text-text-main leading-tight tracking-tight truncate">
                {brand.name}
              </div>
              <div className="text-xs text-muted leading-none truncate mt-0.5">{brand.tagline}</div>
            </div>
          </div>

          <button
            type="button"
            onClick={onCloseMobile}
            className="inline-flex md:hidden items-center justify-center w-10 h-10 rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main transition-colors"
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto p-3 space-y-1">
          {navItems.map((item, idx) => {
            if (item.labelCategory) {
              return (
                <div
                  key={`cat-${item.labelCategory}-${idx}`}
                  className="px-3 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wider text-faint"
                >
                  {item.labelCategory}
                </div>
              );
            }
            const Icon = item.icon!;
            const isActive = currentView === item.id;
            return (
              <button
                type="button"
                key={item.id}
                onClick={() => {
                  onSelectView(item.id as ViewTab);
                  onCloseMobile();
                }}
                className={cn(
                  "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-medium text-sm transition-all focus-visible:ring-2 focus-visible:ring-brand-blue/50 text-start min-h-[44px]",
                  isActive
                    ? "bg-brand-blue text-white shadow-md shadow-brand-blue/25 font-bold"
                    : "text-muted hover:bg-panel-hover hover:text-text-main",
                )}
              >
                <Icon size={20} className="shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-line text-xs text-faint flex flex-col gap-3">
          <button
            type="button"
            onClick={() => setLanguage(language === "ar" ? "en" : "ar")}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 min-h-[44px] rounded-xl border border-line bg-panel-raised hover:bg-panel-hover text-text-main font-bold text-xs transition-colors focus-visible:ring-2 focus-visible:ring-brand-blue/50"
            id="btn-sidebar-lang"
          >
            <Globe size={18} className="text-brand-cyan shrink-0" />
            <span>{language === "ar" ? "English" : "العربية"}</span>
          </button>

          <div className="flex items-center justify-between text-[11px] text-muted">
            <span>v{brand.version || "3.4.0"}</span>
            <span className="flex items-center gap-1.5">
              <Shield size={14} className="text-brand-cyan" /> Local-first
            </span>
          </div>
          <div className="text-[11px] text-muted truncate">
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
