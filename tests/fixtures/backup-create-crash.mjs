import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);

if (process.argv[2] === "sweep") {
  require("../../src/backup/jobs.cjs").sweepBackupTemp();
} else {
  const { acquireSingleInstanceLock } = require("../../src/config/lock.cjs");
  const { db, prepareDatabase } = require("../../src/db/db.cjs");
  const store = require("../../src/db/store.cjs");
  const settings = require("../../src/config/settings.cjs");
  const secrets = require("../../src/config/secrets.cjs");
  const { ROOT: memoryRoot } = require("../../src/utils/memory.cjs");
  const { createBackup, setCaptureHookForTest } = require("../../src/backup/create.cjs");

  acquireSingleInstanceLock();
  await prepareDatabase();
  store.authWrite("creds", JSON.stringify({
    me: { id: "201000000012:4@s.whatsapp.net", lid: "123456789:4@lid" },
    account: { key: "CREDS-SENTINEL-CREATE" }, registered: false,
  }));
  store.authWrite("signal-key", "AUTH-ROW-SENTINEL-CREATE");
  db.prepare("INSERT INTO qr_codes (id, qr_string) VALUES (1, ?)").run("QR-SENTINEL-CREATE");
  secrets.setDashboardPassword("crash-fixture-panel-password");
  store.saveBotSetting("auth:recovery-email", "RECOVERY-SENTINEL-CREATE");
  store.saveBotSetting("secret:session", "SESSION-SENTINEL-CREATE");
  settings.set("gemini_api_key", "GEMINI-PLAINTEXT-SENTINEL-CREATE");
  settings.set("openai_api_key", "OPENAI-PLAINTEXT-SENTINEL-CREATE");
  db.prepare("INSERT INTO user_metadata (user_jid, is_owner, is_admin, first_seen, last_seen) VALUES (?,1,0,1,1)")
    .run("123456789@lid");
  db.prepare("INSERT INTO ai_history (chat_id, history, updated_at) VALUES (?, '[]', 1)").run("chat@g.us");
  mkdirSync(memoryRoot, { recursive: true, mode: 0o700 });
  writeFileSync(join(memoryRoot, "global.md"), "ordinary memory");
  writeFileSync(join(process.env.LEVIX_DATA_DIR, "ai-persona.md"), "ordinary persona");

  setCaptureHookForTest((point) => {
    if (point === process.argv[2]) process.kill(process.pid, "SIGKILL");
  });
  await createBackup({ password: "crash-fixture-backup-password" });
  throw new Error("capture hook was not reached");
}
