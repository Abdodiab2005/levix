import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

function read(...parts) {
  return readFileSync(join(ROOT, ...parts), "utf8");
}

section("dashboard.css fixes");

const css = read("public/dashboard.css");
ok("the hidden rule exists for .gateway-back-btn", css.includes(".gateway-back-btn[hidden] {"));
ok(
  "directional icons flip under RTL",
  css.includes('html[dir="rtl"] .gateway-back-btn svg') &&
    css.includes('html[dir="rtl"] .qr-back svg') &&
    css.includes('html[dir="rtl"] .auth-submit svg'),
);
ok("the password field keeps a LTR box for its eye button", css.includes("direction: ltr;"));

section("gateway i18n");

const i18n = read("public/gateway-i18n.js");
ok("the dictionary carries both languages", i18n.includes("  en: {") && i18n.includes("  ar: {"));
ok(
  "the dictionary exposes the applier",
  i18n.includes("window.LevixGatewayI18n = { lang: lang, t: t, apply: apply }"),
);
for (const code of [
  "tooManyAttempts",
  "incorrectPassword",
  "wrongSetupCode",
  "passwordMismatch",
  "invalidPassword",
]) {
  ok(`error code ${code} has Arabic text`, i18n.includes(`${code}:`));
}

section("gateway templates");

const views = {
  "login.ejs": read("views", "login.ejs"),
  "setup.ejs": read("views", "setup.ejs"),
  "qr.ejs": read("views", "qr.ejs"),
};
for (const [name, html] of Object.entries(views)) {
  ok(`${name} loads the i18n script`, html.includes('src="/gateway-i18n.js"'));
  ok(`${name} marks translated nodes`, html.includes("data-i18n"));
  ok(`${name} carries the brand placeholder`, html.includes("data-brand="));
  ok(`${name} no longer forces a page language`, !html.includes("data-page-lang"));
  ok(`${name} translates its document title`, html.includes("<title data-i18n="));
}

section("gateway routes");

const app = read("app.cjs");
ok(
  "login passes an error code beside the English text",
  app.includes('errorCode: "incorrectPassword"'),
);
ok(
  "setup errors travel as codes",
  app.includes('code: "wrongSetupCode"') && app.includes('code: "passwordMismatch"'),
);

section("four ui languages");

ok("gateway accepts pt-BR", i18n.includes('"pt-BR"'));
ok("gateway accepts es-419", i18n.includes('"es-419"'));
ok("rtl is arabic only", i18n.includes('lang === "ar" ? "rtl" : "ltr"'));
ok(
  "storage normalizes a saved language",
  i18n.includes("normalizeLocale(event.newValue)"),
);
ok(
  "storage is not a two-code guard",
  !i18n.includes('event.newValue === "ar" || event.newValue === "en"'),
);
ok("an unknown gateway language is ignored", i18n.includes("if (!resolved) return;"));

const login = views["login.ejs"];
ok("login does not force a non-arabic page to en", !login.includes('=== "ar" ? "ar" : "en"'));
ok(
  "login sends the page language",
  /var lang = \(window\.LevixGatewayI18n && window\.LevixGatewayI18n\.lang\) \|\| "en";/.test(login),
);
ok(
  "a non-english reset password uses the catalog",
  login.includes('window.LevixGatewayI18n.lang !== "en"'),
);

const enStart = i18n.indexOf("\n    en: {");
const arStart = i18n.indexOf("\n    ar: {");
ok("the English dictionary is present", enStart >= 0 && arStart > enStart);
const enDict = i18n.slice(enStart, arStart);
for (const code of [
  "tooManyAttempts",
  "incorrectPassword",
  "wrongSetupCode",
  "passwordMismatch",
  "invalidPassword",
]) {
  ok(`en dictionary has ${code}`, new RegExp(`\\n\\s+${code}:`).test(enDict));
}

finish();
