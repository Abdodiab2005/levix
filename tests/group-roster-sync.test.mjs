// Group roster sync (C-1, C-2). Fake socket only. On b383ed1 the send path is
// cache.get: it returns the old roster after group-participants.update, no
// refresh runs, a partial groups.update creates an entry and resets the TTL,
// and there is no stale flag or roster-state map.

import { EventEmitter } from "node:events";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("group-roster-sync");

const groupMetadataCache = require("./src/utils/groupMetadataCache.cjs");
const settings = require("./src/config/settings.cjs");
const store = require("./src/db/store.cjs");
const storage = require("./src/utils/storage.cjs");
const { setupEventListeners } = await import("../src/core/events.js");
const { routeSend } = require("./src/messaging/router.cjs");

const G = "120363000000000101@g.us";
const OUT = "120363000000000102@g.us";
const SHARE = "120363000000000103@g.us";
const ROUTE = "120363000000000104@g.us";
const GHOST = "120363000000000188@g.us";
const OWNER = "201555000111@s.whatsapp.net";
const SOURCE = "201555000999@s.whatsapp.net";

const ADMIN = {
  id: "100000000000001@s.whatsapp.net",
  lid: "200000000000001@lid",
  admin: "admin",
};
const MEMBER = {
  id: "200000000000002@lid",
  phoneNumber: "100000000000002@s.whatsapp.net",
  admin: null,
};
const LATE = {
  id: "200000000000099@lid",
  phoneNumber: "100000000000099@s.whatsapp.net",
  admin: null,
};
const OWNER_PART = { id: OWNER, lid: "200000000000111@lid", admin: "admin" };

function roster(id, participants, extra = {}) {
  return { id, subject: extra.subject || "Group", participants, ...extra };
}

function ids(meta) {
  return (meta?.participants || []).map((participant) => participant?.id).join(",");
}

function defer() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function tick() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function sendHook(sock, jid) {
  const hook = groupMetadataCache.groupMetadataForSend;
  if (typeof hook !== "function") return groupMetadataCache.getCached(jid);
  return hook(sock, jid);
}

function stale(jid) {
  return typeof groupMetadataCache.isRosterStale === "function"
    ? groupMetadataCache.isRosterStale(jid)
    : false;
}

function stateSize() {
  return typeof groupMetadataCache.rosterStateSize === "function"
    ? groupMetadataCache.rosterStateSize()
    : -1;
}

const ev = new EventEmitter();
ev.setMaxListeners(30);
const sock = {
  ev,
  user: { id: OWNER },
  ws: { on() {} },
  async groupMetadata(jid) {
    return roster(jid, []);
  },
  async sendMessage() {
    return { key: { id: "out" } };
  },
};

setupEventListeners(sock, {
  saveCreds() {},
  onConnectionUpdate() {},
});

function emit(id, action, participants = [MEMBER]) {
  sock.ev.emit("group-participants.update", { id, action, participants });
}

section("roster event hides the old roster from the send hook");

{
  groupMetadataCache.flushAll();
  const oldRoster = roster(G, [ADMIN]);
  const nextRoster = roster(G, [ADMIN, MEMBER]);
  groupMetadataCache.setCached(G, oldRoster);
  const box = defer();
  let calls = 0;
  sock.groupMetadata = () => {
    calls += 1;
    return box.promise;
  };
  emit(G, "add", [MEMBER]);
  ok("stale before the fetch resolves", stale(G) === true);
  equal("the event starts one refresh", calls, 1);
  let settled = false;
  let early;
  const hookP = Promise.resolve(sendHook(sock, G)).then((value) => {
    settled = true;
    early = value;
    return value;
  });
  await tick();
  ok("send hook does not return the old roster", !settled || ids(early) !== ids(oldRoster));
  equal("getCached keeps the last roster", ids(groupMetadataCache.getCached(G)), ids(oldRoster));
  box.resolve(nextRoster);
  const got = await hookP;
  equal("hook returns the new roster", ids(got), ids(nextRoster));
  const stored = groupMetadataCache.getCached(G);
  const added = stored?.participants?.find((participant) => participant.id === MEMBER.id);
  const admin = stored?.participants?.find((participant) => participant.id === ADMIN.id);
  equal("lid id kept", added?.id, MEMBER.id);
  equal("phoneNumber kept", added?.phoneNumber, MEMBER.phoneNumber);
  equal("admin null kept", added?.admin, null);
  equal("pn lid kept", admin?.lid, ADMIN.lid);
  equal("admin flag kept", admin?.admin, "admin");
  ok("stale cleared after the new roster", stale(G) === false);
}

section("a late answer from an older fetch is discarded");

