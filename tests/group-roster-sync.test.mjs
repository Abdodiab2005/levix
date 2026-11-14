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
const { cacheAllGroups } = await import("../src/core/connection.js");
const { handleCommand, loadCommands } = await import("../src/handlers/command.handler.js");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const { routeSend } = require("./src/messaging/router.cjs");
const permissions = require("./src/utils/permissions.cjs");
const { handleAntiLink } = require("./src/commands/group/antilink.cjs");

const G = "120363000000000101@g.us";
const OUT = "120363000000000102@g.us";
const SHARE = "120363000000000103@g.us";
const ROUTE = "120363000000000104@g.us";
const QUIET = "120363000000000105@g.us";
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

section("live roster read replaces a fresh cache entry for sending");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    const oldRoster = roster(G, [ADMIN]);
    const live = roster(G, [ADMIN, MEMBER]);
    groupMetadataCache.setCached(G, oldRoster);
    let calls = 0;
    sock.groupMetadata = async () => {
      calls += 1;
      return live;
    };
    equal("live read ignores the fresh cache", await groupMetadataCache.readLiveGroupMetadata(sock, G), live);
    equal("a fresh cache still requires one live query", calls, 1);
    equal("the send hook sees the live roster", ids(await sendHook(sock, G)), ids(live));
    equal("the send hook needs no additional query", calls, 1);
    ok("the live roster stays fresh", !stale(G));
  }
  groupMetadataCache.flushAll();
}

section("concurrent live roster reads share one request");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    groupMetadataCache.setCached(G, roster(G, [ADMIN]));
    const box = defer();
    const live = roster(G, [ADMIN, MEMBER]);
    let calls = 0;
    sock.groupMetadata = () => {
      calls += 1;
      return box.promise;
    };
    const first = groupMetadataCache.readLiveGroupMetadata(sock, G);
    const second = groupMetadataCache.readLiveGroupMetadata(sock, G);
    equal("two live readers start one query", calls, 1);
    box.resolve(live);
    const [left, right] = await Promise.all([first, second]);
    equal("the first live reader gets the answer", left, live);
    equal("the second live reader joins the answer", right, live);
    equal("joining does not schedule a follow-up", calls, 1);
  }
  groupMetadataCache.flushAll();
}

section("live roster read drains the follow-up after a roster event");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    const oldRoster = roster(G, [ADMIN]);
    const superseded = roster(G, [LATE]);
    const live = roster(G, [ADMIN, MEMBER]);
    groupMetadataCache.setCached(G, oldRoster);
    const first = defer();
    const followUp = defer();
    let calls = 0;
    sock.groupMetadata = () => {
      calls += 1;
      return calls === 1 ? first.promise : followUp.promise;
    };
    let settled = false;
    const pending = groupMetadataCache.readLiveGroupMetadata(sock, G).then((value) => {
      settled = true;
      return value;
    });
    groupMetadataCache.markRosterChanged(sock, G);
    equal("the event joins the pending live query", calls, 1);
    first.resolve(superseded);
    await tick();
    equal("the event starts one follow-up", calls, 2);
    ok("the superseded answer does not settle the live read", !settled);
    equal("the superseded answer does not replace the cache", ids(groupMetadataCache.getCached(G)), ids(oldRoster));
    followUp.resolve(live);
    equal("the live reader returns the follow-up", await pending, live);
    equal("the cache holds the follow-up", ids(groupMetadataCache.getCached(G)), ids(live));
    ok("the follow-up clears stale", !stale(G));
  }
  groupMetadataCache.flushAll();
}

section("failed live roster reads preserve cached entries and stale flags");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    for (const wasStale of [false, true]) {
      groupMetadataCache.flushAll();
      const oldRoster = roster(G, [ADMIN]);
      groupMetadataCache.setCached(G, oldRoster);
      sock.groupMetadata = async () => { throw new Error("offline"); };
      if (wasStale) {
        groupMetadataCache.markRosterChanged(sock, G);
        await tick();
      }
      const before = JSON.stringify(groupMetadataCache.getCached(G));
      const ttl = groupMetadataCache.cache.getTtl(G);
      equal(`failed live read returns null (stale=${wasStale})`, await groupMetadataCache.readLiveGroupMetadata(sock, G), null);
      equal(`failure keeps the cached roster (stale=${wasStale})`, JSON.stringify(groupMetadataCache.getCached(G)), before);
      equal(`failure keeps the cache TTL (stale=${wasStale})`, groupMetadataCache.cache.getTtl(G), ttl);
      equal(`failure keeps the stale flag (stale=${wasStale})`, stale(G), wasStale);
    }
  }
  groupMetadataCache.flushAll();
}

