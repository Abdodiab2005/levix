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

import fs from "node:fs";
import readline from "node:readline";
import tls from "node:tls";

// Termux builds Node to trust OpenSSL's default store, which points at
// /data/data/com.termux/files/usr/etc/tls. Levix has no such directory, so
// every TLS handshake failed with UNABLE_TO_GET_ISSUER_CERT_LOCALLY, and
// Baileys reported it as close 500. Trust Node's bundled roots plus Android's
// own store (updated with the OS) instead.
const ANDROID_CA_DIRS = ["/apex/com.android.conscrypt/cacerts", "/system/etc/security/cacerts"];
try {
  const certs = new Set(tls.getCACertificates("bundled"));
  for (const dir of ANDROID_CA_DIRS) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      try {
        const pem = fs
          .readFileSync(`${dir}/${file}`, "utf8")
          .match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
        if (pem) certs.add(`${pem[0]}\n`);
      } catch {}
    }
    break;
  }
  tls.setDefaultCACertificates([...certs]);
  console.log("ca ok " + certs.size);
} catch (error) {
  console.log("ca error " + (error && error.message ? error.message : error));
}

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
function reportSession(payload) {
  const code = payload.lastDisconnect?.statusCode ?? "";
  const reason = payload.lastDisconnect?.reason ?? "";
  console.log(`whatsapp session ${payload.state}|${code}|${reason}`);
}

attach((event, payload) => {
  if (event === "session" && payload) reportSession(payload);
});

const { exitCodeFor } = (await import("./src/config/exit-codes.cjs")).default;
try {
  const { start, getLiveSession } = await import("./src/index.js");
  const app = await start({ headless: false, open: false });
  session = app?.session || getLiveSession();
  // An unpaired session begins idle and emits no transition. Send the actual
  // initial snapshot too, so Android can guide pairing without guessing.
  if (session) reportSession(session.getState());
} catch (error) {
  const code = exitCodeFor(error);
  if (code === null) throw error;
  console.error(error.message);
  process.exit(code);
}
