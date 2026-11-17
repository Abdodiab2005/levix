// Recipient labels: nameSource on describePeer, and the pure picker helper.
// Two unknown @lid rows must not both read as the English word "Contact".

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fill } from "../frontend/src/utils/fill.ts";
import {
  MEMBER_CATEGORIES,
  labelRecipients,
  memberCountLabel,
  phoneDigits,
  recipientMatches,
  recipientParts,
} from "../frontend/src/utils/recipientLabel.ts";
import { ROOT, equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-recipient-labels");
const store = require("./src/db/store.cjs");

const LOCALES = ["en", "ar", "pt-BR", "es-419"];

function copy(locale) {
  const data = JSON.parse(readFileSync(join(ROOT, "i18n", locale, "dashboard.json"), "utf8"));
  return (key) => (typeof data[key] === "string" ? data[key] : "");
}

const en = copy("en");
const ar = copy("ar");

section("describePeer nameSource");

store.saveUserMetadata({
  jid: "201222222222@s.whatsapp.net",
  displayName: "Push Person",
  savedName: "Saved Person",
});
const saved = store.describePeer("201222222222@s.whatsapp.net");
equal("saved name wins", saved.nameSource, "saved");
equal("saved label is the saved name", saved.label, "Saved Person");
equal("saved field stays", saved.savedName, "Saved Person");
equal("push field stays beside a saved name", saved.pushName, "Push Person");

store.saveUserMetadata({
  jid: "201333333333@s.whatsapp.net",
  displayName: "Push Only",
});
const push = store.describePeer("201333333333@s.whatsapp.net");
equal("push name is the source when nothing is saved", push.nameSource, "push");
equal("push label is the push name", push.label, "Push Only");
equal("push row has no saved name", push.savedName, null);

const phoneOnly = store.describePeer("201000000010@s.whatsapp.net");
equal("a resolvable phone with no name is source phone", phoneOnly.nameSource, "phone");
equal("phone label keeps the legacy plus form", phoneOnly.label, "+201000000010");
equal("phone field matches the label", phoneOnly.phone, "+201000000010");
equal("phone row kind", phoneOnly.kind, "contact");
equal("phone row has no saved name", phoneOnly.savedName, null);
equal("phone row has no push name", phoneOnly.pushName, null);

store.saveUserMetadata({ jid: "111111111111111@lid" });
const none = store.describePeer("111111111111111@lid");
equal("a nameless LID is source none", none.nameSource, "none");
equal("legacy Contact label stays for older clients", none.label, "Contact");
equal("nameless LID has no phone", none.phone, null);
equal("nameless LID kind", none.kind, "contact");
ok("the label does not contain the LID", !none.label.includes("111111111111111"));

store.upsertGroupDirectory("120363111111111@g.us", {
  subject: "Family",
  participantCount: 12,
});
const group = store.describePeer("120363111111111@g.us");
equal("a stored subject is source subject", group.nameSource, "subject");
equal("group label is the subject", group.label, "Family");
equal("group kind", group.kind, "group");
equal("group member count", group.memberCount, 12);

const unnamed = store.describePeer("120363999999999@g.us");
equal("a group with no subject is source none", unnamed.nameSource, "none");
equal("legacy Group label stays", unnamed.label, "Group");
equal("unnamed group kind", unnamed.kind, "group");
equal("unnamed group has no member count", unnamed.memberCount, null);

section("unknown contacts stay distinct");

const unknown = labelRecipients(
  [
    {
      id: "111111111111111@lid",
      name: "Contact",
      type: "contact",
      nameSource: "none",
    },
    {
      id: "222222222222222@lid",
      name: "Contact",
      type: "contact",
      nameSource: "none",
    },
  ],
  en,
  "en",
);
equal("first unknown title", unknown[0].title, "Unknown contact");
equal("second unknown title", unknown[1].title, "Unknown contact");
ok("subtitles differ", unknown[0].subtitle !== unknown[1].subtitle);
ok("first tail is the last four digits", unknown[0].subtitle.includes("1111"));
ok("second tail is the last four digits", unknown[1].subtitle.includes("2222"));
ok(
  "no full LID or @ in either subtitle",
  !unknown.some(
    (row) =>
      row.subtitle.includes("@") ||
      row.subtitle.includes("111111111111111") ||
      row.subtitle.includes("222222222222222"),
  ),
);

const collided = labelRecipients(
  [
    {
      id: "111111111111111@lid",
      savedName: "Ahmed",
      name: "Ahmed",
      type: "contact",
      nameSource: "saved",
    },
    {
      id: "222222222222222@lid",
      savedName: "Ahmed",
      name: "Ahmed",
      type: "contact",
      nameSource: "saved",
    },
  ],
  en,
  "en",
);
equal("shared saved title stays", collided[0].title, "Ahmed");
equal("the other shared title stays", collided[1].title, "Ahmed");
ok("both shared rows gain a distinguisher", collided[0].subtitle !== collided[1].subtitle);
ok("first shared row shows its tail", collided[0].subtitle.includes("1111"));
ok("second shared row shows its tail", collided[1].subtitle.includes("2222"));

const family = recipientParts(
  {
    id: "120363111111111@g.us",
    name: "Family",
    type: "group",
    nameSource: "subject",
    memberCount: 12,
  },
  en,
  "en",
);
equal("group title is the subject", family.title, "Family");
equal("English member subtitle", family.subtitle, "12 members");
equal("group kind from the helper", family.kind, "group");

const phoneRow = recipientParts(
  {
    id: "201000000010@s.whatsapp.net",
    name: "Contact",
    phone: "+201000000010",
    type: "contact",
    nameSource: "phone",
  },
  en,
  "en",
);
ok("a phone-only title starts with +", phoneRow.title.startsWith("+"));
ok("a phone-only title is not Contact", phoneRow.title !== "Contact");
equal("phone-only subtitle is empty", phoneRow.subtitle, "");
equal("phone-only title keeps the digits", phoneDigits(phoneRow.title), "201000000010");

section("member-count plural keys");

for (const locale of LOCALES) {
  const text = copy(locale);
  for (const category of MEMBER_CATEGORIES) {
    const key = `recipientMembers_${category}`;
    const value = text(key);
    ok(`${locale} ${key} is a string with {count}`, value.includes("{count}") && value !== key);
  }
}
const arabicForms = MEMBER_CATEGORIES.map((category) => ar(`recipientMembers_${category}`));
ok(
  "Arabic plural forms are not one string",
  new Set(arabicForms).size > 1,
);
ok("Arabic one is singular", ar("recipientMembers_one").includes("عضو"));
ok("Arabic two is dual", ar("recipientMembers_two").includes("عضوان"));
ok("Arabic many uses the accusative plural", ar("recipientMembers_many").includes("عضوًا"));

const rules = new Intl.PluralRules("ar");
for (const count of [0, 1, 2, 3, 11, 100]) {
  const category = rules.select(count);
  equal(
    `Arabic ${count} uses recipientMembers_${category}`,
    memberCountLabel(count, ar, "ar"),
    fill(ar(`recipientMembers_${category}`), { count }),
  );
}
equal("English one member", memberCountLabel(1, en, "en"), "1 member");
equal("English other members", memberCountLabel(12, en, "en"), "12 members");

section("search ignores spaces, plus and leading zeros");

const listed = {
  id: "201000000010@s.whatsapp.net",
  name: "Contact",
  phone: "+201000000010",
  type: "contact",
  nameSource: "phone",
};
equal("query digits drop plus, spaces and leading zeros", phoneDigits("+20 100"), "20100");
ok(
  "those digits sit inside the stored number",
  phoneDigits("201000000010").includes(phoneDigits("+20 100")),
);
ok("+20 100 matches 201000000010", recipientMatches(listed, "+20 100"));
ok("0020100 matches the same number", recipientMatches(listed, "0020100"));
ok(
  "another unknown LID does not match that query",
  !recipientMatches(
    {
      id: "333333333333333@lid",
      name: "Contact",
      type: "contact",
      nameSource: "none",
    },
    "+20 100",
  ),
);
ok("an empty query matches", recipientMatches(listed, "  "));
ok(
  "a subject match still works",
  recipientMatches(
    { id: "120363111111111@g.us", name: "Family", type: "group", nameSource: "subject" },
    "fam",
  ),
);

finish();
