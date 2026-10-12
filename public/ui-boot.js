// Decides lang, dir and data-theme before first paint, for the panel and
// every gateway page. Order: the Android host's preference, then what this
// browser saved, then the OS. A page whose text exists in one language only
// pins it with data-page-lang on the script tag; the theme still follows.
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
  var language = prefs && (prefs.language === "ar" || prefs.language === "en")
    ? prefs.language : (savedLang === "ar" || savedLang === "en" ? savedLang
    : /^ar\b/i.test((navigator.languages && navigator.languages[0]) || navigator.language || "") ? "ar" : "en");
  var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  var theme = prefs && (prefs.theme === "dark" || prefs.theme === "light")
    ? prefs.theme : (savedTheme === "dark" || savedTheme === "light" ? savedTheme
    : dark && dark.matches ? "dark" : "light");
  function apply(next) {
    var lang = pageLang || next.language;
    if (lang === "ar" || lang === "en") {
      root.lang = lang;
      root.dir = lang === "ar" ? "rtl" : "ltr";
    }
    if (next.theme === "dark" || next.theme === "light") root.setAttribute("data-theme", next.theme);
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
    apply(next);
    if (host) {
      try {
        if (next.language === "ar" || next.language === "en") localStorage.setItem("levix_lang", next.language);
        if (next.theme === "dark" || next.theme === "light") localStorage.setItem("levix_theme", next.theme);
      } catch (_) {}
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
