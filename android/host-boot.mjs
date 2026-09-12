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

const { run } = await import("./src/cli.js");
await run(["node", "bin/levix.js", "--no-open"]);
