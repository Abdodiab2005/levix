// The one directory the bot writes to.
//
// Database, long-term memory, the editable AI persona, logs, temp media —
// all of it lands under a single directory, so "back up the bot" means copying
// one folder and a packaged or globally installed copy never writes next to
// its own code.
//
// Resolution order:
//
//   1. `--data <dir>` on the command line
//   2. LEVIX_DATA_DIR — how a container is told where its volume is. It is the
//      one environment variable the bot reads, because a Docker volume has no
//      other way to say it.
//   3. `<repo>/data` when running from a clone (writable, not inside
//      node_modules) — keeps a developer's data next to the code
//   4. `~/.levix` — global installs, packaged binaries, read-only images
//
// This module deliberately has no dependencies: the logger and the database
// both need it, and neither can wait for the other.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");

function argDataDir() {
  const index = process.argv.indexOf("--data");
  if (index !== -1 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((arg) => arg.startsWith("--data="));
  return inline ? inline.slice("--data=".length) : null;
}

function isWritable(dir) {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveDataDir() {
  const explicit = argDataDir() || process.env.LEVIX_DATA_DIR;
  if (explicit) return path.resolve(explicit);

  const installed = ROOT.includes(`${path.sep}node_modules${path.sep}`);
  if (!installed && isWritable(ROOT)) return path.join(ROOT, "data");

  return path.join(os.homedir(), ".levix");
}

const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });

// Where the read-only files that ship with the bot live: views/, public/, the
// persona template. Normally that is the package itself. A packaged build
// (a single executable has no package directory) unpacks them somewhere the
// filesystem can see and points this at that copy instead.
let assetRoot = ROOT;

function setAssetRoot(dir) {
  assetRoot = dir;
}

/** A path to a file that ships with the bot and is never written to. */
function assetPath(...parts) {
  return path.join(assetRoot, ...parts);
}

/** A path inside the data directory. Creates nothing — callers do that. */
function dataPath(...parts) {
  return path.join(DATA_DIR, ...parts);
}

/** Same, but the directory is created first. */
function ensureDataDir(...parts) {
  const dir = dataPath(...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  DATA_DIR,
  PACKAGE_ROOT: ROOT,
  dataPath,
  ensureDataDir,
  assetPath,
  setAssetRoot,
};
