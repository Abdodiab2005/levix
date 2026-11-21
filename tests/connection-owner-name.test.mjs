// Tests for F1: owner display name updates through setupEventListeners,
// disposer unregistration on detach, live socket fencing, and role flag preservation.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import {
  cleanOwnerName,
  saveBotOwnerMetadata,
  updateOwnerDisplayName,
} from "../src/core/connection.js";
import { setupEventListeners } from "../src/core/events.js";
import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-connection-owner-name");
const store = require("./src/db/store.cjs");

const OWNER_JID = "201234567890@s.whatsapp.net";

function makeFakeSocket({ id = OWNER_JID, authState } = {}) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  return {
    ev,
    ws,
    user: { id },
    ...(authState !== undefined ? { authState } : {}),
  };
}

section("cleanOwnerName validation");
{
  equal("rejects raw phone JID", cleanOwnerName("201234567890@s.whatsapp.net"), null);
  equal("rejects raw LID", cleanOwnerName("1234567890@lid"), null);
  equal("rejects raw group JID", cleanOwnerName("12345-6789@g.us"), null);
  equal("rejects tilde", cleanOwnerName("~"), null);
  equal("rejects whitespace", cleanOwnerName("   "), null);
  equal("rejects non-string", cleanOwnerName(null), null);
  equal("accepts valid name and trims", cleanOwnerName("  Levix Operator  "), "Levix Operator");
}

section("connection.js registers no socket listeners of its own");
{
  const source = readFileSync(new URL("../src/core/connection.js", import.meta.url), "utf8");
  equal("no ev.on in connection.js", /\bev\.on\(|\.ev\.on\(/.test(source), false);
  equal("bindOwnerDisplayName removed", source.includes("bindOwnerDisplayName"), false);

  const eventsSource = readFileSync(new URL("../src/core/events.js", import.meta.url), "utf8");
  ok(
    "saveCreds stays registered directly on creds.update in events.js",
    eventsSource.includes('if (saveCreds) listen(sock.ev, "creds.update", saveCreds)'),
  );
}

section("owner name updates through setupEventListeners without touching role flags");
{
  store.saveUserMetadata({
    jid: OWNER_JID,
    isOwner: true,
    isAdmin: false,
    displayName: "Original Name",
  });

  const sock = makeFakeSocket();
  let live = true;
  const dispose = setupEventListeners(sock, {
    isLiveSocket: () => live,
  });

  // 1. Live socket receives owner message -> updates name
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000001@g.us", fromMe: true },
        pushName: "First Update",
      },
    ],
  });

  let meta = store.getUserMetadata(OWNER_JID);
  equal("name is updated to First Update", meta.displayName, "First Update");
  equal("isOwner remains true", meta.isOwner, true);
  equal("isAdmin remains false", meta.isAdmin, false);

  // 1b. An append replay on the current live socket changes nothing
  sock.ev.emit("messages.upsert", {
    type: "append",
    messages: [
      {
        key: { remoteJid: "120363000000001@g.us", fromMe: true },
        pushName: "Older Appended Name",
      },
    ],
  });
  meta = store.getUserMetadata(OWNER_JID);
  equal("append upsert with an older pushName changes nothing", meta.displayName, "First Update");

  // 2. JID-shaped pushName is rejected
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000001@g.us", fromMe: true },
        pushName: "9999999999@s.whatsapp.net",
      },
    ],
  });
  meta = store.getUserMetadata(OWNER_JID);
  equal("JID-shaped name is rejected; name stays First Update", meta.displayName, "First Update");

  // 3. Fencing: when isLiveSocket returns false, no write occurs
  live = false;
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000001@g.us", fromMe: true },
        pushName: "Non Live Name",
      },
    ],
  });
  meta = store.getUserMetadata(OWNER_JID);
  equal("non-live socket does not write", meta.displayName, "First Update");

  // 4. Disposer unregisters listeners on detach
  live = true;
  dispose();
  sock.ev.emit("messages.upsert", {
    type: "notify",
    messages: [
      {
        key: { remoteJid: "120363000000001@g.us", fromMe: true },
        pushName: "Disposed Name",
      },
    ],
  });
  meta = store.getUserMetadata(OWNER_JID);
  equal("disposed socket does not write", meta.displayName, "First Update");
}

