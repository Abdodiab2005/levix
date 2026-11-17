import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const src = join(ROOT, "frontend/src");
const read = (path) => readFileSync(join(ROOT, path), "utf8");

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}
const files = walk(src);
const rel = (file) => relative(ROOT, file).replaceAll("\\", "/");
const count = (text, needle) => text.split(needle).length - 1;

const sidebar = read("frontend/src/components/Sidebar.tsx");
const app = read("frontend/src/App.tsx");
const hook = read("frontend/src/hooks/usePlusStatus.ts");
const plusUi = read("frontend/src/components/ui/plus.tsx");
const settingsView = read("frontend/src/views/SettingsView.tsx");

section("Sidebar shows the Plus item only when Plus is available");
ok(
  "the item is added behind plusAvailable === true",
  /plusAvailable === true \? \[\{ plusItem: true \}\] : \[\]/.test(sidebar),
);
equal("one Plus entry in the nav list", count(sidebar, "plusItem: true"), 1);
ok('no static id: "plus" nav entry', !/id:\s*"plus"/.test(sidebar));
ok(
  "the Plus group sits before the Settings group",
  sidebar.indexOf("plusItem: true") < sidebar.indexOf('labelCategory: t("settings")'),
);
ok("item uses the crown icon", /icon=\{<CrownIcon/.test(sidebar));
ok("item opens the plus view", /onSelectView\("plus"\)/.test(sidebar));
ok("brand crown only when access is active", /\{plusActive && \(/.test(sidebar));
ok("brand crown has an accessible label", /aria-label=\{t\("navPlusActiveLabel"\)\}/.test(sidebar));
ok(
  "active badge carries text",
  /<PlusBadge[^>]*>\{t\("plusStateActive"\)\}<\/PlusBadge>/.test(sidebar),
);
ok("no purchase nagging in the nav", !/plusSubscribe|plusRowLearnMore/.test(sidebar));

section("routing");
ok("plus is a valid view", /const VALID_VIEWS[\s\S]*?"plus",[\s\S]*?\];/.test(app));
ok("plus has a title", /plus: t\("plusTitle"\)/.test(app));
ok(
  "plus view renders PlusSettings",
  /currentView === "plus" && <PlusPage \/>/.test(app) && /<PlusSettings/.test(app),
);
ok(
  "legacy #settings/plus is rewritten",
  /legacyPlusRedirect\(window\.location\.hash\)/.test(app) &&
    count(app, "applyLegacyPlusHash()") >= 3,
);
ok("Sidebar ViewTab includes plus", /\|\s*"plus"/.test(sidebar));
ok("Settings keeps no Plus tab entry", !/value:\s*"plus"/.test(settingsView));
ok("Settings no longer reads the host for Plus", !/plusConfigured/.test(settingsView));

section("no file but PlusSettings decides entitlement from the host or storage");
const allowedHost = new Set([
  "frontend/src/views/settings/PlusSettings.tsx",
  "frontend/src/utils/hostBridge.ts",
]);
const hostOrStorage = /LevixHost|localStorage|sessionStorage/;
const plusWords = /plus|entitle|subscri/i;
for (const file of files) {
  const path = rel(file);
  if (allowedHost.has(path)) continue;
  const lines = readFileSync(file, "utf8").split("\n");
  const bad = lines.filter((line) => hostOrStorage.test(line) && plusWords.test(line));
  ok(`${path} has no Plus decision from host or storage`, bad.length === 0, bad.join(" | "));
  ok(`${path} does not call plusConfigured directly`, !/\bplusConfigured\b/.test(lines.join("\n")));
}
const configuredUsers = files
  .filter((file) => /\bisPlusConfigured\b/.test(readFileSync(file, "utf8")))
  .map(rel)
  .sort();
equal(
  "isPlusConfigured is used by the bridge and the shared hook only",
  configuredUsers.join(","),
  "frontend/src/hooks/usePlusStatus.ts,frontend/src/utils/hostBridge.ts",
);
const hookLines = hook.split("\n").filter((line) => line.includes("isPlusConfigured()"));
ok(
  "the hook uses the host flag for availability only",
  hookLines.length > 0 && hookLines.every((line) => line.includes("hostConfigured:")),
);
ok(
  "PlusFeatureRow decides access from the shared status",
  /accessFromStatus\(status, available\)/.test(plusUi) && !/LevixHost|localStorage/.test(plusUi),
);
ok(
  "the shared hook subscribes to plus_status and connect",
  /useSocketEvent\("plus_status"/.test(hook) && /useSocketEvent\("connect"/.test(hook),
);
ok("the shared hook refreshes on visibilitychange", /visibilitychange/.test(hook));
ok(
  "PlusSettings reads the shared hook",
  /usePlusStatus\(\)/.test(read("frontend/src/views/settings/PlusSettings.tsx")),
);

section("in-context rows");
const ai = read("frontend/src/views/AIAssistantView.tsx");
const commands = read("frontend/src/views/CommandsView.tsx");
equal("AIAssistantView has one PlusFeatureRow", count(ai, "<PlusFeatureRow"), 1);
equal("CommandsView has one PlusFeatureRow", count(commands, "<PlusFeatureRow"), 1);
ok("AIAssistantView row opens the autoReply tab", /<PlusFeatureRow\s+tab="autoReply"/.test(ai));
ok("CommandsView row opens the messages tab", /<PlusFeatureRow\s+tab="messages"/.test(commands));
ok(
  "both import it from the ui barrel",
  /PlusFeatureRow,[\s\S]*?from "\.\.\/components\/ui"/.test(ai) &&
    /PlusFeatureRow,[\s\S]*?from "\.\.\/components\/ui"/.test(commands),
);
ok("row renders nothing when unavailable", /access === "unavailable"\) return null/.test(plusUi));
ok("row has no modal or popup", !/Dialog|Popover|Sheet/.test(plusUi));
ok("locked row links to #plus", /access === "locked"[\s\S]*?href=\{plusHash\(\)\}/.test(plusUi));
ok(
  "active row links to the feature tab",
  /access === "active"[\s\S]*?href=\{plusHash\(tab\)\}/.test(plusUi),
);
ok(
  "unknown row disables the action and gives a reason",
  /access === "unknown"[\s\S]*?disabled[\s\S]*?aria-describedby=\{reasonId\}/.test(plusUi),
);
ok(
  "barrel exports the Plus primitives",
  /CrownIcon,[\s\S]*?PlusBadge,[\s\S]*?PlusFeatureRow,[\s\S]*?from "\.\/plus"/.test(
    read("frontend/src/components/ui/index.ts"),
  ),
);
ok(
  "README documents PlusFeatureRow",
  /### CrownIcon \/ PlusBadge \/ PlusFeatureRow/.test(read("frontend/src/components/ui/README.md")),
);

section("accessibility and style of the new primitives");
ok(
  "crown svg is aria-hidden and uses currentColor",
  /aria-hidden="true"/.test(plusUi) && /fill="currentColor"/.test(plusUi),
);
ok("no emoji crown", !/\u{1F451}/u.test(plusUi + sidebar));
ok(
  "no check mark icon in the Plus primitives",
  /import \{ Lock \} from "lucide-react"/.test(plusUi),
);
for (const [name, text] of [
  ["plus.tsx", plusUi],
  ["Sidebar.tsx", sidebar],
  ["usePlusStatus.ts", hook],
]) {
  ok(
    `${name} has no physical-direction classes`,
    !/\b(?:ml|mr|pl|pr|left|right)-|\btext-(?:left|right)\b/.test(text),
  );
  ok(
    `${name} has no hex colour or one-off palette`,
    !/#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])|\b(?:text|bg|border)-(?:red|slate|gray|zinc|amber|yellow|blue|green|purple)-\d{2,3}\b/.test(
      text,
    ),
  );
}

section("i18n keys exist in every locale");
const keys = new Set();
for (const text of [plusUi, sidebar, ai, commands]) {
  for (const match of text.matchAll(/\bt\(\s*"((?:plusRow|navPlus)[A-Za-z0-9]*)"/g))
    keys.add(match[1]);
}
ok("new keys are used", keys.size >= 9, [...keys].join(","));
for (const locale of ["en", "ar", "pt-BR", "es-419"]) {
  const catalog = JSON.parse(read(`i18n/${locale}/dashboard.json`));
  for (const key of [...keys].sort()) {
    ok(`${locale}: ${key}`, typeof catalog[key] === "string" && catalog[key].length > 0);
  }
}

section("review fixes: status kept on failure, switch waits for its value, tab follows the hash");
{
  const hook = read("frontend/src/hooks/usePlusStatus.ts");
  const failure = hook.slice(hook.indexOf("(err) => {"));
  ok("a failed refresh keeps the last status", /status: state\.status,/.test(failure.slice(0, 600)));
  ok("a failed refresh never clears status to null", !/status: null,/.test(failure.slice(0, 600)));
  const page = app.slice(app.indexOf("const PlusPage"), app.indexOf("const MainLayout"));
  ok("PlusPage starts with no value", /useState<boolean \| null>\(null\)/.test(page));
  ok("PlusPage shows a spinner until the value is read", /if \(enabled === null\) return <Spinner/.test(page));
  const features = read("frontend/src/views/plus/PlusFeaturesView.tsx");
  ok("changing the Plus tab updates #plus/<tab>", /replaceState\(null, "", plusHash\(next\)\)/.test(features));
}

finish();
