// Static guard: enforce control-panel design system contract across views, gateway, and components.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { finish, ok, ROOT, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("ui-design-contract");

const allowlistPath = join(ROOT, "tests/fixtures/ui-design-allowlist.json");
const allowlist = JSON.parse(readFileSync(allowlistPath, "utf8"));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

const scanDirs = [
  join(ROOT, "frontend/src/views"),
  join(ROOT, "frontend/src/gateway"),
  join(ROOT, "frontend/src/components"),
];

const files = scanDirs.flatMap((dir) => walk(dir));

section("design system contracts and exports exist");
ok("scanned files exist under frontend/src", files.length > 0);

const barrelContent = readFileSync(join(ROOT, "frontend/src/components/ui/index.ts"), "utf8");
ok("barrel exports StatTile", barrelContent.includes("StatTile"));
ok("barrel exports ListRow", barrelContent.includes("ListRow"));
ok("barrel exports Callout", barrelContent.includes("Callout"));

const readmeContent = readFileSync(join(ROOT, "frontend/src/components/ui/README.md"), "utf8");
ok("README has Design contract section", readmeContent.includes("## Design contract"));
ok(
  "README defines typography scale",
  readmeContent.includes("Typography scale and heading hierarchy"),
);
ok("README defines colour tokens", readmeContent.includes("Colour tokens and semantic colours"));
ok(
  "README defines radii and elevation",
  readmeContent.includes("Radii, elevation, and card surfaces"),
);
ok(
  "README defines spacing and breakpoints",
  readmeContent.includes("Spacing, page padding, grid, and breakpoints"),
);
ok("README defines button hierarchy", readmeContent.includes("Button hierarchy"));
ok("README defines save patterns", readmeContent.includes("SaveField vs useDirtyForm"));
ok(
  "README defines dialogs and bottom sheets",
  readmeContent.includes("Dialogs, bottom sheets, overflow menus"),
);
ok(
  "README defines system states",
  readmeContent.includes("Loading, empty, error, success, disabled states"),
);
ok("README defines RTL and bidi", readmeContent.includes("RTL/LTR and bidi"));
ok(
  "README defines navigation and headers",
  readmeContent.includes("Navigation, tabs, toolbars, page headers"),
);
ok("README defines accessibility", readmeContent.includes("Accessibility"));
ok("README defines content density rules", readmeContent.includes("Content density rules"));
ok("README has PR checklist", readmeContent.includes("PR checklist"));
ok("README documents StatTile", readmeContent.includes("### StatTile"));
ok("README documents ListRow", readmeContent.includes("### ListRow"));
ok("README documents Callout", readmeContent.includes("### Callout"));

// Every occurrence is counted per file, rule and exact matched text. An allowlist
// entry names that triple and the exact count it covers, so one more violation in
// an allowlisted file still fails, and a fixed one forces the entry to shrink.
const found = new Map();
function checkViolation(relPath, rule, matchedText, lineNum) {
  const key = `${relPath}\u0000${rule}\u0000${matchedText}`;
  const entry = found.get(key) || { file: relPath, rule, matched: matchedText, lines: [] };
  entry.lines.push(lineNum);
  found.set(key, entry);
}

section("static scan: design contract enforcement");

// Rules patterns
const hexPattern = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/g;
const palettePattern =
  /\b(?:text|bg|border)-(?:red|slate|gray|zinc|neutral|stone|blue|green|yellow|amber|orange|pink|purple|indigo|rose|teal|cyan|sky|violet|fuchsia|lime|emerald)-\d{2,3}(?:\/\d+)?\b/g;
