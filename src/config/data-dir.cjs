// Resolve the data directory without creating it. Sudo CLI commands inspect
// its owner before loading modules that may write there.
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

module.exports = { ROOT, DATA_DIR };