section("creds.update owner name updates on real rename and ignores replayed upserts");
{
  const flushTick = () => new Promise((resolve) => setTimeout(resolve, 10));

  store.saveUserMetadata({
    jid: OWNER_JID,
    isOwner: true,
    isAdmin: false,
    displayName: "Current Name",
  });

  // 1. Append upsert with own pushName "Old" followed by creds.update with "Old"
  {
    const sock = makeFakeSocket();
    let saved = 0;
    const dispose = setupEventListeners(sock, {
      saveCreds: async () => {
        saved += 1;
      },
      isLiveSocket: () => true,
    });
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { remoteJid: "120363000000001@g.us", fromMe: true },
          pushName: "Old",
        },
      ],
    });
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Old" } });
    await flushTick();
    dispose();

    equal(
      "append then creds.update with Old leaves stored name unchanged",
      store.getUserMetadata(OWNER_JID).displayName,
      "Current Name",
    );
    equal("saveCreds still ran on creds.update", saved, 1);
  }

  // 2. creds.update with "Old" followed in the same batch by append upsert with own pushName "Old"
  {
    const sock = makeFakeSocket();
    let saved = 0;
    const dispose = setupEventListeners(sock, {
      saveCreds: async () => {
        saved += 1;
      },
      isLiveSocket: () => true,
    });
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Old" } });
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { remoteJid: "120363000000001@g.us", fromMe: true },
          pushName: "Old",
        },
      ],
    });
    await flushTick();
    dispose();

    equal(
      "creds.update then append with Old leaves stored name unchanged",
      store.getUserMetadata(OWNER_JID).displayName,
      "Current Name",
    );
    equal("saveCreds still ran on batch-ordered creds.update", saved, 1);
  }

  // 3. creds.update with "Renamed" and no matching upsert updates the stored name
  {
    const sock = makeFakeSocket();
    let saved = 0;
    const dispose = setupEventListeners(sock, {
      saveCreds: async () => {
        saved += 1;
      },
      isLiveSocket: () => true,
    });
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Renamed" } });
    await flushTick();
    dispose();

    const meta = store.getUserMetadata(OWNER_JID);
    equal(
      "creds.update with Renamed and no matching upsert updates stored name",
      meta.displayName,
      "Renamed",
    );
    equal("isOwner remains true after creds.update rename", meta.isOwner, true);
    equal("isAdmin remains false after creds.update rename", meta.isAdmin, false);
    equal("saveCreds ran for rename", saved, 1);
  }

  // 4. A non-own (fromMe: false) append upsert does not suppress a matching creds.update rename
  {
    const sock = makeFakeSocket();
    const dispose = setupEventListeners(sock, {
      isLiveSocket: () => true,
    });
    sock.ev.emit("messages.upsert", {
      type: "append",
      messages: [
        {
          key: { remoteJid: "120363000000001@g.us", fromMe: false },
          pushName: "Renamed Again",
        },
      ],
    });
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Renamed Again" } });
    await flushTick();
    dispose();

    equal(
      "non-own append pushName does not block creds.update rename",
      store.getUserMetadata(OWNER_JID).displayName,
      "Renamed Again",
    );
  }

  // 5. Replayed own name entry expires after 60 seconds
  {
    const realNow = Date.now;
    let fakeNow = 1_700_000_000_000;
    Date.now = () => fakeNow;
    try {
      const sock = makeFakeSocket();
      const dispose = setupEventListeners(sock, {
        isLiveSocket: () => true,
      });
      sock.ev.emit("messages.upsert", {
        type: "append",
        messages: [
          {
            key: { remoteJid: "120363000000001@g.us", fromMe: true },
            pushName: "Expiring Name",
          },
        ],
      });

      fakeNow += 59_000;
      sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Expiring Name" } });
      await flushTick();
      equal(
        "replayed name still suppressed before 60s expiry",
        store.getUserMetadata(OWNER_JID).displayName,
        "Renamed Again",
      );

      // Advance lastCredsName via a second replayed name so the post-expiry
      // emission of "Expiring Name" still enters the deferred replay check.
      sock.ev.emit("messages.upsert", {
        type: "append",
        messages: [
          {
            key: { remoteJid: "120363000000001@g.us", fromMe: true },
            pushName: "Intermediate Replayed Name",
          },
        ],
      });
      sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Intermediate Replayed Name" } });
      await flushTick();

      fakeNow += 2_000;
      sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Expiring Name" } });
      await flushTick();
      dispose();
      equal(
        "replayed name expires after 60s",
        store.getUserMetadata(OWNER_JID).displayName,
        "Expiring Name",
      );
    } finally {
      Date.now = realNow;
    }
  }

  // 6. creds.update after the socket is replaced (or while pending replacement/dispose) changes nothing
  {
    const sock = makeFakeSocket();
    let live = false;
    const dispose = setupEventListeners(sock, {
      isLiveSocket: () => live,
    });
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "After Replace" } });
    await flushTick();
    equal(
      "creds.update after socket replacement changes nothing",
      store.getUserMetadata(OWNER_JID).displayName,
      "Expiring Name",
    );

    live = true;
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Replaced Mid Tick" } });
    live = false;
    await flushTick();
    equal(
      "creds.update invalidated before macrotask fires changes nothing",
      store.getUserMetadata(OWNER_JID).displayName,
      "Expiring Name",
    );

    live = true;
    sock.ev.emit("creds.update", { me: { id: OWNER_JID, name: "Disposed Mid Tick" } });
    dispose();
    await flushTick();
    equal(
      "creds.update cancelled on dispose changes nothing",
      store.getUserMetadata(OWNER_JID).displayName,
      "Expiring Name",
    );
  }
}

