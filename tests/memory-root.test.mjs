// The active memory root is always <data>/memory. A one-time copy from
// PACKAGE_ROOT/memory runs through migrateLegacyMemory so tests can point it
// at throwaway folders and never touch the real install.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("memory-root");
const memory = require("./src/utils/memory.cjs");

const temps = [];
process.on("exit", () => {
  for (const dir of temps) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function makeCase() {
  const tmp = mkdtempSync(join(tmpdir(), "levix-memroot-"));
  temps.push(tmp);
  return {
    tmp,
    dataMemoryDir: join(tmp, "memory"),
    legacyDir: join(tmp, "legacy"),
  };
}

function writeRel(root, rel, content) {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function snapshot(file) {
  const st = statSync(file);
  return { bytes: readFileSync(file), mtimeMs: st.mtimeMs, size: st.size };
}

function sameFile(file, snap) {
  if (!existsSync(file)) return false;
  const now = snapshot(file);
  return now.mtimeMs === snap.mtimeMs && now.size === snap.size && now.bytes.equals(snap.bytes);
}

function captureLog() {
  const events = [];
  return {
    events,
    info(obj, msg) {
      events.push({ level: "info", obj, msg });
    },
    warn(obj, msg) {
      events.push({ level: "warn", obj, msg });
    },
    error(obj, msg) {
      events.push({ level: "error", obj, msg });
    },
  };
}

function mdOnDisk(root) {
  const out = [];
  if (existsSync(join(root, "global.md"))) out.push("global.md");
  const chats = join(root, "chats");
  if (!existsSync(chats)) return out;
  for (const name of readdirSync(chats)) {
    if (name.endsWith(".md")) out.push(`chats/${name}`);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------

section("only the data folder: no copy, files used as is");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(dataMemoryDir, "global.md", "DATA-GLOBAL");
  writeRel(dataMemoryDir, "chats/a.md", "DATA-CHAT");
  const snapG = snapshot(join(dataMemoryDir, "global.md"));
  const snapC = snapshot(join(dataMemoryDir, "chats/a.md"));
  const log = captureLog();
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log });

  equal("data-only action is skip", result.action, "skip");
  equal("data-only does not copy", result.copied, false);
  ok("data global.md is unchanged", sameFile(join(dataMemoryDir, "global.md"), snapG));
  ok("data chat file is unchanged", sameFile(join(dataMemoryDir, "chats/a.md"), snapC));
  ok(
    "no marker when nothing was copied",
    !existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)),
  );
  ok(
    "data-only logs no copy and no conflict",
    log.events.every((e) => e.level !== "info" && e.level !== "warn"),
  );
}

section("only legacy files: copied once, byte-identical, legacy untouched");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "LEGACY-GLOBAL");
  writeRel(legacyDir, "chats/x.md", "LEGACY-CHAT");
  writeRel(legacyDir, "readme.txt", "not memory");
  writeRel(legacyDir, "chats/note.txt", "also not memory");
  const snapG = snapshot(join(legacyDir, "global.md"));
  const snapC = snapshot(join(legacyDir, "chats/x.md"));
  const snapReadme = snapshot(join(legacyDir, "readme.txt"));
  const log = captureLog();
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log });

  equal("legacy-only action is copy", result.action, "copy");
  equal("legacy-only copies", result.copied, true);
  equal(
    "copied global.md is byte-identical",
    readFileSync(join(dataMemoryDir, "global.md"), "utf8"),
    "LEGACY-GLOBAL",
  );
  equal(
    "copied chats/x.md is byte-identical",
    readFileSync(join(dataMemoryDir, "chats/x.md"), "utf8"),
    "LEGACY-CHAT",
  );
  ok("legacy global.md mtime and bytes are untouched", sameFile(join(legacyDir, "global.md"), snapG));
  ok("legacy chats/x.md mtime and bytes are untouched", sameFile(join(legacyDir, "chats/x.md"), snapC));
  ok("legacy non-md file is untouched", sameFile(join(legacyDir, "readme.txt"), snapReadme));
  ok("non-md files are not copied", !existsSync(join(dataMemoryDir, "readme.txt")));
  ok("chats/note.txt is not copied", !existsSync(join(dataMemoryDir, "chats/note.txt")));
  ok("marker is written", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  const info = log.events.filter((e) => e.level === "info");
  equal("one info line", info.length, 1);
  equal("info file count", info[0].obj.files, 2);
  ok("info names the legacy folder", info[0].msg.includes(legacyDir));
  ok("info names the data folder", info[0].msg.includes(dataMemoryDir));
}

