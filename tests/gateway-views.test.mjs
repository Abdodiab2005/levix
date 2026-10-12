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

finish();
