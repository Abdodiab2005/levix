// Android entry. Prints identity, proves node:sqlite, then starts Levix
// with the panel on loopback and no desktop browser.
console.log("version " + process.version);
console.log("platform " + process.platform);
console.log("arch " + process.arch);

try {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE t (x INTEGER); INSERT INTO t VALUES (1)");
  const row = db.prepare("SELECT x FROM t").get();
  db.close();
  if (!row || row.x !== 1) throw new Error("sqlite round-trip failed");
  console.log("sqlite ok");
} catch (error) {
  console.log("sqlite error " + (error && error.message ? error.message : error));
  process.exit(1);
}

import readline from "node:readline";

let session = null;

const rl = readline.createInterface({
  input: process.stdin,
  terminal: false,
});

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (trimmed === "network offline") {
    const s = session || (await import("./src/index.js")).getLiveSession();
    if (s?.setInternetOnline) {
      await s.setInternetOnline(false).catch(() => {});
    }
  } else if (trimmed === "network online") {
    const s = session || (await import("./src/index.js")).getLiveSession();
    if (s?.setInternetOnline) {
      await s.setInternetOnline(true).catch(() => {});
    }
  }
});

const { attach } = await import("./src/bootstrap/events.cjs");
attach((event, payload) => {
  if (event === "session" && payload) {
    const code = payload.lastDisconnect?.statusCode ?? "";
    const reason = payload.lastDisconnect?.reason ?? "";
    console.log(`whatsapp session ${payload.state}|${code}|${reason}`);
  }
});

const { start, getLiveSession } = await import("./src/index.js");
const app = await start({ headless: false, open: false });
session = app?.session || getLiveSession();
