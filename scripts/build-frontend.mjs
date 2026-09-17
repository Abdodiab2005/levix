import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(ROOT, "frontend");

if (!fs.existsSync(FRONTEND)) {
  // If frontend source is not present (e.g. within an installed tarball), nothing to build.
  process.exit(0);
}

const isWin = process.platform === "win32";
const npmCmd = isWin ? "npm.cmd" : "npm";

// Ensure frontend dependencies are installed if missing
const frontendModules = path.join(FRONTEND, "node_modules");
if (!fs.existsSync(frontendModules) || fs.readdirSync(frontendModules).length === 0) {
  console.log("▸ Installing frontend dependencies...");
  try {
    execFileSync(npmCmd, ["ci"], {
      cwd: FRONTEND,
      stdio: "inherit",
      shell: isWin,
    });
  } catch {
    console.warn("  npm ci failed, falling back to npm install");
    execFileSync(npmCmd, ["install"], {
      cwd: FRONTEND,
      stdio: "inherit",
      shell: isWin,
    });
  }
}

execFileSync(npmCmd, ["run", "build"], {
  cwd: FRONTEND,
  stdio: "inherit",
  shell: isWin,
});
