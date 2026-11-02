// Recovery UI now lives in React. Check the state gates and request handling
// against the shipped source and generated translations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

const read = (path) => readFileSync(join(ROOT, path), "utf8");
const login = read("frontend/src/gateway/login.tsx");
const dictionary = read("frontend/src/i18n/gateway.generated.ts");

section("only a verified address is a login recovery option");
ok(
  "email channel requires verified address and mask",
  login.includes("state.recoveryEmailVerified && state.recoveryEmail &&"),
);
ok(
  "email subtitle requires verified address and mask",
  login.includes("state.recoveryEmailVerified && state.recoveryEmail") && login.includes('"resetSubtitleChannels"'),
);
ok("email mask comes from server state", login.includes("{state.recoveryEmail}"));
ok("WhatsApp channel is always offered", login.includes('onClick={() => send("whatsapp")}'));

section("recovery requests and states");
ok("requests have a same-origin credential mode", login.includes('credentials: "same-origin"'));
ok("channel request sends selected language", login.includes("lang: document.documentElement.lang"));
ok("duplicate channel and confirm requests are blocked", (login.match(/if \(busy\) return;/g) || []).length === 2);
ok("channel choices are disabled while busy", login.includes('disabled={busy}') && login.includes('send("email")'));
ok(
  "code form opens after a successful send",
  login.includes("if (result.ok) setSent(true)") && login.includes("{sent && !done && ("),
);
ok("another method is reachable", login.includes('t("resetChooseChannel")') && login.includes("setSent(false)"));
ok(
  "confirmation submits code and passwords",
  login.includes('postJson("/reset/confirm", { code, password, confirm })'),
);
ok("confirmation button is disabled while busy", /type="submit" className="w-full" disabled=\{busy\}/.test(login));
ok(
  "wrong code keeps the typed code",
  login.includes('result.reason === "wrong_code"') &&
    !login.includes('setCode("");\n        showError("resetErrWrongCode"'),
);
ok("wrong code shows attempts left", login.includes('t("resetErrAttemptsLeft", error.vars)'));
ok(
  "expired or changed code returns to channel choice",
  login.includes('"address_changed"') &&
    login.includes('showError("resetErrExpired")') && login.includes("setSent(false)"),
);
ok("failed requests release busy state", (login.match(/finally \{\s*setBusy\(false\);/g) || []).length === 2);
ok("offline requests show server error", (login.match(/showError\("resetErrServer"\)/g) || []).length === 2);
ok(
  "rate limit uses Retry-After and a translated countdown",
  login.includes('response.headers.get("Retry-After")') && login.includes('showError("resetErrThrottled"'),
);
for (const reason of ["unverified", "unavailable", "no_email", "rate_limited"]) {
  ok(`${reason} maps to an error`, login.includes(`${reason}:`) || login.includes(`result.reason === "${reason}"`));
}

section("localized recovery copy");
for (const language of ["en", "ar"]) {
  const start = dictionary.indexOf(`  ${language}: {`);
  const end = dictionary.indexOf("\n  },", start);
  const entries = dictionary.slice(start, end);
  ok(`${language} dictionary is present`, start >= 0 && end > start);
  for (const key of [
    "resetSubtitleChannels", "resetChooseChannel", "resetErrUnverified", "resetErrUnavailable",
    "resetErrNoEmail", "resetErrRateLimited", "resetErrThrottled", "resetErrWrongCode",
    "resetErrAttemptsLeft", "resetErrExpired", "resetErrServer",
  ]) {
    ok(`${language} has ${key}`, entries.includes(`    ${key}:`));
  }
  if (language === "ar") ok("Arabic recovery text is localized", /[\u0600-\u06ff]/.test(entries));
}
finish();