{
  // Dest exists but holds no .md files: copy each file via a temp name inside it.
  const { dataMemoryDir, legacyDir } = makeCase();
  mkdirSync(join(dataMemoryDir, "chats"), { recursive: true });
  writeRel(legacyDir, "global.md", "EMPTY-DEST-GLOBAL");
  writeRel(legacyDir, "chats/x.md", "EMPTY-DEST-CHAT");
  const snapG = snapshot(join(legacyDir, "global.md"));
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("empty dest still copies", result.copied, true);
  equal(
    "empty dest receives global.md",
    readFileSync(join(dataMemoryDir, "global.md"), "utf8"),
    "EMPTY-DEST-GLOBAL",
  );
  equal(
    "empty dest receives chats/x.md",
    readFileSync(join(dataMemoryDir, "chats/x.md"), "utf8"),
    "EMPTY-DEST-CHAT",
  );
  ok("empty-dest copy leaves legacy untouched", sameFile(join(legacyDir, "global.md"), snapG));
  ok("empty dest gets a marker", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  ok(
    "copying marker is gone after a finished in-place copy",
    !existsSync(join(dataMemoryDir, memory.LEGACY_COPYING_MARKER)),
  );
}

section("both have files: data folder wins, legacy untouched, warning, no copy");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(dataMemoryDir, "global.md", "DATA-WINS");
  writeRel(legacyDir, "global.md", "LEGACY-LOSES");
  writeRel(legacyDir, "chats/x.md", "LEGACY-CHAT");
  const snapDest = snapshot(join(dataMemoryDir, "global.md"));
  const snapG = snapshot(join(legacyDir, "global.md"));
  const snapC = snapshot(join(legacyDir, "chats/x.md"));
  const log = captureLog();
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log });

  equal("conflict action", result.action, "conflict");
  equal("conflict does not copy", result.copied, false);
  equal("data global.md is kept", readFileSync(join(dataMemoryDir, "global.md"), "utf8"), "DATA-WINS");
  ok("data global.md is untouched", sameFile(join(dataMemoryDir, "global.md"), snapDest));
  ok("legacy chat file was not copied", !existsSync(join(dataMemoryDir, "chats/x.md")));
  ok("legacy global.md is untouched", sameFile(join(legacyDir, "global.md"), snapG));
  ok("legacy chats/x.md is untouched", sameFile(join(legacyDir, "chats/x.md"), snapC));
  const warns = log.events.filter((e) => e.level === "warn");
  equal("one warning", warns.length, 1);
  ok("warning names the legacy folder", warns[0].msg.includes(legacyDir));
  ok("conflict logs no copy", log.events.every((e) => e.level !== "info"));
}

section("idempotent: running the helper twice copies once");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "ONCE");
  writeRel(legacyDir, "chats/x.md", "ONCE-CHAT");
  const first = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("first run copies", first.copied, true);
  writeRel(dataMemoryDir, "global.md", "MUTATED");
  const second = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("second run does not copy", second.copied, false);
  equal("second run is a skip", second.action, "skip");
  equal("dest mutation is kept", readFileSync(join(dataMemoryDir, "global.md"), "utf8"), "MUTATED");
  equal("legacy still has the original", readFileSync(join(legacyDir, "global.md"), "utf8"), "ONCE");
}

section("marker present after a clear: helper does not copy again");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "OLD-ACCOUNT");
  writeRel(legacyDir, "chats/x.md", "OLD-CHAT");
  const copied = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("seed copy ran", copied.copied, true);
  rmSync(join(dataMemoryDir, "global.md"));
  rmSync(join(dataMemoryDir, "chats/x.md"));
  ok("marker survived the clear", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  const snapG = snapshot(join(legacyDir, "global.md"));
  const again = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("helper does not copy after clear", again.copied, false);
  equal("skip reason is the marker", again.reason, "marker");
  ok("cleared global.md stays gone", !existsSync(join(dataMemoryDir, "global.md")));
  ok("cleared chat file stays gone", !existsSync(join(dataMemoryDir, "chats/x.md")));
  ok("legacy is still untouched", sameFile(join(legacyDir, "global.md"), snapG));
}

