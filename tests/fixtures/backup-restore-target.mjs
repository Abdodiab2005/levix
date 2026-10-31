import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const settings = require("../../src/config/settings.cjs");
const secrets = require("../../src/config/secrets.cjs");
const store = require("../../src/db/store.cjs");
const { restoreUpload } = require("../../src/backup/restore.cjs");
const { DATA_DIR } = require("../../src/config/paths.cjs");
// These cases test restore mechanics, so they confirm destructive changes up front.
const CONFIRM = { confirmDestructive: true };

const [archive, password] = process.argv.slice(2);
const id = "e".repeat(32);
const uploads = join(DATA_DIR, "tmp", "restore");
mkdirSync(uploads, { recursive: true, mode: 0o700 });
settings.set("gemini_api_key", "target-before-restore-key");
secrets.setDashboardPassword("target-install-panel-password");
store.authWrite("creds", JSON.stringify({ me: { id: "201999999999@s.whatsapp.net",
  lid: "987654321@lid" }, account: { key: 9 }, registered: false }));
copyFileSync(archive, join(uploads, `${id}.levixbak`));
const result = await restoreUpload(id, password, undefined, CONFIRM);
const stored = store.getBotSetting("setting:gemini_api_key");
console.log(`RESULT ${JSON.stringify({ keyUsable: settings.get("gemini_api_key") === "gemini-restore-key",
  storedSealed: !String(stored).includes("gemini-restore-key"),
  passwordKept: secrets.verifyDashboardPassword("target-install-panel-password"),
  pairingKept: store.authRead("creds").includes('"key":9'),
  matchesPaired: result.accountMatchesPaired })}`);
