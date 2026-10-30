// check-stage-deps.mjs reports packages the staged code loads that were not installed.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanStage } from "../android/scripts/check-stage-deps.mjs";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const stage = mkdtempSync(join(tmpdir(), "levix-stage-"));
const source = join(stage, "src", "app.js");
const lines = [
  'const present = require("present");',
  'import "node:fs";',
  'const fs = require("fs");',
  'const local = require("./x");',
  'import("@scope/missing/sub");',
  'require("ffmpeg-static");',
  "",
];

function runCli() {
  return spawnSync(process.execPath, [join(ROOT, "android/scripts/check-stage-deps.mjs"), stage], {
    encoding: "utf8",
  });
}

try {
  section("the scan");

  mkdirSync(join(stage, "node_modules", "present"), { recursive: true });
  writeFileSync(join(stage, "node_modules", "present", "package.json"), '{"name":"present"}\n');
  mkdirSync(join(stage, "src"), { recursive: true });
  writeFileSync(source, lines.join("\n"));

  const found = scanStage(stage);
  equal("one package is missing", found.missing.length, 1);
  equal("the missing package is @scope/missing", found.missing[0].name, "@scope/missing");
  equal("the missing package names its file", found.missing[0].files.join(","), "src/app.js");

  const failed = runCli();
  equal("cli exit 1", failed.status, 1);
  ok("cli names the missing package", failed.stdout.includes("missing @scope/missing: src/app.js"));

  const kept = lines.filter((line) => !line.includes("@scope/missing"));
  writeFileSync(source, kept.join("\n"));
  const clean = scanStage(stage);
  equal("nothing is missing", clean.missing.length, 0);
  equal("present and ffmpeg-static are the loaded packages", clean.count, 2);

  const passed = runCli();
  equal("cli exit 0", passed.status, 0);
  equal(
    "cli prints the success line",
    passed.stdout.trim(),
    "Stage dependencies OK: 2 packages loaded by the app code, all present",
  );
} finally {
  rmSync(stage, { recursive: true, force: true });
}

finish();
