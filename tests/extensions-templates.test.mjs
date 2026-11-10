import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-extensions-templates");

const catalog = require("./src/i18n/catalog.generated.cjs");
const { createTranslator, setTemplateOverride, t, withLang } = require("./src/utils/i18n.cjs");
const {
  isCustomizable,
  customizableKeys,
  placeholders,
} = require("./src/extensions/templateKeys.cjs");

const KEY = "bot.help.title";
const LOCALES = ["ar", "en", "pt-BR", "es-419"];

function catalogText(key, locale, params) {
  const translator = createTranslator(catalog, { getLocale: () => locale });
  return translator(key, params);
}

section("override applied for an allowed key in all 4 locales");
ok("title is customizable", isCustomizable(KEY));
ok("title has {name}", placeholders(KEY).includes("name"));
setTemplateOverride((key, locale) => {
  if (key !== KEY) return null;
  return `PLUS-${locale}-{name}`;
});
for (const locale of LOCALES) {
  equal(
    locale,
    withLang(locale, () => t(KEY, { name: "Levix" })),
    `PLUS-${locale}-Levix`,
  );
}
setTemplateOverride(null);

section("unknown placeholder rejected");
{
  const original = catalogText(KEY, "en", { name: "Levix" });
  setTemplateOverride(() => "Hello {nope}");
  equal(
    "catalog kept",
    withLang("en", () => t(KEY, { name: "Levix" })),
    original,
  );
  setTemplateOverride(null);
}

section(">1000 chars rejected");
{
  const original = catalogText(KEY, "en", { name: "Levix" });
  setTemplateOverride(() => "a".repeat(1001));
  equal(
    "catalog kept",
    withLang("en", () => t(KEY, { name: "Levix" })),
    original,
  );
  setTemplateOverride(null);
}

section("bidi and control rejected");
{
  const original = catalogText(KEY, "en", { name: "Levix" });
  setTemplateOverride(() => "ok\u202e");
  equal(
    "bidi rejected",
    withLang("en", () => t(KEY, { name: "Levix" })),
    original,
  );
  setTemplateOverride(() => "ok\u0001");
  equal(
    "control rejected",
    withLang("en", () => t(KEY, { name: "Levix" })),
    original,
  );
  setTemplateOverride(null);
}

section("denied keys never overridden");
{
  const denied = [
    "bot.moderation.warns.hasNoWarnings",
    "bot.core.message.watermark",
    "bot.help.permission",
    "bot.help.permissions.OWNER_ONLY",
    "bot.group.kick.noTarget",
    "bot.ai.gemini.ownerOnly",
  ];
  setTemplateOverride(() => "HACKED");
  for (const key of denied) {
    ok(`${key} is not customizable`, !isCustomizable(key));
    const locale = "en";
    const expected = catalogText(key, locale, {
      member: "x",
      name: "x",
      query: "x",
      prefix: "!",
    });
    equal(
      key,
      withLang(locale, () => t(key, { member: "x", name: "x", query: "x", prefix: "!" })),
      expected,
    );
  }
  setTemplateOverride(null);
}

section("plural keys skipped");
{
  const plural = "bot.schedules.recurrence.hourly";
  ok("plural is not customizable", !isCustomizable(plural));
  const original = catalogText(plural, "en", { count: 2 });
  setTemplateOverride(() => "HACKED");
  equal(
    "plural catalog kept",
    withLang("en", () => t(plural, { count: 2 })),
    original,
  );
  setTemplateOverride(null);
}

section("output byte-identical with no override");
{
  setTemplateOverride(null);
  const keys = [KEY, "bot.ai.gemini.thinking", "bot.core.restart.reconnecting", pluralSafe()];
  for (const key of keys) {
    for (const locale of LOCALES) {
      const a = catalogText(key, locale, { name: "Levix", count: 1 });
      const b = withLang(locale, () => t(key, { name: "Levix", count: 1 }));
      equal(`${key} ${locale}`, b, a);
    }
  }
}

section("customizableKeys matches allow/deny");
{
  const keys = customizableKeys();
  ok("has help.title", keys.includes(KEY));
  ok("has gemini thinking", keys.includes("bot.ai.gemini.thinking"));
  ok("has restart", keys.includes("bot.core.restart.reconnecting"));
  ok(
    "no moderation",
    keys.every((key) => !key.startsWith("bot.moderation.")),
  );
  ok(
    "no core.message",
    keys.every((key) => !key.startsWith("bot.core.message.")),
  );
  ok(
    "no permission keys",
    keys.every((key) => !/permission/i.test(key)),
  );
}

function pluralSafe() {
  return "bot.ai.gemini.thinking";
}

finish();
