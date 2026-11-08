import { spawnSync } from "node:child_process";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-reaction-status");
const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const status = require("./src/automation/status.cjs");
const settings = require("./src/config/settings.cjs");
const sender = require("./src/utils/sendBotMessage.cjs");
const savedSend = sender.sendBotMessage;
let send = async (_sock, _jid, _content, options) => {
  options.signal.throwIfAborted();
  options.deliveryGuard.assert();
  return { key: { id: "fake-sent" } };
};
sender.sendBotMessage = (...args) => send(...args);
const { createReactionAutomation } = await import("../src/automation/engine.js");
const group = "120363700000001@g.us";
const author = "201070000001@s.whatsapp.net";
const reactor = "201070000002@s.whatsapp.net";
const bot = "201070000099@s.whatsapp.net";
const definition = {
  version: 1,
  emoji: "😀",
  transitions: ["add", "change", "remove"],
  originalTypes: ["text"],
  senders: { role: "any", ids: [] },
  action: "ping",
  destination: { mode: "same_chat" },
};

section("bounded status records, snapshots and fixed codes");
equal("unknown rule is null", status.get("missing"), null);
equal("initial global is null", status.global(), null);
status.record("rule", "DELIVERED", 100);
status.record("rule", "DELIVERED", 200);
status.record("rule", "RATE_LIMIT", 300);
let entry = status.get("rule");
equal("last code", entry.lastCode, "RATE_LIMIT");
equal("last timestamp", entry.lastAt, 300);
equal("delivered count", entry.counts.DELIVERED, 2);
equal("rate limit count", entry.counts.RATE_LIMIT, 1);
entry.counts.DELIVERED = 99;
equal("get returns a snapshot", status.get("rule").counts.DELIVERED, 2);
status.record(null, "NO_MATCH", 400);
equal("unselected outcome goes global", status.global().lastCode, "NO_MATCH");
entry = status.global();
entry.counts.NO_MATCH = 99;
equal("global returns a snapshot", status.global().counts.NO_MATCH, 1);
status.clear("rule");
equal("clear removes only selected rule", status.get("rule"), null);
equal("clear preserves global", status.global().lastCode, "NO_MATCH");
status.reset();
for (let index = 0; index < 1001; index++) status.record(`rule-${index}`, "DELIVERED", index);
equal("oldest of 1001 entries evicted", status.get("rule-0"), null);
let retained = 0;
for (let index = 1; index <= 1000; index++) if (status.get(`rule-${index}`)) retained++;
equal("exactly 1000 retained", retained, 1000);
status.record("rule-1", "NO_MATCH", 2000);
equal("updating existing id preserves another entry", status.get("rule-2").lastCode, "DELIVERED");
status.reset();
equal("reset removes global", status.global(), null);
equal("reset removes rules", status.get("rule-1"), null);

const allowed = [
  "REACTION_CANCELLED",
  "REACTION_TIMEOUT",
  "REACTION_STALE",
  "REACTION_INACCESSIBLE",
  "REACTION_FORBIDDEN",
  "REACTION_STT_DISABLED",
  "REACTION_DELIVERY_REFUSED",
  "REACTION_CAPACITY",
  "REACTION_IDENTITY_INVALID",
  "REACTION_VOICE_REQUIRED",
  "STT_KEY_REQUIRED",
  "STT_OUTPUT_INVALID",
  "MEDIA_AUDIO_INVALID",
  "MEDIA_TOO_LARGE",
  "MEDIA_NOT_AVAILABLE",
  "MEDIA_URL_INVALID",
  "DELIVERED",
  "NO_MATCH",
  "BUSY",
  "ACTION_FAILED",
  "RATE_LIMIT",
  "CAPACITY",
  "EVENT_MISSING",
  "DUPLICATE",
];
for (const code of allowed) {
  status.record("codes", code, 1);
  equal(`allowlisted ${code}`, status.get("codes").lastCode, code);
}
const privateText = "private transcript token 201070000001";
for (const code of [privateText, "__proto__", "toString", {}, null, undefined])
  status.record("codes", code, 2);
