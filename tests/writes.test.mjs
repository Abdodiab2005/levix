// "Copying the data directory is a full backup."
//
// That sentence is in the README, and it is only true if nothing important is
// written anywhere else. This test runs the panel with a throwaway working
// directory and a throwaway HOME, exercises the paths that write files —
// settings, the AI persona, the long-term memory, logs, the database — and
// then checks what appeared where.
//
// It is an outcome test, not an instrumentation test: it asks what is on disk
// afterwards, which is the same question a person restoring a backup asks.

import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { useTempDataDir, httpClient, ROOT, section, ok, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-writes");
const workDir = mkdtempSync(join(tmpdir(), "levix-cwd-"));
const homeDir = mkdtempSync(join(tmpdir(), "levix-home-"));

function listFiles(root, prefix = "") {
  if (!existsSync(root)) return [];
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

const repoBefore = new Set(listFiles(ROOT).filter((f) => !f.startsWith("node_modules/")));

// --- run the panel somewhere else entirely --------------------------------

const child = spawn(
  process.execPath,
  [join(ROOT, "tests", "fixtures", "server.mjs"), "--data", dataDir, "--trust", "", "--routes"],
  {
    cwd: workDir,
    env: { ...process.env, LEVIX_DATA_DIR: dataDir, HOME: homeDir },
    stdio: ["ignore", "pipe", "pipe"],
  }
);

let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk));

const address = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`did not start\n${stderr}`)), 20000);
  let buffered = "";
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const match = /^LISTENING (.+)$/m.exec(buffered);
    if (match) {
      clearTimeout(timer);
      resolve(match[1].trim());
    }
  });
});

const http = httpClient(`http://${address}`);

try {
  section("exercise everything that writes");

  await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });

  // A setting (database), the persona (a file), a memory entry (another file).
  await http.json("/dashboard/api/settings", { key: "gemini_model", value: "gemini-x" }, "PATCH");

  const persona = await http.call("/dashboard/api/ai/persona");
  ok("the persona is readable", persona.status === 200);
  const current = (await persona.json()).persona?.body ?? "بوت واتساب";
  equal(
    "the persona is writable",
    (await http.json("/dashboard/api/ai/persona", { body: `${current}\nتم` }, "PUT")).status,
    200
  );

  equal(
    "a memory file is writable",
    (await http.json("/dashboard/api/ai/memory/global", { content: "- a remembered fact\n" }, "PUT"))
      .status,
    200
  );
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
}

// --- where did it all land? ----------------------------------------------

section("everything mutable is inside the data directory");

const dataFiles = listFiles(dataDir);

for (const expected of ["levix.db", "logs/combined.log", "ai-persona.md"]) {
  ok(`the data directory holds ${expected}`, dataFiles.some((f) => f === expected), dataFiles.join(" "));
}
ok(
  "…and the memory file",
  dataFiles.some((f) => f.startsWith("memory/")),
  dataFiles.join(" ")
);

section("and nothing landed anywhere else");

const workFiles = listFiles(workDir);
ok("the working directory is untouched", workFiles.length === 0, workFiles.join(" "));

// ~/.levix would be the fallback data directory; with LEVIX_DATA_DIR set,
// nothing may go near HOME at all.
const homeFiles = listFiles(homeDir);
ok("HOME is untouched", homeFiles.length === 0, homeFiles.join(" "));

const repoAfter = listFiles(ROOT).filter((f) => !f.startsWith("node_modules/"));
const appeared = repoAfter.filter((f) => !repoBefore.has(f));
ok("the installation directory gained no files", appeared.length === 0, appeared.join(" "));

section("the source tree writes nothing at runtime");

// The legacy folders the bot used to write into, before there was a data
// directory. If one of these comes back, a backup silently stops being one.
for (const legacy of ["logs", "memory", "media", "data", "auth_info_baileys"]) {
  const path = join(workDir, legacy);
  ok(`no ${legacy}/ appears beside the process`, !existsSync(path));
}

// A packaged build extracts read-only assets into the data directory; that is
// the one intentional exception and it lives inside the backup, not outside.
ok(
  "the data directory is a directory we can copy",
  statSync(dataDir).isDirectory() && dataFiles.length > 0
);

finish();
