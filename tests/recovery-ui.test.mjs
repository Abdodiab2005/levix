// Recovery UI now lives in React. Check the state gates and request handling
// against the shipped source and generated translations.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { parseInlineMarkup } from "../frontend/src/gateway/inline-markup-parse.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

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
  login.includes('postJson("/reset/confirm", values)') &&
    ["code", "password", "confirm"].every((name) => login.includes(`fields.get("${name}")`)),
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
    login.includes('showError(RESET_REASON_KEYS[result.reason || ""])') &&
    login.includes('address_changed: "resetErrExpired"') &&
    login.includes("setSent(false)"),
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

section("React recovery reason mapping");
const reactSource = readFileSync(join(ROOT, "frontend/src/gateway/login.tsx"), "utf8");
const mappingSource = /const RESET_REASON_KEYS: Record<string, GatewayKey> = (\{[\s\S]*?\});/.exec(
  reactSource,
);
ok("React recovery reason map is declared", Boolean(mappingSource));
const reasonKeys = runInNewContext(`(${mappingSource?.[1] || "{}"})`);
const expectedReasons = {
  no_session: "resetErrNoSession",
  send_failed: "resetErrSendFailed",
  no_email: "resetErrNoEmail",
  unverified: "resetErrUnverified",
  rate_limited: "resetErrRateLimited",
  locked: "resetErrLocked",
  invalid: "resetErrInvalid",
  unavailable: "resetErrUnavailable",
  throttled: "resetErrThrottled",
  wrong_code: "resetErrWrongCode",
  address_changed: "resetErrExpired",
  expired: "resetErrExpired",
  no_pending: "resetErrExpired",
  too_many_attempts: "resetErrExpired",
  mismatch: "resetErrMismatch",
  invalid_password: "resetErrInvalidPassword",
};
equal(
  "React maps every reset reason",
  Object.keys(reasonKeys).sort().join(","),
  Object.keys(expectedReasons).sort().join(","),
);
const generated = readFileSync(join(ROOT, "frontend/src/i18n/gateway.generated.ts"), "utf8");
const generatedDictionary = runInNewContext(
  generated.replace("export const gatewayTranslations = ", "(").replace(/ as const;\s*$/, ")"),
);
for (const [reason, key] of Object.entries(expectedReasons)) {
  equal(`React ${reason} maps to ${key}`, reasonKeys[reason], key);
  for (const locale of ["ar", "en", "pt-BR", "es-419"]) {
    ok(
      `React ${reason} has ${locale} copy`,
      typeof generatedDictionary[locale]?.[key] === "string" &&
        generatedDictionary[locale][key].length > 0,
    );
  }
}
ok(
  "React wrong code shows attempts left",
  reactSource.includes("result.attemptsLeft") && reactSource.includes('t("resetErrAttemptsLeft"'),
);
for (const locale of ["ar", "en", "pt-BR", "es-419"]) {
  ok(
    `React attempts-left has ${locale} copy`,
    Boolean(generatedDictionary[locale]?.resetErrAttemptsLeft),
  );
}

section("React inline catalog markup");
const suspicious =
  "<img onerror=alert(1)><script>alert(1)</script><span onmouseover=alert(1)>bad</span><span>safe</span><strong>bold</strong>";
const segments = parseInlineMarkup(suspicious);
equal(
  "inline catalog allows exact span and strong",
  segments.map((segment) => segment.kind).join(","),
  "text,span,strong",
);
ok(
  "inline catalog keeps img as text",
  segments[0].value.includes("<img onerror=alert(1)>") && segments[0].kind === "text",
);
ok(
  "inline catalog keeps script as text",
  segments[0].value.includes("<script>alert(1)</script>") && segments[0].kind === "text",
);
ok(
  "inline catalog rejects tag attributes",
  segments[0].value.includes("<span onmouseover=alert(1)>bad</span>"),
);
const rendererSource = readFileSync(join(ROOT, "frontend/src/gateway/inline-markup.ts"), "utf8");
ok(
  "inline catalog renderer uses only parsed strong and span elements",
  rendererSource.includes("parseInlineMarkup(value).map") &&
    rendererSource.includes('segment.kind === "text"') &&
    rendererSource.includes("createElement(") &&
    rendererSource.includes("segment.kind,") &&
    rendererSource.includes("segment.value,") &&
    !rendererSource.includes("dangerouslySetInnerHTML"),
);
finish();
