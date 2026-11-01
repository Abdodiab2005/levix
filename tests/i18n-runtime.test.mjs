import { equal, finish, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-i18n-runtime");

const { createTranslator, normalizeLocale } = require("./src/utils/i18n.cjs");

section("locale normalization");
for (const [input, expected] of [
  ["ar", "ar"],
  ["AR-EG", "ar"],
  ["en", "en"],
  ["EN_us", "en"],
  ["pt", "pt-BR"],
  ["pt-PT", "pt-BR"],
  ["pt_br", "pt-BR"],
  ["es", "es-419"],
  ["ES-419", "es-419"],
  ["xx", null],
  [null, null],
]) equal(String(input), normalizeLocale(input), expected);

section("lookup, fallback and one warning per missing key");
let locale = "ar";
const warnings = [];
const t = createTranslator(
  {
    messages: {
      en: {
        greeting: "Hello, {name}. {missing}",
        echo: "{value} {other}",
        items: { one: "{count} item", other: "{count} items" },
      },
      ar: {
        greeting: "مرحباً، {name}. {missing}",
        items: {
          zero: "صفر",
          one: "واحد",
          two: "اثنان",
          few: "قليل",
          many: "كثير",
          other: "آخر",
        },
      },
    },
  },
  { getLocale: () => locale, warn: (key) => warnings.push(key) },
);
equal("exact Arabic hit", t("greeting", { name: "ليلى" }), "مرحباً، ليلى. {missing}");
locale = "pt-BR";
equal("English fallback for pt-BR", t("greeting", { name: "Ana" }), "Hello, Ana. {missing}");
equal("unknown key returns its key", t("unknown"), "unknown");
equal("unknown key still returns its key", t("unknown"), "unknown");
equal("warned once", warnings.join(","), "unknown");
equal("replacement is not expanded again", t("echo", { value: "{other}", other: "expanded" }), "{other} expanded");

section("CLDR plural selection");
locale = "en";
equal("English one", t("items", { count: 1 }), "1 item");
equal("English other", t("items", { count: 2 }), "2 items");
locale = "ar";
for (const [count, expected] of [
  [0, "صفر"],
  [1, "واحد"],
  [2, "اثنان"],
  [3, "قليل"],
  [11, "كثير"],
  [100, "آخر"],
]) equal(`Arabic ${count}`, t("items", { count }), expected);

finish();