section("live roster read ignores non-group jids");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    let calls = 0;
    sock.groupMetadata = async () => {
      calls += 1;
      return roster(G, [ADMIN]);
    };
    equal("a private jid has no live roster", await groupMetadataCache.readLiveGroupMetadata(sock, OWNER), null);
    equal("a private jid makes no query", calls, 0);
  }
  groupMetadataCache.flushAll();
}

section("live roster read refuses unavailable, participant-less and superseded answers");

{
  groupMetadataCache.flushAll();
  if (ok("live roster reader is exported", typeof groupMetadataCache.readLiveGroupMetadata === "function")) {
    const oldRoster = roster(G, [ADMIN]);
    groupMetadataCache.setCached(G, oldRoster);
    equal("a missing socket cannot use the fresh cache", await groupMetadataCache.readLiveGroupMetadata(null, G), null);
    equal("a socket without groupMetadata returns null", await groupMetadataCache.readLiveGroupMetadata({}, G), null);
    sock.groupMetadata = async () => ({ id: G });
    equal("a participant-less live answer returns null", await groupMetadataCache.readLiveGroupMetadata(sock, G), null);
    equal("a participant-less answer leaves the cache alone", ids(groupMetadataCache.getCached(G)), ids(oldRoster));
    const box = defer();
    sock.groupMetadata = () => box.promise;
    const pending = groupMetadataCache.readLiveGroupMetadata(sock, G);
    const replacement = roster(G, [ADMIN, MEMBER]);
    groupMetadataCache.storeFullGroupMetadata(G, replacement);
    box.resolve(roster(G, [LATE]));
    equal("supersession without a follow-up returns null", await pending, null);
    equal("supersession preserves the replacement cache", ids(groupMetadataCache.getCached(G)), ids(replacement));
  }
  groupMetadataCache.flushAll();
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

section("a bulk answer started before a join does not replace the refresh");

{
  groupMetadataCache.flushAll();
  store.upsertGroupDirectory(G, { subject: "Kept", participantCount: 1 });
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  groupMetadataCache.setCached(QUIET, roster(QUIET, [ADMIN], { subject: "Quiet before" }));
  const bulkBox = defer();
  const refreshBox = defer();
  let refreshCalls = 0;
  let bulkStarted = false;
  sock.groupMetadata = () => {
    refreshCalls += 1;
    return refreshBox.promise;
  };
  const pending = cacheAllGroups(
    {
      groupFetchAllParticipating() {
        bulkStarted = true;
        return bulkBox.promise;
      },
    },
    { force: true },
  );
  await tick();
  ok("the bulk request is in flight before the join", bulkStarted);
  emit(G, "add", [MEMBER]);
  ok("the join is stale while the bulk request is open", stale(G) === true);
  equal("the join starts one refresh", refreshCalls, 1);
  bulkBox.resolve({
    [G]: roster(G, [ADMIN], { subject: "Old bulk" }),
    [QUIET]: roster(QUIET, [ADMIN, MEMBER], { subject: "Quiet bulk" }),
  });
  await pending;
  await tick();
  equal(
    "the raced group keeps the pre-join roster",
    ids(groupMetadataCache.getCached(G)),
    ADMIN.id,
  );
  equal("the raced subject stays", groupMetadataCache.getCached(G)?.subject, "Before");
  ok("the raced group stays stale", stale(G) === true);
  equal("the bulk does not start a second refresh", refreshCalls, 1);
  equal("the raced directory row stays", store.getGroupDirectory(G)?.subject, "Kept");
  equal(
    "a quiet group stores the bulk roster",
    ids(groupMetadataCache.getCached(QUIET)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal(
    "a quiet group stores the bulk subject",
    groupMetadataCache.getCached(QUIET)?.subject,
    "Quiet bulk",
  );
  equal(
    "a quiet group updates the directory",
    store.getGroupDirectory(QUIET)?.subject,
    "Quiet bulk",
  );
  refreshBox.resolve(roster(G, [ADMIN, MEMBER], { subject: "Joined" }));
  await tick();
  equal(
    "the refresh roster is stored",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal("the refresh subject is stored", groupMetadataCache.getCached(G)?.subject, "Joined");
  ok("the refresh clears stale", stale(G) === false);
  equal("the refresh stayed the only query", refreshCalls, 1);
}

section("a bulk answer that arrives after the refresh finished does not overwrite it");

{
  groupMetadataCache.flushAll();
  store.upsertGroupDirectory(G, { subject: "Kept", participantCount: 1 });
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  const bulkBox = defer();
  let bulkStarted = false;
  const pending = cacheAllGroups(
    {
      groupFetchAllParticipating() {
        bulkStarted = true;
        return bulkBox.promise;
      },
    },
    { force: true },
  );
  await tick();
  ok("the second bulk request is in flight", bulkStarted);
  sock.groupMetadata = async () => roster(G, [ADMIN, MEMBER], { subject: "Joined" });
  emit(G, "add", [MEMBER]);
  await tick();
  equal(
    "the refresh lands before the bulk answer",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  ok("the finished refresh is fresh", stale(G) === false);
  bulkBox.resolve({
    [G]: roster(G, [ADMIN], { subject: "Old bulk" }),
    [QUIET]: roster(QUIET, [MEMBER], { subject: "Quiet again" }),
  });
  await pending;
  equal(
    "the finished refresh stays",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal("the old bulk subject is not stored", groupMetadataCache.getCached(G)?.subject, "Joined");
  ok("the finished refresh stays fresh", stale(G) === false);
  equal("the raced directory row still stays", store.getGroupDirectory(G)?.subject, "Kept");
  equal(
    "the quiet group still accepts its own bulk row",
    groupMetadataCache.getCached(QUIET)?.subject,
    "Quiet again",
  );
}

section("a flush drops an in-flight bulk answer");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN]));
  const bulkBox = defer();
  const pending = cacheAllGroups(
    {
      groupFetchAllParticipating() {
        return bulkBox.promise;
      },
    },
    { force: true },
  );
  await tick();
  groupMetadataCache.flushAll();
  bulkBox.resolve({ [G]: roster(G, [LATE], { subject: "After flush" }) });
  await pending;
  equal("a flushed bulk does not refill the group", groupMetadataCache.getCached(G), undefined);
}

section("a late full groups.update does not discard a newer refresh");

{
  groupMetadataCache.flushAll();
  store.upsertGroupDirectory(G, { subject: "Kept", participantCount: 1 });
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  const refreshBox = defer();
  let calls = 0;
  sock.groupMetadata = () => {
    calls += 1;
    return refreshBox.promise;
  };
  emit(G, "add", [MEMBER]);
  equal("the join refresh is the first query", calls, 1);
  sock.ev.emit("groups.update", [roster(G, [LATE], { subject: "Late update" })]);
  sock.ev.emit("groups.upsert", [roster(G, [LATE], { subject: "Late upsert" })]);
  await tick();
  equal("a late full payload does not start another fetch", calls, 1);
  equal("the late full payload is not stored", ids(groupMetadataCache.getCached(G)), ADMIN.id);
  equal("the late subject is not stored", groupMetadataCache.getCached(G)?.subject, "Before");
  ok("the join stays stale", stale(G) === true);
  equal(
    "the late payload does not rewrite the directory",
    store.getGroupDirectory(G)?.subject,
    "Kept",
  );
  refreshBox.resolve(roster(G, [ADMIN, MEMBER], { subject: "Joined" }));
  await tick();
  equal("still one fetch after the late payloads", calls, 1);
  equal(
    "the join refresh is the stored roster",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal("the join refresh subject is stored", groupMetadataCache.getCached(G)?.subject, "Joined");
  ok("the join refresh clears stale", stale(G) === false);
}

section("a late full groups.update after the refresh starts a live fetch");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  sock.groupMetadata = async () => roster(G, [ADMIN, MEMBER], { subject: "Joined" });
  emit(G, "add", [MEMBER]);
  await tick();
  equal(
    "the first refresh stored the member",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  const liveBox = defer();
  let calls = 0;
  sock.groupMetadata = () => {
    calls += 1;
    return liveBox.promise;
  };
  sock.ev.emit("groups.update", [roster(G, [LATE], { subject: "Late update" })]);
  await tick();
  equal(
    "the late full update is not stored over the refresh",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal("the late full update starts one live fetch", calls, 1);
  ok("that live fetch is stale until it answers", stale(G) === true);
  liveBox.resolve(roster(G, [ADMIN, MEMBER, LATE], { subject: "Live" }));
  await tick();
  equal("the live answer is stored", groupMetadataCache.getCached(G)?.subject, "Live");
  equal(
    "the live answer keeps the member and the late id",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id},${LATE.id}`,
  );
  ok("the live answer clears stale", stale(G) === false);
}

section("an old full roster 75s after a demotion starts a refresh");

{
  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  sock.groupMetadata = async () => roster(G, [{ ...ADMIN, admin: null }], { subject: "Demoted" });
  emit(G, "demote", [ADMIN]);
  await tick();
  const afterDemotion = Date.now();
  equal(
    "the demotion is stored before the late roster",
    groupMetadataCache.getCached(G)?.subject,
    "Demoted",
  );
  let calls = 0;
  sock.groupMetadata = async () => {
    calls += 1;
    return roster(G, [{ ...ADMIN, admin: null }], { subject: "Live" });
  };
  const late = groupMetadataCache.storeUnsolicitedFullRoster(
    sock,
    G,
    roster(G, [ADMIN], { subject: "Old full" }),
    afterDemotion + 75_000,
  );
  await tick();
  equal("75s after the demotion does not store the old roster", late, null);
  equal("75s starts one refresh", calls, 1);
  equal("the refresh answer is stored", groupMetadataCache.getCached(G)?.subject, "Live");
  ok(
    "the old admin flag is not restored",
    groupMetadataCache.getCached(G)?.participants?.[0]?.admin === null,
  );

  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  sock.groupMetadata = async () => roster(G, [{ ...ADMIN, admin: null }], { subject: "Demoted" });
  emit(G, "demote", [ADMIN]);
  await tick();
  const agedAt = Date.now();
  let agedCalls = 0;
  sock.groupMetadata = async () => {
    agedCalls += 1;
    return roster(G, [LATE], { subject: "Should not run" });
  };
  const aged = groupMetadataCache.storeUnsolicitedFullRoster(
    sock,
    G,
    roster(G, [LATE], { subject: "Aged" }),
    agedAt + 10 * 60 * 1000 + 1,
  );
  equal("after 10 minutes with no event in the window the roster is stored", aged?.subject, "Aged");
  equal("the aged roster replaces the group", ids(groupMetadataCache.getCached(G)), LATE.id);
  equal("the aged roster does not start a refresh", agedCalls, 0);
  ok("the aged roster is fresh", stale(G) === false);
}

section("roster event records older than 10 minutes no longer block a bulk store");

{
  groupMetadataCache.flushAll();
  const before = Date.now();
  groupMetadataCache.setCached(G, roster(G, [ADMIN], { subject: "Before" }));
  const cursor = groupMetadataCache.captureRosterCursor(before);
  sock.groupMetadata = async () => roster(G, [ADMIN, MEMBER], { subject: "Joined" });
  emit(G, "add", [MEMBER]);
  await tick();
  const after = Date.now();
  equal(
    "the prune fixture stored the member",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  ok("the prune fixture is fresh", stale(G) === false);
  const blocked = groupMetadataCache.storeBulkGroupMetadata(
    G,
    roster(G, [ADMIN], { subject: "Old bulk" }),
    cursor,
  );
  equal("a cursor from before the join cannot store", blocked, null);
  equal(
    "the member stays while the record is inside 10 minutes",
    ids(groupMetadataCache.getCached(G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  groupMetadataCache.captureRosterCursor(before + 10 * 60 * 1000);
  const still = groupMetadataCache.storeBulkGroupMetadata(
    G,
    roster(G, [ADMIN], { subject: "Old bulk" }),
    cursor,
  );
  equal("a record exactly 10 minutes old still blocks", still, null);
  groupMetadataCache.captureRosterCursor(after + 10 * 60 * 1000 + 1);
  const stored = groupMetadataCache.storeBulkGroupMetadata(
    G,
    roster(G, [LATE], { subject: "Pruned bulk" }),
    cursor,
  );
  equal("a record older than 10 minutes no longer blocks", stored?.subject, "Pruned bulk");
  equal("the pruned bulk replaces the roster", ids(groupMetadataCache.getCached(G)), LATE.id);

  const flushed = groupMetadataCache.captureRosterCursor();
  groupMetadataCache.flushAll();
  const rejected = groupMetadataCache.storeBulkGroupMetadata(
    G,
    roster(G, [ADMIN], { subject: "After flush" }),
    flushed,
  );
  equal("a flush rejects that bulk cursor", rejected, null);
  equal("the flush leaves the group empty", groupMetadataCache.getCached(G), undefined);
}

section("authorization uses a fresh roster; moderation keeps the last known admin");

{
  // On b383ed1 a cached admin is already allowed and already protected.
  // Those two checks pass before this fix. The stale deny and the live allow do not.
  settings.set("bot_language", "en");
  settings.set("bot_min_delay_ms", 0);
  settings.set("bot_max_delay_ms", 0);
  settings.set("reply_route", "same_chat");
  timing.sleep = async () => {};
  await permissions.primePermissions();
  await loadCommands();

  function commandSock() {
    const sent = [];
    return {
      sent,
      user: { id: "209999999999@s.whatsapp.net" },
      async sendMessage(jid, content) {
        sent.push({ jid, content });
        return { key: { id: `out-${sent.length}`, remoteJid: jid } };
      },
      async sendPresenceUpdate() {},
      async groupMetadata() {
        throw new Error("offline");
      },
    };
  }

  function commandMessage(text, participant = ADMIN.id) {
    return {
      key: { remoteJid: G, fromMe: false, id: `cmd-${text.length}`, participant },
      message: { conversation: text },
      pushName: "Admin",
    };
  }

  function sentText(fake) {
    return fake.sent.map((row) => row.content?.text || "").join("\n");
  }

  function linkMessage(participant, id) {
    return {
      key: { remoteJid: G, fromMe: false, id, participant },
      message: { conversation: "https://spam.example/now" },
      pushName: "Sender",
    };
  }

  groupMetadataCache.flushAll();
  const known = roster(G, [ADMIN, MEMBER], { subject: "Known" });
  groupMetadataCache.setCached(G, known);
  sock.groupMetadata = async () => {
    throw new Error("offline");
  };
  emit(G, "demote", [ADMIN]);
  await tick();
  ok("the failed refresh is stale", stale(G) === true);
  equal(
    "the failed refresh keeps the admin flag",
    groupMetadataCache.getCached(G)?.participants?.[0]?.admin,
    "admin",
  );
  equal(
    "a display read still returns the last roster",
    ids(await groupMetadataCache.resolveGroupMetadata(sock, G)),
    `${ADMIN.id},${MEMBER.id}`,
  );
  equal(
    "a fresh read is null when the refresh failed",
    await groupMetadataCache.resolveGroupMetadata(sock, G, { fresh: true }),
    null,
  );

  const directDeny = commandSock();
  await handleCommand(directDeny, commandMessage("!setrules"), "!setrules");
  ok(
    "a stale roster denies the direct admin command",
    /Only group admins/.test(sentText(directDeny)),
  );
  ok("the direct command does not run", !/Write the rules/.test(sentText(directDeny)));

  const groupDeny = commandSock();
  await handleCommand(groupDeny, commandMessage("!group setrules"), "!group setrules");
  ok("a stale roster denies the group form", /Only group admins/.test(sentText(groupDeny)));
  ok("the group form does not run", !/Write the rules/.test(sentText(groupDeny)));

  store.saveGroupSettings(G, {
    antilink: {
      enabled: true,
      mode: "ALL",
      allowed_domains: [],
      blocked_domains: [],
      action: "DELETE",
    },
  });
  ok(
    "moderation still protects the last-known admin",
    (await handleAntiLink(sock, linkMessage(ADMIN.id, "link-admin"))) === false,
  );
  ok(
    "moderation still acts on the last-known member",
    (await handleAntiLink(sock, linkMessage(MEMBER.id, "link-member"))) === true,
  );

  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(
    G,
    roster(G, [{ ...ADMIN, admin: null }, MEMBER], { subject: "Member" }),
  );
  sock.groupMetadata = async () =>
    roster(G, [{ ...ADMIN, admin: "admin" }, MEMBER], { subject: "Promoted" });
  emit(G, "promote", [ADMIN]);
  await tick();
  const promoted = groupMetadataCache
    .getCached(G)
    ?.participants?.find((participant) => participant.id === ADMIN.id);
  equal("the live refresh stores the admin flag", promoted?.admin, "admin");
  ok("the live refresh is fresh", stale(G) === false);
  const directAllow = commandSock();
  await handleCommand(directAllow, commandMessage("!setrules"), "!setrules");
  ok(
    "a fresh roster allows the direct admin command",
    /Write the rules/.test(sentText(directAllow)),
  );
  const groupAllow = commandSock();
  await handleCommand(groupAllow, commandMessage("!group setrules"), "!group setrules");
  ok("a fresh roster allows the group form", /Write the rules/.test(sentText(groupAllow)));

  groupMetadataCache.flushAll();
  groupMetadataCache.setCached(G, roster(G, [ADMIN, MEMBER], { subject: "Fresh" }));
  ok("the seeded roster is fresh", stale(G) === false);
  const seeded = commandSock();
  await handleCommand(seeded, commandMessage("!setrules"), "!setrules");
  ok("a fresh cache hit allows the admin command", /Write the rules/.test(sentText(seeded)));
  ok("the fresh cache hit does not query", seeded.sent.length > 0);
}

finish();