{
  groupMetadataCache.flushAll();
  const current = roster(G, [ADMIN]);
  const late = roster(G, [LATE]);
  const fresh = roster(G, [ADMIN, MEMBER]);
  groupMetadataCache.setCached(G, current);
  const boxes = [];
  let calls = 0;
  sock.groupMetadata = () => {
    calls += 1;
    const box = defer();
    boxes.push(box);
    return box.promise;
  };
  emit(G, "add", [MEMBER]);
  emit(G, "remove", [MEMBER]);
  await tick();
  equal("both events share the first fetch", calls, 1);
  if (calls >= 1) {
    boxes[0].resolve(late);
    await tick();
    ok("the late roster was not stored", ids(groupMetadataCache.getCached(G)) !== ids(late));
  }
  equal("the generation schedules one follow-up", calls, 2);
  if (calls >= 2) {
    boxes[1].resolve(fresh);
    await tick();
  }
  equal("the newer roster is stored", ids(groupMetadataCache.getCached(G)), ids(fresh));
  ok("the follow-up clears stale", stale(G) === false);
}

section("ten roster events share at most two fetches");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN]));
  const actions = ["add", "remove", "promote", "demote", "modify", "leave"];
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  sock.groupMetadata = () => {
    calls += 1;
    if (calls === 1) return gate.then(() => roster(G, [ADMIN, MEMBER]));
    return Promise.resolve(roster(G, [MEMBER, ADMIN]));
  };
  for (let i = 0; i < 10; i += 1) emit(G, actions[i % actions.length], [MEMBER]);
  await tick();
  equal("the burst starts one fetch", calls, 1);
  release();
  await tick();
  ok("ten events cause at most two queries", calls >= 1 && calls <= 2);
  equal("the follow-up is the second query", calls, 2);
  equal(
    "the follow-up roster is stored",
    ids(groupMetadataCache.getCached(G)),
    `${MEMBER.id},${ADMIN.id}`,
  );
}

section("add, remove, promote and demote each refresh");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN]));
  let calls = 0;
  sock.groupMetadata = async () => {
    calls += 1;
    return roster(G, [ADMIN, MEMBER]);
  };
  for (const action of ["add", "remove", "promote", "demote", "modify", "leave"]) {
    const before = calls;
    emit(G, action, [MEMBER]);
    await tick();
    ok(`${action} triggers a refresh`, calls === before + 1);
  }
}

section("full groups.update is stored; partial keeps ttl and does not create");

{
  groupMetadataCache.flushAll();
  const full = roster(G, [ADMIN, MEMBER], { subject: "Full" });
  sock.ev.emit("groups.update", [full]);
  const stored = groupMetadataCache.getCached(G);
  equal("full update subject", stored?.subject, "Full");
  equal("full update ids", ids(stored), ids(full));
  const member = stored?.participants?.find((participant) => participant.id === MEMBER.id);
  const admin = stored?.participants?.find((participant) => participant.id === ADMIN.id);
  equal("full update phoneNumber", member?.phoneNumber, MEMBER.phoneNumber);
  equal("full update admin null", member?.admin, null);
  equal("full update pn lid", admin?.lid, ADMIN.lid);
  ok("full update is fresh", stale(G) === false);

  groupMetadataCache.cache.set(G, stored, 120);
  const before = groupMetadataCache.cache.getTtl(G);
  const box = defer();
  sock.groupMetadata = () => box.promise;
  emit(G, "promote", [ADMIN]);
  ok("a roster event is stale before the partial patch", stale(G) === true);
  sock.ev.emit("groups.update", [
    { id: G, subject: "Renamed" },
    { id: GHOST, subject: "ghost" },
  ]);
  const after = groupMetadataCache.cache.getTtl(G);
  ok("partial keeps the remaining ttl", Math.abs(after - before) < 2000);
  ok("partial does not reset the ttl to an hour", after < Date.now() + 180000);
  equal("partial subject", groupMetadataCache.getCached(G)?.subject, "Renamed");
  equal("partial keeps participants", ids(groupMetadataCache.getCached(G)), ids(full));
  ok("partial does not clear stale", stale(G) === true);
  equal("partial does not create an entry", groupMetadataCache.getCached(GHOST), undefined);
  box.resolve(full);
  await tick();
}

section("a failed refresh keeps the last roster");

{
  groupMetadataCache.flushAll();
  const oldRoster = roster(G, [ADMIN]);
  groupMetadataCache.setCached(G, oldRoster);
  let calls = 0;
  sock.groupMetadata = async () => {
    calls += 1;
    throw new Error("offline");
  };
  emit(G, "remove", [ADMIN]);
  await tick();
  ok("the failure still queried", calls >= 1);
  equal("getCached keeps the last id", ids(groupMetadataCache.getCached(G)), ids(oldRoster));
  const hook = await sendHook(sock, G);
  equal("hook returns undefined", hook, undefined);
  const resolved = await groupMetadataCache.resolveGroupMetadata(sock, G);
  equal("resolve returns the last id", ids(resolved), ids(oldRoster));
  ok("the entry stays stale", stale(G) === true);
}

section("an outbound-only group fetches once");

{
  groupMetadataCache.flushAll();
  let calls = 0;
  sock.groupMetadata = async (jid) => {
    calls += 1;
    return roster(jid, [MEMBER]);
  };
  const first = await sendHook(sock, OUT);
  equal("a hook miss fetches once", calls, 1);
  equal("the fetched member is returned", ids(first), MEMBER.id);
  equal(
    "phoneNumber is on the fetched roster",
    first?.participants?.[0]?.phoneNumber,
    MEMBER.phoneNumber,
  );
  const second = await sendHook(sock, OUT);
  equal("the second hook makes no query", calls, 1);
  equal("the second hook is the cached roster", ids(second), MEMBER.id);
}

