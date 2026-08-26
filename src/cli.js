// The `levix` command.
//
// Kept here rather than in bin/levix.js so the packaged executable can use the
// same entry point: bin/ is a two-line wrapper, and scripts/build-sea.mjs
// bundles this file. Every branch imports what it needs and nothing else —
// `levix where` must not start a database, let alone WhatsApp.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

const MIN_MAJOR = 24;

function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major >= MIN_MAJOR) return;

  console.error(
    [
      "",
      `  ${pkg.name} needs Node ${MIN_MAJOR} or newer (you have ${process.versions.node}).`,
      "",
      "  It stores everything in SQLite, which Node ships with itself from",
      `  version ${MIN_MAJOR} on — that is what makes the install a single command`,
      "  with nothing to compile.",
      "",
      "  Get it from https://nodejs.org (pick the LTS build).",
      "",
    ].join("\n")
  );
  process.exit(1);
}

function help() {
  console.log(
    [
      "",
      `  ${pkg.name} ${pkg.version} — ${pkg.description}`,
      "",
      "  Usage",
      "    levix                    start Levix with the web panel",
      "    levix headless           start Levix with no web UI at all",
      "    levix where              print the data directory",
      "    levix reset-password     reset the panel password",
      "    levix domain [name]      point a domain at Levix (may need sudo)",
      "",
      "  Options",
      "    --data <dir>             keep the database and files somewhere else",
      "    --headless               same as the headless command",
      "    --no-open                don't open a browser on start",
      "    --version, --help",
      "",
      "  Everything else is configured from the control panel itself,",
      "  which prints its address when the bot starts.",
      "",
    ].join("\n")
  );
}

// The command is the first argument that isn't a flag or a flag's value.
// `levix --data /var/lib/levix where` has to run `where`, not start the bot —
// which is exactly how someone debugging a systemd install types it.
const FLAGS_WITH_VALUES = new Set(["--data"]);

export function parseArgv(argv) {
  const flags = new Set();
  const positional = [];

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS_WITH_VALUES.has(arg)) {
      i += 1; // skip its value
      continue;
    }
    if (arg.startsWith("-")) {
      flags.add(arg.split("=")[0]);
      continue;
    }
    positional.push(arg);
  }

  return { command: positional[0] ?? null, positional, flags };
}

export async function main(argv = process.argv) {
  const { command, positional, flags } = parseArgv(argv);

  if (flags.has("--help") || flags.has("-h") || command === "help") {
    help();
    return 0;
  }

  if (flags.has("--version") || flags.has("-v")) {
    console.log(pkg.version);
    return 0;
  }

  checkNode();

  switch (command) {
    case "where": {
      const { DATA_DIR } = await import("./config/paths.cjs");
      console.log(DATA_DIR);
      return 0;
    }

    case "reset-password": {
      const store = (await import("./db/store.cjs")).default;
      const { close } = await import("./db/db.cjs");
      store.deleteBotSetting("auth:password");
      close();
      console.log(
        "\n  Password cleared. Start the bot and open the panel to choose a new one.\n"
      );
      return 0;
    }

    case "domain": {
      const { runDomainCommand } = await import("./domain/command.js");
      return runDomainCommand({
        domain: positional[1] ?? null,
        assumeYes: flags.has("--yes") || flags.has("-y"),
      });
    }

    case "headless":
    case null:
    case undefined: {
      const { start } = await import("./index.js");
      await start({
        headless: command === "headless" || flags.has("--headless"),
        open: !flags.has("--no-open"),
      });
      // The bot keeps the process alive on its own from here.
      return null;
    }

    default:
      console.error(`\n  Unknown command: ${command}\n`);
      help();
      return 1;
  }
}

/** Entry point for bin/levix.js and for the packaged executable. */
export async function run(argv = process.argv) {
  const code = await main(argv);
  // `null` means "the bot is running now" — exiting would kill it.
  if (code !== null) process.exit(code);
}

export default run;
