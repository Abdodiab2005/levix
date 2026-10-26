// Shared artifact validation: a strict local v2 relay, no SMTP or external HTTP.
// The installed client must bind an address and complete a real panel reset.
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

export async function createRecoveryArtifactProbe() {
  const email = "artifact@example.com";
  const verifyCode = "743821";
  const verification = randomBytes(16).toString("hex");
  const token = `v1.${randomBytes(32).toString("base64url")}`;
  let pending = false;
  let authorized = false;
  let resetCode = null;
  const requests = [];

  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    let status = 400;
    let answer = { ok: false, error: "invalid" };
    const keys = body && typeof body === "object" ? Object.keys(body).sort().join(",") : "";
    if (req.method === "POST" && body) {
      if (
        body.kind === "verify" &&
        keys === "kind,lang,to" &&
        body.to === email &&
        body.lang === "en"
      ) {
        requests.push("verify");
        pending = true;
        answer = { ok: true, verification };
        status = 200;
      } else if (
        body.kind === "confirm" &&
        keys === "code,kind,verification" &&
        pending &&
        body.verification === verification &&
        body.code === verifyCode
      ) {
        requests.push("confirm");
        pending = false;
        authorized = true;
        answer = { ok: true, token };
        status = 200;
      } else if (
        body.kind === "reset" &&
        keys === "code,kind,lang,to,token" &&
        authorized &&
        body.to === email &&
        body.token === token &&
        body.lang === "en" &&
        /^\d{6}$/.test(body.code)
      ) {
        requests.push("reset");
        resetCode = body.code;
        answer = { ok: true };
        status = 200;
      }
    }
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(answer));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  server.unref();

  return {
    endpoint: `http://127.0.0.1:${server.address().port}/api/recovery-email`,
    async close() {
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
    async verify(base, report) {
      let reportedFailure = false;
      function check(label, condition) {
        report(label, Boolean(condition));
        if (!condition) {
          reportedFailure = true;
          throw new Error(label);
        }
      }
      try {
        const login = await fetch(`${base}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password: "a-good-password" }),
          signal: AbortSignal.timeout(20_000),
        });
        const cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");
        check("recovery probe signs in to the installed panel", login.status === 303 && cookie);
        async function json(path, body, authenticated = false) {
          const response = await fetch(`${base}${path}`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...(authenticated ? { cookie } : {}) },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(20_000),
          });
          return { status: response.status, body: await response.json() };
        }
        const denied = await json(
          "/dashboard/api/recovery-email/start",
          { email, lang: "en" },
          true,
        );
        check(
          "binding recovery requires the current password",
          denied.status === 400 && denied.body.error === "wrong_password",
        );
        const started = await json(
          "/dashboard/api/recovery-email/start",
          { email, current: "a-good-password", lang: "en" },
          true,
        );
        check(
          "installed client requests server-generated verification",
          started.status === 200 && started.body.success && requests.join(",") === "verify",
        );
        const confirmed = await json(
          "/dashboard/api/recovery-email/verify",
          { code: verifyCode },
          true,
        );
        check(
          "installed client confirms and stores relay authorization",
          confirmed.status === 200 &&
            confirmed.body.verified &&
            requests.join(",") === "verify,confirm",
        );
        check(
          "recovery API does not expose its token",
          !JSON.stringify(confirmed.body).includes(token),
        );
        const sent = await json("/reset/request", { channel: "email", lang: "en" });
        check(
          "anonymous email reset sends the stored token",
          sent.status === 200 &&
            sent.body.ok &&
            resetCode &&
            requests.join(",") === "verify,confirm,reset",
        );
        const completed = await json("/reset/confirm", {
          code: resetCode,
          password: "artifact-replacement-password",
          confirm: "artifact-replacement-password",
        });
        check(
          "installed client completes an email password reset",
          completed.status === 200 && completed.body.ok,
        );
        const replayed = await json("/reset/confirm", {
          code: resetCode,
          password: "artifact-replacement-password",
          confirm: "artifact-replacement-password",
        });
        check("artifact reset code is single use", replayed.body.reason === "no_pending");
        const stale = await fetch(`${base}/dashboard/api/stats`, {
          headers: { cookie },
          signal: AbortSignal.timeout(20_000),
        });
        check("email reset invalidates the previous panel session", stale.status === 401);
        const nextLogin = await fetch(`${base}/login`, {
          method: "POST",
          redirect: "manual",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ password: "artifact-replacement-password" }),
          signal: AbortSignal.timeout(20_000),
        });
        check("the replacement password signs in", nextLogin.status === 303);
        return true;
      } catch {
        // Never print response bodies or credentials on failure.
        if (!reportedFailure) {
          report("recovery artifact probe completes without a network/protocol failure", false);
        }
        return false;
      }
    },
  };
}
