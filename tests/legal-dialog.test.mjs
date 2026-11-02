import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

const dialog = readFileSync(join(ROOT, "frontend/src/views/legal/TermsConsentDialog.tsx"), "utf8");
const app = readFileSync(join(ROOT, "frontend/src/App.tsx"), "utf8");

section("legal consent dialog source");
ok("Retry calls the Terms loader", /onClick=\{loadTerms\}[\s\S]*?\{t\("retry"\)\}/.test(dialog));
ok("stale load responses are guarded", /request === requestId\.current && !savingRef\.current/.test(dialog));
ok(
  "409 replaces the document and requires a new check",
  /cause\.status === 409[\s\S]*?setDocument\(cause\.data as LegalTermsResponse\);[\s\S]*?setChecked\(false\);[\s\S]*?setChanged\(true\);/.test(dialog),
);
ok("changed notice is an alert", /role=\{changed \? "alert" : undefined\}/.test(dialog));
ok("legal text stays plain text", !dialog.includes("dangerouslySetInnerHTML"));
ok("loading has an accessible label", /<Spinner label=\{t\("loading"\)\}/.test(dialog));

section("panel state");
for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
  const catalog = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
  ok(`${locale} labels consent_required`, Boolean(catalog.consent_required));
}
ok(
  "accept refreshes backend session state",
  /onAccepted=\{\(next\) => \{[\s\S]*?refreshStatus\(\)\.then/.test(app),
);
ok(
  "stale consent socket state cannot replace accepted state",
  /socketStatus\.state === "consent_required"/.test(app) &&
    /acceptedStatus[\s\S]*?\? acceptedStatus\s*:\s*\{\}/.test(app),
);
ok(
  "a new non-consent socket state clears the accepted override",
  /socketAtAccept\.current = socketStatus;/.test(app) &&
    /acceptedStatus &&\s*socketStatus &&\s*socketStatus !== socketAtAccept\.current &&\s*socketStatus\.state !== "consent_required"[\s\S]*?setAcceptedStatus\(null\)/.test(app),
);

finish();
