// Baileys' records in the debug log.
//
// Baileys logs protocol nodes, the paired account and pushName updates. The
// debug log may leave the device inside a crash report, so these tests pin
// that display names, group subjects, message text and raw node text never
// reach the file, while the failure facts (tags, error types, codes) do. They
// also pin that nothing Baileys logs lands in combined.log.

import fs from "node:fs";
import path from "node:path";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-baileys-log");

const { createBaileysLogger, shape } = require("./src/diagnostics/baileysLog.cjs");
const { readDebugTail } = require("./src/diagnostics/debugLog.cjs");

const NAME = "Layla Hassan";
const SUBJECT = "Family Plans 2026";
const TEXT = "meet me at the station";

const log = createBaileysLogger("trace");
log.info({ me: { id: "201001234567:3@s.whatsapp.net", name: NAME } }, "pairing configured");
log.debug({ name: NAME }, "updated pushName");
log.info(
  {
    node: {
      tag: "notification",
      attrs: { type: "w:gp2", notify: NAME, from: "120363000000000000@g.us" },
      content: [{ tag: "subject", attrs: { subject: SUBJECT }, content: Buffer.from(TEXT) }],
    },
  },
  "group notification",
);
log.warn(
  { node: `<message notify="${NAME}" type="text"><body>${TEXT}</body></message>` },
  "bad node",
);
log.info({ operation: "set", data: { contacts: [{ fullName: NAME }] } }, "app state");
log.trace({ xml: `<iq type="result"><group subject="${SUBJECT}"/></iq>` }, "recv xml");
log.error({ err: new Error("stream errored") }, "socket failed");

const file = readDebugTail();

section("personal text never reaches the debug log");
ok("no display name", !file.includes(NAME));
ok("no group subject", !file.includes(SUBJECT));
ok("no message text", !file.includes(TEXT));
ok("no phone number", !file.includes("201001234567"));

section("the failure facts survive");
ok("node tag kept", file.includes('"tag":"notification"'));
ok("protocol type kept", file.includes('"type":"w:gp2"'));
ok("node string keeps its outer tag", file.includes("<message>"));
ok("error message kept", file.includes("stream errored"));
ok("records are tagged", file.includes('"module":"baileys"'));

section("Baileys never writes the operational logs");
const combined = path.join(dataDir, "logs", "combined.log");
const text = fs.existsSync(combined) ? fs.readFileSync(combined, "utf8") : "";
ok("combined.log has no baileys record", !text.includes('"module":"baileys"'));

section("shape");
equal("buffer becomes its size", shape(Buffer.from("abc")), "[3 bytes]");
equal("unsafe string becomes its length", shape("hello", 0, "notify"), "[5 chars]");
equal("safe attribute keeps its value", shape("w:gp2", 0, "type"), "w:gp2");

finish();