section("creds.update ignores unchanged persisted me.name and updates on subsequent rename");
{
  const flushTick = () => new Promise((resolve) => setTimeout(resolve, 10));
  const TEST_LID = "9876543210@lid";

  store.saveUserMetadata({
    jid: OWNER_JID,
    isOwner: true,
    isAdmin: false,
    displayName: "New",
  });

  const creds = {
    me: { id: OWNER_JID, lid: TEST_LID, name: "Old" },
    lastPropHash: "hash-1",
  };
  const sock = makeFakeSocket({
    authState: { creds },
  });
  let saved = 0;
  const dispose = setupEventListeners(sock, {
    saveCreds: async () => {
      saved += 1;
    },
    isLiveSocket: () => true,
  });

  // 1. Connection-open shape with unchanged persisted name "Old"
  sock.ev.emit("creds.update", {
    me: { id: OWNER_JID, lid: TEST_LID, name: "Old" },
  });
  await flushTick();
  equal(
    "connection-open creds.update with unchanged Old leaves stored name New",
    store.getUserMetadata(OWNER_JID).displayName,
    "New",
  );

  // 2. Full-creds shape (edge routing / props hash) with unchanged "Old"
  sock.ev.emit("creds.update", {
    ...creds,
    routingInfo: Buffer.from("edge"),
  });
  await flushTick();
  equal(
    "full-creds creds.update with unchanged Old leaves stored name New",
    store.getUserMetadata(OWNER_JID).displayName,
    "New",
  );

  // 3. Later creds.update with a changed name "Renamed" updates stored name
  sock.ev.emit("creds.update", {
    me: { id: OWNER_JID, lid: TEST_LID, name: "Renamed" },
  });
  await flushTick();
  equal(
    "later creds.update with Renamed updates stored name",
    store.getUserMetadata(OWNER_JID).displayName,
    "Renamed",
  );

  // 4. Subsequent creds.update still carrying "Renamed" does not overwrite a newer stored name
  store.saveUserMetadata({
    jid: OWNER_JID,
    isOwner: true,
    isAdmin: false,
    displayName: "Live Name",
  });
  sock.ev.emit("creds.update", {
    me: { id: OWNER_JID, lid: TEST_LID, name: "Renamed" },
    lastPropHash: "hash-2",
  });
  await flushTick();
  dispose();
  equal(
    "repeated creds.update with Renamed leaves Live Name untouched",
    store.getUserMetadata(OWNER_JID).displayName,
    "Live Name",
  );
  equal("saveCreds ran for all four creds.update events", saved, 4);
}