section("in-place copy resumes after a crash mid-loop");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  mkdirSync(dataMemoryDir, { recursive: true });
  writeRel(legacyDir, "global.md", "FIRST-FILE");
  writeRel(legacyDir, "chats/x.md", "SECOND-FILE");
  const log1 = captureLog();
  let committed = 0;
  const first = memory.migrateLegacyMemory({
    dataMemoryDir,
    legacyDir,
    log: log1,
    afterFile() {
      committed += 1;
      if (committed === 1) throw new Error("injected crash");
    },
  });
  equal("injected crash stops the first run", first.copied, false);
  ok(
    "copying marker remains after the crash",
    existsSync(join(dataMemoryDir, memory.LEGACY_COPYING_MARKER)),
  );
  ok("copied marker is not written yet", !existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  equal("first file landed", readFileSync(join(dataMemoryDir, "global.md"), "utf8"), "FIRST-FILE");
  ok("second file is still missing", !existsSync(join(dataMemoryDir, "chats/x.md")));
  ok("crash is not a conflict warning", log1.events.every((e) => e.level !== "warn"));
  writeRel(dataMemoryDir, "global.md", "DO-NOT-OVERWRITE");
  const snapFirst = snapshot(join(dataMemoryDir, "global.md"));
  const log2 = captureLog();
  const second = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: log2 });
  equal("second run completes", second.copied, true);
  equal("second run is a resume", second.reason, "resume");
  equal("second run is not a conflict", second.action, "copy");
  ok("no conflict warning on resume", log2.events.every((e) => e.level !== "warn"));
  ok("first file was not overwritten", sameFile(join(dataMemoryDir, "global.md"), snapFirst));
  equal(
    "missing file is copied",
    readFileSync(join(dataMemoryDir, "chats/x.md"), "utf8"),
    "SECOND-FILE",
  );
  ok("copied marker is written", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  ok("copying marker is gone", !existsSync(join(dataMemoryDir, memory.LEGACY_COPYING_MARKER)));
}

section("markLegacyMemoryHandled writes the marker and later migrate skips");

{
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "SHOULD-NOT-COPY");
  writeRel(legacyDir, "chats/x.md", "SHOULD-NOT-COPY-CHAT");
  memory.markLegacyMemoryHandled(dataMemoryDir);
  ok("marker written", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
  const log = captureLog();
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log });
  equal("migrate skips after mark", result.copied, false);
  equal("skip reason is marker", result.reason, "marker");
  equal("skip action", result.action, "skip");
  ok("legacy global.md was not copied", !existsSync(join(dataMemoryDir, "global.md")));
  ok(
    "no copy and no conflict after mark",
    log.events.every((e) => e.level !== "info" && e.level !== "warn"),
  );
}

section("leftover temp folder from a crash is cleaned and the copy completes");

{
  const { tmp, dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "AFTER-CRASH");
  writeRel(legacyDir, "chats/x.md", "AFTER-CRASH-CHAT");
  const leftoverPid = process.pid === 99999 ? 99998 : 99999;
  const leftover = join(tmp, `memory.legacy-copy-${leftoverPid}`);
  mkdirSync(leftover, { recursive: true });
  writeRel(leftover, "junk.md", "crash leftover");
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("copy completes after leftover cleanup", result.copied, true);
  ok("leftover temp folder is gone", !existsSync(leftover));
  equal(
    "dest has the legacy global.md",
    readFileSync(join(dataMemoryDir, "global.md"), "utf8"),
    "AFTER-CRASH",
  );
  ok("dest is not the leftover junk", !existsSync(join(dataMemoryDir, "junk.md")));
  ok("marker is written", existsSync(join(dataMemoryDir, memory.LEGACY_COPY_MARKER)));
}

section("a symlink in the legacy folder is skipped");

if (process.platform === "win32") {
  console.log("    skip  POSIX symlink check (win32)");
} else {
  const { dataMemoryDir, legacyDir } = makeCase();
  writeRel(legacyDir, "global.md", "REAL-GLOBAL");
  writeRel(legacyDir, "chats/real.md", "REAL-CHAT");
  symlinkSync("real.md", join(legacyDir, "chats", "link.md"));
  ok("legacy link.md is a symlink", lstatSync(join(legacyDir, "chats", "link.md")).isSymbolicLink());
  const result = memory.migrateLegacyMemory({ dataMemoryDir, legacyDir, log: captureLog() });
  equal("copy still runs around the symlink", result.copied, true);
  equal("regular global.md is copied", readFileSync(join(dataMemoryDir, "global.md"), "utf8"), "REAL-GLOBAL");
  equal("regular chats/real.md is copied", readFileSync(join(dataMemoryDir, "chats/real.md"), "utf8"), "REAL-CHAT");
  ok("symlink is not copied", !existsSync(join(dataMemoryDir, "chats/link.md")));
  equal("copied markdown files", mdOnDisk(dataMemoryDir).join(","), "chats/real.md,global.md");
}

section("marker never appears in listMemory / memoryStats / buildMemoryContext");