entry = status.get("codes");
equal("unknown codes become ACTION_FAILED", entry.lastCode, "ACTION_FAILED");
equal("only public record fields", Object.keys(entry).sort().join(","), "counts,lastAt,lastCode");
ok(
  "only allowlisted count keys",
  Object.keys(entry.counts).every((code) => allowed.includes(code)),
);
ok("record contains no private error text", !JSON.stringify(entry).includes(privateText));
status.record("codes", "DELIVERED", { text: privateText });
equal("invalid timestamp is not stored", typeof status.get("codes").lastAt, "number");
status.record({ message: privateText }, "DELIVERED", 3);
equal("non-id data cannot become a rule key", status.get({ message: privateText }), null);

section("status clears on edits, enablement, disablement and deletion");
store.saveReactionRule({ id: "editable", chatJid: group, priority: 0, definition });
status.record("unrelated", "BUSY", 1);
for (const action of ["edit", "enable", "disable", "delete"]) {
  status.record("editable", "DELIVERED", 1);
  if (action === "edit")
    store.saveReactionRule({ id: "editable", chatJid: group, priority: 1, definition });
  if (action === "enable") store.setReactionRuleEnabled("editable", true);
  if (action === "disable") store.setReactionRuleEnabled("editable", false);
  if (action === "delete") store.deleteReactionRule("editable");
  equal(`${action} clears status`, status.get("editable"), null);
  equal(`${action} preserves unrelated status`, status.get("unrelated").lastCode, "BUSY");
}

section("account clearing resets status without resetting on the global switch");
store.saveReactionRule({ id: "account-rule", chatJid: group, priority: 0, definition });
store.setReactionRuleEnabled("account-rule", true);
const accountRevision = store.getReactionRule("account-rule").revision;
const oldEpoch = status.epoch();
status.record("account-rule", "DELIVERED", 1);
status.record(null, "NO_MATCH", 2);
for (const enabled of [true, false]) {
  store.setReactionAutomationEnabled(enabled);
  equal("global switch preserves rule history", status.get("account-rule").lastCode, "DELIVERED");
  equal("global switch preserves global history", status.global().lastCode, "NO_MATCH");
  equal("global switch preserves epoch", status.epoch(), oldEpoch);
}
store.clearReactionAccountState();
equal("account clearing disables rules", store.getReactionRule("account-rule").enabled, 0);
equal(
  "account clearing leaves revisions unchanged",
  store.getReactionRule("account-rule").revision,
  accountRevision,
);
equal("account clearing removes rule history", status.get("account-rule"), null);
equal("account clearing removes unrelated history", status.get("unrelated"), null);
equal("account clearing removes global history", status.global(), null);
ok("account clearing advances epoch", status.epoch() !== oldEpoch);
status.record("account-rule", "REACTION_CANCELLED", 3, oldEpoch);
status.record(null, "REACTION_CANCELLED", 3, oldEpoch);
equal("old epoch cannot restore rule history", status.get("account-rule"), null);
equal("old epoch cannot restore global history", status.global(), null);
status.record("new-account-rule", "DELIVERED", 4);
status.record(null, "BUSY", 4);
status.record("new-account-rule", "ACTION_FAILED", 5, oldEpoch);
status.record(null, "ACTION_FAILED", 5, oldEpoch);
equal(
  "old epoch cannot overwrite current rule history",
  status.get("new-account-rule").lastCode,
  "DELIVERED",
);
equal("old epoch cannot overwrite current global history", status.global().lastCode, "BUSY");

section("status never persists and restart starts empty");
const before = db.prepare("SELECT total_changes() AS n").get().n;
const schemaBefore = JSON.stringify(
  db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
);
status.record("ram-only", "DELIVERED", 123);
status.record(null, "BUSY", 124);
status.get("ram-only");
status.global();
equal(
  "recording and reading write no SQLite rows",
  db.prepare("SELECT total_changes() AS n").get().n,
  before,
);
equal(
  "schema unchanged",
  JSON.stringify(db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all()),
  schemaBefore,
);
equal("schema remains 12", db.prepare("PRAGMA user_version").get().user_version, 12);
const child = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `
  import { createRequire } from 'node:module';
  const require = createRequire(process.cwd() + '/package.json');
  const status = require('./src/automation/status.cjs');
  console.log('RESULT ' + JSON.stringify({ rule: status.get('ram-only'), global: status.global() }));
`,
  ],
  { env: { ...process.env, LEVIX_DATA_DIR: dataDir }, encoding: "utf8" },
);
equal("fresh process exits", child.status, 0);
equal(
  "fresh process has no runtime records",
  /^RESULT (.*)$/m.exec(child.stdout)?.[1],
  '{"rule":null,"global":null}',
);

