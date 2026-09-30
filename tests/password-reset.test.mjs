import {
  equal,
  finish,
  require as harnessRequire,
  httpClient,
  ok,
  section,
  startServer,
  useTempDataDir,
} from "./harness.mjs";

// The WhatsApp-code password reset: the module logic in this process (codes,
// attempts, throttling) and the two unauthenticated routes app.cjs exposes.

useTempDataDir("levix-password-reset");
const reset = harnessRequire("./src/panel/password-reset.cjs");
const secrets = harnessRequire("./src/config/secrets.cjs");

secrets.setDashboardPassword("a-good-password");

section("requesting a code needs a live WhatsApp session");

let result = await reset.requestResetCode("10.0.0.1");
equal("no session -> no_session", result.ok ? undefined : result.reason, "no_session");

section("the code arrives on the linked account's own chat");

const sent = [];
reset.setSession({
  socket: {
    user: { id: "201234567890@s.whatsapp.net" },
    async sendMessage(jid, content) {
      sent.push({ jid, content });
      return { key: { id: "fake" } };
    },
  },
});

result = await reset.requestResetCode("10.0.0.2");
equal("request succeeds", result.ok, true);
equal("one WhatsApp message went out", sent.length, 1);
equal("it went to the paired account's own jid", sent[0].jid, "201234567890@s.whatsapp.net");
const code = /\b(\d{6})\b/.exec(sent[0].content.text)?.[1];
equal("the message carries a 6-digit code", code?.length, 6);

section("a second request too soon is throttled");

result = await reset.requestResetCode("10.0.0.3");
equal("global cooldown blocks the second send", result.reason, "throttled");
ok("cooldown carries a retryAfter", (result.retryAfter || 0) > 0 && result.retryAfter <= 60);

section("completing the reset");

equal(
  "mismatched confirmation does not burn the code",
  reset.completeReset(code, "new-password-1", "different").reason,
  "mismatch",
);
equal(
  "a wrong code is refused",
  reset.completeReset("000000", "new-password-1", "new-password-1").reason,
  "wrong_code",
);
equal("four attempts remain", reset.completeReset("000001", "x-pass", "x-pass").attemptsLeft, 3);
equal("third wrong", reset.completeReset("000002", "x-pass", "x-pass").reason, "wrong_code");
equal("fourth wrong", reset.completeReset("000003", "x-pass", "x-pass").reason, "wrong_code");
equal(
  "the fifth wrong code kills the pending request",
  reset.completeReset("000004", "x-pass", "x-pass").reason,
  "too_many_attempts",
);
equal(
  "and nothing is left to complete",
  reset.completeReset(code, "new-password-1", "new-password-1").reason,
  "no_pending",
);

reset._resetForTests();
sent.length = 0;
await reset.requestResetCode("10.0.0.4");
const freshCode = /\b(\d{6})\b/.exec(sent[0].content.text)?.[1];
equal(
  "a fresh request completes with the right code",
  reset.completeReset(freshCode, "another-good-one", "another-good-one").ok,
  true,
);
equal("the password actually changed", secrets.verifyDashboardPassword("another-good-one"), true);
equal(
  "the code was single use",
  reset.completeReset(freshCode, "x-pass", "x-pass").reason,
  "no_pending",
);

section("the HTTP surface");

const webDir = useTempDataDir("levix-password-reset-http");
const server = await startServer({ dataDir: webDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  let res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("loopback setup sets the password", res.status, 303);

  res = await http.json("/reset/request", {});
  equal("request without a WhatsApp session is 409", res.status, 409);
  equal("the body says why", (await res.json()).reason, "no_session");

  res = await http.call("/reset/request", {
    method: "POST",
    headers: { origin: "null", "content-type": "application/json" },
    body: "{}",
  });
  equal("Origin:null passes the mutation check like login", res.status, 409);

  res = await http.json("/reset/confirm", {
    code: "123456",
    password: "whatever-1",
    confirm: "whatever-1",
  });
  equal("confirm with nothing pending is 401", res.status, 401);
} finally {
  server.stop();
}

finish();