{
  const liveRoot = join(dataDir, "memory");
  mkdirSync(join(liveRoot, "chats"), { recursive: true });
  writeFileSync(
    join(liveRoot, "global.md"),
    "- visible global fact <!-- id:mtest1 at:2026-01-01T00:00:00.000Z -->\n",
  );
  writeFileSync(join(liveRoot, "chats", "120363-test@g.us.md"), "- visible chat fact\n");
  writeFileSync(join(liveRoot, memory.LEGACY_COPY_MARKER), "MARKER_SHOULD_NOT_APPEAR\n");
  writeFileSync(join(liveRoot, memory.LEGACY_COPYING_MARKER), "COPYING_SHOULD_NOT_APPEAR\n");

  equal("active root is <data>/memory", memory.ROOT, liveRoot);

  const listed = memory.listMemory({ scope: "global" });
  const listedText = JSON.stringify(listed);
  ok("listMemory returns the real fact", listed.some((e) => e.content.includes("visible global fact")));
  ok("listMemory omits the marker name", !listedText.includes(memory.LEGACY_COPY_MARKER));
  ok("listMemory omits the copying marker name", !listedText.includes(memory.LEGACY_COPYING_MARKER));
  ok("listMemory omits the marker body", !listedText.includes("MARKER_SHOULD_NOT_APPEAR"));
  ok("listMemory omits the copying marker body", !listedText.includes("COPYING_SHOULD_NOT_APPEAR"));

  const stats = memory.memoryStats("120363-test@g.us");
  const statsText = JSON.stringify(stats);
  equal("memoryStats counts one chat file", stats.chatFiles, 1);
  ok("memoryStats omits the marker name", !statsText.includes(memory.LEGACY_COPY_MARKER));
  ok("memoryStats omits the copying marker name", !statsText.includes(memory.LEGACY_COPYING_MARKER));
  ok("memoryStats omits the marker body", !statsText.includes("MARKER_SHOULD_NOT_APPEAR"));
  ok("memoryStats omits the copying marker body", !statsText.includes("COPYING_SHOULD_NOT_APPEAR"));

  const ctx = memory.buildMemoryContext("120363-test@g.us");
  ok("buildMemoryContext injects the global fact", ctx.includes("visible global fact"));
  ok("buildMemoryContext injects the chat fact", ctx.includes("visible chat fact"));
  ok("buildMemoryContext omits the marker name", !ctx.includes(memory.LEGACY_COPY_MARKER));
  ok("buildMemoryContext omits the copying marker name", !ctx.includes(memory.LEGACY_COPYING_MARKER));
  ok("buildMemoryContext omits the marker body", !ctx.includes("MARKER_SHOULD_NOT_APPEAR"));
  ok("buildMemoryContext omits the copying marker body", !ctx.includes("COPYING_SHOULD_NOT_APPEAR"));

  const exported = readFileSync(memory.memoryFilePath("global"), "utf8");
  ok("!memory file export is global.md", exported.includes("visible global fact"));
  ok("!memory file export omits the marker body", !exported.includes("MARKER_SHOULD_NOT_APPEAR"));
  ok("!memory file export omits the copying marker body", !exported.includes("COPYING_SHOULD_NOT_APPEAR"));

  const chatNames = readdirSync(memory.CHATS_DIR).filter((f) => f.endsWith(".md"));
  ok(
    "dashboard chat listing is .md files only",
    chatNames.includes("120363-test@g.us.md") &&
      !chatNames.includes(memory.LEGACY_COPY_MARKER) &&
      !chatNames.includes(memory.LEGACY_COPYING_MARKER),
  );
  const rootMd = readdirSync(memory.ROOT).filter((f) => f.endsWith(".md"));
  ok("dashboard root listing of .md omits the marker", !rootMd.includes(memory.LEGACY_COPY_MARKER));
  ok(
    "dashboard root listing of .md omits the copying marker",
    !rootMd.includes(memory.LEGACY_COPYING_MARKER),
  );
  ok(
    "marker stays in the memory root",
    readdirSync(memory.ROOT).includes(memory.LEGACY_COPY_MARKER),
  );
  ok(
    "copying marker stays in the memory root",
    readdirSync(memory.ROOT).includes(memory.LEGACY_COPYING_MARKER),
  );

  memory.clearAllMemoryFiles();
  ok(
    "clearAllMemoryFiles keeps the marker",
    existsSync(join(liveRoot, memory.LEGACY_COPY_MARKER)),
  );
  ok(
    "clearAllMemoryFiles drops the copying marker",
    !existsSync(join(liveRoot, memory.LEGACY_COPYING_MARKER)),
  );
  ok("clearAllMemoryFiles removes global.md", !existsSync(memory.GLOBAL_FILE));
  ok(
    "clearAllMemoryFiles removes the chat file",
    !existsSync(memory.memoryFilePath("chat", "120363-test@g.us")),
  );
}

finish();
