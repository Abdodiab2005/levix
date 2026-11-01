// Catalog validator, renderer, and Android escaping.
// Run after `node scripts/i18n-seed.tmp.mjs` and `node scripts/i18n.mjs build`.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-i18n-catalog");

const {
  applyGatewayMarkers,
  diffGenerated,
  escapeAndroidString,
  loadCatalog,
  renderAndroidXml,
  renderGatewayDict,
  renderGenerated,
  renderLocalesConfig,
  renderNodeCatalog,
  renderTranslations,
  validate,
} = await import("../scripts/i18n.mjs");

function sample() {
  return {
    locales: [
      { code: "en", name: "English", dir: "ltr", android: "values", required: true },
      { code: "ar", name: "Arabic", dir: "rtl", android: "values-ar", required: true },
      {
        code: "pt-BR",
        name: "Portuguese",
        dir: "ltr",
        android: "values-pt-rBR",
        required: false,
      },
    ],
    bundles: {
      en: {
        dashboard: { hello: "Hello {name}" },
        gateway: { hi: "Hi" },
        android: { app: "App %1$s" },
      },
      ar: {
        dashboard: { hello: "Ahlan {name}" },
        gateway: { hi: "Marhaba" },
        android: { app: "Tatbiq %1$s" },
      },
    },
    notes: {},
    review: {},
    htmlKeys: [],
    rawTexts: {},
  };
}

function problemHas(list, file, key, text) {
  return list.some((item) => {
    return item.file === file && item.key === key && item.message.includes(text);
  });
}

section("validator");

{
  const catalog = sample();
  delete catalog.bundles.ar.dashboard.hello;
  const { errors } = validate(catalog);
  ok("missing key fails", problemHas(errors, "ar/dashboard", "hello", "missing key"));
}

{
  const catalog = sample();
  catalog.bundles.ar.dashboard.extra = "X";
  const { errors } = validate(catalog);
  ok("extra key fails", problemHas(errors, "ar/dashboard", "extra", "extra key"));
}

{
  const catalog = sample();
  catalog.bundles.ar.dashboard.hello = "Ahlan";
  const { errors } = validate(catalog);
  ok(
    "placeholder mismatch fails",
    problemHas(errors, "ar/dashboard", "hello", "placeholders do not match"),
  );
}

