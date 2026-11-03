import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ltrSegments, templateSegments } from "../frontend/src/views/legal/legal-bidi.mjs";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

function joined(segments) {
  return segments.map((segment) => segment.text).join("");
}

function ltrTexts(segments) {
  return segments.filter((segment) => segment.ltr).map((segment) => segment.text);
}

section("arabic prose");
const ar = JSON.parse(readFileSync(join(ROOT, "src/legal/bundled/ar.json"), "utf8"));
const opening = ar.terms.sections[0].paragraphs[0];
ok("opening starts with Levix", opening.startsWith("Levix"));
const openingSegments = ltrSegments(opening);
equal("opening is one segment", openingSegments.length, 1);
equal("opening is not ltr", openingSegments[0].ltr, false);
equal("opening text", openingSegments[0].text, opening);

section("technical tokens");
const dated = "الإصدار 2026-11-02.1 ساري من 2026-11-02.";
const datedSegments = ltrSegments(dated);
equal("dated round-trip", joined(datedSegments), dated);
equal("date tokens", ltrTexts(datedSegments).join(" "), "2026-11-02.1 2026-11-02");
equal("date period stays outside", datedSegments.at(-1).text, ".");
equal("date period is not ltr", datedSegments.at(-1).ltr, false);

const linked = "الموقع https://levix.leviro.net.";
const linkedSegments = ltrSegments(linked);
equal("url round-trip", joined(linkedSegments), linked);
equal("url token", ltrTexts(linkedSegments).join(""), "https://levix.leviro.net");
equal("url period stays outside", linkedSegments.at(-1).text, ".");
equal("url period is not ltr", linkedSegments.at(-1).ltr, false);

for (const tail of [".", ",", ";", ":", ")", '".', ")."]) {
  const sample = `انظر https://levix.leviro.net${tail}`;
  const parts = ltrSegments(sample);
  equal(`url tail ${JSON.stringify(tail)}`, ltrTexts(parts).join(""), "https://levix.leviro.net");
  equal(`url tail round-trip ${JSON.stringify(tail)}`, joined(parts), sample);
}

const http = ltrSegments("انظر http://example.com.");
equal("http url", ltrTexts(http).join(""), "http://example.com");

const versioned = "البناء 4.9.2 و 4.9.2+android.70.";
const versionSegments = ltrSegments(versioned);
equal("version round-trip", joined(versionSegments), versioned);
equal("version tokens", ltrTexts(versionSegments).join(" "), "4.9.2 4.9.2+android.70");

const mailed = "راسل ops@leviro.net.";
const mailSegments = ltrSegments(mailed);
equal("mail round-trip", joined(mailSegments), mailed);
equal("mail token", ltrTexts(mailSegments).join(""), "ops@leviro.net");

const sha = ltrSegments("تجزئة SHA-256 الخاصة");
equal("SHA-256 is one segment", sha.length, 1);
equal("SHA-256 is not ltr", sha[0].ltr, false);
const shaParagraph = [ar.terms, ar.privacy]
  .flatMap((part) => part.sections.flatMap((block) => block.paragraphs))
  .find((paragraph) => paragraph.includes("SHA-256"));
ok("bundled Arabic mentions SHA-256", Boolean(shaParagraph));
equal(
  "bundled SHA-256 is not a token",
  shaParagraph ? ltrTexts(ltrSegments(shaParagraph)).length : -1,
  0,
);

section("bundled paragraphs");
for (const locale of ["ar", "en", "pt-BR", "es-419"]) {
  const doc = JSON.parse(readFileSync(join(ROOT, "src/legal/bundled", `${locale}.json`), "utf8"));
  let count = 0;
  for (const part of [doc.terms, doc.privacy]) {
    for (const block of part.sections) {
      for (const paragraph of block.paragraphs) {
        count += 1;
        equal(`${locale} #${count}`, joined(ltrSegments(paragraph)), paragraph);
      }
    }
  }
  ok(`${locale} has paragraphs`, count > 0);
}

section("template segments");
const template = "الإصدار {version} · ساري المفعول من {date} {unknown}";
const filled = templateSegments(template, { version: "2026-11-02.1", date: "2026-11-02" });
equal("two ltr values", filled.filter((segment) => segment.ltr).length, 2);
equal("version value", filled.find((segment) => segment.text === "2026-11-02.1")?.ltr, true);
equal("date value", filled.find((segment) => segment.text === "2026-11-02")?.ltr, true);
equal(
  "unknown stays literal",
  joined(filled),
  "الإصدار 2026-11-02.1 · ساري المفعول من 2026-11-02 {unknown}",
);
equal(
  "unknown placeholder is not ltr",
  filled.find((segment) => segment.text === "{unknown}")?.ltr,
  false,
);

finish();
