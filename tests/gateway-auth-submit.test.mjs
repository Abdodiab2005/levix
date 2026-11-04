import {
  authDestination,
  navigateAfterAuth,
  submitGatewayForm,
} from "../frontend/src/gateway/auth-submit.mjs";
import { equal, finish, ok, section } from "./harness.mjs";

section("destination");
let dest = authDestination("http://localhost:3001/login#connection", "/", "#stickers");
equal("current hash wins", dest.href, "http://localhost:3001/#connection");
equal("different path replaces", dest.reload, false);
dest = authDestination("http://localhost:3001/", "/", "#stickers");
equal("stored hash used", dest.href, "http://localhost:3001/#stickers");
equal("hash change reloads", dest.reload, true);
dest = authDestination("http://localhost:3001/login#connection", "https://evil.invalid/path", "");
equal("off-origin redirect becomes root", dest.href, "http://localhost:3001/#connection");
let removed = false;
let reloaded = false;
const win = {
  location: {
    href: "http://localhost:3001/",
    hash: "",
    reload() {
      reloaded = true;
    },
  },
  sessionStorage: {
    getItem() {
      return "#connection";
    },
    removeItem() {
      removed = true;
    },
  },
};
navigateAfterAuth("/", win);
ok(
  "stored link consumed and page reloaded",
  removed && reloaded && win.location.hash === "#connection",
);

section("submit");
const OriginalFormData = globalThis.FormData;
globalThis.FormData = class {
  constructor(form) {
    this.fields = form.fields;
  }
  [Symbol.iterator]() {
    return this.fields[Symbol.iterator]();
  }
};
const form = { fields: [["password", "a & b"]] };
let request;
const fetchImpl = async (url, options) => {
  request = { url, ...options };
  return {
    json: async () => ({
      ok: false,
      error: { code: "incorrectPassword", message: "Incorrect Password" },
      retryAfter: 7,
    }),
  };
};
let result = await submitGatewayForm("/login", form, { fetchImpl });
equal("error passed through", result.error.code, "incorrectPassword");
equal("retry passed through", result.retryAfter, 7);
equal("accept JSON", request.headers.Accept, "application/json");
equal("form content type", request.headers["Content-Type"], "application/x-www-form-urlencoded");
equal("urlencoded body", request.body.toString(), "password=a+%26+b");
equal("same-origin credentials", request.credentials, "same-origin");
result = await submitGatewayForm("/login", form, {
  fetchImpl: async () => {
    throw new Error("offline");
  },
});
equal("network failure", result.error.code, "resetErrServer");
result = await submitGatewayForm("/login", form, {
  fetchImpl: async () => ({
    json: async () => {
      throw new Error("not JSON");
    },
  }),
});
equal("non-JSON failure", result.error.code, "resetErrServer");
result = await submitGatewayForm("/login", form, {
  timeoutMs: 1,
  fetchImpl: async (_url, options) =>
    new Promise((_resolve, reject) =>
      options.signal.addEventListener("abort", () => reject(new Error("aborted"))),
    ),
});
equal("timeout failure", result.error.code, "resetErrServer");
globalThis.FormData = OriginalFormData;
finish();
