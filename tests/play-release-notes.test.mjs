// The Google Play "What's new" text comes from the release approval comment.
// A mistake here either fails a release after it was approved or ships the
// wrong words to every Play user, so the parsing rules are pinned.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NOTES_MAX, parseNotes } from "../scripts/play-release-notes.mjs";
import { equal, finish, ok, ROOT, section, throws } from "./harness.mjs";

const work = mkdtempSync(join(tmpdir(), "levix-play-notes-"));
process.on("exit", () => {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {}
});

section("plain text is the default language");
{
  const notes = parseNotes("  Faster Sticker Studio.\r\nArabic login screens.  \n");
  equal("one section", notes.size, 1);
  equal(
    "en-US body, CRLF and edges cleaned",
    notes.get("en-US"),
    "Faster Sticker Studio.\nArabic login screens.",
  );
}

section("bracketed language headers split the notes");
{
  const notes = parseNotes(
    "Sticker paging fixes.\n\n[ar]\nإصلاحات في صفحات الملصقات.\n[en-GB]\nSticker paging fixes, en-GB.",
  );
  equal("three languages, in order", [...notes.keys()].join(","), "en-US,ar,en-GB");
  equal("ar body", notes.get("ar"), "إصلاحات في صفحات الملصقات.");
  const headed = parseNotes("[ar]\nعربي فقط");
  equal("a comment can start with a header", [...headed.keys()].join(","), "ar");
}

section("ordinary lines are never headers");
{
  const notes = parseNotes("fix: login works again\nar: this line is text\n[not a header] either");
  equal("still one section", notes.size, 1);
  ok("colon lines kept", notes.get("en-US").includes("ar: this line is text"));
}

section("what fails before Google Play is touched");
{
  throws("empty comment", () => parseNotes("   \n "));
  throws("headers without notes", () => parseNotes("[ar]\n[en-US]\n"));
  throws("the same language twice", () => parseNotes("one\n[en-US]\ntwo"));
  throws(`more than ${NOTES_MAX} characters`, () => parseNotes("x".repeat(NOTES_MAX + 1)));
  equal(
    "exactly the limit passes",
    parseNotes("ب".repeat(NOTES_MAX)).get("en-US").length,
    NOTES_MAX,
  );
}

section("the CLI writes the whatsNewDirectory layout");
{
  const comment = join(work, "comment.txt");
  const out = join(work, "whatsnew");
  writeFileSync(comment, "English notes.\n[ar]\nملاحظات عربية.\n");
  const run = spawnSync("node", [join(ROOT, "scripts", "play-release-notes.mjs"), comment, out], {
    encoding: "utf8",
  });
  equal("exit 0", run.status, 0);
  equal("one file per language", readdirSync(out).sort().join(","), "whatsnew-ar,whatsnew-en-US");
  equal("ar file content", readFileSync(join(out, "whatsnew-ar"), "utf8"), "ملاحظات عربية.\n");

  writeFileSync(comment, "");
  const empty = spawnSync(
    "node",
    [join(ROOT, "scripts", "play-release-notes.mjs"), comment, join(work, "none")],
    {
      encoding: "utf8",
    },
  );
  equal("empty comment exits 1", empty.status, 1);
  ok("and says why in a workflow error", empty.stderr.includes("::error::"));
}

finish();
