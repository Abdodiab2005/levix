import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

section("submit bridge");
let listener;
let capture;
let requests = [];
let writes = 0;
let navigations = 0;
const location = {
  _href: "http://127.0.0.1:3001/login",
  get href() {
    return this._href;
  },
  set href(value) {
    this._href = value;
    navigations++;
  },
  hash: "",
  replace() {
    navigations++;
  },
  reload() {
    navigations++;
  },
};
const document = {
  addEventListener(name, handler, options) {
    if (name === "submit") {
      listener = handler;
      capture = options;
    }
  },
  open() {},
  write() {
    writes++;
  },
  close() {},
};
class XHR {}
XHR.prototype.open = function () {};
XHR.prototype.send = function () {};
XHR.prototype.setRequestHeader = function () {};
const host = {
  request(...args) {
    requests.push(args);
    return JSON.stringify({ status: 401, body: Buffer.from("error").toString("base64") });
  },
};
const window = { LevixHost: host, fetch() {}, XMLHttpRequest: XHR };
const sessionStorage = {
  getItem() {
    return null;
  },
  setItem() {},
  removeItem() {},
};
runInNewContext(readFileSync(`${ROOT}/android/app/src/main/assets/panel-bridge.js`, "utf8"), {
  window,
  document,
  location,
  sessionStorage,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  Uint8Array,
  ArrayBuffer,
  FormData: class {
    constructor(form) {
      this.fields = form.fields;
    }
    [Symbol.iterator]() {
      return this.fields[Symbol.iterator]();
    }
  },
  btoa: (s) => Buffer.from(s, "binary").toString("base64"),
  atob: (s) => Buffer.from(s, "base64").toString("binary"),
});
equal("listener uses bubble phase", capture, false);
const form = (method) => ({
  tagName: "FORM",
  fields: [["password", "secret value"]],
  getAttribute(name) {
    return name === "method" ? method : "/login";
  },
});
let prevented = false;
listener({
  defaultPrevented: true,
  target: form("post"),
  preventDefault() {
    prevented = true;
  },
});
ok(
  "prevented event ignored",
  !prevented && requests.length === 0 && navigations === 0 && writes === 0,
);
listener({
  defaultPrevented: false,
  target: form("get"),
  preventDefault() {
    prevented = true;
  },
});
ok(
  "GET left alone",
  !prevented && requests.length === 0 && navigations === 0 && !location.href.includes("secret"),
);
listener({
  defaultPrevented: false,
  target: form(null),
  preventDefault() {
    prevented = true;
  },
});
ok(
  "form without method left alone",
  !prevented && requests.length === 0 && navigations === 0 && !location.href.includes("secret"),
);
listener({
  defaultPrevented: false,
  target: form("post"),
  preventDefault() {
    prevented = true;
  },
});
ok("POST intercepted", prevented && requests.length === 1);
equal("POST method", requests[0]?.[1], "POST");
equal(
  "POST urlencoded body",
  Buffer.from(requests[0]?.[3] || "", "base64").toString(),
  "password=secret+value",
);
equal("classic page error rendered", writes, 1);
finish();
