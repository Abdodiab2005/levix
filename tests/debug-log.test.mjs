// The technical debug log (v4.8.1 hotfix).
//
// Four promises, read off the files and the wire:
//   * secret-shaped keys are redacted at any depth, content keys keep a length;
//   * every surviving string is sanitized (a JID and an e-mail disappear);
//   * retention is 14 days, and Clear logs removes the directory;
//   * it leaves the device only with feedback diagnostics or a crash-report
//     send, and each preview shows exactly the string that is sent.
//
// The panel sections use a local stub for both endpoints. No outside network.

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import {
  equal,
  finish,
  httpClient,
  ok,
  require,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

const dataDir = useTempDataDir("levix-debug-log");

const debugLog = require("./src/diagnostics/debugLog.cjs");
const logger = require("./src/utils/logger.cjs");

const { DEBUG_DIR, MAX_FILE_BYTES, readDebugTail, resetDebugLogState, sweepDebugLogs } = debugLog;

const today = () => new Date().toISOString().slice(0, 10);
const todayFile = () => join(DEBUG_DIR, `debug-${today()}.log`);
const readToday = () => readFileSync(todayFile(), "utf8");

section("secret-shaped keys never keep their value");

logger.debug(
  {
    password: "p@ss-hunter2",
    nested: {
      apiKey: "sk-live-abcdef",
      deeper: { authorization: "Bearer tok-1234567890", cookie: "sid=abc" },
    },
    session: "sess-1",
    passcode: "9999",
  },
  "secret probe",
);
let text = readToday();
ok("a top-level password is gone", !text.includes("hunter2"));
ok("a nested api key is gone", !text.includes("sk-live-abcdef"));
ok("a deeper authorization is gone", !text.includes("tok-1234567890"));
ok("a cookie is gone", !text.includes("sid=abc"));
ok("a session value is gone", !text.includes("sess-1"));
ok("a passcode value is gone", !text.includes("9999"));
ok("the redaction marker is written", text.includes("[redacted]"));

section("diagnostic codes survive, short digit codes do not");

logger.debug(
  {
    err: { code: "ENOENT", statusCode: 404 },
    code: "123456",
    pairingCode: "ABCD-1234",
    resetCode: "1234",
    verificationCode: "5678",
    setupCode: "SETUP-9",
    otp: "999111",
  },
  "code probe",
);
const lastRecord = () => JSON.parse(readToday().trim().split("\n").at(-1));
let codeRecord = lastRecord();
equal("err.code is kept", codeRecord.err.code, "ENOENT");
equal("statusCode is kept", codeRecord.err.statusCode, 404);
equal("a 6-digit bare code is redacted", codeRecord.code, "[redacted]");
equal("pairingCode is redacted", codeRecord.pairingCode, "[redacted]");
equal("resetCode is redacted", codeRecord.resetCode, "[redacted]");
equal("verificationCode is redacted", codeRecord.verificationCode, "[redacted]");
equal("setupCode is redacted", codeRecord.setupCode, "[redacted]");
equal("otp is redacted", codeRecord.otp, "[redacted]");
logger.debug({ code: "ERR_SOCKET" }, "code keep probe");
codeRecord = lastRecord();
equal("a non-digit bare code is kept for diagnosis", codeRecord.code, "ERR_SOCKET");

section("a handled command never writes its arguments");

{
  const { loadCommands } = await import("../src/handlers/command.handler.js");
  const { handleIncomingMessage } = await import("../src/handlers/message.handler.js");
  await loadCommands();
  const secretArg = "hunter2-phrase";
  const shortSecret = "482913";
  const commandText = `!ping ${secretArg} ${shortSecret}`;
  await handleIncomingMessage(
    { sendMessage: async () => ({ key: { id: "m-sent" } }) },
    {
      type: "notify",
      messages: [
        {
          key: { remoteJid: "201111111111@s.whatsapp.net", fromMe: false, id: "m-cmd-1" },
          message: { conversation: commandText },
          messageTimestamp: Math.floor(Date.now() / 1000),
        },
      ],
    },
  );
  const commandLog = readToday();
  ok("command arguments are not in the debug file", !commandLog.includes(secretArg));
  ok("a short argument is not in the debug file", !commandLog.includes(shortSecret));
  const handled = commandLog
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((row) => String(row.msg || "").includes("Handled as command"));
  equal("the command was logged", handled.length, 1);
  equal("the log names the command token", handled[0].command, "!ping");
  equal("the log names the chat type", handled[0].chat, "private");
  equal("the log keeps the text length", handled[0].bodyLength, commandText.length);
}

section("message content keeps only a length");

logger.debug(
  {
    text: "hello secret world",
    body: "1234567890",
    caption: "cap",
    conversation: "talk",
    message: "m",
    quoted: "quote",
    content: "content",
    prompt: "prompt",
    reply: "reply",
  },
  "content probe",
);
text = readToday();
ok("message text is gone", !text.includes("hello secret world"));
ok("the text length is kept", text.includes("[redacted 18 chars]"));
ok("the body length is kept", text.includes("[redacted 10 chars]"));
ok("a one-character message is still only a length", text.includes("[redacted 1 chars]"));

section("every surviving string is sanitized");

logger.debug(
  { note: "mail me@example.com or 201234567890@s.whatsapp.net ticket 1234567" },
  "identity probe",
);
text = readToday();
ok("the e-mail is gone", !text.includes("me@example.com"));
ok("the JID is gone", !text.includes("s.whatsapp.net"));
ok("the e-mail became <email>", text.includes("<email>"));
ok("the JID became <jid>", text.includes("<jid>"));
ok("a long number became <number>", text.includes("<number>"));

const tail = readDebugTail();
ok("the read tail is re-sanitized: no e-mail", !tail.includes("me@example.com"));
ok("the read tail is re-sanitized: no JID", !tail.includes("s.whatsapp.net"));
ok("re-reading does not re-measure a length marker", tail.includes("[redacted 18 chars]"));
ok("the read tail returns JSON records", tail.split("\n").every((line) => !line || !!JSON.parse(line)));

section("14 days on the device, then swept");

const oldFile = join(DEBUG_DIR, "debug-2001-01-01.log");
const freshFile = join(DEBUG_DIR, `debug-${today()}.log`);
const unrelatedFile = join(DEBUG_DIR, "notes.txt");
writeFileSync(oldFile, "{}\n");
writeFileSync(unrelatedFile, "keep");
writeFileSync(freshFile, `${readFileSync(freshFile, "utf8")}{}\n`);
const past = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000);
utimesSync(oldFile, past, past);
utimesSync(unrelatedFile, past, past);
sweepDebugLogs();
ok("a file older than 14 days is deleted", !existsSync(oldFile));
ok("today's file is kept", existsSync(freshFile));
ok("a file that is not a debug log is left alone", existsSync(unrelatedFile));

