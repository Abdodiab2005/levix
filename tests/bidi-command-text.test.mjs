// CodeText keeps a command token in source order. These checks read the source.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish, ok, ROOT, section } from "./harness.mjs";

function source(rel) {
  return readFileSync(join(ROOT, rel), "utf8");
}

section("CodeText isolates a token as bdi dir=ltr");
{
  const code = source("frontend/src/components/ui/code-text.tsx");
  ok("renders a bdi element", code.includes("<bdi"));
  ok('sets dir="ltr" on that element', code.includes('dir="ltr"'));
  ok("uses the monospace token face", code.includes("font-mono"));
  ok("does not insert bidi control characters", !/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(code));
  ok("copy uses the clipboard", code.includes("navigator.clipboard"));
  ok("copy failure is translated", code.includes('t("copyFailed")'));
  const barrel = source("frontend/src/components/ui/index.ts");
  ok("barrel exports CodeText", barrel.includes('export { CodeText, type CodeTextProps } from "./code-text"'));
}

section("prefix preview keeps the prefix first");
{
  const settings = source("frontend/src/views/SettingsView.tsx");
  ok("SettingsView uses CodeText", settings.includes("<CodeText"));
  ok("preview uses the live prefix", settings.includes("${livePrefix}help"));
  ok("preview includes lang ar", settings.includes("${livePrefix}lang ar"));
  ok("preview includes sticker", settings.includes("${livePrefix}sticker"));
  ok("prefix card has no bare code element", !settings.includes("<code"));
}

section("command views render names, aliases, and usage through CodeText");
for (const rel of [
  "frontend/src/views/CommandsView.tsx",
  "frontend/src/views/commands/CommandTable.tsx",
  "frontend/src/views/commands/CommandMobileList.tsx",
  "frontend/src/views/commands/CommandDetails.tsx",
  "frontend/src/views/commands/AliasToken.tsx",
  "frontend/src/views/commands/CommandAliasDialog.tsx",
]) {
  const text = source(rel);
  ok(`${rel} uses CodeText`, text.includes("<CodeText"));
  ok(`${rel} has no bare code element`, !text.includes("<code"));
}

section("RTL catalog strings isolate embedded commands");
{
  // A command inside an Arabic sentence (for example "!help") reorders to
  // "help!" unless it sits between U+2066 (LRI) and U+2069 (PDI).
  const ar = JSON.parse(readFileSync(join(ROOT, "i18n/ar/dashboard.json"), "utf8"));
  const bare = [];
  for (const [key, value] of Object.entries(ar)) {
    const text = String(value);
    for (const match of text.matchAll(/(?<![\w\u2066])[!/][a-z][\w-]*/g)) {
      if (text[match.index + match[0].length] !== "\u2069") bare.push(`${key}: ${match[0]}`);
    }
  }
  ok(`no bare command token in Arabic dashboard strings (${bare.join(", ") || "none"})`, bare.length === 0);
}

finish();
