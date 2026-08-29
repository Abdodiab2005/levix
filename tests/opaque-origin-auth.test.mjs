import { useTempDataDir, httpClient, startServer, section, equal, finish } from "./harness.mjs";

const dataDir = useTempDataDir("levix-opaque-origin-auth");
const server = await startServer({ dataDir, trust: "", routes: true });
const http = httpClient(server.base);

try {
  section("opaque-origin browser auth forms");

  let res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "different-one" },
    { origin: "null" },
  );
  equal("Origin:null setup without Sec-Fetch-Site reaches validation", res.status, 400);

  res = await http.form(
    "/setup",
    { password: "a-good-password", confirm: "a-good-password" },
    { origin: "null" },
  );
  equal("Origin:null setup without Sec-Fetch-Site can complete", res.status, 303);

  res = await http.call("/logout", {
    method: "POST",
    headers: { origin: server.base },
  });
  equal("same-origin logout succeeds before login checks", res.status, 303);

  res = await http.form("/login", { password: "wrong" }, { origin: "null" });
  equal("Origin:null login without Sec-Fetch-Site reaches password validation", res.status, 401);

  res = await http.form("/login", { password: "a-good-password" }, { origin: "null" });
  equal("Origin:null login without Sec-Fetch-Site can sign in", res.status, 303);

  res = await http.call("/logout", {
    method: "POST",
    headers: { origin: "null" },
  });
  equal("the Origin:null exception does not extend to logout", res.status, 403);

  res = await http.call("/dashboard/api/settings", {
    method: "PATCH",
    headers: {
      origin: "null",
      "content-type": "application/json",
    },
    body: JSON.stringify({ key: "gemini_model", value: "gemini-x" }),
  });
  equal("the Origin:null exception does not extend to dashboard APIs", res.status, 403);

  res = await http.form(
    "/login",
    { password: "a-good-password" },
    { origin: "null", "sec-fetch-site": "cross-site" },
  );
  equal("explicit cross-site metadata still rejects Origin:null login", res.status, 403);
} finally {
  server.stop();
}

finish();
