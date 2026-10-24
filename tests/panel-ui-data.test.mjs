// Real authenticated dashboard routes and SQLite; WhatsApp and photo network
// I/O are stubbed at their existing boundaries, with no external requests.
import {
  equal,
  finish,
  httpClient,
  listen,
  ok,
  require,
  section,
  useTempDataDir,
} from "./harness.mjs";

useTempDataDir("levix-panel-ui-data");
const store = require("./src/db/store.cjs");
const { groupMetadataCache } = await import("../src/core/socket.js");
const { default: routes, setSession } = await import("../src/routes/dashboard.api.esm.js");
const {
  app,
  server,
  io,
  dashboardJson,
  requireLoginApi,
  noStore,
  installFinalHandlers,
} = require("./app.cjs");
app.use("/dashboard/api", requireLoginApi, noStore, dashboardJson, routes);
installFinalHandlers();
const { base } = await listen(server);
const http = httpClient(base);
const provider = require("./src/utils/providerUrl.cjs");
const originalFetch = provider.safeProviderFetch;
const liveId = "120363000000001@g.us";
const directoryId = "120363000000002@g.us";
const settingsId = "120363000000003@g.us";
const photoPath = (id = liveId) => `/dashboard/api/groups/${encodeURIComponent(id)}/photo`;

