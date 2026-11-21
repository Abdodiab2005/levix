// Tests for F1: owner display name updates through setupEventListeners,
// disposer unregistration on detach, live socket fencing, and role flag preservation.

import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { cleanOwnerName, updateOwnerDisplayName } from "../src/core/connection.js";
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

  // 2. JID-shaped pushName is rejected
  sock.ev.emit("messages.upsert", {
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

finish();
