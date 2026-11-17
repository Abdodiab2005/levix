import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildWarningsExplanation,
  describePresetPolicy,
  formatGroupMembers,
  groupMembersPluralKey,
  moderationActionKey,
  moderationActionTone,
  PLURAL_CATEGORIES,
  parseWhatsAppMarkdown,
  shouldWarnPresetReplace,
} from "../frontend/src/utils/moderationText.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const LOCALES = ["en", "ar", "pt-BR", "es-419"];
const catalogs = Object.fromEntries(
  LOCALES.map((locale) => [
    locale,
    JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8")),
  ]),
);
const groupsViewPath = join(ROOT, "frontend/src/views/GroupsView.tsx");
const groupsView = readFileSync(groupsViewPath, "utf8");

section("WhatsApp markdown parser turns formatting into segments and keeps unmatched * as text");
{
  const parsed = parseWhatsAppMarkdown("*Rules*\n_be nice_ ~old~ ```x```");
  equal(
    "formatted segments match expected sequence",
    JSON.stringify(parsed),
    JSON.stringify([
      { type: "bold", text: "Rules" },
      { type: "text", text: "\n" },
      { type: "italic", text: "be nice" },
      { type: "text", text: " " },
      { type: "strike", text: "old" },
      { type: "text", text: " " },
      { type: "mono", text: "x" },
    ]),
  );

  const unmatched = parseWhatsAppMarkdown("2 * 3 and *unclosed");
  equal(
    "unmatched asterisk stays plain text",
    JSON.stringify(unmatched),
    JSON.stringify([{ type: "text", text: "2 * 3 and *unclosed" }]),
  );

  const crossLine = parseWhatsAppMarkdown("*unclosed\n*bold*");
  equal(
    "unclosed marker before newline stays text while next line parses bold",
    JSON.stringify(crossLine),
    JSON.stringify([
      { type: "text", text: "*unclosed\n" },
      { type: "bold", text: "bold" },
    ]),
  );

  equal("empty input returns empty array", parseWhatsAppMarkdown("").length, 0);
}

section("plural keys exist for every Intl.PluralRules category of each locale");
{
  for (const locale of LOCALES) {
    const dict = catalogs[locale];
    const resolved = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
    for (const category of resolved) {
      const key = `groupMembers_${category}`;
      ok(
        `${locale} has ${key} for Intl.PluralRules`,
        typeof dict[key] === "string" && dict[key].includes("{n}"),
      );
    }
    for (const category of PLURAL_CATEGORIES) {
      const key = `groupMembers_${category}`;
      ok(`${locale} has ${key}`, typeof dict[key] === "string" && dict[key].includes("{n}"));
    }
    ok(
      `${locale} has groupMembersUnknown`,
      typeof dict.groupMembersUnknown === "string" && dict.groupMembersUnknown.length > 0,
    );
  }

  equal("Arabic 0 -> groupMembers_zero", groupMembersPluralKey(0, "ar"), "groupMembers_zero");
  equal("Arabic 1 -> groupMembers_one", groupMembersPluralKey(1, "ar"), "groupMembers_one");
  equal("Arabic 2 -> groupMembers_two", groupMembersPluralKey(2, "ar"), "groupMembers_two");
  equal("Arabic 5 -> groupMembers_few", groupMembersPluralKey(5, "ar"), "groupMembers_few");
  equal("Arabic 15 -> groupMembers_many", groupMembersPluralKey(15, "ar"), "groupMembers_many");
  equal("Arabic 100 -> groupMembers_other", groupMembersPluralKey(100, "ar"), "groupMembers_other");
  equal("English 1 -> groupMembers_one", groupMembersPluralKey(1, "en"), "groupMembers_one");
  equal("English 4 -> groupMembers_other", groupMembersPluralKey(4, "en"), "groupMembers_other");

  const tAr = (key) => catalogs.ar[key] ?? key;
  equal("Arabic 2 members formatted", formatGroupMembers(2, "ar", tAr), "عضوان (2)");
  equal("Arabic 5 members formatted", formatGroupMembers(5, "ar", tAr), "5 أعضاء");
  equal(
    "null members formatted",
    formatGroupMembers(null, "ar", tAr),
    catalogs.ar.groupMembersUnknown,
  );
}