section("engine records selected and unselected outcomes without message data");
db.exec(
  "DELETE FROM reaction_rules; DELETE FROM reaction_budgets; DELETE FROM reaction_events; DELETE FROM reaction_state; DELETE FROM reaction_executions;",
);
store.saveBotSetting("command_permissions", {});
store.saveBotSetting("disabled_commands", []);
settings.set("bot_language", "en");
let clock = Date.now() + 10_000;
let sequence = 0;
store.saveReactionRule({ id: "engine-rule", chatJid: group, priority: 0, definition });
store.setReactionRuleEnabled("engine-rule", true, clock);
store.setReactionAutomationEnabled(true);
status.reset();
const sock = {
  user: { id: bot },
  async groupMetadata(jid) {
    return { id: jid, participants: [{ id: bot }, { id: author }, { id: reactor }] };
  },
  sendMessage() {
    throw new Error("all sends must use fake helper");
  },
};
const engine = createReactionAutomation(sock, { now: () => clock });
engine.intake.open();
clock += 2000;
function receive(emoji = "😀") {
  const original = {
    key: { remoteJid: group, participant: author, id: `original-${++sequence}`, fromMe: false },
    message: { conversation: privateText },
    messageTimestamp: Math.floor(clock / 1000),
  };
  engine.intake.observeUpsert({ type: "notify", messages: [original] });
  engine.intake.observeReactions([
    {
      key: original.key,
      reaction: {
        key: { remoteJid: group, participant: reactor, id: `event-${++sequence}`, fromMe: false },
        text: emoji,
        senderTimestampMs: ++clock,
      },
    },
  ]);
}
try {
  receive();
  await engine.settled();
  equal("successful engine outcome remains DELIVERED", engine.stats().lastCode, "DELIVERED");
  equal("winner recorded by id", status.get("engine-rule")?.lastCode, "DELIVERED");
  equal("engine uses supplied clock", status.get("engine-rule")?.lastAt, clock);
  equal("selected outcomes do not become global", status.global(), null);
  receive("👍");
  await engine.settled();
  equal("unmatched engine outcome", status.global()?.lastCode, "NO_MATCH");
  equal("unmatched leaves winner count unchanged", status.get("engine-rule").counts.DELIVERED, 1);
  send = async () => {
    throw new Error(privateText);
  };
  receive();
  await engine.settled();
  equal(
    "unexpected action failure recorded safely",
    status.get("engine-rule").lastCode,
    "ACTION_FAILED",
  );
  ok(
    "engine status contains no message or exception",
    !JSON.stringify(status.get("engine-rule")).includes(privateText),
  );
  receive();
  await engine.settled();
  receive();
  await engine.settled();
  equal("admission limit recorded globally", status.global().lastCode, "RATE_LIMIT");

  clock += 60_001;
  let release;
  let entered = false;
  send = async (_sock, _jid, _content, options) => {
    entered = true;
    await new Promise((resolve) => {
      release = resolve;
    });
    options.signal.throwIfAborted();
    return { key: { id: "late" } };
  };
  receive();
  for (let turn = 0; turn < 100 && !entered; turn++)
    await new Promise((resolve) => setImmediate(resolve));
  ok("fake send holds selected job", entered);
  receive();
  equal("busy job outcome recorded globally", status.global().lastCode, "BUSY");
  store.setReactionAutomationEnabled(false);
  release();
  await engine.settled();
  equal(
    "selected cancellation recorded by id",
    status.get("engine-rule").lastCode,
    "REACTION_CANCELLED",
  );

  ok(
    "all runtime data remains code-only",
    !JSON.stringify(status.get("engine-rule")).includes(privateText),
  );

  section("late selected jobs cannot restore edited, disabled or deleted rule status");
  for (const change of ["edit", "disable", "delete"]) {
    for (const completion of ["cancelled", "late-success"]) {
      clock += 60_001;
      store.saveReactionRule({ id: "engine-rule", chatJid: group, priority: 0, definition });
      store.setReactionRuleEnabled("engine-rule", true, clock);
      store.setReactionAutomationEnabled(true);
      status.reset();
      clock += 2000;
      entered = false;
      release = null;
      send = async (_sock, _jid, _content, options) => {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        if (completion === "cancelled") options.signal.throwIfAborted();
        return { key: { id: "late" } };
      };
      receive();
      for (let turn = 0; turn < 100 && !entered; turn++)
        await new Promise((resolve) => setImmediate(resolve));
      ok(`${change}/${completion}: job selected rule`, entered);
      if (change === "edit")
        store.saveReactionRule({ id: "engine-rule", chatJid: group, priority: 1, definition });
      if (change === "disable") store.setReactionRuleEnabled("engine-rule", false);
      if (change === "delete") store.deleteReactionRule("engine-rule");
      equal(`${change}/${completion}: history cleared`, status.get("engine-rule"), null);
      if (completion === "late-success") {
        if (change === "delete")
          store.saveReactionRule({ id: "engine-rule", chatJid: group, priority: 0, definition });
        status.record("engine-rule", "BUSY", clock);
      }
      release?.();
      await engine.settled();
      equal(
        `${change}/${completion}: old outcome goes global`,
        status.global()?.lastCode,
        completion === "cancelled" ? "REACTION_CANCELLED" : "DELIVERED",
      );
      if (completion === "cancelled")
        equal(`${change}: stale status stays cleared`, status.get("engine-rule"), null);
      else {
        equal(
          `${change}: current history survives late success`,
          status.get("engine-rule").lastCode,
          "BUSY",
        );
        equal(
          `${change}: current counts stay unchanged`,
          JSON.stringify(status.get("engine-rule").counts),
          '{"BUSY":1}',
        );
      }
    }
  }

  section("old-account jobs cannot restore rule or global status after reset");
  const savedMetadata = sock.groupMetadata;
  for (const stage of ["metadata", "send"]) {
    clock += 60_001;
    store.saveReactionRule({ id: "engine-rule", chatJid: group, priority: 0, definition });
    store.setReactionRuleEnabled("engine-rule", true, clock);
    store.setReactionAutomationEnabled(true);
    status.reset();
    const revision = store.getReactionRule("engine-rule").revision;
    clock += 2000;
    entered = false;
    release = null;
    if (stage === "metadata") {
      sock.groupMetadata = async (jid) => {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        return savedMetadata(jid);
      };
    } else {
      send = async (_sock, _jid, _content, options) => {
        entered = true;
        await new Promise((resolve) => {
          release = resolve;
        });
        options.signal.throwIfAborted();
        return { key: { id: "late" } };
      };
    }
    receive();
    for (let turn = 0; turn < 100 && !entered; turn++)
      await new Promise((resolve) => setImmediate(resolve));
    ok(`${stage}: old-account work is pending`, entered);
    status.record("engine-rule", "DELIVERED", clock);
    status.record(null, "NO_MATCH", clock);
    store.clearReactionAccountState();
    equal(
      `${stage}: clearing does not rotate revision`,
      store.getReactionRule("engine-rule").revision,
      revision,
    );
    equal(`${stage}: rule history reset`, status.get("engine-rule"), null);
    equal(`${stage}: global history reset`, status.global(), null);
    if (stage === "metadata") {
      store.setReactionRuleEnabled("engine-rule", true, clock);
      store.setReactionAutomationEnabled(true);
      status.record("engine-rule", "BUSY", clock);
      status.record(null, "BUSY", clock);
    }
    release?.();
    await engine.settled();
    sock.groupMetadata = savedMetadata;
    equal(`${stage}: old-account job was cancelled`, engine.stats().lastCode, "REACTION_CANCELLED");
    if (stage === "send") {
      equal(
        "selected old-account job cannot resurrect rule history",
        status.get("engine-rule"),
        null,
      );
      equal("selected old-account job cannot resurrect global history", status.global(), null);
    } else {
      equal(
        "unselected old-account job cannot overwrite current rule history",
        status.get("engine-rule").lastCode,
        "BUSY",
      );
      equal(
        "unselected old-account job cannot overwrite current global history",
        status.global().lastCode,
        "BUSY",
      );
    }
  }
  clock += 60_001;
  store.setReactionRuleEnabled("engine-rule", true, clock);
  store.setReactionAutomationEnabled(true);
  clock += 2000;
  send = async (_sock, _jid, _content, options) => {
    options.signal.throwIfAborted();
    options.deliveryGuard.assert();
    return { key: { id: "new-account-sent" } };
  };
  receive();
  await engine.settled();
  equal(
    "current-account jobs still record outcomes",
    status.get("engine-rule")?.lastCode,
    "DELIVERED",
  );
} finally {
  engine.close();
  sender.sendBotMessage = savedSend;
}
finish();
