import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
// These cases test restore mechanics, so they confirm destructive changes up front.
const CONFIRM = { confirmDestructive: true };
const mode = process.argv[2];
const password = "restore-kill-backup-password";
const kdf = { N: 32768, r: 8, p: 1 };

if (mode === "recover") {
  const settings = require("../../src/config/settings.cjs");
  const { runRestoreRecovery } = require("../../src/backup/recovery.cjs");
  const { readOutcome } = require("../../src/backup/journal.cjs");
  runRestoreRecovery();
  process.stdout.write(`${JSON.stringify({
    outcome: readOutcome()?.outcome ?? null,
    gemini_api_key: settings.get("gemini_api_key"),
    whatsapp_proxy_password: settings.get("whatsapp_proxy_password"),
  })}\n`);
} else {
  const apiSentinel = process.argv[3];
  const proxySentinel = process.argv[4];
  const oldApi = process.argv[5];
  const oldProxy = process.argv[6];
  if (!apiSentinel || !proxySentinel || !oldApi || !oldProxy) {
    throw new Error("kill fixture needs sentinel and previous key arguments");
  }
  const { DATA_DIR } = require("../../src/config/paths.cjs");
  const settings = require("../../src/config/settings.cjs");
  const { createBackup } = require("../../src/backup/create.cjs");
  const restore = require("../../src/backup/restore.cjs");
  settings.set("gemini_api_key", apiSentinel);
  settings.set("whatsapp_proxy_password", proxySentinel);
  const archive = await createBackup({ password, kdf });
  settings.set("gemini_api_key", oldApi);
  settings.set("whatsapp_proxy_password", oldProxy);
  const id = "c".repeat(32);
  const uploads = join(DATA_DIR, "tmp", "restore");
  mkdirSync(uploads, { recursive: true, mode: 0o700 });
  copyFileSync(archive.path, join(uploads, `${id}.levixbak`));
  restore.setCrashHookForTest((step) => {
    if (step === mode) process.kill(process.pid, "SIGKILL");
  });
  await restore.restoreUpload(id, password, undefined, CONFIRM);
  throw new Error("crash hook was not reached");
}
