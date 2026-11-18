// SessionEntry must print as a placeholder. libsignal logs the object itself.

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import util from "node:util";
import { equal, finish, ok, require, section } from "./harness.mjs";

const {
  installSignalSessionInspect,
  SESSION_PLACEHOLDER,
} = require("./src/diagnostics/signalSessionInspect.cjs");

function loadSessionRecord() {
  const { SessionRecord } = require("libsignal");
  return SessionRecord;
}

function hidesKeys(label, text, privKey, rootKey) {
  ok(`${label} hides privKey hex`, !text.includes(privKey.toString("hex")));
  ok(`${label} hides privKey base64`, !text.includes(privKey.toString("base64")));
  ok(`${label} hides rootKey hex`, !text.includes(rootKey.toString("hex")));
  ok(`${label} hides rootKey base64`, !text.includes(rootKey.toString("base64")));
}

section("install");
const SessionRecord = loadSessionRecord();
equal(
  "Levix and Baileys load the same libsignal",
  require.resolve("libsignal"),
  createRequire(require.resolve("@whiskeysockets/baileys")).resolve("libsignal"),
);
ok("install returns true", installSignalSessionInspect() === true);
const prototype = Object.getPrototypeOf(SessionRecord.createEntry());
const hookBefore = Object.getOwnPropertyDescriptor(prototype, util.inspect.custom);
ok("second install returns true", installSignalSessionInspect() === true);
const hookAfter = Object.getOwnPropertyDescriptor(prototype, util.inspect.custom);
const customKeys = Object.getOwnPropertySymbols(prototype).filter(
  (symbol) => symbol === util.inspect.custom,
);
equal("one own custom inspect", customKeys.length, 1);
equal("hook function is unchanged", hookBefore?.value, hookAfter?.value);
ok("hook is configurable", hookAfter?.configurable === true);
ok("hook is not enumerable", hookAfter?.enumerable === false);
ok("hook is not writable", hookAfter?.writable === false);

section("inspect");
const privKey = randomBytes(32);
const rootKey = randomBytes(32);
const now = Date.now();
const entry = SessionRecord.createEntry();
entry.registrationId = 1;
entry.currentRatchet = {
  ephemeralKeyPair: { pubKey: randomBytes(33), privKey },
  lastRemoteEphemeralKey: randomBytes(33),
  previousCounter: 0,
  rootKey,
};
entry.indexInfo = {
  baseKey: randomBytes(33),
  baseKeyType: 1,
  closed: -1,
  used: now,
  created: now,
  remoteIdentityKey: randomBytes(33),
};
const inspected = util.inspect(entry);
equal("inspect equals the placeholder", inspected, SESSION_PLACEHOLDER);
hidesKeys("inspect", inspected, privKey, rootKey);

section("libsignal console");
const recorded = [];
function capture(...args) {
  recorded.push(util.format(...args));
}
const originalInfo = console.info;
const originalWarn = console.warn;
try {
  console.info = capture;
  console.warn = capture;
  const record = new SessionRecord();
  record.setSession(entry);
  record.closeSession(entry);
  record.closeSession(entry);
  record.openSession(entry);
} finally {
  console.info = originalInfo;
  console.warn = originalWarn;
}
const text = recorded.join("\n");
ok("logs Closing session:", text.includes("Closing session:"));
ok("logs Session already closed", text.includes("Session already closed"));
ok("logs Opening session:", text.includes("Opening session:"));
ok("logs the placeholder", text.includes(SESSION_PLACEHOLDER));
hidesKeys("console", text, privKey, rootKey);

section("startup");
const indexSource = fs.readFileSync(
  fileURLToPath(new URL("../src/index.js", import.meta.url)),
  "utf8",
);
ok("index.js calls the installer", indexSource.includes("installSignalSessionInspect()"));

finish();
