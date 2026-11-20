import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addAutoReplyChat,
  addExcludedChat,
  createLatestReader,
  createRecoveryRefreshGate,
  createRequestGeneration,
  createWriteQueue,
  describeAutoReplyPeers,
  fallbackRecipientForJid,
  filterAndSortTemplateKeys,
  getDraftText,
  presetDisplayCopy,
  RECOVERY_REFRESH_COOLDOWN_MS,
  recoverPlusPurchases,
  removeAutoReplyChat,
  removeExcludedChat,
  samplePlaceholderValue,
  setAutoReplyScopeMode,
  showsPlusUntil,
  substitutePlaceholders,
  visibleTemplatePreview,
} from "../frontend/src/views/plus/plusUiLogic.ts";
import {
  CHAT_JID_PATTERN,
  DEFAULT_AUTO_REPLY_POLICY,
  normalizeAutoReplyConfig,
} from "../frontend/src/views/plus/types.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const deepEqual = (label, actual, expected) =>
  equal(label, JSON.stringify(actual), JSON.stringify(expected));

section("U3: placeholder samples and template preview substitution");

equal("sample value for name is Levix", samplePlaceholderValue("name"), "Levix");
equal("sample value for count is 3", samplePlaceholderValue("count"), "3");
equal(
  "sample value for other placeholder is wrapped in angle brackets",
  samplePlaceholderValue("command"),
  "<command>",
);
equal(
  "sample value for reason is wrapped in angle brackets",
  samplePlaceholderValue("reason"),
  "<reason>",
);

equal(
  "substitutes name, count, and unknown placeholders in template",
  substitutePlaceholders("Hello {name}! You have {count} attempts left for {command} ({reason})."),
  "Hello Levix! You have 3 attempts left for <command> (<reason>).",
);

equal(
  "handles templates without placeholders",
  substitutePlaceholders("Plain message text without tokens."),
  "Plain message text without tokens.",
);

equal(
  "handles duplicate placeholders consistently",
  substitutePlaceholders("{name} pinged {name}: {count} + {count} = 6"),
  "Levix pinged Levix: 3 + 3 = 6",
);

section("U3: draft text selection for locales");

const manualOverrides = {
  ar: "مرحبا {name}",
  "es-419": "Hola {name}",
};

equal(
  "Original Everywhere uses source text in every locale",
  getDraftText("ar", "original", "en", "Original text for {name}", manualOverrides),
  "Original text for {name}",
);

equal(
  "Original Everywhere uses source text for source locale",
  getDraftText("en", "original", "en", "Original text for {name}", manualOverrides),
  "Original text for {name}",
);

equal(
  "Original Everywhere uses source text for pt-BR",
  getDraftText("pt-BR", "original", "en", "Original text for {name}", manualOverrides),
  "Original text for {name}",
);

equal(
  "Auto mode uses source text for source locale",
  getDraftText("en", "auto", "en", "English {name}", manualOverrides),
  "English {name}",
);

equal(
  "Auto mode uses manual override when provided for other locale",
  getDraftText("ar", "auto", "en", "English {name}", manualOverrides),
  "مرحبا {name}",
);

equal(
  "Auto mode returns empty string when no manual override exists for other locale",
  getDraftText("pt-BR", "auto", "en", "English {name}", manualOverrides),
  "",
);

section("U2: write serialization and field preservation");

