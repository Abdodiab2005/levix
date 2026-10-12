// The local crash-report store (contract section 4).
//
// Everything here is on-disk behaviour: the cap, the seven-day sweep, atomic
// writes, the upload object (no local-only keys), and the last-20 send record.

import fs from "node:fs";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-crash-store");

const crash = require("./src/diagnostics/crashReports.cjs");
const { dataPath } = require("./src/config/paths.cjs");

const crashDir = dataPath("crash-reports");
const fileFor = (id) => dataPath("crash-reports", `${id}.json`);

section("a report is validated, fingerprinted and stored");

ok(
  "an unknown category is refused",
  (() => {
    try {
      crash.createReport({ category: "not-a-category" });
      return false;
    } catch (error) {
      return error.status === 400;
    }
  })(),
);

const report = crash.createReport({
  category: "node-uncaught",
  error: { type: "TypeError", message: "cannot read x of undefined", stack: "a\nb\nc\nd" },
  screen: "stickers?token=hidden#top",
  breadcrumbs: [{ at: "2026-10-12T19:03:58.000Z", kind: "nav", name: "stickers" }],
  device: { device: "samsung SM-A556E", platform: "hacker", evil: "x" },
});

ok("the id is 16 lowercase hex", /^[0-9a-f]{16}$/.test(report.id));
ok("the fingerprint is 16 hex", /^[0-9a-f]{16}$/.test(report.fingerprint));
equal("the schema is 1", report.schema, 1);
equal("the status starts pending", report.status, "pending");
equal("there is no last error", report.lastError, null);
equal("the category is kept", report.category, "node-uncaught");
equal("the screen loses its query and hash", report.screen, "stickers");
ok("the device block drops unknown keys", !("evil" in report.device));
ok("the device block drops server keys", !("platform" in report.device));

ok("the file exists", fs.existsSync(fileFor(report.id)));
ok("no tmp file is left behind", !fs.existsSync(`${fileFor(report.id)}.tmp`));
ok("the stored json parses", !!crash.readReport(report.id));

section("the fingerprint groups equal failures");

const a = crash.createReport({
  category: "web-error",
  error: { type: "Error", message: "one", stack: "f1\nf2\nf3\nf4" },
});
const b = crash.createReport({
  category: "web-error",
  error: { type: "Error", message: "different message", stack: "f1\nf2\nf3\nffff" },
});
const c = crash.createReport({
  category: "web-error",
  error: { type: "Error", message: "one", stack: "g1\ng2\ng3" },
});
equal("same category, type and first three frames group", a.fingerprint, b.fingerprint);
ok("a different frame does not group", a.fingerprint !== c.fingerprint);

section("the upload object has no local-only keys");

const upload = crash.uploadObject(report);
ok("status is stripped", !("status" in upload));
ok("lastError is stripped", !("lastError" in upload));
equal("the id rides along", upload.id, report.id);
equal("the fingerprint rides along", upload.fingerprint, report.fingerprint);
ok(
  "the preview re-adds status and lastError",
  (() => {
    const preview = crash.list().reports.find((r) => r.id === report.id);
    return preview.status === "pending" && preview.lastError === null;
  })(),
);

section("stored text is sanitized at store time");

const dirty = crash.createReport({
  category: "node-uncaught",
  error: {
    type: "Error",
    message: "failed for 201234567890@s.whatsapp.net",
    stack: ["at /home/me/.levix/x.js:1"],
  },
});
ok("a JID in the message is redacted", dirty.error.message.includes("<jid>"));
ok("the JID is gone", !dirty.error.message.includes("@s.whatsapp.net"));

section("the store keeps at most 20 reports");

for (let i = 0; i < 25; i += 1) {
  crash.createReport({ category: "web-error", error: { type: "Error", message: `report ${i}` } });
}
equal("the cap holds on disk", crash.listReports().length, 20);
const files = fs.readdirSync(crashDir).filter((name) => name.endsWith(".json"));
equal("the directory holds 20 report files", files.length, 20);

section("reports older than seven days are swept");

const stale = crash.createReport({
  category: "web-error",
  error: { type: "Error", message: "old" },
});
const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
fs.utimesSync(fileFor(stale.id), eightDaysAgo, eightDaysAgo);
crash.sweep();
ok("the stale report is gone", !fs.existsSync(fileFor(stale.id)));

section("the send record keeps the last 20 ids");

for (let i = 0; i < 25; i += 1) {
  crash.recordSent({
    id: `id-${i}`,
    sentAt: new Date().toISOString(),
    category: "web-error",
    type: "Error",
  });
}
const sent = crash.readSent();
equal("only 20 sends are kept", sent.length, 20);
equal("the newest send is first", sent[0].id, "id-24");
equal(
  "a sent record carries only id, sentAt, category and type",
  Object.keys(sent[0]).sort().join(","),
  "category,id,sentAt,type",
);

section("delete never touches the network");

const toDelete = crash.createReport({
  category: "web-error",
  error: { type: "Error", message: "x" },
});
ok("one report is deleted", crash.deleteReport(toDelete.id) === true);
ok("the file is gone", !fs.existsSync(fileFor(toDelete.id)));
ok("deleting a bad id is refused", crash.deleteReport("../../etc/passwd") === false);
const removed = crash.deleteAllReports();
ok("delete-all removes the rest", removed > 0, `removed ${removed}`);
equal("the directory is empty of reports", crash.listReports().length, 0);

section("the Node fatal capture always writes something or nothing, never throws");

const fatal = crash.captureNodeFatal("node-uncaught", new Error("kaboom"));
ok("a report is returned", !!fatal);
equal("the category is node-uncaught", fatal.category, "node-uncaught");
equal("the error type is kept", fatal.error.type, "Error");
ok(
  "a rejection is category node-rejection",
  crash.captureNodeFatal("node-rejection", "plain string").category === "node-rejection",
);
ok(
  "a non-Error reason still produces a report",
  !!crash.captureNodeFatal("node-rejection", undefined),
);

finish();
