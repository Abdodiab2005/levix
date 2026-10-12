// Feedback diagnostics (contract section 3).
//
// Two promises are checked against the bytes on the wire:
//   * without the diagnostics key, the envelope has no `diagnostics` and no
//     device fields at all;
//   * with it, the forwarded object is exactly what the preview route returned.
//
// A local stub stands in for levix.leviro.net/api/feedback. No outside network.

import { createServer } from "node:http";
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

const dataDir = useTempDataDir("levix-feedback-diag");

const received = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    received.push({ url: req.url, body: parsed, raw: body });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.LEVIX_FEEDBACK_URL = `http://127.0.0.1:${stub.address().port}/api/feedback`;

const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

const client = {
  nativeApp: "4.7.0 (65)",
  android: "15 (API 35)",
  device: "samsung SM-A556E",
  abi: "arm64-v8a",
  webview: "131.0.6778.135",
  screen: "412x915@2.63",
  language: "ar",
  theme: "dark",
  connectivity: "wifi",
  memory: "ok",
  storage: "ok",
  levix: "9.9.9",
  node: "v0.0.0",
  platform: "hacker",
};

try {
  section("both diagnostics routes are behind the panel session");

  let res = await http.json("/dashboard/api/feedback/diagnostics-preview", { client });
  equal("the preview needs a session", res.status, 401);
  res = await http.json("/dashboard/api/feedback", {
    message: "a message that is long enough",
    diagnostics: client,
  });
  equal("the feedback route needs a session", res.status, 401);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("claiming the panel signs us in", res.status, 303);

  section("the preview is the sanitized section 1 object");

  res = await http.json("/dashboard/api/feedback/diagnostics-preview", { client });
  equal("the preview answers", res.status, 200);
  const preview = (await res.json()).diagnostics;
  equal("the preview has the schema", preview.schema, 1);
  equal(
    "the preview ignores the client platform",
    preview.platform,
    require("./src/panel/feedback.cjs").describeRuntime().platform,
  );
  ok("the preview keeps the Android fields", preview.device === "samsung SM-A556E");
  ok("the preview drops unknown keys", !("evil" in preview));

  section("without the key nothing device-shaped travels");

  const before = received.length;
  res = await http.json("/dashboard/api/feedback", {
    message: "A plain report with no diagnostics attached.",
    topic: "bug",
  });
  equal("the plain report is accepted", res.status, 200);
  equal("exactly one request went out", received.length, before + 1);
  const plain = received[received.length - 1].body;
  ok("the envelope has no diagnostics key", !("diagnostics" in plain));
  equal(
    "no device field rode along",
    Object.keys(plain).sort().join(","),
    "app,contact,message,rating,source,topic",
  );

  section("with the key the forwarded object equals the preview");

  res = await http.json("/dashboard/api/feedback", {
    message: "A report with the diagnostics box ticked and nothing else.",
    topic: "bug",
    diagnostics: client,
  });
  equal("the report is accepted", res.status, 200);
  const withDiag = received[received.length - 1].body;
  ok("the envelope carries diagnostics", !!withDiag.diagnostics);
  equal(
    "the forwarded diagnostics are byte-for-byte the preview",
    JSON.stringify(withDiag.diagnostics),
    JSON.stringify(preview),
  );
  ok("the diagnostics are the top-level key", "diagnostics" in withDiag);
  ok("no raw device value is loose on the envelope", !("device" in withDiag));

  section("a multipart diagnostics field travels too");

  const boundary = "----levix-feedback-diag-test";
  const part = (name, value) =>
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const multipart = [
    part("message", "A multipart report with the diagnostics field."),
    part("topic", "idea"),
    part("diagnostics", JSON.stringify(client)),
    `--${boundary}--\r\n`,
  ].join("");
  res = await http.call("/dashboard/api/feedback", {
    method: "POST",
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
    body: multipart,
  });
  equal("the multipart report is accepted", res.status, 200);
  const fromMultipart = received[received.length - 1].body;
  equal(
    "the multipart diagnostics equal the preview too",
    JSON.stringify(fromMultipart.diagnostics),
    JSON.stringify(preview),
  );

  section("a malformed diagnostics value is refused before the wire");

  const wireBefore = received.length;
  res = await http.json("/dashboard/api/feedback", {
    message: "A report whose diagnostics field is broken JSON.",
    diagnostics: "{not json",
  });
  equal("broken JSON is a bad request", res.status, 400);
  equal("nothing was forwarded", received.length, wireBefore);
} finally {
  await server.stop();
  await new Promise((resolve) => stub.close(resolve));
}

finish();