try {
  let res = await http.form("/setup", { password: "a-good-password", confirm: "a-good-password" });
  equal("claiming the real panel signs in", res.status, 303);
  equal(
    "group photos require the panel session",
    (await httpClient(base).call(photoPath())).status,
    401,
  );

  section("group totals share the directory/list union");
  groupMetadataCache.set(liveId, {
    subject: "Live family",
    participants: [{ id: "one" }, { id: "two" }],
  });
  store.upsertGroupDirectory(directoryId, { subject: "Stored friends", participantCount: 12 });
  equal("neither known group has settings", store.getAllGroupSettings().length, 0);
  let stats = await (await http.call("/dashboard/api/stats")).json();
  let groups = (await (await http.call("/dashboard/api/groups")).json()).groups;
  equal("two known groups count without settings rows", stats.stats.totalGroups, 2);
  equal("group list agrees with count without settings", groups.length, 2);
  equal(
    "live roster supplies member count",
    groups.find((group) => group.id === liveId).memberCount,
    2,
  );
  equal(
    "persisted directory supplies member count",
    groups.find((group) => group.id === directoryId).memberCount,
    12,
  );

  store.upsertGroupDirectory(liveId, { subject: "Stale family", participantCount: 1 });
  store.saveGroupSettings(liveId, { rules: "Keep this rule" });
  store.saveGroupSettings(directoryId, {});
  store.saveGroupSettings(settingsId, { blacklist: ["keep-this"], rules: "Stored rule" });
  stats = await (await http.call("/dashboard/api/stats")).json();
  groups = (await (await http.call("/dashboard/api/groups")).json()).groups;
  equal("union deduplicates groups present in every source", stats.stats.totalGroups, 3);
  equal("list and overview use the same group union", groups.length, stats.stats.totalGroups);
  equal(
    "settings-only group remains visible",
    groups.filter((group) => group.id === settingsId).length,
    1,
  );
  equal(
    "live subject wins over stale stored subject",
    groups.find((group) => group.id === liveId).subject,
    "Live family",
  );

  section("inspector identities use names and never invent LID phones");
  const savedId = "123456789012345@lid";
  const pushedId = "201222222222@s.whatsapp.net";
  const phoneId = "201333333333@s.whatsapp.net";
  const unknownId = "987654321098765@lid";
  store.saveUserMetadata({
    jid: savedId,
    phone: "201111111111",
    savedName: "Saved contact",
    displayName: "Push contact",
  });
  store.saveUserMetadata({ jid: pushedId, displayName: "Push only" });
  const identities = [
    [savedId, "Saved contact", "contact"],
    [pushedId, "Push only", "contact"],
    [phoneId, "+201333333333", "contact"],
    [unknownId, null, "contact"],
    [liveId, "Live family", "group"],
    [directoryId, "Stored friends", "group"],
    [settingsId, null, "group"],
  ];
  for (const [id] of identities)
    store.saveChatHistory(id, [{ role: "user", parts: [{ text: "Stored conversation" }] }]);
  const { conversations } = await (await http.call("/dashboard/api/ai/conversations")).json();
  equal("every stored conversation appears", conversations.length, identities.length);
  for (const [id, name, kind] of identities) {
    const row = conversations.find((conversation) => conversation.chatId === id);
    equal(`${id} list name`, row?.name, name);
    equal(`${id} list kind`, row?.kind, kind);
    res = await http.call(`/dashboard/api/ai/conversations/${encodeURIComponent(id)}`);
    equal(`${id} detail is readable`, res.status, 200);
    const detail = await res.json();
    equal(`${id} detail name agrees with list`, detail.name, name);
    equal(`${id} detail retains request key`, detail.chatId, id);
    equal(
      `${id} detail retains conversation text`,
      detail.messages[0]?.text,
      "Stored conversation",
    );
  }

  section("group setting edits preserve existing configuration");
  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}`,
    {
      antilink: { enabled: true, mode: "WHITELIST", allowed_domains: ["EXAMPLE.COM"], action: "KICK" },
      antispam: { enabled: true, time_window: 15, message_count: 6, action: "WARN" },
      media_control: { enabled: true, blocked_types: ["image", "audio"], action: "DELETE" },
      welcome_system: { enabled: true, messages: ["أهلاً", "Welcome"] },
      warn_system: { max_warnings: 4, action: "NONE" },
      forbidden_words: { enabled: true, action: "WARN" },
      join_requests: { auto_approve_enabled: true },
    },
    "PATCH",
  );
  equal("full group controls are accepted", res.status, 200);
  const config = store.getGroupSettings(settingsId);
  equal("existing rules survive moderation changes", config.rules, "Stored rule");
  equal("existing blacklist survives moderation changes", config.blacklist[0], "keep-this");
  equal("domain normalization is retained", config.antilink.allowed_domains[0], "example.com");
  equal(
    "welcome messages retain both languages",
    config.welcome_system.messages.join("|"),
    "أهلاً|Welcome",
  );
  equal(
    "media restrictions retain selected types",
    config.media_control.blocked_types.join(","),
    "image,audio",
  );
  equal("antispam count is saved", config.antispam.message_count, 6);
  equal("warning limit is saved", config.warn_system.max_warnings, 4);
  equal("explicit NONE is stored as FLAG", config.warn_system.action, "FLAG");
  equal("antilink action is saved", config.antilink.action, "KICK");
  equal("media action is saved", config.media_control.action, "DELETE");
  equal("forbidden-words action is saved", config.moderation.forbiddenWords.action, "WARN");
  equal("join requests are saved", config.join_requests.auto_approve_enabled, true);
  groups = (await (await http.call("/dashboard/api/groups")).json()).groups;
  const panelGroup = groups.find((group) => group.id === settingsId);
  ok("GET groups includes the English summary", panelGroup.moderation_summary.en.includes("Anti-link"));
  ok("GET groups includes the Arabic summary", panelGroup.moderation_summary.ar.includes("منع الروابط"));
  equal("forbidden-word count is exposed", panelGroup.forbidden_words.count, 0);
  equal("explicit NONE becomes FLAG on the panel", panelGroup.warn_system.action, "FLAG");
  equal("GET antilink action is the stored value", panelGroup.antilink.action, "KICK");
  equal("GET media action is the stored value", panelGroup.media_control.action, "DELETE");
  ok(
    "GET summary for FLAG names admin review",
    panelGroup.moderation_summary.en.includes("flag for admin review"),
  );
  equal(
    "unset warn action is shown as KICK",
    groups.find((group) => group.id === liveId).warn_system.action,
    "KICK",
  );
  ok(
    "GET summary for an unset action names kick",
    groups.find((group) => group.id === liveId).moderation_summary.en.includes("remove the member"),
  );

  section("flagged members list and clear from the API");
  const flaggedId = "201555555555@s.whatsapp.net";
  store.saveUserWarnings(settingsId, flaggedId, [
    { reason: "link", by: "bot", date: new Date().toISOString() },
  ]);
  store.upsertModerationFlag(settingsId, flaggedId, {
    warnCount: 3,
    lastRule: "link",
    reasons: ["link"],
    flaggedAt: 1_700_000_000_000,
  });
  groups = (await (await http.call("/dashboard/api/groups")).json()).groups;
  const flaggedGroup = groups.find((group) => group.id === settingsId);
  equal("GET lists the flagged member", flaggedGroup.flagged_members.length, 1);
  equal("flagged member id is canonical", flaggedGroup.flagged_members[0].user_id, flaggedId);
  equal("flagged warn count is exposed", flaggedGroup.flagged_members[0].warn_count, 3);

  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}/flagged/dismiss`,
    { user_id: flaggedId },
  );
  equal("dismiss flag succeeds", res.status, 200);
  equal("dismiss drops the flag", store.getModerationFlag(settingsId, flaggedId), null);
  equal("dismiss keeps warnings", store.getUserWarnings(settingsId, flaggedId).length, 1);

  store.upsertModerationFlag(settingsId, flaggedId, {
    warnCount: 3,
    lastRule: "link",
    reasons: ["link"],
  });
  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}/flagged/clear`,
    { user_id: flaggedId },
  );
  equal("clear succeeds", res.status, 200);
  equal("clear drops the flag", store.getModerationFlag(settingsId, flaggedId), null);
  equal("clear drops warnings", store.getUserWarnings(settingsId, flaggedId).length, 0);

  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}/flagged/clear`,
    {},
  );
  equal("clear without user_id is 400", res.status, 400);

  store.upsertModerationFlag(settingsId, flaggedId, {
    warnCount: 3,
    lastRule: "spam",
    reasons: ["spam"],
  });
  setSession(null);
  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}/flagged/kick`,
    { user_id: flaggedId },
  );
  equal("kick without a socket is 503", res.status, 503);

  const flaggedKicks = [];
  groupMetadataCache.set(settingsId, {
    subject: "Stored rule group",
    participants: [
      { id: flaggedId, admin: null },
      { id: "209999999999@s.whatsapp.net", admin: "admin" },
    ],
  });
  setSession({
    socket: {
      user: { id: "209999999999@s.whatsapp.net" },
      async groupParticipantsUpdate(_jid, users, action) {
        flaggedKicks.push({ users: [...users], action });
      },
    },
    getState: () => ({ state: "connected", connected: true }),
  });
  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}/flagged/kick`,
    { user_id: flaggedId },
  );
  equal("kick flagged succeeds", res.status, 200);
  equal("kick was sent", flaggedKicks.length, 1);
  equal("kick uses the member id", flaggedKicks[0].users[0], flaggedId);
  equal("kick clears the flag", store.getModerationFlag(settingsId, flaggedId), null);
  const kickedView = await res.json();
  equal("kick response has no flagged members", kickedView.group.flagged_members.length, 0);
  setSession(null);
  res = await http.json("/dashboard/api/groups/moderation-preview", {
    antilink: { enabled: true, mode: "ALL" },
    warn_system: { max_warnings: 5, action: "KICK" },
  });
  equal("preview route succeeds", res.status, 200);
  const preview = await res.json();
  ok("preview English reflects the draft warn limit", preview.en.includes("Warn limit: 5"));
  ok("preview English says kick at the limit", preview.en.includes("remove the member"));
  ok("preview Arabic is Arabic", preview.ar.includes("حد الإنذارات"));
  res = await http.json("/dashboard/api/groups/moderation-preview", {
    antilink: { enabled: true, mode: "ALL", action: "DELETE" },
    warn_system: { max_warnings: 5, action: "FLAG" },
  });
  equal("FLAG preview route succeeds", res.status, 200);
  const flagPreview = await res.json();
  ok("FLAG preview names admin review", flagPreview.en.includes("flag for admin review"));
  ok("DELETE preview names delete only", flagPreview.en.includes("delete only"));
  res = await http.json("/dashboard/api/groups/moderation-preview", {
    antilink: { enabled: true, mode: "ALL" },
  });
  equal("unset preview route succeeds", res.status, 200);
  const unsetPreview = await res.json();
  ok(
    "unset preview kicks at the default limit",
    unsetPreview.en.includes("Warn limit: 3") && unsetPreview.en.includes("remove the member"),
  );
  res = await http.json(
    `/dashboard/api/groups/${encodeURIComponent(settingsId)}`,
    { media_control: { blocked_types: ["unknown"] } },
    "PATCH",
  );
  equal("invalid media types are rejected", res.status, 400);
  equal(
    "invalid edit leaves stored types untouched",
    store.getGroupSettings(settingsId).media_control.blocked_types.join(","),
    "image,audio",
  );

  section("group photos enforce identity, URL, MIME and byte bounds");
  let photoCalls = 0;
  let fetchCalls = 0;
  let photoUrl = "https://mmg.whatsapp.net/photo.jpg";
  let makeResponse = () =>
    new Response(Buffer.from("photo-bytes"), {
      headers: { "content-type": "image/jpeg; charset=binary" },
    });
  provider.safeProviderFetch = async (url, init, options) => {
    fetchCalls += 1;
    equal("photo fetch uses the checked URL", url, photoUrl);
    equal("photo fetch disallows loopback resolution", options.allowLoopback, false);
    ok("photo fetch has a cancellation deadline", init.signal instanceof AbortSignal);
    return makeResponse();
  };
  const fakeSocket = {
    async profilePictureUrl(id) {
      photoCalls += 1;
      equal("profile lookup uses a known group id", id, liveId);
      return photoUrl;
    },
  };
  setSession(null);
  equal("disconnected group uses image fallback", (await http.call(photoPath())).status, 404);
  setSession({ socket: fakeSocket, getState: () => ({ state: "connected", connected: true }) });
  equal(
    "unknown group cannot trigger photo lookup",
    (await http.call(photoPath("120363999999999@g.us"))).status,
    404,
  );
  equal(
    "contact cannot trigger group photo lookup",
    (await http.call(photoPath(phoneId))).status,
    404,
  );
  equal("fallback guards did not query WhatsApp", photoCalls, 0);
  await http.call("/dashboard/api/stats");
  await http.call("/dashboard/api/groups");
  equal("overview and group listing do not fetch photos", photoCalls, 0);
  for (const url of [
    "http://mmg.whatsapp.net/photo.jpg",
    "https://mmg.whatsapp.net.evil.test/photo.jpg",
    "https://127.0.0.1/photo.jpg",
    "not-a-url",
  ]) {
    photoUrl = url;
    equal(`unsafe photo URL ${url} uses fallback`, (await http.call(photoPath())).status, 404);
  }
  equal("unsafe URLs never reach network fetch", fetchCalls, 0);
  photoUrl = "https://mmg.whatsapp.net/photo.jpg";
  res = await http.call(photoPath());
  equal("bounded image response is served", res.status, 200);
  equal("photo type is retained", res.headers.get("content-type"), "image/jpeg");
  equal("photo response stays private", res.headers.get("cache-control"), "no-store");
  equal("photo bytes survive proxy", await res.text(), "photo-bytes");
  makeResponse = () =>
    new Response("<html>no photo</html>", { headers: { "content-type": "text/html" } });
  equal("non-image response uses fallback", (await http.call(photoPath())).status, 404);
  makeResponse = () =>
    new Response("expired", { status: 403, headers: { "content-type": "image/jpeg" } });
  equal("expired remote URL uses fallback", (await http.call(photoPath())).status, 404);
  makeResponse = () =>
    new Response(Buffer.alloc(1024 * 1024), { headers: { "content-type": "image/png" } });
  res = await http.call(photoPath());
  equal("image exactly at the size limit is accepted", res.status, 200);
  equal(
    "complete limit-sized photo survives proxy",
    (await res.arrayBuffer()).byteLength,
    1024 * 1024,
  );
  makeResponse = () =>
    new Response(Buffer.alloc(1024 * 1024 + 1), { headers: { "content-type": "image/png" } });
  equal("oversized response uses fallback", (await http.call(photoPath())).status, 404);
  makeResponse = () => {
    throw new Error("network unavailable");
  };
  equal("network failure uses fallback", (await http.call(photoPath())).status, 404);
} catch (error) {
  ok("panel UI route regressions run", false, error?.stack || String(error));
} finally {
  provider.safeProviderFetch = originalFetch;
  setSession(null);
  groupMetadataCache.flushAll();
  server.closeAllConnections?.();
  io.close();
  server.close();
  finish();
}
