// Does anything actually survive a restart?
//
// The first half writes state; the second half reads it back **from a second
// process**, which is the only honest way to test this — a single process
// would be reading its own open handle and would pass even if nothing had ever
// reached the disk.
//
// Also covers the Baileys auth round-trip, because the buffers in a session
// key are the one thing here that a naive JSON column would quietly corrupt,
// and the symptom is "scan the QR again" a week later.

import { spawnSync } from "node:child_process";
import { useTempDataDir, require, section, ok, equal, ROOT, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-persist");

const store = require("./src/db/store.cjs");
const secrets = require("./src/config/secrets.cjs");
const runtime = require("./src/config/runtime-config.cjs");
const { createAuthStorage } = require("./src/auth/auth-storage.cjs");

// --- write ----------------------------------------------------------------

runtime.setPrefix(".");
secrets.setDashboardPassword("correct horse battery");
const sessionSecret = secrets.getSessionSecret();
store.saveGroupSettings("g1@g.us", { antilink: true, warnLimit: 3 });
store.setUserRole("201234567890", "admin", true);
store.saveSchedule({
  id: "j2",
  type: "recurring",
  targetJid: "g1@g.us",
  message: "daily",
  cronString: "0 9 * * *",
  status: "active",
});
store.incrementForwardScore("m1", "g1@g.us", "u1");
store.incrementForwardScore("m1", "g1@g.us", "u1");

// Baileys hands us objects full of Buffers; they have to come back as Buffers.
const auth = createAuthStorage("sqlite");
await auth.writeData("creds", {
  noiseKey: { private: Buffer.from([1, 2, 3, 4]), public: Buffer.from([5, 6]) },
  registered: false,
  nested: { deep: { buf: Buffer.from("hello") } },
  list: [Buffer.from([9]), 7, "x"],
});

require("./src/db/db.cjs").checkpoint();

// --- read back, in a different process ------------------------------------

section("state survives a restart");

const probe = `
  const store = require(${JSON.stringify(`${ROOT}src/db/store.cjs`)});
  const secrets = require(${JSON.stringify(`${ROOT}src/config/secrets.cjs`)});
  const runtime = require(${JSON.stringify(`${ROOT}src/config/runtime-config.cjs`)});
  const { createAuthStorage } = require(${JSON.stringify(`${ROOT}src/auth/auth-storage.cjs`)});
  (async () => {
    const back = await createAuthStorage("sqlite").readData("creds");
    process.stdout.write("RESULT" + JSON.stringify({
      prefix: runtime.getPrefix(),
      password: secrets.verifyDashboardPassword("correct horse battery"),
      wrongPassword: secrets.verifyDashboardPassword("nope nope nope"),
      sessionSecret: secrets.getSessionSecret(),
      warnLimit: store.getGroupSettings("g1@g.us").warnLimit,
      admin: store.isUserBotAdmin("201234567890"),
      cron: store.getSchedule("j2").cronString,
      forwards: store.getForwardScore("m1").count,
      setupCode: secrets.getSetupCode(),
      hasCreds: store.hasCredentials(),
      bufferIsBuffer: Buffer.isBuffer(back.noiseKey.private),
      bufferBytes: [...back.noiseKey.private],
      nestedBuffer: Buffer.isBuffer(back.nested.deep.buf) && back.nested.deep.buf.toString(),
      arrayBuffer: Buffer.isBuffer(back.list[0]) && back.list[1] === 7,
      falseKept: back.registered === false,
    }));
  })();
`;

const child = spawnSync(process.execPath, ["-e", probe], {
  env: { ...process.env, LEVIX_DATA_DIR: dataDir },
  encoding: "utf8",
});

const marker = child.stdout.indexOf("RESULT");
if (marker === -1) {
  ok("the second process read the database", false, child.stderr.slice(0, 400));
  finish();
  process.exit(1);
}
const after = JSON.parse(child.stdout.slice(marker + "RESULT".length));

equal("prefix persisted", after.prefix, ".");
ok("password verifies after restart", after.password === true);
ok("a wrong password still fails", after.wrongPassword === false);
equal("session secret is reused, not regenerated", after.sessionSecret, sessionSecret);
equal("group settings persisted", after.warnLimit, 3);
ok("bot-admin role persisted", after.admin === true);
equal("schedule persisted", after.cron, "0 9 * * *");
equal("forward counter persisted", after.forwards, 2);
ok("the setup code is new in a new process", after.setupCode !== secrets.getSetupCode());

section("baileys auth survives the round trip");

ok("credentials are stored", after.hasCreds === true);
ok("a Buffer comes back a Buffer", after.bufferIsBuffer === true);
equal("its bytes are unchanged", after.bufferBytes.join(","), "1,2,3,4");
equal("a nested Buffer survives", after.nestedBuffer, "hello");
ok("a Buffer inside an array survives", after.arrayBuffer === true);
ok("`false` is not turned into undefined", after.falseKept === true);

finish();
