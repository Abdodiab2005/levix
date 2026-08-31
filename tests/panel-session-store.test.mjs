import { require, section, ok, equal, finish } from "./harness.mjs";

const { PanelSessionStore } = require("./src/panel/session-store.cjs");

const call = (fn) =>
  new Promise((resolve, reject) =>
    fn((error, value) => (error ? reject(error) : resolve(value)))
  );

const set = (store, sid, sess) => call((done) => store.set(sid, sess, done));
const get = (store, sid) => call((done) => store.get(sid, done));
const destroy = (store, sid) => call((done) => store.destroy(sid, done));
const length = (store) => call((done) => store.length(done));
const clear = (store) => call((done) => store.clear(done));

section("bounded panel sessions");

const store = new PanelSessionStore({ ttlMs: 10_000, maxSessions: 2 });
await set(store, "a", { loggedIn: true, cookie: { maxAge: 10_000 } });

const first = await get(store, "a");
ok("a stored session is returned", first.loggedIn === true);
first.loggedIn = false;
ok("reads are isolated copies", (await get(store, "a")).loggedIn === true);

await set(store, "b", { loggedIn: true, cookie: { maxAge: 20_000 } });
await set(store, "c", { loggedIn: true, cookie: { maxAge: 30_000 } });
equal("the store stays bounded", await length(store), 2);
equal("the earliest-expiring session is evicted", await get(store, "a"), null);
ok("newer sessions remain", Boolean(await get(store, "b")) && Boolean(await get(store, "c")));

await destroy(store, "b");
equal("destroy removes one session", await get(store, "b"), null);
await clear(store);
equal("clear removes everything", await length(store), 0);

section("expiry");

const short = new PanelSessionStore({ ttlMs: 5, maxSessions: 4 });
await set(short, "short", { loggedIn: true, cookie: { maxAge: 5 } });
await new Promise((resolve) => setTimeout(resolve, 20));
equal("expired sessions disappear on read", await get(short, "short"), null);
equal("expired sessions do not count toward the bound", await length(short), 0);

finish();
