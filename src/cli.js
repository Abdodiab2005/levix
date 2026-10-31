// The `levix` command.
//
// Kept here rather than in bin/levix.js so the packaged executable can use the
// same entry point: bin/ is a two-line wrapper, and scripts/build-sea.mjs
// bundles this file. Every branch imports what it needs and nothing else —
// `levix where` must not start a database, let alone WhatsApp.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");

// Official builds and tests use Node 24. Older majors lack what Levix needs
// and are refused. Newer majors start with a warning: no official build or
// test runs on them.
const SUPPORTED_MAJOR = 24;

function checkNode() {
  const version = process.versions.node;
  const major = Number(version.split(".")[0]);
  if (major === SUPPORTED_MAJOR) return;

  if (major > SUPPORTED_MAJOR) {
    console.error(
      [
        "",
        `  Warning: Node ${version} is newer than Node ${SUPPORTED_MAJOR}, ` +
          `the version ${pkg.name} is built and`,
        `  tested on. It will start, but Node ${version} is not officially supported, and`,
        "  help with problems on it is best effort. For a supported setup, install",
        `  Node ${SUPPORTED_MAJOR} LTS from https://nodejs.org.`,
        "",
      ].join("\n"),
    );
    return;
  }

  console.error(
    [
      "",
      `  ${pkg.name} needs Node ${SUPPORTED_MAJOR} (you have ${version}).`,
      "",
      "  It stores everything in SQLite, which Node ships with itself from",
      `  version ${SUPPORTED_MAJOR} on — that is what makes the install a single command`,
      "  with nothing to compile.",
      "",
      `  Get Node ${SUPPORTED_MAJOR} LTS from https://nodejs.org.`,
      "",
    ].join("\n"),
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
    ].join("\n"),
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

/** Run data access as the data directory owner; keep domain setup privileged. */
export function createCliDataIdentity({
  proc = process,
  fs = require("node:fs"),
  dataDir,
} = {}) {
  const direct = async (fn) => fn();
  if (proc.getuid?.() !== 0) return direct;

  const directory = dataDir ?? require("./config/data-dir.cjs").DATA_DIR;
  let owner;
  try {
    owner = fs.lstatSync(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("Create the Levix data directory as the service user before running this command with sudo");
    }
    throw error;
  }
  if (owner.isSymbolicLink() || !owner.isDirectory()) {
    throw new Error("Levix data directory must be a real directory for sudo commands");
  }
  if (owner.uid === 0) return direct;

  return async (fn) => {
    proc.setegid(owner.gid);
    let changedUid = false;
    try {
      proc.seteuid(owner.uid);
      changedUid = true;
      return await fn();
    } finally {
      try {
        if (changedUid) proc.seteuid(0);
      } finally {
        proc.setegid(0);
      }
    }
  };
}

/** CLI commands that use settings share the same lock and schema boundary. */
export async function withCliDatabase(fn) {
  const asDataOwner = createCliDataIdentity();
  const { DATA_UNAVAILABLE } = (await import("./config/exit-codes.cjs")).default;
  let lock;
  let database;
  let ownsLock = false;
  try {
    const ready = await asDataOwner(async () => {
      lock = (await import("./config/lock.cjs")).default;
      database = (await import("./db/db.cjs")).default;
      try {
        lock.acquireSingleInstanceLock();
        ownsLock = true;
      } catch (error) {
        if (error.code !== "ELEVIXLOCKED") throw error;
      }
      if (ownsLock) {
        await database.prepareDatabase();
        await (await import("./backup/recovery.cjs")).default.runRestoreRecovery();
      } else {
        const current = database.schemaVersion(database.openWithoutMigration());
        if (current !== database.MIGRATIONS.length) {
          console.error(`Cannot access this data directory while Levix runs: schema ${current} differs from this build's schema ${database.MIGRATIONS.length}. Stop Levix and use the matching version.`);
          return false;
        }
      }
      return true;
    });
    if (!ready) return DATA_UNAVAILABLE;
    return await fn(asDataOwner);
  } finally {
    if (database) await asDataOwner(async () => {
      try {
        database.close();
      } finally {
        if (ownsLock) lock.release();
      }
    });
  }
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
      return withCliDatabase(async (asDataOwner) => {
        const store = (await import("./db/store.cjs")).default;
        await asDataOwner(() => store.deleteBotSetting("auth:password"));
        console.log("\n  Password cleared. Start the bot and open the panel to choose a new one.\n");
        return 0;
      });
    }

    case "domain": {
      return withCliDatabase(async (asDataOwner) => {
        const { runDomainCommand } = await import("./domain/command.js");
        return runDomainCommand({
          domain: positional[1] ?? null,
          assumeYes: flags.has("--yes") || flags.has("-y"),
          asDataOwner,
        });
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
  let code;
  try {
    code = await main(argv);
  } catch (error) {
    const classified = (await import("./config/exit-codes.cjs")).default.exitCodeFor(error);
    if (classified !== null) {
      console.error(error.message);
      code = classified;
    } else {
      throw error;
    }
  }
  // `null` means "the bot is running now" — exiting would kill it.
  if (code !== null) process.exit(code);
}

export default run;
