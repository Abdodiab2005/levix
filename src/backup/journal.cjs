const fs = require("node:fs");
const path = require("node:path");
const { dataPath, ensureDataDir } = require("../config/paths.cjs");
const { fsyncDirectory } = require("../db/db.cjs");

const root = () => {
  const folder = ensureDataDir("restore");
  if (process.platform !== "win32") fs.chmodSync(folder, 0o700);
  return folder;
};
const journalPath = () => dataPath("restore", "journal.json");

function atomicJson(file, value) {
  const folder = path.dirname(file);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const temp = `${file}.${require("node:crypto").randomBytes(8).toString("hex")}.part`;
  try {
    fs.writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    const fd = fs.openSync(temp, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, file);
    fsyncDirectory(folder);
  } finally { fs.rmSync(temp, { force: true }); }
}

function writeJournal(value) { atomicJson(path.join(root(), "journal.json"), value); }
function readJournal() {
  try { return JSON.parse(fs.readFileSync(journalPath(), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
function clearJournal() {
  fs.rmSync(journalPath(), { force: true });
  fsyncDirectory(root());
}
function writeOutcome(value) { atomicJson(dataPath("restore", "last-outcome.json"), value); }
function readOutcome() {
  try { return JSON.parse(fs.readFileSync(dataPath("restore", "last-outcome.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

module.exports = { writeJournal, readJournal, clearJournal, writeOutcome, readOutcome, atomicJson };
