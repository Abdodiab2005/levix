import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const main = read("frontend/src/gateway/main.tsx");
const login = read("frontend/src/gateway/login.tsx");
const qr = read("frontend/src/gateway/qr.tsx");
const shell = read("frontend/gateway.html");
const dictionary = read("frontend/src/i18n/gateway.generated.ts");
const locale = read("frontend/src/i18n/locale.ts");
const boot = read("public/ui-boot.js");

section("React gateway and translations");
ok("ui-boot runs first in the head", /<head>\s*<script src="\/ui-boot\.js"><\/script>/.test(shell));
ok("gateway shell mounts React", shell.includes('id="root"') && shell.includes("/src/gateway/main.tsx"));
ok("brand name comes from server state", main.includes("state.brand.name"));
ok("brand tagline is translated", main.includes('t("tagline")'));
ok(
  "login, setup and QR have translated document titles",
  ["titleLogin", "titleSetup", "titleQr"].every((key) => main.includes(`"${key}"`)),
);
ok("gateway text uses resolved locale", main.includes("resolveLocale(document.documentElement.lang)"));
ok(
  "gateway responds to host and storage language changes",
  main.includes("levix-ui-prefs") && main.includes("storage"),
);
ok("Arabic alone is RTL", locale.includes('lang === "ar" ? "rtl" : "ltr"'));
ok(
  "password control is shared across login and setup",
  main.includes("PasswordInput") && login.includes("<PasswordField"),
);
ok(
  "password field keeps LTR direction for its eye button",
  read("frontend/src/components/ui/password-input.tsx").includes('dir = "ltr"'),
);
ok(
  "React renders translated reset text",
  login.includes('error.key === "resetErrWrongCode"') && login.includes('t("resetErrAttemptsLeft"'),
);
ok("QR has a translated back control", qr.includes('t("backToDashboard")'));

for (const language of ["en", "ar", "pt-BR", "es-419"]) {
  const label = language.includes("-") ? JSON.stringify(language) : language;
  const start = dictionary.indexOf(`  ${label}: {`);
  const end = dictionary.indexOf("\n  },", start);
  const entries = dictionary.slice(start, end);
  ok(`${language} dictionary exists`, start >= 0 && end > start);
  for (const code of [
    "tooManyAttempts", "incorrectPassword", "wrongSetupCode", "passwordMismatch", "invalidPassword",
  ]) {
    ok(`${language} has ${code}`, entries.includes(`    ${code}:`));
  }
  ok(
    `${language} has title translations`,
    ["titleLogin", "titleSetup", "titleQr"].every((key) => entries.includes(`    ${key}:`)),
  );
}
ok("unknown locale falls back to English", locale.includes('normalizeLocale(value) ?? "en"'));
ok("boot maps all four locales", ["ar", "en", "pt-BR", "es-419"].every((code) => boot.includes(code)));
ok("login sends the selected page language on reset", login.includes("lang: document.documentElement.lang"));
ok("server errors use translated codes", login.includes("state.error.code in gatewayTranslations.en"));

section("gateway routes");
const app = read("app.cjs");
ok("login passes an error code beside English text", app.includes('errorCode: "incorrectPassword"'));
ok("setup errors travel as codes", app.includes('code: "wrongSetupCode"') && app.includes('code: "passwordMismatch"'));
finish();
