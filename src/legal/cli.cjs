// `levix terms`: read and accept the Terms from a terminal (ADR-006, Q-04).
//
//   levix terms                     print, then ask the operator to type "accept"
//   levix terms show [--lang l]     print the documents, the version and the hash
//   levix terms status              exit 0 when accepted, 2 when not
//   levix terms accept --terms-version <v> --sha256 <hash> [--lang l]
//                                   unattended installs: record only an exact match
//   levix terms revoke              delete the acceptance
//
// The interactive form refuses without a terminal on both ends, so a pipe or a
// script can never type the confirmation. The provisioning form needs the
// version and the hash the operator read with `show`. There is no start flag
// and no environment variable that accepts.

const consent = require("./consent.cjs");
const terms = require("./terms.cjs");

const WIDTH = 78;
const EXIT = Object.freeze({ OK: 0, REFUSED: 1, REQUIRED: 2 });

function wrap(text, indent) {
  const lines = [];
  let current = "";
  for (const word of text.split(/\s+/)) {
    if (current && indent.length + current.length + 1 + word.length > WIDTH) {
      lines.push(indent + current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) lines.push(indent + current);
  return lines;
}

function renderPart(part) {
  const lines = [part.title, "=".repeat(Math.min(part.title.length, WIDTH)), ""];
  for (const section of part.sections) {
    lines.push(section.heading);
    for (const paragraph of section.paragraphs) lines.push(...wrap(paragraph, "  "), "");
  }
  return lines;
}

/** The two documents, then what identifies them and the links that belong to them. */
function renderDocument(entry) {
  return [
    "",
    ...renderPart(entry.document.terms),
    ...renderPart(entry.document.privacy),
    `Version:  ${entry.version}`,
    `Language: ${entry.locale}`,
    `SHA-256:  ${entry.sha256}`,
    "",
    `Full Privacy Policy: ${terms.LINKS.privacyPolicy}`,
    `License:             ${terms.LINKS.license}`,
    `Website:             ${terms.LINKS.website}`,
    "",
  ];
}

function pickDocument(values, io) {
  const requested = values.get("--lang");
  const locale = requested ?? terms.DEFAULT_LOCALE;
  const entry = terms.documentFor(locale);
  if (!entry) {
    io.error(`No Terms in "${locale}". Available: ${terms.availableLocales().join(", ")}.`);
    return null;
  }
  return entry;
}

function statusLine(status) {
  if (status.ok) {
    const a = status.accepted;
    return `Accepted: Terms ${a.termsVersion} (${a.locale}) on ${a.acceptedAt}, with Levix ${a.appVersion}.`;
  }
  return `Not accepted: ${consent.describeReason(status.reason)}`;
}

const AFTER_ACCEPT =
  "Accepted. Levix connects to WhatsApp on its next start; a running Levix continues within a few seconds.";

/**
 * Run one `levix terms` subcommand.
 *
 * `io`: `{ out(line), error(line), isInteractive, ask(question) -> Promise<string> }`.
 * `asDataOwner` wraps every database write (sudo runs as the data directory owner).
 */
async function runTerms({ positional = [], values = new Map(), io, asDataOwner = (fn) => fn() }) {
  const sub = positional[1] ?? null;
  const print = (lines) => {
    for (const line of lines) io.out(line);
  };

  try {
    terms.currentRelease();
  } catch (error) {
    io.error(`The bundled Terms are not usable: ${error.message}`);
    return EXIT.REFUSED;
  }

  switch (sub) {
    case "show": {
      const entry = pickDocument(values, io);
      if (!entry) return EXIT.REFUSED;
      print(renderDocument(entry));
      print([
        "To accept this exact text on an unattended install, run:",
        `  levix terms accept --terms-version ${entry.version} --sha256 ${entry.sha256}` +
          (entry.locale === terms.DEFAULT_LOCALE ? "" : ` --lang ${entry.locale}`),
        "",
      ]);
      return EXIT.OK;
    }

    case "status": {
      const status = consent.consentStatus();
      io.out(statusLine(status));
      return status.ok ? EXIT.OK : EXIT.REQUIRED;
    }

    case "accept": {
      const version = values.get("--terms-version");
      const sha256 = values.get("--sha256");
      if (!version || !sha256) {
        io.error("Usage: levix terms accept --terms-version <version> --sha256 <hash> [--lang <language>]");
        io.error('Read the Terms and get both values with "levix terms show".');
        return EXIT.REFUSED;
      }
      const entry = pickDocument(values, io);
      if (!entry) return EXIT.REFUSED;
      try {
        await asDataOwner(() =>
          consent.recordAcceptance({ version, sha256: sha256.toLowerCase(), locale: entry.locale, via: "provision" }),
        );
      } catch (error) {
        if (error.code !== "TERMS_MISMATCH") throw error;
        io.error("Not accepted: that version and SHA-256 do not match the current Terms.");
        io.error(`Read the current text with "levix terms show${entry.locale === terms.DEFAULT_LOCALE ? "" : ` --lang ${entry.locale}`}".`);
        return EXIT.REFUSED;
      }
      io.out(AFTER_ACCEPT);
      return EXIT.OK;
    }

    case "revoke": {
      await asDataOwner(() => consent.revokeAcceptance());
      io.out("Acceptance removed. A live WhatsApp connection stays up; Levix asks again before it next connects.");
      return EXIT.OK;
    }

    case null: {
      if (!io.isInteractive) {
        io.error('"levix terms" needs a terminal to ask for your confirmation.');
        io.error('On an unattended install, run "levix terms show", then "levix terms accept".');
        return EXIT.REFUSED;
      }
      const entry = pickDocument(values, io);
      if (!entry) return EXIT.REFUSED;
      print(renderDocument(entry));
      const answer = await io.ask(
        'Type "accept" to accept the Terms of Use and the Privacy Notice for this installation.\nAnything else cancels: ',
      );
      if (String(answer ?? "").trim().toLowerCase() !== "accept") {
        io.out("Not accepted. Levix will not connect to WhatsApp until the Terms are accepted.");
        return EXIT.REFUSED;
      }
      await asDataOwner(() =>
        consent.recordAcceptance({ version: entry.version, sha256: entry.sha256, locale: entry.locale, via: "cli" }),
      );
      io.out(AFTER_ACCEPT);
      return EXIT.OK;
    }

    default:
      io.error(`Unknown terms command: ${sub}. Use show, status, accept or revoke.`);
      return EXIT.REFUSED;
  }
}

/** The real terminal. */
function terminalIo({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr } = {}) {
  return {
    out: (line) => stdout.write(`${line}\n`),
    error: (line) => stderr.write(`${line}\n`),
    isInteractive: Boolean(stdin.isTTY && stdout.isTTY),
    async ask(question) {
      const readline = require("node:readline/promises");
      const rl = readline.createInterface({ input: stdin, output: stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

module.exports = { EXIT, runTerms, terminalIo, renderDocument };
