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

function makeFakeSocket({ id = OWNER_JID } = {}) {
  const ev = new EventEmitter();
  const ws = new EventEmitter();
  return {
    ev,
    ws,
    user: { id },
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
  equal(
    "no ownerName listener on creds.update in events.js",
    /listen\(\s*sock\.ev,\s*["']creds\.update["'],\s*\(update\)\s*=>\s*ownerName/.test(
      eventsSource,
    ),
    false,
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

  // 1c. A creds.update with an older name after a notify message leaves the stored name unchanged
  sock.ev.emit("creds.update", {
    me: { id: OWNER_JID, name: "Older Creds Name" },
  });
  meta = store.getUserMetadata(OWNER_JID);
  equal(
    "creds.update with an older name leaves the stored name unchanged",
    meta.displayName,
    "First Update",
  );

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