section("Clear logs flushes the debug log too");

logger.debug("before clear");
ok("a debug file exists before clearing", existsSync(todayFile()));
logger.clearLogs();
equal("the debug directory is empty after Clear logs", readdirSync(DEBUG_DIR).length, 0);
logger.debug("after clear");
ok("logging resumes after clearing", readToday().includes("after clear"));

// --- the two send paths ---------------------------------------------------

const feedback = [];
const crashes = [];

const feedbackStub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    feedback.push(parsed);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
const crashStub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    crashes.push(parsed);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: parsed?.id }));
  });
});
await new Promise((resolve) => feedbackStub.listen(0, "127.0.0.1", resolve));
await new Promise((resolve) => crashStub.listen(0, "127.0.0.1", resolve));
process.env.LEVIX_FEEDBACK_URL = `http://127.0.0.1:${feedbackStub.address().port}/api/feedback`;
process.env.LEVIX_CRASH_REPORT_URL = `http://127.0.0.1:${crashStub.address().port}/api/crash-reports`;

const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  let res = await http.form("/setup", {
    password: "a-good-password",
    confirm: "a-good-password",
  });
  equal("claiming the panel signs us in", res.status, 303);

  section("feedback has debugLog only when diagnostics are ticked");

  res = await http.json("/dashboard/api/feedback", {
    message: "A plain report with no diagnostics attached.",
    topic: "bug",
  });
  equal("the plain report is accepted", res.status, 200);
  const plain = feedback.at(-1);
  ok("the envelope has no debugLog key", !("debugLog" in plain));

  // The preview and the send must be handed the same client object: the route
  // is a promise of the exact upload, not of a similar one.
  const diagnosticsClient = { device: "samsung SM-A556E", language: "en" };

  res = await http.json("/dashboard/api/feedback/diagnostics-preview", {
    client: diagnosticsClient,
  });
  equal("the diagnostics preview still answers", res.status, 200);
  const preview = await res.json();
  ok("the diagnostics preview has the diagnostics", !!preview.diagnostics);
  equal("the preview has a debugLog string", typeof preview.debugLog, "string");

  ok("the preview returns a snapshot id", typeof preview.debugLogId === "string" && preview.debugLogId.length > 0);
  res = await http.json("/dashboard/api/feedback", {
    message: "A report with the diagnostics box ticked.",
    topic: "bug",
    diagnostics: diagnosticsClient,
    debugLogId: preview.debugLogId,
  });
  equal("the diagnostics report is accepted", res.status, 200);
  const withDiag = feedback.at(-1);
  ok("the envelope carries diagnostics", !!withDiag.diagnostics);
  equal(
    "the forwarded diagnostics equal the preview",
    JSON.stringify(withDiag.diagnostics),
    JSON.stringify(preview.diagnostics),
  );
  equal("the preview and the send carry the same debug log", withDiag.debugLog, preview.debugLog);

  const unseen = "after-preview-unseen-marker";
  debugLog.writeRecord({ time: Date.now(), level: 20, msg: unseen });
  res = await http.json("/dashboard/api/feedback", {
    message: "A second report still using the previewed snapshot.",
    topic: "bug",
    diagnostics: diagnosticsClient,
    debugLogId: preview.debugLogId,
  });
  equal("the snapshotted report is accepted", res.status, 200);
  const frozen = feedback.at(-1);
  equal("the send keeps the previewed debug log", frozen.debugLog, preview.debugLog);
  ok("records written after the preview are not uploaded", !frozen.debugLog.includes(unseen));
  res = await http.json("/dashboard/api/feedback", {
    message: "A report whose snapshot id is missing.",
    topic: "bug",
    diagnostics: diagnosticsClient,
  });
  equal("the report without a snapshot is accepted", res.status, 200);
  ok("a missing snapshot id uploads no debug log", !("debugLog" in feedback.at(-1)));

  section("a crash-report send carries it, the preview does too");

  res = await http.json("/dashboard/api/crash-reports", {
    category: "web-error",
    error: { type: "TypeError", message: "render failed", stack: "f1\nf2" },
    screen: "stickers",
  });
  equal("a report is stored", res.status, 200);
  const id = (await res.json()).id;

  res = await http.call("/dashboard/api/crash-reports");
  const listed = (await res.json()).reports.find((report) => report.id === id);
  ok("the preview has the stored report", !!listed);
  equal("the crash preview carries a debugLog string", typeof listed.debugLog, "string");

  ok("the crash preview returns a snapshot id", typeof listed.debugLogId === "string" && listed.debugLogId.length > 0);
  res = await http.json(`/dashboard/api/crash-reports/${id}/send`, { debugLogId: listed.debugLogId });
  equal("the send succeeds", res.status, 200);
  const wire = crashes.at(-1);
  equal("the crash upload carries debugLog", typeof wire.debugLog, "string");
  equal(
    "the crash preview and the send carry the same debug log",
    wire.debugLog,
    listed.debugLog,
  );
  ok("the crash upload is still a report", wire.id === id && wire.schema === 1);

  section("an expired snapshot uploads no debug log");

  const feedbackMod = require("./src/panel/feedback.cjs");
  const crashMod = require("./src/diagnostics/crashReports.cjs");
  const expiredPreview = feedbackMod.buildDiagnosticsAttachment({ language: "en" });
  debugLog.expireDebugSnapshot(expiredPreview.debugLogId);
  await feedbackMod.submitFeedback(
    {
      message: "Expired snapshot must not upload a fresh tail.",
      topic: "bug",
      rating: null,
      contact: null,
    },
    null,
    { language: "en" },
    expiredPreview.debugLogId,
  );
  ok("an expired feedback id uploads no debug log", !("debugLog" in feedback.at(-1)));
  ok("diagnostics are still attached", !!feedback.at(-1).diagnostics);
  await feedbackMod.submitFeedback(
    {
      message: "A missing snapshot id must not upload a fresh tail.",
      topic: "bug",
      rating: null,
      contact: null,
    },
    null,
    { language: "en" },
  );
  ok("an in-process missing id uploads no debug log", !("debugLog" in feedback.at(-1)));

  const expiredReport = crashMod.createReport({
    category: "web-error",
    error: { type: "Error", message: "expired snapshot", stack: "a\nb" },
  });
  const crashSnap = debugLog.storeDebugSnapshot("frozen-preview-bytes");
  debugLog.expireDebugSnapshot(crashSnap);
  await crashMod.sendReport(expiredReport.id, crashSnap);
  ok("an expired crash id uploads no debug log", !("debugLog" in crashes.at(-1)));
  const bareReport = crashMod.createReport({
    category: "web-error",
    error: { type: "Error", message: "missing snapshot", stack: "c\nd" },
  });
  await crashMod.sendReport(bareReport.id);
  ok("an in-process missing crash id uploads no debug log", !("debugLog" in crashes.at(-1)));

  const crashUnseen = "crash-after-preview-unseen-marker";
  debugLog.writeRecord({ time: Date.now(), level: 20, msg: crashUnseen });
  res = await http.json("/dashboard/api/crash-reports", {
    category: "web-error",
    error: { type: "TypeError", message: "later render", stack: "f3\nf4" },
    screen: "stickers",
  });
  equal("a second report is stored", res.status, 200);
  const laterId = (await res.json()).id;
  res = await http.json(`/dashboard/api/crash-reports/${laterId}/send`, {
    debugLogId: listed.debugLogId,
  });
  equal("the snapshotted crash send succeeds", res.status, 200);
  equal("the crash send keeps the previewed debug log", crashes.at(-1).debugLog, listed.debugLog);
  ok("a newer debug record is not in the crash upload", !crashes.at(-1).debugLog.includes(crashUnseen));

  res = await http.json("/dashboard/api/crash-reports", {
    category: "web-error",
    error: { type: "TypeError", message: "no snapshot", stack: "f5\nf6" },
    screen: "stickers",
  });
  const bareId = (await res.json()).id;
  res = await http.json(`/dashboard/api/crash-reports/${bareId}/send`, {});
  equal("a crash send without a snapshot succeeds", res.status, 200);
  ok("a missing crash snapshot uploads no debug log", !("debugLog" in crashes.at(-1)));
} finally {
  await server.stop();
  await new Promise((resolve) => feedbackStub.close(resolve));
  await new Promise((resolve) => crashStub.close(resolve));
}

// --- the 5 MB daily cap ---------------------------------------------------

section("a file stops at 5 MB and says so once");

mkdirSync(DEBUG_DIR, { recursive: true });
writeFileSync(todayFile(), Buffer.alloc(MAX_FILE_BYTES - 10, 0x78));
resetDebugLogState();
debugLog.writeRecord({ time: Date.now(), level: 20, msg: "past the cap marker" });
text = readToday();
ok("the record past the cap is not written", !text.includes("past the cap marker"));
equal("the cap warning is written once", (text.match(/daily cap/g) || []).length, 1);
debugLog.writeRecord({ time: Date.now(), level: 20, msg: "another record" });
equal(
  "a further record does not repeat the warning",
  (readToday().match(/daily cap/g) || []).length,
  1,
);
ok("the file stays just past the cap", statSync(todayFile()).size < MAX_FILE_BYTES + 1024);

finish();
