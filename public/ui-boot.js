// Decides lang, dir and data-theme before first paint, for the panel and
// every gateway page. Order: the Android host's preference, then what this
// browser saved, then the OS. Every gateway page follows the shared language,
// so none passes data-page-lang; the attribute remains an escape hatch for a
// future page whose text exists in one language only.
(function () {
  var root = document.documentElement;
  var host = window.LevixHost;
  var script = document.currentScript;
  var pageLang = script && script.getAttribute("data-page-lang");
  var savedLang, savedTheme, prefs;
  try {
    savedLang = localStorage.getItem("levix_lang");
    savedTheme = localStorage.getItem("levix_theme");
  } catch (_) {}
  if (host && typeof host.getUiPrefs === "function") {
    try { prefs = JSON.parse(host.getUiPrefs()); } catch (_) {}
  }
  // Same subtag rule as frontend/src/i18n/locale.ts. This file loads first, so
  // it cannot import that module. "_" or "-", any case: ar, pt -> pt-BR,
  // es -> es-419, en. Anything else is unknown.
  function normalizeLocale(value) {
    if (typeof value !== "string") return null;
    var subtag = value.trim().split(/[_-]/)[0].toLowerCase();
    if (subtag === "ar") return "ar";
    if (subtag === "pt") return "pt-BR";
    if (subtag === "es") return "es-419";
    if (subtag === "en") return "en";
    return null;
  }
  var language = normalizeLocale(prefs && prefs.language)
    || normalizeLocale(savedLang)
    || normalizeLocale((navigator.languages && navigator.languages[0]) || navigator.language)
    || "en";
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  var theme = prefs && (prefs.theme === "dark" || prefs.theme === "light")
    ? prefs.theme : (savedTheme === "dark" || savedTheme === "light" ? savedTheme
    : dark && dark.matches ? "dark" : "light");
  function apply(next) {
    var lang = normalizeLocale(pageLang);
    if (!lang && next) lang = normalizeLocale(next.language);
    if (lang && (pageLang || (next && typeof next.language === "string"))) {
      root.lang = lang;
      root.dir = lang === "ar" ? "rtl" : "ltr";
    }
    if (next && (next.theme === "dark" || next.theme === "light")) {
      root.setAttribute("data-theme", next.theme);
    }
  }
  apply({ language: language, theme: theme });
  if (prefs) {
    try {
      localStorage.setItem("levix_lang", language);
      localStorage.setItem("levix_theme", theme);
    } catch (_) {}
  }
  window.addEventListener("levix-ui-prefs", function (event) {
    var next = event.detail || {};
    var lang = normalizeLocale(next.language);
    apply(lang ? { language: lang, theme: next.theme } : next);
    if (host) {
      try {
        if (lang) localStorage.setItem("levix_lang", lang);
        if (next.theme === "dark" || next.theme === "light") localStorage.setItem("levix_theme", next.theme);
      } catch (_) {}
    }
  });
  window.addEventListener("storage", function (event) {
    var next = {};
    if (event.key === "levix_theme" && (event.newValue === "dark" || event.newValue === "light")) {
      next.theme = event.newValue;
    }
    var saved = event.key === "levix_lang" ? normalizeLocale(event.newValue) : null;
    if (saved) next.language = saved;
    if (next.theme || next.language) {
      apply(next);
    }
  });
  if (!host && savedTheme !== "dark" && savedTheme !== "light" && dark) {
    dark.addEventListener("change", function (event) {
      try { if (localStorage.getItem("levix_theme")) return; } catch (_) {}
      var next = { theme: event.matches ? "dark" : "light" };
      apply(next);
      window.dispatchEvent(new CustomEvent("levix-ui-prefs", { detail: next }));
    });
  }
})();
