// The "What's new" text of a Google Play release, taken from the comment the
// reviewer writes when approving the google-play environment in the release
// workflow.
//
// Plain text is the notes for the default language (en-US). A line holding
// only a Play language code in brackets, such as [ar] or [en-US], starts the
// notes for that language. Google Play allows 500 characters per language.
//
//   node scripts/play-release-notes.mjs <comment-file> <out-dir>
//
// writes <out-dir>/whatsnew-<language>, the layout upload-google-play's
// whatsNewDirectory reads. An empty comment or an over-long section fails the
// job before anything reaches Google Play.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NOTES_MAX = 500;
export const DEFAULT_LANGUAGE = "en-US";
const HEADER = /^\[([a-z]{2,3}(?:-[A-Z]{2})?)\]$/;

/** @returns {Map<string, string>} language -> notes, in comment order */
export function parseNotes(comment) {
  const text = String(comment ?? "")
    .replace(/\r\n?/g, "\n")
    .trim();
  if (!text) {
    throw new Error(
      "The approval comment is empty. It becomes the release's What's new text: re-run the job and approve with a message.",
    );
  }
  const sections = new Map();
  let language = DEFAULT_LANGUAGE;
  let lines = [];
  const flush = () => {
    const body = lines.join("\n").trim();
    lines = [];
    if (!body) return;
    if (sections.has(language)) throw new Error(`The comment has two [${language}] sections.`);
    sections.set(language, body);
  };
  for (const line of text.split("\n")) {
    const header = HEADER.exec(line.trim());
    if (header) {
      flush();
      language = header[1];
    } else {
      lines.push(line);
    }
  }
  flush();
  if (sections.size === 0)
    throw new Error("The approval comment has language headers but no notes.");
  for (const [lang, body] of sections) {
    const length = [...body].length;
    if (length > NOTES_MAX) {
      throw new Error(
        `The [${lang}] notes are ${length} characters; Google Play allows ${NOTES_MAX}.`,
      );
    }
  }
  return sections;
}

export function writeNotes(sections, outDir) {
  mkdirSync(outDir, { recursive: true });
  for (const [lang, body] of sections) writeFileSync(join(outDir, `whatsnew-${lang}`), `${body}\n`);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [commentFile, outDir] = process.argv.slice(2);
  if (!commentFile || !outDir) {
    console.error("usage: node scripts/play-release-notes.mjs <comment-file> <out-dir>");
    process.exit(2);
  }
  try {
    const sections = parseNotes(readFileSync(commentFile, "utf8"));
    writeNotes(sections, outDir);
    for (const [lang, body] of sections) {
      console.log(`--- whatsnew-${lang} (${[...body].length}/${NOTES_MAX}) ---\n${body}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
