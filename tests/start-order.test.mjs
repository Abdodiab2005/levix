// Startup must lock, copy, and migrate in that order, with no WhatsApp socket.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { equal, finish, ok, ROOT, section, throws, useTempDataDir } from "./harness.mjs";

const root = useTempDataDir("levix-start-order");
const fixture = join(ROOT, "tests", "fixtures", "start-order-child.mjs");
const freshDir = (name) => {
  const dir = join(root, name);
  mkdirSync(dir);
  return dir;
};
const envFor = (dir) => ({ ...process.env, LEVIX_DATA_DIR: dir });
function run(mode, dir) {
  const child = spawnSync(process.execPath, [fixture, mode], { env: envFor(dir), encoding: "utf8", timeout: 8000 });
  const line = /^RESULT (.*)$/m.exec(child.stdout);
  ok(`${mode} fixture exits cleanly`, child.status === 0 && !!line, child.stderr || child.stdout);
  return line ? JSON.parse(line[1]) : {};
}
function launch(mode, dir) {
  const child = spawn(process.execPath, [fixture, mode], { env: envFor(dir), stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", resolve));
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  return {
    child,
    closed,
    async firstLine() {
      const deadline = Date.now() + 5000;
      while (!output.includes("\n") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return output.trim().split("\n")[0];
    },
    stop() { child.kill("SIGKILL"); },
  };
}

section("imports and startup guard");
{
  const dir = freshDir("imports");
  equal("store, settings, logger and index do not open the database", run("imports", dir).exists, false);
  equal("no database file", existsSync(join(dir, "levix.db")), false);
  const guarded = run("guard", freshDir("guard"));
  equal("early query has a code", guarded.code, "DATABASE_NOT_PREPARED");
  equal("early query has the stated message", guarded.message, "database used before startup prepared it");
  equal("early query creates no database", guarded.exists, false);
}

section("preparation and backup");
{
  const fresh = run("fresh", freshDir("fresh"));
  equal("fresh start has no copy", fresh.report?.copyPath, null);
  equal("fresh start has no backups folder", fresh.copyExists, false);
  equal("fresh start reaches target schema", fresh.version, fresh.report?.to);

  const old = run("old", freshDir("old"));
  equal("old copy has source schema", old.copyVersion, old.report?.from);
  equal("old upgrade writes exactly one copy", old.copyCount, 1);
  equal("old copy passes integrity check", old.copyIntegrity, "ok");
  equal("copy preserves row", old.copyRow, "kept");
  equal("migrated database preserves row", old.liveRow, "kept");
  equal("migrated database reaches target", old.liveVersion, old.report?.to);
  if (process.platform !== "win32") {
    equal("copy mode", old.fileMode, 0o600);
    equal("folder mode", old.folderMode, 0o700);
  }

  const secrets = run("secrets", freshDir("secrets"));
  equal("copy contains no sentinel bytes", secrets.sentinels.join(","), "");
  equal("copy contains no pairing rows", secrets.authRows, 0);
  equal("copy contains no QR rows", secrets.qrRows, 0);
  equal("copy contains only non-secret bot keys", secrets.botKeys.join(","),
    "prefix,setting:bot_language,test:row");
  ok("secret setting key was seeded", !!secrets.secretKey);
  equal("copy preserves ordinary todo", secrets.todo, '["nonsecret task"]');
  equal("copy preserves prefix", secrets.prefix, '"!"');
  equal("copy schema matches source schema", JSON.stringify(secrets.copySchema), JSON.stringify(secrets.sourceSchema));
  equal("copy retains source version", secrets.version, 1);
  equal("secret-free copy passes integrity check", secrets.integrity, "ok");
  equal("secret-free copy has one final file", secrets.files.filter((name) => name.endsWith(".db")).length, 1);
  if (process.platform !== "win32") equal("secret-free copy mode", secrets.mode, 0o600);

  const rolledBack = run("rollback", freshDir("rollback"));
  equal("previous build opens restored schema", rolledBack.previous?.from, 1);
  equal("restored database remains version 1", rolledBack.version, 1);
  equal("restored database keeps ordinary setting", rolledBack.row, "kept");
  equal("restored database keeps todo", rolledBack.todo, '["nonsecret task"]');
  equal("restored database has no pairing", rolledBack.authRows, 0);
  equal("restored database has no password", rolledBack.password, null);

  const newer = run("newer", freshDir("newer"));
  equal("newer schema is refused", newer.code, "SCHEMA_NEWER");
  equal("newer file is byte identical", newer.after, newer.before);
  equal("newer file has no copy", newer.copied, false);

  const failed = run("copyfail", freshDir("copyfail"));
  equal("copy failure has code", failed.code, "BACKUP_FAILED");
  equal("copy failure leaves file byte identical", failed.after, failed.before);
  equal("copy failure leaves version", failed.version, 1);

  const verificationFailure = run("verifyfail", freshDir("verifyfail"));
  equal("pre-rename failure has code", verificationFailure.code, "BACKUP_FAILED");
  equal("pre-rename failure leaves live bytes unchanged", verificationFailure.after, verificationFailure.before);
  equal("pre-rename failure leaves source version", verificationFailure.version, 1);
  equal("pre-rename failure removes partial and final files", verificationFailure.files.length, 0);

  const migration = run("failure", freshDir("failure"));
  equal("migration error is rethrown", migration.message, "injected migration failure");
  equal("coded migration error has startup classification", migration.code, "MIGRATION_FAILED");
  equal("migration rollback keeps version", migration.version, 1);
  equal("migration rollback keeps row", migration.row, "kept");
  equal("migration rollback removes earlier step", migration.intermediate, undefined);

  const retained = run("retention", freshDir("retention"));
  equal("three upgrades make three distinct copies", new Set(retained.copyPaths).size, 3);
  equal("only newest two copies remain", retained.remaining.join(","), "false,true,true");
}

section("process lifetime lock");
{
  const dir = freshDir("lock");
  const a = launch("hold", dir);
  const b = launch("hold", dir);
  const lines = await Promise.all([a.firstLine(), b.firstLine()]);
  equal("one simultaneous starter wins", lines.filter((line) => line === "HELD").length, 1);
  equal("one simultaneous starter is refused", lines.filter((line) => line.includes("ELEVIXLOCKED")).length, 1);
  a.stop(); b.stop();
  await Promise.all([a.closed, b.closed]);
  equal("claim succeeds immediately after SIGKILL", run("claim", dir).acquired, true);
  writeFileSync(join(dir, "levix.lock"), String(process.pid));
  equal("unrelated live pid hint cannot block", run("claim", dir).acquired, true);
}

if (process.platform === "win32") {
  console.log("  SKIP SIGKILL migration crash: Windows has different termination semantics");
} else {
  section("crash during secret-free copy");
  const copyDir = freshDir("copycrash");
  const killed = spawnSync(process.execPath, [fixture, "copycrash"], {
    env: envFor(copyDir), encoding: "utf8", timeout: 8000,
  });
  equal("copy child died at after-rows", killed.signal, "SIGKILL");
  const beforeHash = /^BEFORE ([a-f0-9]{64})$/m.exec(killed.stdout)?.[1];
  ok("copy child recorded live hash", !!beforeHash);
  const liveFile = join(copyDir, "levix.db");
  equal("copy crash leaves live bytes unchanged",
    createHash("sha256").update(readFileSync(liveFile)).digest("hex"), beforeHash);
  const oldDb = new DatabaseSync(liveFile, { readOnly: true });
  equal("copy crash leaves version 1", oldDb.prepare("PRAGMA user_version").get().user_version, 1);
  oldDb.close();
  const backupDir = join(copyDir, "backups", "pre-migration");
  const partialNames = readdirSync(backupDir);
  equal("copy crash leaves no final copy", partialNames.filter((name) => name.endsWith(".db")).length, 0);
  ok("copy crash leaves a partial file", partialNames.some((name) => name.endsWith(".part")));
  const partialBytes = partialNames.map((name) => readFileSync(join(backupDir, name)).toString("utf8")).join("");
  ok("partial files contain no secret sentinels", !/\b(?:CREDS|SIGNAL|QR|PASSWORD|RECOVERY|SESSION|APIKEY|PROXY)-SENTINEL-/.test(partialBytes));
  const afterCrash = run("recover", copyDir);
  equal("recovery removes stale part", afterCrash.parts.length, 0);
  equal("recovery leaves one final copy", afterCrash.finals.length, 1);
  equal("recovery starts from old schema", afterCrash.prior?.version, 1);
  ok("recovery migrates successfully", afterCrash.report?.to > 1);

  section("crash during migration");
  const dir = freshDir("crash");
  const child = launch("crash", dir);
  equal("child reached migration transaction", await child.firstLine(), "IN_TRANSACTION");
  child.stop();
  await child.closed;
  const recovered = run("recover", dir);
  equal("crash kept old version", recovered.prior?.version, 1);
  equal("crash kept row", recovered.prior?.row, "kept");
  ok("second preparation succeeds", recovered.report?.to > 1);
  equal("second preparation keeps row", recovered.row, "kept");
}

section("password reset with a running process");
for (const [label, expectedCode, expectedPassword] of [["full", 0, null], ["old", 78, "saved"]]) {
  const dir = freshDir(`reset-${label}`);
  run(`reset-${label}`, dir);
  const holder = launch("hold", dir);
  equal(`${label} holder acquired`, await holder.firstLine(), "HELD");
  const before = run("password", dir);
  const reset = spawnSync(process.execPath, [join(ROOT, "bin", "levix.js"), "reset-password"], {
    env: envFor(dir), encoding: "utf8", timeout: 8000,
  });
  equal(`${label} reset exit`, reset.status, expectedCode);
  const after = run("password", dir);
  equal(`${label} password state`, after.password, expectedPassword);
  if (label === "old") {
    equal("pending migration leaves database bytes", after.sha256, before.sha256);
    equal("pending migration leaves schema", after.version, before.version);
  }
  holder.stop();
  await holder.closed;
}

section("domain CLI database boundary");
{
  const dir = freshDir("domain-held");
  run("reset-old", dir);
  const holder = launch("hold", dir);
  equal("domain mismatch holder acquired", await holder.firstLine(), "HELD");
  const refused = run("domain-cli-held", dir);
  equal("domain refuses a different live schema", refused.code, 78);
  equal("domain refusal leaves database bytes", refused.after, refused.before);
  equal("domain refusal leaves schema", refused.version, 1);
  equal("domain refusal writes no setting", refused.domain, null);
  holder.stop();
  await holder.closed;

  const free = freshDir("domain-free");
  run("reset-old", free);
  const written = run("domain-free", free);
  equal("free domain command succeeds", written.code, 0);
  equal("domain callback reached after preparation", written.schemaAtEntry, written.version);
  ok("domain callback ran", written.entered);
  equal("domain setting is saved", written.domain, "bot.example.com");
  ok("old schema was copied before the domain write", written.copied);
}

section("sudo CLI database identity");
{
  const { createCliDataIdentity } = await import("../src/cli.js");
  const calls = [];
  const proc = {
    getuid() { calls.push("getuid"); return 0; },
    setegid(gid) { calls.push(`gid:${gid}`); },
    seteuid(uid) { calls.push(`uid:${uid}`); },
  };
  const fs = {
    lstatSync(file) {
      calls.push(`lstat:${file}`);
      return { uid: 1000, gid: 1001, isDirectory: () => true, isSymbolicLink: () => false };
    },
  };
  const dir = join(root, "identity-fixture");
  const asDataOwner = createCliDataIdentity({ proc, fs, dataDir: dir });
  await asDataOwner(async () => { calls.push("prepare"); });
  calls.push("domain");
  await asDataOwner(async () => { calls.push("close"); });
  equal("database opens and closes as owner; domain work runs as root", calls.join("|"), [
    "getuid", `lstat:${dir}`,
    "gid:1001", "uid:1000", "prepare", "uid:0", "gid:0",
    "domain",
    "gid:1001", "uid:1000", "close", "uid:0", "gid:0",
  ].join("|"));

  const nonRootCalls = [];
  const nonRoot = createCliDataIdentity({
    proc: { getuid() { nonRootCalls.push("getuid"); return 1000; } },
    fs: { lstatSync() { throw new Error("non-root must not inspect data directory"); } },
    dataDir: dir,
  });
  await nonRoot(async () => { nonRootCalls.push("callback"); });
  equal("non-root run does not switch identity or inspect the directory",
    nonRootCalls.join("|"), "getuid|callback");

  throws("sudo rejects a symlink data directory", () => createCliDataIdentity({
    proc: { getuid: () => 0 }, dataDir: dir,
    fs: { lstatSync: () => ({ isSymbolicLink: () => true, isDirectory: () => false }) },
  }));
  throws("sudo rejects a missing data directory", () => createCliDataIdentity({
    proc: { getuid: () => 0 }, dataDir: dir,
    fs: { lstatSync() { const error = new Error("missing"); error.code = "ENOENT"; throw error; } },
  }));
}

section("directory fsync portability");
{
  const { fsyncDirectory } = (await import("../src/db/db.cjs")).default;
  const calls = [];
  fsyncDirectory("backups", {
    openSync() { calls.push("open"); return 7; },
    fsyncSync() { calls.push("fsync"); const error = new Error("unsupported"); error.code = "EPERM"; throw error; },
    closeSync() { calls.push("close"); },
  });
  equal("unsupported directory fsync is skipped and handle closes", calls.join("|"), "open|fsync|close");
  let opens = 0;
  fsyncDirectory("backups", {
    openSync() { opens += 1; const error = new Error("directory open unsupported"); error.code = "EISDIR"; throw error; },
  });
  equal("unsupported directory open is skipped", opens, 1);
  const error = throws("other directory fsync failures still propagate", () => fsyncDirectory("backups", {
    openSync: () => 7,
    fsyncSync() { const failure = new Error("I/O error"); failure.code = "EIO"; throw failure; },
    closeSync() {},
  }));
  equal("unexpected fsync error is preserved", error?.code, "EIO");
}

section("data failure exit code");
{
  const { exitCodeFor } = (await import("../src/config/exit-codes.cjs")).default;
  for (const code of ["SCHEMA_NEWER", "BACKUP_FAILED", "MIGRATION_FAILED", "DATABASE_NOT_PREPARED",
    "ACTIVATION_RECOVERY_FAILED"]) {
    equal(`${code} is terminal on CLI and Android`, exitCodeFor({ code }), 78);
  }
  equal("unrelated failures keep their existing path", exitCodeFor({ code: "EADDRINUSE" }), null);
}

finish();
