import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const viewsDir = join(ROOT, "frontend/src/views/reactions");
const catalogPath = join(ROOT, "i18n/en/dashboard.json");
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

function filesUnder(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".ts") || name.endsWith(".tsx"))
    .map((name) => join(dir, name));
}

const files = filesUnder(viewsDir);
const relativePath = (file) => relative(ROOT, file);
ok("reaction view files exist", files.length > 0, files.join(", "));

const keyPattern = /\bt\(\s*(["'])([A-Za-z][A-Za-z0-9]*)\1/g;
const layoutPattern = /\b(?:ml|mr|pl|pr|left|right)-|\btext-(?:left|right)\b/;
const hexPattern = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
const palettePattern =
  /\b(?:text|bg|border)-(?:red|slate|gray|zinc|neutral|stone|blue|green|yellow|amber|orange|pink|purple|indigo|rose|teal|cyan|sky|violet|fuchsia|lime|emerald)-\d{2,3}\b/;
const importPattern = /\bfrom\s+["']([^"']+)["']/g;

section("t() keys exist in i18n/en/dashboard.json");
const used = new Set();
for (const file of files) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(keyPattern)) used.add(match[2]);
}
equal("views use t() keys", used.size > 0, true);
for (const key of [...used].sort()) {
  ok(`${key} is in en/dashboard.json`, Object.hasOwn(catalog, key));
}

section("no physical-direction classes, hex colours, or one-off palettes");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relative = relativePath(file);
  ok(`${relative} has no ml/mr/pl/pr/left/right layout classes`, !layoutPattern.test(text));
  ok(`${relative} has no raw hex colours`, !hexPattern.test(text));
  ok(`${relative} has no text-red/bg-slate palettes`, !palettePattern.test(text));
}

section("UI primitives import from the barrel");
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const relative = relativePath(file);
  for (const match of text.matchAll(importPattern)) {
    const source = match[1];
    if (!source.includes("components/ui")) continue;
    equal(`${relative} UI import ${source}`, source, "../../components/ui");
  }
}

section("editor explains STT without disabled message-type checkboxes");
{
  const editor = readFileSync(join(viewsDir, "ReactionRuleEditor.tsx"), "utf8");
  const types = editor.match(/<section[^>]*aria-labelledby="rx-types-heading"[\s\S]*?<\/section>/)?.[0] || "";
  ok("message-type section exists", types.length > 0);
  ok("no typesLocked checkbox lock remains", !/disabled=\{typesLocked\}/.test(editor));
  ok("message-type checkboxes are enabled", !/disabled=/.test(types));
  ok("STT substitutes its explanation", /draft\.action === "stt"\s*\?/.test(types) && types.includes('t("reactionSttVoiceOnly")'));
  ok("all supported messages is a checkbox", /<Checkbox\s+label=\{t\("reactionAllTypes"\)\}/.test(types));
  const destination = editor.match(/<RadioGroup\b[\s\S]*?\/>/)?.[0] || "";
  ok("destination has no duplicate visible label", destination.length > 0 && !/\blabel=/.test(destination));
  ok("destination is named by its fieldset heading", /<fieldset[^>]*id="rx-destination"[^>]*aria-labelledby="rx-destination-heading"/.test(editor));
  ok("emoji error is exposed to assistive technology", editor.includes('error={emojiError}') && editor.includes('aria-invalid={emojiError ? true : undefined}'));
  const guard = editor.indexOf("if (submitPending.current) return;");
  const lock = editor.indexOf("submitPending.current = true;");
  const firstRequest = editor.indexOf("await api.checkReactionRule");
  ok("submit checks the synchronous pending guard", guard >= 0 && guard < firstRequest);
  ok("submit sets the pending guard before the first request", lock >= 0 && lock < firstRequest);
  ok("revision conflict explains how to retain edits", editor.includes('setFormError(t("reactionEditConflict"))'));
  const view = readFileSync(join(viewsDir, "ReactionRulesView.tsx"), "utf8");
  const conflict = view.match(/const handleConflict = async \(\) => \{[\s\S]*?\n  \};/)?.[0] || "";
  ok("save conflict keeps the editor open", conflict.length > 0 && !conflict.includes("setEditorOpen(false)"));
  ok("advanced options use Disclosure", editor.includes("<Disclosure"));
  ok("editor uses the mobile dialog variant", editor.includes('variant="mobileFullscreen"'));
  const dialog = readFileSync(join(ROOT, "frontend/src/components/ui/dialog.tsx"), "utf8");
  ok("dialog mobile variant fills the viewport", dialog.includes("h-dvh max-h-dvh max-w-none"));
  ok("dialog desktop variant retains a size limit", dialog.includes("sm:max-w-[var(--dialog-max-width)]"));
  ok("dialog footer is sticky and clears the safe area", dialog.includes("sticky bottom-0") && dialog.includes("env(safe-area-inset-bottom)"));
  const editorKeys = [...editor.matchAll(keyPattern)].map((match) => match[2]);
  for (const locale of ["ar", "pt-BR", "es-419"]) {
    const json = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
    for (const key of new Set(editorKeys)) ok(`${locale} has editor key ${key}`, typeof json[key] === "string" && json[key].length > 0);
  }
}

section("automation toggle is single-flight; sort is recent activity");
{
  const view = readFileSync(join(viewsDir, "ReactionRulesView.tsx"), "utf8");
  const autoToggle = view.match(/<Toggle\s+checked=\{automation\}[\s\S]*?\/>/)?.[0] || "";
  ok("automation Toggle passes aria-busy=", /aria-busy=\{[^}]+\}/.test(autoToggle));
  ok("automation Toggle does not pass disabled=", !/disabled=/.test(autoToggle));
  ok("view has no reactionSortNewest", !view.includes("reactionSortNewest"));
  ok('view has no "newest" sort value', !view.includes('"newest"'));
  ok("view toasts reactionAutomationChanged", view.includes('"reactionAutomationChanged"'));
  for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
    const json = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
    ok(`${locale} has reactionSortRecent`, Object.hasOwn(json, "reactionSortRecent"));
    ok(`${locale} has no reactionSortNewest`, !Object.hasOwn(json, "reactionSortNewest"));
    ok(
      `${locale} has reactionAutomationChanged`,
      typeof json.reactionAutomationChanged === "string" &&
        json.reactionAutomationChanged.length > 0,
    );
  }
}

finish();
