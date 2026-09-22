// The feedback path: the panel's line to the developer.
//
// Two halves. First the validator in src/panel/feedback.cjs, in-process. Then
// the real route, through the real panel server, with a local stub standing in
// for levix.leviro.net/api/feedback — so what actually travels can be read off
// the wire, including the promise that nothing about WhatsApp is attached.
//
// No outside network is touched: LEVIX_FEEDBACK_URL points at the stub.

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

const dataDir = useTempDataDir("levix-feedback");

const feedback = require("./src/panel/feedback.cjs");

section("the validator decides what may leave");

let result = feedback.validateFeedback({ message: "too short" });
ok("a message under the minimum is refused", result.ok === false);

result = feedback.validateFeedback({ message: "a message that is long enough to send" });
ok("a long enough message passes", result.ok === true);
equal("an unknown topic falls back to other", result.value.topic, "other");
equal("no rating means no rating", result.value.rating, null);
equal("no contact means no contact", result.value.contact, null);

result = feedback.validateFeedback({
  message: "a message that is long enough to send",
  topic: "bug",
  rating: 4,
  contact: "  me@example.com  ",
});
equal("a known topic is kept", result.value.topic, "bug");
equal("a rating in range is kept", result.value.rating, 4);
equal("the contact is trimmed", result.value.contact, "me@example.com");

ok(
  "a rating out of range is refused",
  feedback.validateFeedback({ message: "a message that is long enough", rating: 9 }).ok === false,
);
ok(
  "a fractional rating is refused",
  feedback.validateFeedback({ message: "a message that is long enough", rating: 2.5 }).ok === false,
);
ok("a non-object body is refused", feedback.validateFeedback("nope").ok === false);

result = feedback.validateFeedback({
  message: `line one\nline two\u0007 with a bell\u0000`,
});
// Checked by code point rather than a regex: a control character inside a
// character class is exactly what the linter (rightly) refuses.
const hasControl = [...result.value.message].some((char) => {
  const code = char.codePointAt(0);
  return (code < 0x20 || code === 0x7f) && char !== "\n" && char !== "\r" && char !== "\t";
});
ok("control characters are stripped", !hasControl);
ok("line breaks the operator typed survive", result.value.message.includes("\n"));

result = feedback.validateFeedback({ message: "x".repeat(5000) });
equal("an overlong message is cut to the limit", result.value.message.length, feedback.MESSAGE_MAX);

const runtime = feedback.describeRuntime();
ok("the runtime reports a version", typeof runtime.version === "string" && runtime.version !== "");
ok(
  "the runtime reports a platform",
  typeof runtime.platform === "string" && runtime.platform !== "",
);

// --- the route, end to end ------------------------------------------------

// The stub answers like the website: 503 when asked to refuse, 200 otherwise.
const received = [];
const stub = createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {}
    received.push({ url: req.url, headers: req.headers, body: parsed });
    if (parsed?.message?.includes("REFUSE-ME")) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "Feedback delivery is not configured." }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
// Read by src/panel/feedback.cjs at call time, in the server's own process.
process.env.LEVIX_FEEDBACK_URL = `http://127.0.0.1:${stub.address().port}/api/feedback`;

const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  section("the endpoint is behind the panel session");

  let res = await http.json("/dashboard/api/feedback", {
    message: "a message that is long enough",
  });
  equal("no session, no feedback", res.status, 401);

  res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("claiming the panel signs us in", res.status, 303);

  section("what the form needs to render itself");

  res = await http.call("/dashboard/api/feedback/meta");
  equal("the meta route answers", res.status, 200);
  const meta = await res.json();
  ok("it lists the topics", Array.isArray(meta.topics) && meta.topics.includes("bug"));
  equal("it states the minimum", meta.messageMin, feedback.MESSAGE_MIN);
  equal("it states the maximum", meta.messageMax, feedback.MESSAGE_MAX);
  ok("it names the version that will travel", typeof meta.runtime.version === "string");

  section("a bad submission never reaches the wire");

  const before = received.length;
  res = await http.json("/dashboard/api/feedback", { message: "short" });
  equal("a too-short message is refused", res.status, 400);
  res = await http.json("/dashboard/api/feedback", { message: "long enough to pass", rating: 42 });
  equal("an impossible rating is refused", res.status, 400);
  equal("nothing was forwarded", received.length, before);

  section("a good submission is forwarded, and carries only what it should");

  res = await http.json("/dashboard/api/feedback", {
    message: "The pairing code screen does not refresh on my phone.",
    topic: "bug",
    rating: 4,
    contact: "me@example.com",
  });
  equal("the panel reports success", res.status, 200);
  equal("exactly one request went out", received.length, before + 1);

  const sent = received[received.length - 1];
  equal("it went to the configured endpoint", sent.url, "/api/feedback");
  equal("it is marked as coming from the panel", sent.body.source, "panel");
  equal(
    "the message is intact",
    sent.body.message,
    "The pairing code screen does not refresh on my phone.",
  );
  equal("the topic is intact", sent.body.topic, "bug");
  equal("the rating is intact", sent.body.rating, 4);
  equal("the contact is intact", sent.body.contact, "me@example.com");
  ok("the version travels with it", typeof sent.body.app?.version === "string");
  ok("the platform travels with it", typeof sent.body.app?.platform === "string");
  ok("the user-agent names Levix", String(sent.headers["user-agent"]).startsWith("Levix/"));

  // The promise the panel makes to the operator, checked against the bytes.
  const wire = JSON.stringify(sent.body);
  const keys = Object.keys(sent.body).sort().join(",");
  equal(
    "no field travels that the form did not offer",
    keys,
    "app,contact,message,rating,source,topic",
  );
  ok("no cookie rides along", !("cookie" in sent.headers));
  ok(
    "nothing WhatsApp-shaped is in the payload",
    !/whatsapp|s\.whatsapp\.net|@g\.us|creds|apiKey|api_key|password/i.test(wire),
  );

  section("the receiving end's answer is passed through, not swallowed");

  res = await http.json("/dashboard/api/feedback", {
    message: "REFUSE-ME — this one the stub turns down",
  });
  equal("a 503 from the endpoint stays a 503", res.status, 503);
  const refused = await res.json();
  ok(
    "the operator is told it failed",
    refused.success === false && typeof refused.error === "string",
  );

  section("a stuck retry loop cannot become a flood");

  // Two attempts have been forwarded so far; the throttle allows five an hour.
  const statuses = [];
  for (let i = 0; i < 4; i += 1) {
    res = await http.json("/dashboard/api/feedback", {
      message: `another long enough message ${i}`,
    });
    statuses.push(res.status);
  }
  equal("the third, fourth and fifth go out", statuses.slice(0, 3).join(","), "200,200,200");
  equal("the sixth is throttled", statuses[3], 429);
  res = await http.json("/dashboard/api/feedback", { message: "one more long enough message" });
  equal("and it stays throttled", res.status, 429);
  ok("the throttle says when to come back", Number(res.headers.get("retry-after")) > 0);
} finally {
  await server.stop();
  await new Promise((resolve) => stub.close(resolve));
}

finish();
