// file: frontend/src/context/I18nContext.tsx
import React, { createContext, useContext, useState, useEffect, useMemo } from "react";
import { translations, Language } from "../i18n/translations";

interface I18nContextType {
  language: Language;
  direction: "rtl" | "ltr";
  setLanguage: (lang: Language) => void;
  t: (key: keyof typeof translations["en"], fallback?: string) => string;
}

const I18nContext = createContext<I18nContextType | null>(null);

export const I18nProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [language, setLanguageState] = useState<Language>(() => {
    const saved = localStorage.getItem("levix_lang");
    if (saved === "ar" || saved === "en") return saved;
    return navigator.language.startsWith("ar") ? "ar" : "en";
  });

  const direction = language === "ar" ? "rtl" : "ltr";

  useEffect(() => {
    localStorage.setItem("levix_lang", language);
    document.documentElement.lang = language;
    document.documentElement.dir = direction;
  }, [language, direction]);

  const setLanguage = (lang: Language) => {
    setLanguageState(lang);
  };

  const t = useMemo(() => {
    return (key: keyof typeof translations["en"], fallback?: string): string => {
      const dict = translations[language] || translations["en"];
      return (dict as any)[key] ?? (translations["en"] as any)[key] ?? fallback ?? String(key);
    };
  }, [language]);

  return (
    <I18nContext.Provider value={{ language, direction, setLanguage, t }}>
      {children}
    </I18nContext.Provider>
  );
};

export const useI18n = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
};
