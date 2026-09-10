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

async function waitForTls() {
  const attempts = 8;
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch("https://web.whatsapp.com/", {
        method: "HEAD",
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      console.log("tls ok " + response.status);
      return;
    } catch (error) {
      const msg = error && error.message ? error.message : String(error);
      console.log("tls wait " + i + "/" + attempts + " " + msg);
      if (i < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2000 * i));
      } else {
        console.log("tls skipped " + msg);
      }
    }
  }
}

await waitForTls();

const { run } = await import("./src/cli.js");
await run(["node", "bin/levix.js", "--no-open"]);
