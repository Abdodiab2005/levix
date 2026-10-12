// The crash-report API (contract section 5).
//
// The real panel server talks to a local stub standing in for
// levix.leviro.net/api/crash-reports, so what leaves the device can be read off
// the wire: no status/lastError, and no request on delete.

import { createServer } from "node:http";
import { equal, finish, httpClient, ok, section, startServer, useTempDataDir } from "./harness.mjs";

const dataDir = useTempDataDir("levix-crash-api");

const received = [];
let failNext = false;
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    received.push({ url: req.url, body: parsed });
    if (failNext) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "stub refused it" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, id: parsed?.id }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
process.env.LEVIX_CRASH_REPORT_URL = `http://127.0.0.1:${stub.address().port}/api/crash-reports`;

const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

function bodyFor(index) {
  return {
    category: "web-error",
    error: { type: "TypeError", message: `render failed ${index}`, stack: `f${index}\nf2\nf3` },
    screen: "stickers",
    breadcrumbs: [{ at: "2026-10-12T19:03:58.000Z", kind: "nav", name: "stickers" }],
    device: { device: "samsung SM-A556E", platform: "hacker" },
  };
}

try {
  section("the routes are behind the panel session");

  let res = await http.call("/dashboard/api/crash-reports");
  equal("listing needs a session", res.status, 401);
  res = await http.json("/dashboard/api/crash-reports", bodyFor(0));
  equal("posting needs a session", res.status, 401);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("claiming the panel signs us in", res.status, 303);

  section("POST stores a report and returns its id");

  res = await http.json("/dashboard/api/crash-reports", bodyFor(0));
  equal("a report is stored", res.status, 200);
  const first = await res.json();
  ok("the id is returned", /^[0-9a-f]{16}$/.test(first.id));
  equal("storing sends nothing", received.length, 0);

  section("the rate limit is 10 per window");

  const statuses = [];
  for (let i = 1; i < 10; i += 1) {
    res = await http.json("/dashboard/api/crash-reports", bodyFor(i));
    statuses.push(res.status);
  }
  equal(
    "reports two through ten are accepted",
    statuses.join(","),
    "200,200,200,200,200,200,200,200,200",
  );

  res = await http.json("/dashboard/api/crash-reports", bodyFor(99));
  equal("the eleventh is throttled", res.status, 429);
  ok("the throttle says when to come back", Number(res.headers.get("retry-after")) > 0);

  section("GET previews the upload object plus the local status");

  res = await http.call("/dashboard/api/crash-reports");
  equal("listing answers", res.status, 200);
  const listed = await res.json();
  equal("ten reports are pending", listed.reports.length, 10);
  ok(
    "every preview has a status",
    listed.reports.every((r) => r.status === "pending"),
  );
  ok(
    "no preview has a last error yet",
    listed.reports.every((r) => r.lastError === null),
  );
  equal("nothing has been sent", listed.sent.length, 0);
  const preview = listed.reports.find((r) => r.id === first.id);
  ok(
    "the preview has no local-only keys",
    !("status" in preview.error) && !("lastError" in preview.error),
  );

  section("send forwards, deletes the file and records the send");

  res = await http.json(`/dashboard/api/crash-reports/${first.id}/send`, {});
  equal("the send reports success", res.status, 200);
  equal("exactly one request went to the endpoint", received.length, 1);
  const wire = received[0].body;
  equal("the wire object keeps the id", wire.id, first.id);
  ok("the wire object has no status", !("status" in wire));
  ok("the wire object has no lastError", !("lastError" in wire));
  ok("the wire object has the schema", wire.schema === 1);

  res = await http.call("/dashboard/api/crash-reports");
  const afterSend = await res.json();
  equal("the sent report is gone locally", afterSend.reports.length, 9);
  ok("the sent report is not in the list", !afterSend.reports.some((r) => r.id === first.id));
  equal("one send is recorded", afterSend.sent.length, 1);
  equal("the send record names the report", afterSend.sent[0].id, first.id);
  equal(
    "the send record has only id, sentAt, category and type",
    Object.keys(afterSend.sent[0]).sort().join(","),
    "category,id,sentAt,type",
  );

  section("a failed send keeps the file as failed");

  const keep = afterSend.reports[0].id;
  failNext = true;
  res = await http.json(`/dashboard/api/crash-reports/${keep}/send`, {});
  equal("the failed send is an error", res.status, 502);
  failNext = false;

  res = await http.call("/dashboard/api/crash-reports");
  const afterFail = await res.json();
  equal("the failed report is still local", afterFail.reports.length, 9);
  const failed = afterFail.reports.find((r) => r.id === keep);
  equal("its status is failed", failed.status, "failed");
  ok("it carries the reason", typeof failed.lastError === "string" && failed.lastError.length > 0);

  section("a failed send is never retried by itself");

  const requestsAfterFail = received.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  equal("no retry left the machine", received.length, requestsAfterFail);

  section("delete terminates locally and never hits the network");

  const requestsBeforeDelete = received.length;
  res = await http.json(`/dashboard/api/crash-reports/${keep}`, {}, "DELETE");
  equal("delete answers success", res.status, 200);
  equal("delete made no request", received.length, requestsBeforeDelete);

  res = await http.json("/dashboard/api/crash-reports/0123456789abcdef", {}, "DELETE");
  equal("deleting an unknown id is a 404", res.status, 404);

  res = await http.json("/dashboard/api/crash-reports", {}, "DELETE");
  equal("delete-all answers success", res.status, 200);
  const cleared = await res.json();
  ok("delete-all reports a count", cleared.removed >= 1);

  res = await http.call("/dashboard/api/crash-reports");
  equal("nothing is left", (await res.json()).reports.length, 0);
} finally {
  await server.stop();
  await new Promise((resolve) => stub.close(resolve));
}

finish();