section("resolveGroupMetadata shares an in-flight fetch");

{
  groupMetadataCache.flushAll();
  let calls = 0;
  const box = defer();
  sock.groupMetadata = () => {
    calls += 1;
    return box.promise.then(() => roster(SHARE, [ADMIN, MEMBER]));
  };
  const first = groupMetadataCache.resolveGroupMetadata(sock, SHARE);
  const second = groupMetadataCache.resolveGroupMetadata(sock, SHARE);
  await tick();
  equal("two readers make one query", calls, 1);
  box.resolve();
  const [left, right] = await Promise.all([first, second]);
  equal("both readers see the same roster", ids(left), ids(right));
  equal("the shared roster includes the new member", ids(left), `${ADMIN.id},${MEMBER.id}`);
}

section("flushAll clears state and the map does not grow");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN]));
  const box = defer();
  sock.groupMetadata = () => box.promise;
  emit(G, "add", [MEMBER]);
  ok("a refresh holds state", stateSize() >= 1);
  groupMetadataCache.flushAll();
  equal("flushAll clears roster state", stateSize(), 0);
  equal("flushAll clears the entry", groupMetadataCache.getCached(G), undefined);
  box.resolve(roster(G, [ADMIN, MEMBER]));
  await tick();
  equal("a late answer does not refill the cache", groupMetadataCache.getCached(G), undefined);

  groupMetadataCache.setCached(G, roster(G, [ADMIN]));
  const raw = defer();
  sock.groupMetadata = () => raw.promise;
  emit(G, "leave", [ADMIN]);
  ok("state exists before the raw cache flush", stateSize() >= 1);
  groupMetadataCache.cache.flushAll();
  equal("raw cache flush clears roster state", stateSize(), 0);
  raw.resolve(roster(G, [ADMIN]));
  await tick();
  equal("a late answer after raw flush stays empty", groupMetadataCache.getCached(G), undefined);

  const groupIds = [];
  for (let i = 0; i < 12; i += 1) {
    groupIds.push(`120363${String(200000000000 + i)}@g.us`);
  }
  for (const id of groupIds) groupMetadataCache.setCached(id, roster(id, [ADMIN]));
  equal("fresh entries do not keep state", stateSize(), 0);
  for (const id of groupIds) groupMetadataCache.cache.del(id);
  equal("deleting fresh entries leaves the map empty", stateSize(), 0);

  sock.groupMetadata = async () => {
    throw new Error("offline");
  };
  for (const id of groupIds) {
    groupMetadataCache.setCached(id, roster(id, [ADMIN]));
    emit(id, "remove", [ADMIN]);
  }
  await tick();
  equal("each stale group has state", stateSize(), groupIds.length);
  for (const id of groupIds.slice(0, -1)) groupMetadataCache.cache.del(id);
  equal("delete drops idle stale state", stateSize(), 1);
  const last = groupIds[groupIds.length - 1];
  groupMetadataCache.cache.ttl(last, 0.05);
  await new Promise((resolve) => setTimeout(resolve, 200));
  groupMetadataCache.cache.get(last);
  equal("expiry drops idle stale state", stateSize(), 0);
  equal("the expired entry is gone", groupMetadataCache.getCached(last), undefined);
}

section("the reply router still sees the linked account during a refresh");

{
  groupMetadataCache.flushAll();
  // readCreds() uses storage.authRead. That export is absent, so the call
  // throws and the linked account is empty on every tree. Attach the store
  // reader, then the router can match these creds against getCached.
  storage.authRead = store.authRead;
  settings.set("reply_route", "authorized_chat");
  settings.set("reply_route_chat", ROUTE);
  store.authWrite(
    "creds",
    JSON.stringify({ registered: true, me: { id: OWNER, lid: OWNER_PART.lid } }),
  );
  groupMetadataCache.setCached(ROUTE, roster(ROUTE, [OWNER_PART, MEMBER]));
  const box = defer();
  sock.groupMetadata = () => box.promise;
  emit(ROUTE, "add", [MEMBER]);
  ok("the route group is stale while the refresh is open", stale(ROUTE) === true);
  const cached = groupMetadataCache.getCached(ROUTE);
  ok(
    "getCached still lists the linked account",
    (cached?.participants || []).some((participant) => participant.id === OWNER),
  );
  const plan = routeSend({
    sourceJid: SOURCE,
    requestedJid: SOURCE,
    commandName: "ping",
    sensitivity: "operational",
    category: "progress",
  });
  equal("the linked account is still a member", plan.allow, true);
  equal("the group stays the destination", plan.destination, ROUTE);
  box.resolve(roster(ROUTE, [OWNER_PART, MEMBER]));
  await tick();
  settings.set("reply_route", "same_chat");
  settings.set("reply_route_chat", "");
}

finish();
