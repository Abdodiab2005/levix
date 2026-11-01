// file: frontend/src/context/I18nContext.tsx
import type React from "react";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { dirOf, normalizeLocale, resolveLocale } from "../i18n/locale";
import { type Language, type MessageKey, translations } from "../i18n/translations";

export interface I18nContextType {
  language: Language;
  theme: "light" | "dark";
  direction: "rtl" | "ltr";
  setLanguage: (lang: Language) => void;
  setTheme: (theme: "light" | "dark") => void;
  t: (key: MessageKey, fallback?: string) => string;
}

export const I18nContext = createContext<I18nContextType | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() =>
    resolveLocale(document.documentElement.lang),
  );
  const [theme, setThemeState] = useState<"light" | "dark">(() =>
    document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark",
  );

  const direction = dirOf(language);

  useEffect(() => {
    const onHostPrefs = (event: Event) => {
      const next = (event as CustomEvent<{ language?: string; theme?: "light" | "dark" }>).detail;
      const lang = normalizeLocale(next?.language);
      if (lang) setLanguageState(lang);
      if (next?.theme === "light" || next?.theme === "dark") setThemeState(next.theme);
    };
    window.addEventListener("levix-ui-prefs", onHostPrefs);
    return () => window.removeEventListener("levix-ui-prefs", onHostPrefs);
  }, []);

  const notifyHost = (
    nextLanguage: Language,
    nextTheme: "light" | "dark",
    field: "language" | "theme",
  ) => {
    const host = (
      window as Window & {
        LevixHost?: { setUiPrefs?: (language: string, theme: string, field: string) => void };
      }
    ).LevixHost;
    host?.setUiPrefs?.(nextLanguage, nextTheme, field);
  };

  const setLanguage = (lang: Language) => {
    if (lang === language) return;
    setLanguageState(lang);
    document.documentElement.lang = lang;
    document.documentElement.dir = dirOf(lang);
    localStorage.setItem("levix_lang", lang);
    notifyHost(lang, theme, "language");
  };

  const setTheme = (next: "light" | "dark") => {
    if (next === theme) return;
    setThemeState(next);
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("levix_theme", next);
    notifyHost(language, next, "theme");
  };

  const t = useMemo(() => {
    return (key: MessageKey, fallback?: string): string => {
      return translations[language]?.[key] ?? translations.en[key] ?? fallback ?? key;
    };
  }, [language]);

  return (
    <I18nContext.Provider value={{ language, theme, direction, setLanguage, setTheme, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
};
