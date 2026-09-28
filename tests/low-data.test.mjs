// Low-data design pins.
//
// The defaults here are contractual (see the "Low-data design" note in
// AGENTS.md): link previews opt-in, remote thumbnails opt-in, history sync
// never, group metadata cache-first, full group rosters TTL-gated. A change
// that silently reintroduces a network request on the hot path should fail
// one of these checks.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("low-data");

const settings = require("./src/config/settings.cjs");
const { getBaileysConfig } = await import("../src/config/baileys.config.js");
const { cacheAllGroups, GROUP_SYNC_TTL_MS } = await import("../src/core/connection.js");
const groupMetadataCache = require("./src/utils/groupMetadataCache.cjs");
const { withMediaThumbnail } = require("./src/utils/thumbnail.cjs");
const { sendBotMessage } = require("./src/utils/sendBotMessage.cjs");

section("history sync stays off (the biggest one)");

{
  const config = getBaileysConfig(null);
  equal("syncFullHistory stays false", config.syncFullHistory, false);
  equal(
    "shouldSyncHistoryMessage refuses everything",
    config.shouldSyncHistoryMessage({ syncType: 1 }),
    false,
  );
  equal("the bot never marks itself online", config.markOnlineOnConnect, false);
}

section("link previews are opt-in");

{
  equal("link_previews_enabled defaults to off", settings.get("link_previews_enabled"), false);

  // A capture socket for sendBotMessage (typing off: no presence, no delays).
  function captureSock() {
    const sent = [];
    return {
      sent,
      async sendMessage(_jid, content) {
        sent.push(content);
        return {};
      },
      async sendPresenceUpdate() {},
    };
  }

  const sock = captureSock();
  await sendBotMessage(
    sock,
    "201000000000@s.whatsapp.net",
    { text: "المصادر:\n• Example — https://example.com/article" },
    { typing: false },
  );
  ok(
    "URL text goes out with linkPreview: null — no page fetch",
    sock.sent[0]?.linkPreview === null,
  );

  const sock2 = captureSock();
  await sendBotMessage(
    sock2,
    "201000000000@s.whatsapp.net",
    { text: "plain text, no links" },
    { typing: false },
  );
  ok("plain text is also marked skip-preview (harmless)", sock2.sent[0]?.linkPreview === null);

  // An explicit caller decision is never overridden.
  const sock3 = captureSock();
  await sendBotMessage(
    sock3,
    "201000000000@s.whatsapp.net",
    { text: "https://example.com", linkPreview: { title: "kept" } },
    { typing: false },
  );
  equal("explicit preview objects survive", sock3.sent[0]?.linkPreview?.title, "kept");

  // Opting in restores Baileys' own preview generation.
  settings.set("link_previews_enabled", true);
  const sock4 = captureSock();
  await sendBotMessage(
    sock4,
    "201000000000@s.whatsapp.net",
    { text: "https://example.com/article" },
    { typing: false },
  );
  ok(
    "opted in: linkPreview is left for Baileys to fill",
    !("linkPreview" in sock4.sent[0]),
  );
  settings.set("link_previews_enabled", "");
  ok("clearing the setting returns to the default", settings.get("link_previews_enabled") === false);
}

section("group metadata: cache-first resolver");

{
  groupMetadataCache.flushAll();
  let liveCalls = 0;
  const sock = {
    async groupMetadata(jid) {
      liveCalls += 1;
      return { id: jid, subject: `Group ${jid}`, participants: [] };
    },
  };

  const first = await groupMetadataCache.resolveGroupMetadata(sock, "120363000000000001@g.us");
  ok("miss falls back to one live query", liveCalls === 1);
  equal("live result is returned", first.subject, "Group 120363000000000001@g.us");

  const second = await groupMetadataCache.resolveGroupMetadata(sock, "120363000000000001@g.us");
  ok("hit costs no network", liveCalls === 1);
  equal("hit returns the cached metadata", second.id, "120363000000000001@g.us");

  await groupMetadataCache.resolveGroupMetadata(sock, "120363000000000002@g.us");
  ok("a different group is a different cache entry", liveCalls === 2);

  equal(
    "non-group jids never query",
    await groupMetadataCache.resolveGroupMetadata(sock, "201000000000@s.whatsapp.net"),
    null,
  );
  ok("non-group jids really made no calls", liveCalls === 2);

  const failingSock = {
    async groupMetadata() {
      liveCalls += 1;
      throw new Error("boom");
    },
  };
  equal(
    "a failing live query resolves null (and is not cached)",
    await groupMetadataCache.resolveGroupMetadata(failingSock, "120363000000000003@g.us"),
    null,
  );
  const retried = await groupMetadataCache.resolveGroupMetadata(
    { async groupMetadata() { return { id: "x" }; } },
    "120363000000000003@g.us",
  );
  equal("next caller retries after a failure", retried.id, "x");
}

section("full group syncs are TTL-gated");
{
  groupMetadataCache.flushAll();
  let rosterFetches = 0;
  const sock = {
    async groupFetchAllParticipating() {
      rosterFetches += 1;
      return {
        "120363000000000001@g.us": {
          id: "120363000000000001@g.us",
          subject: "Roster group",
          participants: [],
        },
      };
    },
  };

  const t0 = 1_000_000_000_000;

  // First open after a process start: fetch.
  await cacheAllGroups(sock, { now: t0 });
  equal("first open fetches the roster", rosterFetches, 1);
  ok(
    "roster lands in the shared cache",
    Boolean(groupMetadataCache.getCached("120363000000000001@g.us")),
  );

  // Reconnect an hour later: fresh enough, skip.
  await cacheAllGroups(sock, { now: t0 + 60 * 60 * 1000 });
  equal("reconnect inside the TTL skips the fetch", rosterFetches, 1);

  // Explicit request: fetch regardless (pinned to t0 so the freshness stamp
  // the force sets is in the test's own timeline).
  await cacheAllGroups(sock, { force: true, now: t0 });
  equal("force fetches", rosterFetches, 2);

  // Reconnect after the TTL: fetch again.
  await cacheAllGroups(sock, { now: t0 + GROUP_SYNC_TTL_MS + 1000 });
  equal("stale roster fetches again", rosterFetches, 3);

  ok("the TTL is six hours", GROUP_SYNC_TTL_MS === 6 * 60 * 60 * 1000);
}

section("remote thumbnails are opt-in");

{
  equal("thumbnail_remote defaults to off", settings.get("thumbnail_remote"), false);

  // With the gate off, a remote-URL send must come back without a thumbnail
  // and without any download attempt: the resolver bails before touching the
  // network, so this returns fast and unchanged.
  const content = { image: { url: "https://example.com/photo.jpg" } };
  const result = await withMediaThumbnail({ ...content });
  ok("remote media gets no thumbnail by default", !result.jpegThumbnail);
  equal("the media content itself is untouched", result.image.url, "https://example.com/photo.jpg");

  // Local buffers are not media the bot downloaded — they keep previews.
  // A real 1x1 PNG, scaled to a thumbnail by the bundled ffmpeg, no network.
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  const local = await withMediaThumbnail({ image: tinyPng });
  ok(
    "local media still gets its preview from disk (no network)",
    Buffer.isBuffer(local.jpegThumbnail),
  );
}

finish();
