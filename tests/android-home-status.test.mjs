import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { finish, ok } from "./harness.mjs";

// Exercise the real Android entry point with a fresh, isolated account. An
// idle session emits no transition, but the home screen still needs its state.
const data = mkdtempSync(join(tmpdir(), "levix-android-home-"));
const boot = join(data, "boot.mjs");
copyFileSync(fileURLToPath(new URL("../android/host-boot.mjs", import.meta.url)), boot);
symlinkSync(fileURLToPath(new URL("../src", import.meta.url)), join(data, "src"), "dir");
const child = spawn(process.execPath, [boot], {
  env: { ...process.env, LEVIX_ANDROID: "1", LEVIX_DATA_DIR: data, LEVIX_OPEN_BROWSER: "0" },
  stdio: ["pipe", "pipe", "pipe"],
});
let output = "";
const closed = new Promise((resolve) => child.once("close", resolve));
try {
  const initial = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 30_000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (output.includes("whatsapp session idle|")) {
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.stderr.resume();
  });
  ok("fresh Android engine reports authoritative idle state without pairing", initial);
  ok("initial WhatsApp state accompanies engine readiness", output.includes("Levix ready"));
  ok(
    "startup does not manufacture a connected state",
    !output.includes("whatsapp session connected|"),
  );
} finally {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  await closed;
  clearTimeout(killTimer);
  rmSync(data, { recursive: true, force: true });
}
finish();