section("preset summary, action labels/tones, and warning explanation helpers");
{
  const tEn = (key) => catalogs.en[key] ?? key;
  const basePolicy = {
    mode: "simple",
    limit: 3,
    limitAction: "KICK",
    features: { antilink: null, media: null, forbidden: null, antispam: null },
    hitMerge: "max",
    weights: { antilink: 1, media: 1, forbidden: 1, antispam: 1, manual: 1 },
    flagAt: 3,
    kickAt: 5,
    decay: { mode: "off", days: 30 },
    membership: "clear",
    flag: {
      notify: "group",
      mentionAdmins: true,
      cooldownMinutes: 0,
      whileFlagged: "record",
      escalateAfter: 3,
    },
  };

  const strictPolicy = {
    ...basePolicy,
    limit: 2,
    features: { antilink: "KICK", media: "WARN", forbidden: "WARN", antispam: "KICK" },
  };

  const summary = describePresetPolicy(strictPolicy, tEn);
  ok("preset summary includes derived limit 2", summary.includes("2"));
  ok("preset summary includes Remove the member", summary.includes("Remove the member"));
  ok("preset summary includes Warn the member", summary.includes("Warn the member"));

  equal("KICK tone is danger", moderationActionTone("KICK"), "danger");
  equal("WARN tone is warn", moderationActionTone("WARN"), "warn");
  equal("DELETE tone is neutral", moderationActionTone("DELETE"), "neutral");
  equal(
    "DELETE key is moderationActionDelete",
    moderationActionKey("DELETE"),
    "moderationActionDelete",
  );
  equal("WARN key is moderationActionWarn", moderationActionKey("WARN"), "moderationActionWarn");
  equal("KICK key is moderationActionKick", moderationActionKey("KICK"), "moderationActionKick");

  const simpleLines = buildWarningsExplanation(basePolicy, tEn);
  equal("simple explanation has 2 lines when decay is off", simpleLines.length, 2);
  ok(
    "simple explanation mentions limit 3 and admin fallback",
    simpleLines[1].includes("3") && simpleLines[1].includes("not a group admin"),
  );

  const decayLines = buildWarningsExplanation(
    { ...basePolicy, decay: { mode: "expire", days: 14 } },
    tEn,
  );
  equal("decay adds a 3rd line when set", decayLines.length, 3);
  ok("decay line mentions 14 days", decayLines[2].includes("14"));

  const customPolicy = { ...basePolicy, limit: 4 };
  equal(
    "picking preset over custom draft triggers replace warning",
    shouldWarnPresetReplace(customPolicy, basePolicy, strictPolicy, true),
    true,
  );
  equal(
    "picking same preset does not trigger replace warning",
    shouldWarnPresetReplace(strictPolicy, basePolicy, strictPolicy, false),
    false,
  );
}

section("GroupsView static checks: member counts, formatted preview, design tokens, and i18n keys");
{
  ok('GroupsView no longer renders t("thMembers")', !groupsView.includes('t("thMembers")'));
  ok("GroupsView uses formatGroupMembers", groupsView.includes("formatGroupMembers("));
  ok(
    "GroupsView no longer renders previewText as one raw string",
    !/\{\s*previewText\s*\}/.test(groupsView),
  );
  ok(
    "GroupsView parses previewText with parseWhatsAppMarkdown",
    groupsView.includes("parseWhatsAppMarkdown(previewText)"),
  );
  ok(
    "GroupsView does not use dangerouslySetInnerHTML",
    !groupsView.includes("dangerouslySetInnerHTML"),
  );
  ok("GroupsView has no text-faint", !groupsView.includes("text-faint"));

  const layoutPattern = /\b(?:ml|mr|pl|pr|left|right)-|\btext-(?:left|right)\b/;
  const hexPattern = /#[0-9a-fA-F]{3,8}(?![0-9a-fA-F])/;
  const palettePattern =
    /\b(?:text|bg|border)-(?:red|slate|gray|zinc|neutral|stone|blue|green|yellow|amber|orange|pink|purple|indigo|rose|teal|cyan|sky|violet|fuchsia|lime|emerald)-\d{2,3}\b/;
  ok("GroupsView has no physical-direction classes", !layoutPattern.test(groupsView));
  ok("GroupsView has no raw hex colours", !hexPattern.test(groupsView));
  ok("GroupsView has no one-off Tailwind palette classes", !palettePattern.test(groupsView));

  const keyPattern = /\bt\(\s*(["'])([A-Za-z][A-Za-z0-9_]*)\1/g;
  const usedKeys = new Set();
  for (const match of groupsView.matchAll(keyPattern)) {
    usedKeys.add(match[2]);
  }
  ok("GroupsView uses translated keys", usedKeys.size > 0);
  for (const key of [...usedKeys].sort()) {
    for (const locale of LOCALES) {
      ok(`${key} exists in ${locale}/dashboard.json`, Object.hasOwn(catalogs[locale], key));
    }
  }
}

finish();
