// Execute the shipped login script and dictionaries with a tiny DOM test double.
// No browser dependencies, network requests, real credentials or email.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const template = readFileSync(join(ROOT, "views/login.ejs"), "utf8");
const script = [...template.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const dictionary = readFileSync(join(ROOT, "public/gateway-i18n.js"), "utf8");

for (const language of ["en", "ar"]) {
  section(`${language} recovery UI`);
  function element() {
    const events = {};
    return {
      hidden: false,
      disabled: false,
      value: "",
      textContent: "",
      events,
      addEventListener(name, handler) {
        events[name] = handler;
      },
      focus() {},
      getAttribute() {
        return "email";
      },
    };
  }
  const elements = new Map();
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  const channelButton = element();
  const submit = element();
  get("reset-channels").querySelectorAll = () => [channelButton];
  get("reset-form").querySelector = () => submit;
  const document = {
    documentElement: {
      lang: language,
      getAttribute() {
        return "Levix";
      },
    },
    getElementById: get,
    querySelectorAll: () => [],
    addEventListener() {},
  };
  const window = { location: {}, addEventListener() {} };
  let answer = {};
  let send;
  let calls = 0;
  let timeout;
  const fetch = async (_url, options) => {
    calls += 1;
    ok("request has a timeout signal", Boolean(options.signal));
    if (send) return send();
    return { json: async () => answer };
  };
  runInNewContext(dictionary + script, {
    document,
    window,
    fetch,
    setTimeout(_callback, ms) {
      timeout = ms;
      return 1;
    },
    clearTimeout() {},
    AbortController: class {
      signal = {};
      abort() {}
    },
  });
  const t = window.LevixGatewayI18n.t;
  const choose = () =>
    get("reset-channels").events.click({ target: { closest: () => channelButton } });
  const confirm = () => get("reset-form").events.submit({ preventDefault() {} });

  for (const [reason, key] of [
    ["unverified", "resetErrUnverified"],
    ["unavailable", "resetErrUnavailable"],
    ["no_email", "resetErrNoEmail"],
    ["rate_limited", "resetErrRateLimited"],
  ]) {
    answer = { ok: false, reason };
    await choose();
    equal(`${reason} is translated`, get("reset-error").textContent, t(key));
    ok(
      `${reason} has real localized copy`,
      language === "ar" ? /[\u0600-\u06ff]/.test(t(key)) : t(key) !== key,
    );
    equal(`${reason} leaves channel choices enabled`, channelButton.disabled, false);
  }
  answer = { ok: false, reason: "rate_limited", retryAfter: 173 };
  await choose();
  equal("rate delay is shown", get("reset-error").textContent, t("resetErrThrottled", { n: 173 }));
  equal("UI timeout is bounded", timeout, 20000);

  let release;
  send = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const first = choose();
  const before = calls;
  await choose();
  equal("duplicate channel send is prevented", calls, before);
  release({ json: async () => ({ ok: true }) });
  await first;
  send = null;
  equal("success opens the code form", get("reset-form").hidden, false);
  get("reset-choose-channel").events.click();
  equal("another method is reachable without guessing a code", get("reset-channels").hidden, false);
  equal("another method hides the code form", get("reset-form").hidden, true);
  ok(
    "alternative method label is localized",
    language === "ar"
      ? /[\u0600-\u06ff]/.test(t("resetChooseChannel"))
      : t("resetChooseChannel") !== "resetChooseChannel",
  );

  get("reset-code").value = "123456";
  send = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const pending = confirm();
  const beforeConfirm = calls;
  await confirm();
  equal("duplicate reset confirmation is prevented", calls, beforeConfirm);
  equal("submit is disabled during confirmation", submit.disabled, true);
  release({ json: async () => ({ ok: false, reason: "wrong_code", attemptsLeft: 4 }) });
  await pending;
  send = null;
  equal("wrong code preserves the typed code", get("reset-code").value, "123456");
  equal(
    "attempt count is localized",
    get("reset-error").textContent,
    `${t("resetErrWrongCode")} ${t("resetErrAttemptsLeft", { n: 4 })}`,
  );
  equal("submit recovers after failure", submit.disabled, false);

  answer = { ok: false, reason: "address_changed" };
  await confirm();
  equal("changed address returns to channel choice", get("reset-channels").hidden, false);
  equal(
    "changed address explains expired code",
    get("reset-error").textContent,
    t("resetErrExpired"),
  );
  send = async () => {
    throw new Error("offline");
  };
  await choose();
  equal("offline is localized", get("reset-error").textContent, t("resetErrServer"));
  equal("offline releases channel buttons", channelButton.disabled, false);
}
finish();