{
  const queue = createWriteQueue();
  const executionOrder = [];
  let inFlight = 0;
  let maxInFlight = 0;

  function deferredTask(id, delayMs) {
    return async () => {
      inFlight += 1;
      if (inFlight > maxInFlight) maxInFlight = inFlight;
      executionOrder.push(`start-${id}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      executionOrder.push(`end-${id}`);
      inFlight -= 1;
      return id;
    };
  }

  const p1 = queue.enqueue(deferredTask("watermark", 30));
  const p2 = queue.enqueue(deferredTask("progress", 10));
  const p3 = queue.enqueue(deferredTask("third", 5));

  const results = await Promise.all([p1, p2, p3]);

  deepEqual("all queued writes resolve their values in order", results, [
    "watermark",
    "progress",
    "third",
  ]);
  equal("exactly one write runs in flight at any time", maxInFlight, 1);
  deepEqual("writes are strictly serialized (one in flight, queue next)", executionOrder, [
    "start-watermark",
    "end-watermark",
    "start-progress",
    "end-progress",
    "start-third",
    "end-third",
  ]);
}

section("U2: watermark and progress send saved values for unchanged fields");

{
  let saved = {
    hideWatermark: false,
    hideProgress: "none",
    commands: ["ping", "help"],
  };

  const queue = createWriteQueue();
  const sentPayloads = [];

  async function mockWatermarkSave(hide) {
    return queue.enqueue(async () => {
      const payload = {
        hideWatermark: hide,
        hideProgress: saved.hideProgress,
        commands: saved.commands,
      };
      sentPayloads.push({ kind: "watermark", payload });
      saved = { ...payload };
      return saved;
    });
  }

  async function mockProgressSave(draft) {
    return queue.enqueue(async () => {
      const payload = {
        hideWatermark: saved.hideWatermark,
        hideProgress: draft.hideProgress,
        commands: draft.commands,
      };
      sentPayloads.push({ kind: "progress", payload });
      saved = { ...payload };
      return saved;
    });
  }

  // User changed progress in draft:
  const progressDraft = { hideProgress: "selected", commands: ["gemini"] };

  // Watermark toggle clicked first, progress save queued immediately:
  const wmPromise = mockWatermarkSave(true);
  const progPromise = mockProgressSave(progressDraft);

  await Promise.all([wmPromise, progPromise]);

  equal(
    "watermark save sent currently saved progress values",
    sentPayloads[0].payload.hideProgress,
    "none",
  );
  deepEqual("watermark save sent currently saved commands", sentPayloads[0].payload.commands, [
    "ping",
    "help",
  ]);
  equal("watermark save updated hideWatermark", sentPayloads[0].payload.hideWatermark, true);

  equal(
    "queued progress save sent latest saved hideWatermark value",
    sentPayloads[1].payload.hideWatermark,
    true,
  );
  equal("progress save sent draft hideProgress", sentPayloads[1].payload.hideProgress, "selected");
  deepEqual("progress save sent draft commands", sentPayloads[1].payload.commands, ["gemini"]);
}

section("U1: auto-reply immediate toggle uses saved config, never unsaved draft");

{
  let savedConfig = {
    enabled: true,
    killSwitch: false,
    globalPerHour: 50,
    chats: [
      {
        jid: "123@s.whatsapp.net",
        enabled: true,
        trigger: "all",
        keywords: [],
        instructions: "",
        cooldownSeconds: 60,
        perSenderPerHour: 5,
        perChatPerHour: 20,
      },
    ],
  };

  const queue = createWriteQueue();
  const sentPayloads = [];

  // Unsaved user edits in draft form:
  const draftForm = {
    globalPerHour: 120,
    chats: [],
  };

  async function mockToggleKillSwitch(value) {
    return queue.enqueue(async () => {
      const payload = {
        ...savedConfig,
        killSwitch: value,
      };
      sentPayloads.push({ kind: "toggle-kill", payload });
      savedConfig = { ...payload };
      return savedConfig;
    });
  }

  await mockToggleKillSwitch(true);

  equal(
    "kill switch toggle applied immediately with confirmed killSwitch value",
    savedConfig.killSwitch,
    true,
  );
  equal(
    "kill switch toggle sent saved globalPerHour, not unsaved draft",
    sentPayloads[0].payload.globalPerHour,
    50,
  );
  equal(
    "kill switch toggle sent saved chats count, not unsaved draft",
    sentPayloads[0].payload.chats.length,
    1,
  );
  equal("user draft edits to globalPerHour were not sent by toggle", draftForm.globalPerHour, 120);
}

section("until date appears only for active, grace and canceled states");

for (const [state, expected] of [
  ["none", false],
  ["active", true],
  ["grace", true],
  ["canceled", true],
  ["inactive", false],
  ["expired", false],
  ["clock", false],
  ["unverified", false],
]) {
  equal(`${state}: until visibility`, showsPlusUntil(state), expected);
}

section("status reads ignore reversed completion order and stale failures");

{
  const reads = createRequestGeneration();
  let displayed = "initial";
  const older = reads.begin();
  const newer = reads.begin();
  equal("newest read is current", reads.isCurrent(newer), true);
  equal("older read is stale", reads.isCurrent(older), false);
  if (reads.isCurrent(newer)) displayed = "newer success";
  if (reads.isCurrent(older)) displayed = "older success";
  equal("older success cannot overwrite newer success", displayed, "newer success");
  if (reads.isCurrent(older)) displayed = null;
  equal("older failure cannot clear newer success", displayed, "newer success");
  const latest = reads.begin();
  if (reads.isCurrent(latest)) displayed = null;
  equal("latest failure clears status", displayed, null);
  equal("new read invalidates previous success token", reads.isCurrent(newer), false);
}

section("a stale status read failure cannot report an error over a newer success");

function deferredReader() {
  const pending = [];
  const shown = [];
  const reader = createLatestReader(
    () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    (value) => shown.push(value),
  );
  // Mirrors PlusSettings statusChanged: every rejection becomes the displayed error.
  const errors = [];
  const report = (read) =>
    read.then(
      () => {},
      (err) => errors.push(err.message),
    );
  return { pending, shown, reader, errors, report };
}

{
  const { pending, shown, reader, errors, report } = deferredReader();
  const a = reader.read();
  const aReported = report(a);
  const b = reader.read();
  const bReported = report(b);
  pending[1].resolve("B active");
  await bReported;
  pending[0].reject(new Error("A network"));
  await aReported;
  equal("stale failure reports no error", JSON.stringify(errors), JSON.stringify([]));
  equal("only the newer success is shown", JSON.stringify(shown), JSON.stringify(["B active"]));
  equal("stale read settles with the newer outcome", await a, "B active");
}

{
  const { pending, shown, reader, errors, report } = deferredReader();
  const a = report(reader.read());
  const b = report(reader.read());
  pending[0].reject(new Error("A network"));
  pending[1].reject(new Error("B network"));
  await Promise.all([a, b]);
  equal(
    "newer failure is still reported, never the stale one",
    JSON.stringify(errors),
    JSON.stringify(["B network", "B network"]),
  );
  equal("newer failure clears the shown status", JSON.stringify(shown), JSON.stringify([null]));
}

{
  const { pending, shown, reader, errors, report } = deferredReader();
  const only = report(reader.read());
  pending[0].reject(new Error("current network"));
  await only;
  equal(
    "current failure stays visible",
    JSON.stringify(errors),
    JSON.stringify(["current network"]),
  );
  equal("current failure clears the shown status", JSON.stringify(shown), JSON.stringify([null]));
}

{
  const { pending, shown, reader, errors, report } = deferredReader();
  const a = report(reader.read());
  reader.cancel();
  pending[0].reject(new Error("after cancel"));
  await a;
  equal("cancelled read shows nothing", JSON.stringify(shown), JSON.stringify([]));
  equal(
    "cancelled read rejects with its own error",
    JSON.stringify(errors),
    JSON.stringify(["after cancel"]),
  );
}

section("foreground recovery re-verifies an inactive entitlement once Play owns it again");

// A fake verifier: the only place the displayed entitlement can come from.
function recoveryHarness({ serverState, afterRefresh = serverState, clock = { at: 0 } }) {
  const calls = { claim: 0, refresh: 0, read: 0 };
  const server = { state: serverState };
  const gate = createRecoveryRefreshGate(RECOVERY_REFRESH_COOLDOWN_MS, () => clock.at);
  const deps = (purchases, shownState = server.state) => ({
    purchases,
    state: shownState,
    gate,
    claim: async (fresh) => {
      calls.claim += fresh.length;
      server.state = "active";
    },
    readState: async () => {
      calls.read += 1;
      return server.state;
    },
    refresh: async () => {
      calls.refresh += 1;
      server.state = afterRefresh;
    },
  });
  return { calls, server, deps, clock };
}

const owned = (token, acknowledged = true) => ({
  status: "purchased",
  acknowledged,
  purchaseToken: token,
  productId: "levix.plus",
  packageName: "net.leviro.levix",
});

{
  // QA Finding 7: hold or pause ended in Play, same token, app still holds an inactive token.
  const h = recoveryHarness({ serverState: "inactive", afterRefresh: "active" });
  const outcome = await recoverPlusPurchases(h.deps([owned("t1")]));
  equal("inactive + owned purchase refreshes", outcome, "refreshed");
  equal("one server refresh", h.calls.refresh, 1);
  equal("nothing is claimed", h.calls.claim, 0);
  equal("the server now reports active", h.server.state, "active");
}

for (const state of ["none", "expired", "unverified"]) {
  const h = recoveryHarness({ serverState: state, afterRefresh: "active" });
  equal(
    `${state}: still refreshes`,
    await recoverPlusPurchases(h.deps([owned("t1")])),
    "refreshed",
  );
  equal(`${state}: one refresh`, h.calls.refresh, 1);
}

for (const state of ["active", "grace", "canceled", "clock"]) {
  const h = recoveryHarness({ serverState: state });
  equal(`${state}: no refresh`, await recoverPlusPurchases(h.deps([owned("t1")])), "none");
  equal(`${state}: refresh not called`, h.calls.refresh, 0);
}

{
  const h = recoveryHarness({ serverState: "inactive", afterRefresh: "inactive" });
  equal("no Play purchase: nothing", await recoverPlusPurchases(h.deps([])), "none");
  equal("no Play purchase: no refresh", h.calls.refresh, 0);
  equal(
    "a Play result alone never changes the entitlement",
    await recoverPlusPurchases(h.deps([owned("t1")])),
    "refreshed",
  );
  equal("server still inactive after its own answer", h.server.state, "inactive");
}

{
  // A new purchase made outside the app is unacknowledged and is claimed instead.
  const h = recoveryHarness({ serverState: "inactive" });
  equal(
    "fresh purchase is claimed",
    await recoverPlusPurchases(h.deps([owned("new", false)])),
    "claimed",
  );
  equal("one claim", h.calls.claim, 1);
  equal("no refresh after a claim alone", h.calls.refresh, 0);
}

{
  // Claim then re-read: an acknowledged purchase beside it refreshes only if the server is still stale.
  const h = recoveryHarness({ serverState: "inactive", afterRefresh: "active" });
  const outcome = await recoverPlusPurchases(h.deps([owned("new", false), owned("old")]));
  equal("claim made the server active, so no refresh", outcome, "claimed");
  equal("state re-read from the server after the claim", h.calls.read, 1);
  equal("no refresh", h.calls.refresh, 0);
}

{
  const clock = { at: 1_000 };
  const h = recoveryHarness({ serverState: "inactive", afterRefresh: "inactive", clock });
  equal(
    "first foreground refreshes",
    await recoverPlusPurchases(h.deps([owned("t1")])),
    "refreshed",
  );
  clock.at += 30_000;
  equal(
    "repeat inside the cooldown is skipped",
    await recoverPlusPurchases(h.deps([owned("t1")])),
    "skipped",
  );
  equal("still one refresh", h.calls.refresh, 1);
  equal(
    "another purchase token is not blocked",
    await recoverPlusPurchases(h.deps([owned("t2")])),
    "refreshed",
  );
  clock.at += RECOVERY_REFRESH_COOLDOWN_MS;
  equal(
    "after the cooldown it refreshes again",
    await recoverPlusPurchases(h.deps([owned("t1")])),
    "refreshed",
  );
  equal("three refreshes in total", h.calls.refresh, 3);
}

{
  const h = recoveryHarness({ serverState: "inactive" });
  const failing = {
    ...h.deps([owned("t1")]),
    refresh: async () => {
      throw new Error("NETWORK");
    },
  };
  let error = null;
  try {
    await recoverPlusPurchases(failing);
  } catch (err) {
    error = err.message;
  }
  equal("a refresh failure reaches the caller", error, "NETWORK");
}

section(
  "U4: Auto Reply v1 save-path preserves scopeMode, groupsEnabled, excludedChats and policy round-trip",
);

{
  const fullV1 = {
    schemaVersion: 1,
    enabled: false,
    killSwitch: false,
    globalPerHour: 40,
    scopeMode: "except",
    groupsEnabled: true,
    chats: [
      {
        jid: "123@s.whatsapp.net",
        enabled: true,
        trigger: "keywords",
        keywords: ["urgent"],
        instructions: "Row instructions",
        cooldownSeconds: 30,
        perSenderPerHour: 8,
        perChatPerHour: 25,
        globalMemory: { read: true },
      },
    ],
    excludedChats: ["999@s.whatsapp.net", "888@g.us"],
    policy: {
      privateTrigger: "keywords",
      groupTrigger: "mention",
      keywords: ["support"],
      instructions: "Global policy instructions",
      cooldownSeconds: 45,
      perSenderPerHour: 12,
      perChatPerHour: 50,
      globalMemory: { read: true },
    },
  };

  const toggledEnabled = normalizeAutoReplyConfig(fullV1, { enabled: true });
  deepEqual("enabling preserves all v1 fields round-trip", toggledEnabled, {
    ...fullV1,
    enabled: true,
  });

  const toggledKill = normalizeAutoReplyConfig(toggledEnabled, { killSwitch: true });
  deepEqual("kill switch toggle preserves all v1 fields round-trip", toggledKill, {
    ...fullV1,
    enabled: true,
    killSwitch: true,
  });

  const editedForm = normalizeAutoReplyConfig(toggledKill, {
    globalPerHour: 100,
    chats: [],
  });
  deepEqual(
    "form save updates globalPerHour and chats while keeping scopeMode, groupsEnabled, excludedChats and policy",
    editedForm,
    {
      ...fullV1,
      enabled: true,
      killSwitch: true,
      globalPerHour: 100,
      chats: [],
    },
  );

  // Legacy v0 config without schemaVersion/scopeMode never widens on save (C-A1).
  const legacyV0 = {
    enabled: true,
    killSwitch: false,
    globalPerHour: 30,
    chats: fullV1.chats,
  };
  const migratedV0 = normalizeAutoReplyConfig(legacyV0);
  equal("v0 config normalizes to schemaVersion 1", migratedV0.schemaVersion, 1);
  equal("v0 config defaults scopeMode to only (never widens)", migratedV0.scopeMode, "only");
  equal(
    "v0 config defaults groupsEnabled to true so listed groups keep working",
    migratedV0.groupsEnabled,
    true,
  );
  deepEqual("v0 config defaults excludedChats to empty array", migratedV0.excludedChats, []);
  deepEqual(
    "v0 config defaults policy to DEFAULT_AUTO_REPLY_POLICY",
    migratedV0.policy,
    DEFAULT_AUTO_REPLY_POLICY,
  );

  // Partial v1 config with schemaVersion 1 defaults missing optional fields sensibly.
  const partialV1 = {
    schemaVersion: 1,
    enabled: false,
    killSwitch: false,
    globalPerHour: 30,
    chats: [],
  };
  const normalizedPartialV1 = normalizeAutoReplyConfig(partialV1);
  equal("partial v1 without a mode stays only", normalizedPartialV1.scopeMode, "only");
  equal("partial v1 defaults groupsEnabled to false", normalizedPartialV1.groupsEnabled, false);
  deepEqual("partial v1 defaults excludedChats to []", normalizedPartialV1.excludedChats, []);
  deepEqual("partial v1 defaults policy", normalizedPartialV1.policy, DEFAULT_AUTO_REPLY_POLICY);
}

section("U5: scope mode switching keeps both selected chats and excluded chats lists");

{
  const initialChats = [
    {
      jid: "201111111111@s.whatsapp.net",
      enabled: true,
      trigger: "all",
      keywords: [],
      instructions: "VIP contact",
      cooldownSeconds: 15,
      perSenderPerHour: 12,
      perChatPerHour: 40,
      globalMemory: { read: false },
    },
    {
      jid: "120363111111111@g.us",
      enabled: false,
      trigger: "keywords",
      keywords: ["help", "bot"],
      instructions: "Support group",
      cooldownSeconds: 30,
      perSenderPerHour: 5,
      perChatPerHour: 20,
      globalMemory: { read: true },
    },
  ];
  const initialExcluded = ["201999999999@s.whatsapp.net", "120363999999999@g.us"];

  const startState = {
    scopeMode: "only",
    globalPerHour: 50,
    chats: initialChats,
    excludedChats: initialExcluded,
  };

  const toExcept = setAutoReplyScopeMode(startState, "except");
  equal("mode switched to except", toExcept.scopeMode, "except");
  deepEqual("switching to except keeps selected chats list", toExcept.chats, initialChats);
  deepEqual(
    "switching to except keeps excludedChats list",
    toExcept.excludedChats,
    initialExcluded,
  );

  const toAll = setAutoReplyScopeMode(toExcept, "all");
  equal("mode switched to all", toAll.scopeMode, "all");
  deepEqual("switching to all keeps selected chats list", toAll.chats, initialChats);
  deepEqual("switching to all keeps excludedChats list", toAll.excludedChats, initialExcluded);

  const backToOnly = setAutoReplyScopeMode(toAll, "only");
  equal("mode switched back to only", backToOnly.scopeMode, "only");
  deepEqual("switching back to only keeps selected chats list", backToOnly.chats, initialChats);
  deepEqual(
    "switching back to only keeps excludedChats list",
    backToOnly.excludedChats,
    initialExcluded,
  );
}

section("U6: excluded list and selected chat list add/remove pure helpers");

{
  let excluded = [];
  const r1 = addExcludedChat(excluded, "201234567890@s.whatsapp.net");
  equal("valid contact JID is added to excluded list", r1.added, true);
  equal("no rejection reason for valid contact JID", r1.reason, null);
  excluded = r1.excludedChats;

  const r2 = addExcludedChat(excluded, "120363123456789@g.us");
  equal("valid group JID is added to excluded list", r2.added, true);
  excluded = r2.excludedChats;
  deepEqual("excluded list holds both JIDs in order", excluded, [
    "201234567890@s.whatsapp.net",
    "120363123456789@g.us",
  ]);

  const dup = addExcludedChat(excluded, "201234567890@s.whatsapp.net");
  equal("duplicate excluded JID is rejected", dup.added, false);
  equal("duplicate reason is duplicate", dup.reason, "duplicate");
  deepEqual("duplicate attempt leaves excluded list unchanged", dup.excludedChats, excluded);

  const bad = addExcludedChat(excluded, "not-a-valid-jid");
  equal("invalid JID is rejected", bad.added, false);
  equal("invalid reason is invalid", bad.reason, "invalid");

  const capped = addExcludedChat(excluded, "111111111111111@lid", 2);
  equal("adding past limit is rejected", capped.added, false);
  equal("limit reason is limit", capped.reason, "limit");

  const afterRemove = removeExcludedChat(excluded, "201234567890@s.whatsapp.net");
  deepEqual("removeExcludedChat removes the target JID only", afterRemove, [
    "120363123456789@g.us",
  ]);
  deepEqual(
    "removeExcludedChat with unknown JID leaves list intact",
    removeExcludedChat(afterRemove, "999999999@s.whatsapp.net"),
    ["120363123456789@g.us"],
  );

  // Selected chat rows add/remove
  let chats = [];
  const c1 = addAutoReplyChat(chats, "201234567890@s.whatsapp.net", DEFAULT_AUTO_REPLY_POLICY);
  equal("contact chat row added", c1.added, true);
  equal("contact chat defaults to privateTrigger (all)", c1.chat?.trigger, "all");
  chats = c1.chats;

  const c2 = addAutoReplyChat(chats, "120363123456789@g.us", DEFAULT_AUTO_REPLY_POLICY);
  equal("group chat row added", c2.added, true);
  equal("group chat defaults to groupTrigger (mention)", c2.chat?.trigger, "mention");
  chats = c2.chats;

  const cDup = addAutoReplyChat(chats, "120363123456789@g.us", DEFAULT_AUTO_REPLY_POLICY);
  equal("duplicate chat row rejected", cDup.added, false);
  equal("duplicate chat reason", cDup.reason, "duplicate");

  const remainingChats = removeAutoReplyChat(chats, "201234567890@s.whatsapp.net");
  equal("removeAutoReplyChat leaves 1 chat", remainingChats.length, 1);
  equal("remaining chat is the group", remainingChats[0].jid, "120363123456789@g.us");
}

section("U7: preview rendering never shows a raw placeholder");

{
  const rawPlaceholderPattern = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
  equal(
    "sample value for quotedText is friendly text",
    samplePlaceholderValue("quotedText"),
    "Hello!",
  );
  ok(
    "quotedText sample is not a raw placeholder",
    !rawPlaceholderPattern.test(samplePlaceholderValue("quotedText")),
  );

  const templateItem = {
    key: "bot.tools.quote",
    placeholders: ["quotedText", "count", "name", "customToken"],
    catalog: {
      en: "Quoted: {quotedText} ({count} by {name}, {customToken})",
      ar: "اقتباس: {quotedText} ({count} من {name}، {customToken})",
    },
    override: null,
  };

  for (const loc of ["en", "ar", "pt-BR", "es-419"]) {
    const rendered = visibleTemplatePreview(templateItem, loc);
    ok(`${loc}: preview is non-empty`, rendered.length > 0);
    ok(`${loc}: preview never contains a raw {placeholder}`, !rawPlaceholderPattern.test(rendered));
    ok(`${loc}: preview does not contain {quotedText}`, !rendered.includes("{quotedText}"));
    ok(`${loc}: preview does not contain {count}`, !rendered.includes("{count}"));
  }

  // Verify every bot catalog template across all locales renders without raw placeholders.
  for (const loc of ["en", "ar", "pt-BR", "es-419"]) {
    const botDir = join(ROOT, "i18n", loc, "bot");
    for (const file of readdirSync(botDir)) {
      if (!file.endsWith(".json")) continue;
      const entries = JSON.parse(readFileSync(join(botDir, file), "utf8"));
      for (const [key, val] of Object.entries(entries)) {
        if (typeof val !== "string") continue;
        const preview = substitutePlaceholders(val);
        ok(
          `${loc}/${file}:${key} preview has no raw placeholder`,
          !rawPlaceholderPattern.test(preview),
          preview,
        );
      }
    }
  }
}

section("U8: Auto Reply peer resolution never displays raw JIDs and uses unknown-contact fallback");

{
  const enCatalog = JSON.parse(readFileSync(join(ROOT, "i18n/en/dashboard.json"), "utf8"));
  const t = (key) => enCatalog[key] || "";
  const recipients = [
    {
      id: "201222222222@s.whatsapp.net",
      name: "Saved Contact",
      savedName: "Saved Contact",
      phone: "+201222222222",
      type: "contact",
      nameSource: "saved",
    },
    {
      id: "120363111111111@g.us",
      name: "Project Group",
      type: "group",
      memberCount: 8,
      nameSource: "subject",
    },
  ];
  const jids = [
    "201222222222@s.whatsapp.net",
    "120363111111111@g.us",
    "201000000010@s.whatsapp.net",
    "111111111111111@lid",
    "120363999999999@g.us",
  ];
  const peers = describeAutoReplyPeers(jids, recipients, t, "en");
  equal(
    "known contact shows saved name",
    peers.get("201222222222@s.whatsapp.net")?.title,
    "Saved Contact",
  );
  equal(
    "known group shows group subject",
    peers.get("120363111111111@g.us")?.title,
    "Project Group",
  );
  ok(
    "unlisted phone JID formats as phone number without @s.whatsapp.net",
    peers.get("201000000010@s.whatsapp.net")?.title.startsWith("+") &&
      !peers.get("201000000010@s.whatsapp.net")?.title.includes("@"),
  );
  equal(
    "unlisted LID uses existing unknown-contact label",
    peers.get("111111111111111@lid")?.title,
    enCatalog.recipientUnknownContact,
  );
  equal(
    "unlisted group uses existing unnamed-group label",
    peers.get("120363999999999@g.us")?.title,
    enCatalog.recipientUnnamedGroup,
  );
  for (const [jid, part] of peers) {
    ok(
      `peer label for ${jid} never contains raw @ domain`,
      !part.title.includes("@") && !part.subtitle.includes("@"),
    );
  }
  equal(
    "fallbackRecipientForJid marks @g.us as group",
    fallbackRecipientForJid("123@g.us").type,
    "group",
  );
}

section(
  "U9: preset localization, message filtering/sorting, and preset examples collapsed by default",
);

{
  for (const loc of ["en", "ar", "pt-BR", "es-419"]) {
    const catalog = JSON.parse(readFileSync(join(ROOT, "i18n", loc, "dashboard.json"), "utf8"));
    const t = (key) => catalog[key] || "";
    for (const id of ["minimal", "professional", "fun"]) {
      const copy = presetDisplayCopy(
        { id, name: "Fallback Name", description: "Fallback Description" },
        t,
      );
      ok(
        `${loc} ${id} preset has localized name`,
        copy.name.length > 0 && copy.name !== "Fallback Name",
      );
      ok(
        `${loc} ${id} preset has localized description`,
        copy.description.length > 0 && copy.description !== "Fallback Description",
      );
    }
  }

  const sampleKeys = [
    {
      key: "bot.tools.weather.done",
      placeholders: [],
      catalog: { en: "Weather ready" },
      override: null,
    },
    {
      key: "bot.core.ping.pong",
      placeholders: [],
      catalog: { en: "Pong!" },
      override: {
        mode: "original",
        source: { locale: "en", text: "Custom Pong!" },
        values: { en: "Custom Pong!" },
        manual: [],
        translated: [],
        failed: [],
        updatedAt: 1,
      },
    },
  ];

  const onlyCustom = filterAndSortTemplateKeys(sampleKeys, {
    search: "",
    area: "all",
    onlyCustomized: true,
    sort: "area",
    areaOf: (k) => k.split(".")[1] || "",
    areaLabel: (k) => k.split(".")[1] || "",
    commandOf: (k) => k.split(".")[2] || null,
  });
  equal("onlyCustomized filter returns 1 customized key", onlyCustom.length, 1);
  equal("onlyCustomized returns the customized key", onlyCustom[0].key, "bot.core.ping.pong");

  const sortedCustomFirst = filterAndSortTemplateKeys(sampleKeys, {
    search: "",
    area: "all",
    onlyCustomized: false,
    sort: "customized",
    areaOf: (k) => k.split(".")[1] || "",
    areaLabel: (k) => k.split(".")[1] || "",
    commandOf: (k) => k.split(".")[2] || null,
  });
  equal(
    "customized sort places customized item first",
    sortedCustomFirst[0].key,
    "bot.core.ping.pong",
  );

  // Static check: preset examples are collapsed in a Disclosure by default.
  const presetsSource = readFileSync(join(ROOT, "frontend/src/views/plus/PresetsTab.tsx"), "utf8");
  ok("PresetsTab imports Disclosure from components/ui", /\bDisclosure\b/.test(presetsSource));
  const disclosureIdx = presetsSource.indexOf("<Disclosure");
  const previewIdx = presetsSource.indexOf("preset.preview.slice");
  ok(
    "preset examples are rendered inside a collapsed-by-default Disclosure",
    disclosureIdx !== -1 && previewIdx > disclosureIdx,
  );
  ok(
    "preset examples substitute placeholders in preview text",
    presetsSource.includes("substitutePlaceholders(line.text)"),
  );

  // Static check: MessagesTab renders human-readable previews without TemplateBody raw tokens.
  const messagesSource = readFileSync(
    join(ROOT, "frontend/src/views/plus/MessagesTab.tsx"),
    "utf8",
  );
  ok("MessagesTab uses ListRow", /\bListRow\b/.test(messagesSource));
  ok(
    "MessagesTab uses FilterButton and SortMenu",
    /\bFilterButton\b/.test(messagesSource) && /\bSortMenu\b/.test(messagesSource),
  );
  ok(
    "MessagesTab renders visibleTemplatePreview",
    messagesSource.includes("visibleTemplatePreview("),
  );
  ok(
    "MessagesTab does not render raw TemplateBody tokens in list rows",
    !messagesSource.includes("<TemplateBody"),
  );
}

section("R3: CHAT_JID_PATTERN accepts legacy groups and standard JIDs");
{
  equal(
    "accepts legacy group with hyphen",
    CHAT_JID_PATTERN.test("123456789-1234567890@g.us"),
    true,
  );
  equal("accepts short legacy group", CHAT_JID_PATTERN.test("1-2@g.us"), true);
  equal("accepts standard group", CHAT_JID_PATTERN.test("120363000000000001@g.us"), true);
  equal("accepts user s.whatsapp.net", CHAT_JID_PATTERN.test("201111111111@s.whatsapp.net"), true);
  equal("accepts lid format", CHAT_JID_PATTERN.test("123456789@lid"), true);

  equal("rejects letters in user", CHAT_JID_PATTERN.test("abc@s.whatsapp.net"), false);
  equal("rejects letters in legacy group", CHAT_JID_PATTERN.test("123-abc@g.us"), false);
  equal("rejects hyphen in user JID", CHAT_JID_PATTERN.test("123-456@s.whatsapp.net"), false);
  equal("rejects hyphen in LID", CHAT_JID_PATTERN.test("123-456@lid"), false);
  equal("rejects invalid server", CHAT_JID_PATTERN.test("12345@c.us"), false);
  equal("rejects broadcast", CHAT_JID_PATTERN.test("status@broadcast"), false);
}

finish();