section(
  "saveBotOwnerMetadata preserves stored name on reconnect and writes initial name on fresh open",
);
{
  // 1. Stored name "New", creds/socket name "Old" at connection open -> stored name stays "New"
  store.saveUserMetadata({
    jid: OWNER_JID,
    isOwner: true,
    displayName: "New",
  });
  const reconnectSock = makeFakeSocket({ id: OWNER_JID });
  reconnectSock.user.name = "Old";
  await saveBotOwnerMetadata(reconnectSock);
  let meta = store.getUserMetadata(OWNER_JID);
  equal(
    "stored name 'New', creds/socket name 'Old' at connection open: stored name stays 'New'",
    meta.displayName,
    "New",
  );

  // 2. Nothing stored, open writes the socket name
  const FRESH_OWNER_JID = "201999888777@s.whatsapp.net";
  const freshSock = makeFakeSocket({ id: FRESH_OWNER_JID });
  freshSock.user.name = "Initial Socket Name";
  await saveBotOwnerMetadata(freshSock);
  meta = store.getUserMetadata(FRESH_OWNER_JID);
  equal(
    "nothing stored: connection open writes the socket name",
    meta.displayName,
    "Initial Socket Name",
  );

  // 3. pushNameOverride path updates stored name for live notify messages
  await saveBotOwnerMetadata(reconnectSock, "Live Notify Override");
  meta = store.getUserMetadata(OWNER_JID);
  equal("pushNameOverride path writes live notify name", meta.displayName, "Live Notify Override");
}

section("canonical owner record is preferred over stale alias row in profile lookup");
{
  const { createAccountProfile } = require("./src/panel/account-profile.cjs");
  const LID_JID = "1234567890@lid"; // Sorts lexicographically before 201234567890@s.whatsapp.net

  // Stale LID row has "Old"
  store.saveUserMetadata({
    jid: LID_JID,
    isOwner: true,
    displayName: "Old",
  });

  // Notify writes "New" to the canonical PN row
  // A paired socket carries the phone JID as user.id and the LID as user.lid.
  const notifySock = makeFakeSocket({ id: OWNER_JID });
  notifySock.user.lid = LID_JID;
  updateOwnerDisplayName(notifySock, "New");

  const pnMeta = store.getUserMetadata(OWNER_JID);
  const lidMeta = store.getUserMetadata(LID_JID);
  equal("PN row has New written by notify", pnMeta?.displayName, "New");
  equal("LID row has Old", lidMeta?.displayName, "Old");

  // Profile lookup: linked account with both LID and PN
  const identity = {
    phone: OWNER_JID,
    lid: LID_JID,
    selfJids: [LID_JID, OWNER_JID], // LID sorts first
  };
  const profileService = createAccountProfile({
    getContext: () => ({
      socket: notifySock,
      state: { connected: true },
      epoch: 1,
      identity,
    }),
    getUserDisplayName: (jid) => store.getUserMetadata(jid, { exact: true })?.displayName ?? null,
  });

  const profile = await profileService.get();
  equal(
    "profile returns New from canonical owner record instead of Old from alias row",
    profile.name,
    "New",
  );
}

finish();