const arbitraryColorPattern = /\b(?:text|bg|border)-\[(?:#|rgb|rgba|hsl|hsla)[^\]]+\]/g;
const physicalPattern =
  /\b(?:ml|mr|pl|pr|left|right|rounded-l|rounded-r|border-l|border-r)-|\btext-(?:left|right)\b/g;
const nativeElementPattern = /<(button|input|select|textarea)\b/g;
const toastMessagePattern = /\btoast\s*\([^)]*\.message\b/g;
const englishFallbackPattern = /\bt\(\s*["'][^"']+["']\s*\)\s*(?:\|\||\?\?)\s*["'`]/g;
const jidTextPattern = /(?<![=$])\{[A-Za-z0-9_$.?]*\.jid\}/g;
const iconButtonNoLabelPattern = /<IconButton\b(?![^>]*\blabel=)[^>]*>/g;

for (const file of files) {
  const relPath = relative(ROOT, file).replace(/\\/g, "/");
  const rawContent = readFileSync(file, "utf8");
  const cleanContent = stripComments(rawContent);
  const lines = cleanContent.split("\n");

  lines.forEach((line, idx) => {
    const lineNum = idx + 1;

    // Rule a: raw colours
    for (const match of line.matchAll(hexPattern)) {
      checkViolation(relPath, "raw-color", match[0], lineNum);
    }
    for (const match of line.matchAll(palettePattern)) {
      checkViolation(relPath, "raw-color", match[0], lineNum);
    }
    for (const match of line.matchAll(arbitraryColorPattern)) {
      checkViolation(relPath, "raw-color", match[0], lineNum);
    }

    // Rule b: physical layout
    for (const match of line.matchAll(physicalPattern)) {
      checkViolation(relPath, "physical-layout", match[0], lineNum);
    }

    // Rule c: native element (exempting components/ui)
    if (!relPath.startsWith("frontend/src/components/ui/")) {
      for (const match of line.matchAll(nativeElementPattern)) {
        checkViolation(relPath, "native-element", match[0], lineNum);
      }
    }

    // Rule d: error message in JSX or toast
    if (line.includes(".message")) {
      const jsxErrorMatch =
        /(?:\{|:\s*|=\s*\{?)([A-Za-z0-9_$]*(?:err|error|Error))\??\.message\s*\}?/.exec(line);
      if (jsxErrorMatch) {
        checkViolation(relPath, "error-message", `${jsxErrorMatch[1]}.message`, lineNum);
      }
      for (const match of line.matchAll(toastMessagePattern)) {
        checkViolation(relPath, "error-message", match[0], lineNum);
      }
    }

    // Rule e: English fallbacks after translation
    for (const match of line.matchAll(englishFallbackPattern)) {
      checkViolation(relPath, "english-fallback", match[0], lineNum);
    }

    // Rule f: raw WhatsApp identifiers
    for (const match of line.matchAll(jidTextPattern)) {
      checkViolation(relPath, "raw-identifier", match[0], lineNum);
    }
    // JSX text only: a .ts file holds validation patterns, not rendered text.
    const waTextMatch = relPath.endsWith(".tsx")
      ? /(?:>|^)[^<"'`]*@(s\.whatsapp\.net|g\.us|lid)[^<"'`]*(?:<|$)/.exec(line)
      : null;
    if (waTextMatch) {
      checkViolation(relPath, "raw-identifier", `@${waTextMatch[1]}`, lineNum);
    }

    // Rule g: icon-only IconButton without label
    for (const match of line.matchAll(iconButtonNoLabelPattern)) {
      checkViolation(relPath, "icon-button-label", match[0], lineNum);
    }
  });
}

section("violations match the allowlist exactly");
const allowed = new Map(
  allowlist.map((entry) => [`${entry.file}\u0000${entry.rule}\u0000${entry.matched}`, entry]),
);
for (const [key, hit] of found) {
  const entry = allowed.get(key);
  ok(
    `${hit.file}:${hit.lines.join(",")} ${hit.rule} ${JSON.stringify(hit.matched)}`,
    Boolean(entry) && entry.count === hit.lines.length,
    entry
      ? `allowlist covers ${entry.count}, found ${hit.lines.length}`
      : "violation is not allowlisted",
  );
}
for (const [key, entry] of allowed) {
  ok(
    `allowlist entry ${entry.file} [${entry.rule}] ${entry.matched} still matches`,
    found.has(key),
    `stale entry: the violation is gone, delete it (${entry.reason})`,
  );
  ok(`allowlist entry ${entry.file} [${entry.rule}] has a reason`, Boolean(entry.reason));
}

finish();
