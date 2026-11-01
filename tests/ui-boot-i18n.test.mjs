// Boot the plain ui-boot.js script against a fake document, storage, navigator
// and host. The script runs before modules exist, so the subtag rule is inline.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { equal, finish, ROOT, section } from "./harness.mjs";

const source = readFileSync(join(ROOT, "public/ui-boot.js"), "utf8");

function boot(options = {}) {
  const store = { ...(options.saved || {}) };
  const listeners = {};
  const root = {
    lang: "",
    dir: "",
    setAttribute(name, value) {
      this[name] = value;
    },
  };
  const document = {
    documentElement: root,
    currentScript: options.currentScript || null,
  };
  const localStorage = {
    getItem(key) {
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem(key, value) {
      store[key] = String(value);
    },
  };
  const languages = options.languages || (options.navigatorLanguage ? [options.navigatorLanguage] : []);
  const navigator = {
    language: options.navigatorLanguage || "",
    languages,
  };
  const window = {
    addEventListener(name, fn) {
      listeners[name] = fn;
    },
    dispatchEvent() {},
  };
  if (options.host !== false) {
    window.LevixHost = {
      getUiPrefs() {
        return JSON.stringify(options.prefs || {});
      },
    };
  }
  runInNewContext(source, { document, window, localStorage, navigator });
  return { root, listeners, store };
}

section("host, saved value, then the browser");

{
  const booted = boot({
    prefs: { language: "pt-BR", theme: "light" },
    saved: { levix_lang: "es-419" },
    navigatorLanguage: "fr-FR",
  });
  equal("host pt-BR wins", booted.root.lang, "pt-BR");
  equal("host pt-BR is ltr", booted.root.dir, "ltr");
  equal("host writes the resolved language", booted.store.levix_lang, "pt-BR");
}

{
  const booted = boot({
    host: false,
    saved: { levix_lang: "es-419" },
    navigatorLanguage: "fr-FR",
  });
  equal("saved es-419 is used", booted.root.lang, "es-419");
  equal("saved es-419 is ltr", booted.root.dir, "ltr");
}

section("browser language subtags");

equal("pt-PT is pt-BR", boot({ host: false, navigatorLanguage: "pt-PT" }).root.lang, "pt-BR");
equal("es-MX is es-419", boot({ host: false, navigatorLanguage: "es-MX" }).root.lang, "es-419");
{
  const arabic = boot({ host: false, navigatorLanguage: "ar-EG" });
  equal("ar-EG is ar", arabic.root.lang, "ar");
  equal("ar is rtl", arabic.root.dir, "rtl");
}
{
  const french = boot({ host: false, navigatorLanguage: "fr-FR" });
  equal("fr-FR is en", french.root.lang, "en");
  equal("en is ltr", french.root.dir, "ltr");
}
equal(
  "languages[0] wins over navigator.language",
  boot({ host: false, languages: ["pt-PT"], navigatorLanguage: "fr-FR" }).root.lang,
  "pt-BR",
);

section("unknown values");

{
  const booted = boot({
    host: false,
    saved: { levix_lang: "zz" },
    navigatorLanguage: "pt-PT",
  });
  equal("an unknown saved value is ignored", booted.root.lang, "pt-BR");
  equal("the ignored value stays ltr", booted.root.dir, "ltr");
}

{
  const booted = boot({ host: false, navigatorLanguage: "en" });
  booted.listeners.storage({ key: "levix_lang", newValue: "es-419" });
  equal("storage accepts es-419", booted.root.lang, "es-419");
  equal("storage es-419 is ltr", booted.root.dir, "ltr");
  booted.listeners.storage({ key: "levix_lang", newValue: "zz" });
  equal("unknown storage does not change the language", booted.root.lang, "es-419");
  booted.listeners["levix-ui-prefs"]({ detail: { language: "pt-BR" } });
  equal("prefs accept pt-BR", booted.root.lang, "pt-BR");
  equal("a host-less prefs event does not write storage", booted.store.levix_lang, undefined);
  booted.listeners["levix-ui-prefs"]({ detail: { language: "ar" } });
  equal("prefs ar is rtl", booted.root.dir, "rtl");
  booted.listeners.storage({ key: "levix_theme", newValue: "dark" });
  equal("a theme event keeps the language", booted.root.lang, "ar");
  equal("a theme event keeps rtl", booted.root.dir, "rtl");
}

{
  const booted = boot({
    prefs: { language: "en" },
    navigatorLanguage: "fr-FR",
  });
  booted.listeners["levix-ui-prefs"]({ detail: { language: "es_419" } });
  equal("a host prefs event normalizes es_419", booted.root.lang, "es-419");
  equal("the host listener stores the code", booted.store.levix_lang, "es-419");
}

{
  const booted = boot({
    host: false,
    navigatorLanguage: "en",
    currentScript: {
      getAttribute(name) {
        return name === "data-page-lang" ? "ar-EG" : null;
      },
    },
  });
  equal("a page language overrides the browser", booted.root.lang, "ar");
  equal("a page language sets rtl", booted.root.dir, "rtl");
}

finish();
