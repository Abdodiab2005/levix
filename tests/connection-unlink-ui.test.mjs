// Connection screen: a failed unlink is not a success toast, and the retry is
// the primary action. Source and catalogs only. No React.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const view = readFileSync(join(ROOT, "frontend/src/views/ConnectionView.tsx"), "utf8");
const keys = [
  "connectionUnlinkIncomplete",
  "connectionUnlinkIncompleteHint",
  "connectionUnlinkRetry",
];
const text = {
  en: {
    connectionUnlinkIncomplete:
      "Unlink did not finish. The stored WhatsApp credentials could not be deleted.",
    connectionUnlinkIncompleteHint:
      "WhatsApp will not reconnect until the credentials are deleted. Free up storage if the device is full, then unlink again.",
    connectionUnlinkRetry: "Unlink again",
  },
  ar: {
    connectionUnlinkIncomplete: "لم يكتمل فصل الحساب. تعذّر حذف بيانات اعتماد واتساب المخزّنة.",
    connectionUnlinkIncompleteHint:
      "لن يعاد الاتصال بواتساب حتى تُحذف بيانات الاعتماد. حرّر مساحة التخزين إن كان الجهاز ممتلئًا، ثم افصل الحساب مرة أخرى.",
    connectionUnlinkRetry: "افصل مرة أخرى",
  },
  "pt-BR": {
    connectionUnlinkIncomplete:
      "A desvinculação não terminou. Não foi possível apagar as credenciais do WhatsApp armazenadas.",
    connectionUnlinkIncompleteHint:
      "O WhatsApp não vai se reconectar até as credenciais serem apagadas. Libere espaço se o aparelho estiver cheio e desvincule de novo.",
    connectionUnlinkRetry: "Desvincular de novo",
  },
  "es-419": {
    connectionUnlinkIncomplete:
      "La desvinculación no terminó. No se pudieron borrar las credenciales de WhatsApp guardadas.",
    connectionUnlinkIncompleteHint:
      "WhatsApp no se volverá a conectar hasta que se borren las credenciales. Libera espacio si el dispositivo está lleno y vuelve a desvincular.",
    connectionUnlinkRetry: "Volver a desvincular",
  },
};

section("ConnectionView treats unlink_incomplete as a failed unlink");

ok("the view checks unlink_incomplete", view.includes("unlink_incomplete"));
ok("pairing controls stay hidden for that state", view.includes("!unlinkIncomplete"));
ok(
  "the error toast is connectionUnlinkIncomplete",
  view.includes('toast(t("connectionUnlinkIncomplete"), "error")'),
);
ok(
  "the notice uses connectionUnlinkIncompleteHint",
  view.includes('t("connectionUnlinkIncompleteHint")'),
);
ok("the retry button uses connectionUnlinkRetry", view.includes('t("connectionUnlinkRetry")'));
ok(
  "a rejected unlink toasts the server's message",
  view
    .slice(view.indexOf("const confirmUnlink"), view.indexOf("const rawPhone"))
    .includes('toast(err instanceof Error ? err.message : String(err), "error")'),
);
for (const key of keys) ok(`the view uses ${key}`, view.includes(`t("${key}")`));

section("the three keys exist in all four catalogs");

for (const [locale, expected] of Object.entries(text)) {
  const catalog = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
  for (const key of keys) {
    equal(`${locale} ${key}`, catalog[key], expected[key]);
  }
}

finish();
