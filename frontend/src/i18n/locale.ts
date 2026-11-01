// Panel locale helpers. ui-boot.js and gateway-i18n.js repeat normalizeLocale
// inline because they run before modules load. Keep the subtag rule the same:
// ar, pt -> pt-BR, es -> es-419, en. Anything else is null.

import type { Language } from "./translations";

const SUBTAG_TO_LANGUAGE: Record<string, Language> = {
  ar: "ar",
  pt: "pt-BR",
  es: "es-419",
  en: "en",
};

/** Map a stored or browser tag onto a registry locale, or null when it is unknown. */
export function normalizeLocale(value: unknown): Language | null {
  if (typeof value !== "string") return null;
  const subtag = value.trim().split(/[_-]/)[0]?.toLowerCase() ?? "";
  if (!subtag) return null;
  return SUBTAG_TO_LANGUAGE[subtag] ?? null;
}

/** normalizeLocale, or English when the value is missing or unknown. */
export function resolveLocale(value: unknown): Language {
  return normalizeLocale(value) ?? "en";
}

/** Arabic is the only right-to-left registry locale. */
export function dirOf(lang: Language): "rtl" | "ltr" {
  return lang === "ar" ? "rtl" : "ltr";
}

const INTL_TAGS_WITH_OVERRIDES = new Set<Language>(["ar", "en"]);

/**
 * Intl tag for a panel language. Pass the tags a call site already uses for
 * ar and en so those two formats stay the same. Other locales use their code.
 */
export function intlLocale(
  lang: Language,
  overrides?: Partial<Record<Language, string>>,
): string {
  if (overrides && INTL_TAGS_WITH_OVERRIDES.has(lang)) {
    const tag = overrides[lang];
    if (tag) return tag;
  }
  return lang;
}

/** The panel language, then English, then Arabic, then an empty string. */
export function pickLocalized(
  map: Partial<Record<Language, string>> | null | undefined,
  language: Language,
): string {
  if (!map) return "";
  return map[language] ?? map.en ?? map.ar ?? "";
}