{
  const catalog = sample();
  catalog.bundles.ar.android.app = "Tatbiq %2$d";
  const { errors } = validate(catalog);
  ok(
    "android token mismatch fails",
    problemHas(errors, "ar/android", "app", "positional tokens do not match"),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.android.count = { one: "%1$d item", other: "%1$d items" };
  catalog.bundles.ar.android.count = { one: "%1$d" };
  const { errors } = validate(catalog);
  ok("plural without other fails", problemHas(errors, "ar/android", "count", 'missing "other"'));
}

{
  const catalog = sample();
  catalog.bundles.en.android.count = { few: "%1$d", other: "%1$d" };
  catalog.bundles.ar.android.count = { one: "%1$d", other: "%1$d" };
  const { errors } = validate(catalog);
  ok(
    "en rejects few",
    problemHas(errors, "en/android", "count", 'category "few" is not valid for en'),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.android.count = { one: "%1$d", other: "%1$d" };
  catalog.bundles.ar.android.count = { several: "%1$d", other: "%1$d" };
  const { errors } = validate(catalog);
  ok(
    "ar rejects several",
    problemHas(errors, "ar/android", "count", 'category "several" is not valid for ar'),
  );
}

{
  const catalog = sample();
  catalog.rawTexts["en/dashboard.json"] = '{ "a": "1", "a": "2" }\n';
  const { errors } = validate(catalog);
  ok("duplicate json key fails", problemHas(errors, "en/dashboard.json", "a", "duplicate key"));
}

{
  const catalog = sample();
  catalog.bundles.en.dashboard.hello = "Hello <b>{name}</b>";
  catalog.bundles.ar.dashboard.hello = "Ahlan <b>{name}</b>";
  const { errors } = validate(catalog);
  ok(
    "markup in a plain key fails",
    problemHas(errors, "en/dashboard", "hello", "contains markup"),
  );
}

{
  const catalog = sample();
  catalog.htmlKeys = ["trust"];
  catalog.bundles.en.gateway.trust = '<span class="mark">Private</span> workspace';
  catalog.bundles.ar.gateway.trust =
    '<span class="mark" onmouseover="alert(1)">x</span> workspace';
  const { errors } = validate(catalog);
  ok(
    "html key rejects an extra onmouseover",
    problemHas(errors, "ar/gateway", "trust", 'attribute "onmouseover" is not allowed'),
  );
}

{
  const catalog = sample();
  catalog.htmlKeys = ["trust"];
  catalog.bundles.en.gateway.trust = '<span class="mark">Private</span> workspace';
  catalog.bundles.ar.gateway.trust = '<span class="other">خاص</span> workspace';
  const { errors } = validate(catalog);
  ok(
    "html key rejects a changed class",
    problemHas(errors, "ar/gateway", "trust", "attributes are not in the English value"),
  );
}

{
  const catalog = sample();
  catalog.htmlKeys = ["trust"];
  catalog.bundles.en.gateway.trust = '<span class="mark">Private</span> workspace';
  catalog.bundles.ar.gateway.trust = '<span class="mark">خاص</span> مساحة';
  const { errors } = validate(catalog);
  ok(
    "html key allows the same tags with translated text",
    errors.length === 0,
    errors.map((item) => item.message).join("; "),
  );
}

{
  // A missing tag is allowed. Each tag that is present must still be an exact
  // English tag. The translation may drop one.
  const catalog = sample();
  catalog.htmlKeys = ["trust"];
  catalog.bundles.en.gateway.trust = '<span class="mark">Private</span> workspace';
  catalog.bundles.ar.gateway.trust = "مساحة عمل خاصة";
  const { errors } = validate(catalog);
  ok(
    "html key allows a missing tag",
    errors.length === 0,
    errors.map((item) => item.message).join("; "),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.dashboard.bye = "Bye";
  catalog.bundles.ar.dashboard.bye = "Ma salama";
  catalog.bundles["pt-BR"] = { dashboard: { hello: "Ola {name}" } };
  const { errors, warnings } = validate(catalog);
  ok(
    "untranslated key does not fail",
    errors.length === 0,
    errors.map((item) => item.message).join("; "),
  );
  ok(
    "untranslated key is reported",
    problemHas(warnings, "pt-BR/dashboard", "bye", "untranslated"),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.bot = {
    help: { count: { one: "{name} item", other: "{name} items" } },
  };
  catalog.bundles.ar.bot = {
    help: {
      count: {
        zero: "{name} items",
        one: "{name} item",
        two: "{name} items",
        few: "{name} items",
        many: "{name} items",
        other: "{name} items",
      },
    },
  };
  const { errors } = validate(catalog);
  ok(
    "bot plural is accepted",
    errors.length === 0,
    errors.map((item) => item.message).join("; "),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.bot = {
    help: { count: { one: "{name} item", other: "{name} items" } },
  };
  catalog.bundles.ar.bot = {
    help: {
      count: {
        zero: "{name} items",
        one: "{name} item",
        two: "two items",
        few: "{name} items",
        many: "{name} items",
        other: "{name} items",
      },
    },
  };
  const { errors } = validate(catalog);
  ok(
    "bot plural placeholder fails",
    problemHas(errors, "ar/bot/help", "count", "placeholders do not match"),
  );
}

{
  const catalog = sample();
  catalog.bundles.en.dashboard.items = { one: "1 item", other: "{n} items" };
  catalog.bundles.ar.dashboard.items = { one: "1", other: "{n}" };
  const { errors } = validate(catalog);
  ok("dashboard plural fails", problemHas(errors, "en/dashboard", "items", "plural"));
}

section("determinism");

{
  const catalog = sample();
  catalog.bundles.en.android.count = { one: "%1$d item", other: "%1$d items" };
  catalog.bundles.ar.android.count = { one: "%1$d", other: "%1$d" };
  const gateway = [
    "// head",
    "// <i18n:generated>",
    "  var DICT = {};",
    "// </i18n:generated>",
    "// tail",
    "",
  ].join("\n");
  const first = renderGenerated(catalog, gateway);
  const second = renderGenerated(catalog, gateway);
  const names = Object.keys(first).sort();
  equal("same paths", names.join("\n"), Object.keys(second).sort().join("\n"));
  for (const name of names) equal(name, first[name], second[name]);
  equal("translations twice", renderTranslations(catalog), renderTranslations(catalog));
  equal("gateway dict twice", renderGatewayDict(catalog), renderGatewayDict(catalog));
  equal("android twice", renderAndroidXml(catalog, "en"), renderAndroidXml(catalog, "en"));
  equal("node catalog twice", renderNodeCatalog(catalog), renderNodeCatalog(catalog));
  // locales_config.xml walks the registry in locales.json order.
  equal("locales config twice", renderLocalesConfig(catalog), renderLocalesConfig(catalog));
  equal(
    "locales config order",
    renderLocalesConfig(catalog),
    [
      '<?xml version="1.0" encoding="utf-8"?>',
      "<!-- Generated by scripts/i18n.mjs from i18n/. Do not edit. -->",
      '<locale-config xmlns:android="http://schemas.android.com/apk/res/android">',
      '    <locale android:name="en"/>',
      '    <locale android:name="ar"/>',
      '    <locale android:name="pt-BR"/>',
      "</locale-config>",
      "",
    ].join("\n"),
  );
  const marked = applyGatewayMarkers(gateway, renderGatewayDict(catalog));
  equal("markers twice", marked, applyGatewayMarkers(gateway, renderGatewayDict(catalog)));
}

section("translations shape");

{
  const catalog = sample();
  catalog.locales.push({
    code: "es-419",
    name: "Español (Latinoamérica)",
    dir: "ltr",
    android: "values-b+es+419",
    required: false,
  });
  const text = renderTranslations(catalog);
  ok(
    "Language is every registry code",
    text.includes('export type Language = "en" | "ar" | "pt-BR" | "es-419";'),
  );
  ok("MessageKey is the English object", text.includes("export type MessageKey = keyof typeof en;"));
  ok("en is a complete record", text.includes("en: Record<MessageKey, string>;"));
  ok("ar is partial", text.includes("ar: Partial<Record<MessageKey, string>>;"));
  ok(
    "pt-BR is partial",
    text.includes('"pt-BR": Partial<Record<MessageKey, string>>;'),
  );
  ok(
    "es-419 is partial",
    text.includes('"es-419": Partial<Record<MessageKey, string>>;'),
  );
  const enDecl = text.indexOf("const en = ");
  const translationsDecl = text.indexOf("export const translations:");
  ok("the English object is bound before translations", enDecl >= 0 && enDecl < translationsDecl);
  const body = text.slice(translationsDecl);
  const arValue = body.indexOf("\n  ar: {");
  const enValue = body.indexOf("\n  en,\n");
  ok("ar content stays before the en binding", arValue >= 0 && arValue < enValue);
  ok("ar text is kept", body.includes('hello: "Ahlan {name}"'));
  ok("en text is kept", text.includes('hello: "Hello {name}"'));
  ok("a locale without dashboard.json is empty", body.includes('\n  "pt-BR": {},'));
  ok("es-419 without dashboard.json is empty", body.includes('\n  "es-419": {},'));
  const locales = [
    '  { code: "en", name: "English", dir: "ltr" },',
    '  { code: "ar", name: "Arabic", dir: "rtl" },',
    '  { code: "pt-BR", name: "Portuguese", dir: "ltr" },',
    '  { code: "es-419", name: "Español (Latinoamérica)", dir: "ltr" },',
  ].join("\n");
  ok("LOCALES follow the registry", text.includes(locales));
}

section("android escaping");

equal("apostrophe", escapeAndroidString("it's"), "it\\'s");
equal("quote", escapeAndroidString('say "hi"'), 'say \\"hi\\"');
equal("leading at", escapeAndroidString("@home"), "\\@home");
equal("newline", escapeAndroidString("a\nb"), "a\\nb");
equal("ampersand", escapeAndroidString("A & B"), "A &amp; B");
equal("less than", escapeAndroidString("A < B"), "A &lt; B");
equal("literal percent", escapeAndroidString("100% of %1$s"), "100%% of %1$s");
equal("leading space", escapeAndroidString(" x"), '" x"');
equal("leading question", escapeAndroidString("?help"), "\\?help");
equal("greater than", escapeAndroidString("A > B"), "A &gt; B");

section("real catalog");

{
  const loaded = loadCatalog(ROOT);
  ok(
    "catalog loads",
    loaded.errors.length === 0,
    loaded.errors.map((item) => item.message).join("\n"),
  );
  const result = validate(loaded.catalog);
  ok(
    "catalog is valid",
    result.errors.length === 0,
    result.errors.map((item) => item.message).join("\n"),
  );
  ok(
    "no untranslated warnings",
    result.warnings.length === 0,
    result.warnings.map((item) => item.message).join("\n"),
  );
  const html = [
    "loginTrust",
    "setupTrust",
    "qrTrust",
    "qrStep1",
    "qrStep2",
    "qrStep3",
    "qrCallout",
  ];
  ok(
    "html keys",
    html.every((key) => loaded.catalog.htmlKeys.includes(key)),
    (loaded.catalog.htmlKeys || []).join(", "),
  );
  const drift = diffGenerated(loaded.catalog, (rel) => {
    try {
      return readFileSync(join(ROOT, rel), "utf8");
    } catch {
      return null;
    }
  });
  ok(
    "generated files match",
    drift.length === 0,
    drift.map((item) => item.message).join("\n"),
  );
}

finish();
