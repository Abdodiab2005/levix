import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  addAutoReplyChat,
  addExcludedChat,
  autoReplyFormDataFrom,
  createLatestReader,
  createRecoveryRefreshGate,
  createRequestGeneration,
  createWriteQueue,
  describeAutoReplyPeers,
  fallbackRecipientForJid,
  filterAndSortTemplateKeys,
  getDraftText,
  hasSamplePlaceholderValue,
  humanizePlaceholder,
  isPhoneTitle,
  presetDisplayCopy,
  RECOVERY_REFRESH_COOLDOWN_MS,
  reconcileAutoReplyDraft,
  recoverPlusPurchases,
  removeAutoReplyChat,
  removeExcludedChat,
  samplePlaceholderValue,
  saveAutoReplyForm,
  saveAutoReplyPatch,
  setAutoReplyScopeMode,
  showsPlusUntil,
  substitutePlaceholders,
  visibleTemplatePreview,
} from "../frontend/src/views/plus/plusUiLogic.ts";
import {
  CHAT_JID_PATTERN,
  DEFAULT_AUTO_REPLY_POLICY,
  isAutoReplyRevision,
  normalizeAutoReplyConfig,
} from "../frontend/src/views/plus/types.ts";
import { equal, finish, ok, ROOT, section } from "./harness.mjs";

const deepEqual = (label, actual, expected) =>
  equal(label, JSON.stringify(actual), JSON.stringify(expected));

section("U3: placeholder samples and template preview substitution");

equal("sample value for name is Levix", samplePlaceholderValue("name"), "Levix");
equal("sample value for count is 3", samplePlaceholderValue("count"), "3");
equal(
  "sample value for command is a readable command sample",
  samplePlaceholderValue("command"),
  "!help",
);
equal(
  "sample value for reason is readable text",
  samplePlaceholderValue("reason"),
  "Contains a forbidden word",
);
equal(
  "unknown placeholder is humanized into words without angle brackets",
  samplePlaceholderValue("customMetricName"),
  "Custom metric name",
);
equal(
  "humanizePlaceholder splits camelCase and snake_case",
  humanizePlaceholder("max_chatCount"),
  "Max chat count",
);

equal(
  "substitutes name, count, command and reason in template with readable samples",
  substitutePlaceholders("Hello {name}! You have {count} attempts left for {command} ({reason})."),
  "Hello Levix! You have 3 attempts left for !help (Contains a forbidden word).",
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

section("U7: preview rendering never shows a raw placeholder or angle-bracket token");

{
  const rawPlaceholderPattern = /\{[A-Za-z_][A-Za-z0-9_]*\}/;
  const angleTokenPattern = /<[A-Za-z_][A-Za-z0-9_]*>/;
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
    ok(`${loc}: preview never contains a <token>`, !angleTokenPattern.test(rendered));
    ok(`${loc}: preview does not contain {quotedText}`, !rendered.includes("{quotedText}"));
    ok(`${loc}: preview does not contain {count}`, !rendered.includes("{count}"));
  }

  // Walk every placeholder in every bot catalog across all four locales.
  const catalogPlaceholders = new Set();
  for (const loc of ["en", "ar", "pt-BR", "es-419"]) {
    const botDir = join(ROOT, "i18n", loc, "bot");
    for (const file of readdirSync(botDir)) {
      if (!file.endsWith(".json")) continue;
      const entries = JSON.parse(readFileSync(join(botDir, file), "utf8"));
      for (const [key, val] of Object.entries(entries)) {
        if (typeof val !== "string") continue;
        for (const match of val.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
          catalogPlaceholders.add(match[1]);
        }
        const preview = substitutePlaceholders(val);
        // Usage lines such as `!debt del <id>` are catalog text; a sample must add no new <token>.
        const angleTokens = (text) => (text.match(new RegExp(angleTokenPattern, "g")) ?? []).length;
        ok(
          `${loc}/${file}:${key} preview has no raw placeholder and adds no <token>`,
          !rawPlaceholderPattern.test(preview) && angleTokens(preview) <= angleTokens(val),
          preview,
        );
      }
    }
  }
  ok("bot catalogs contain placeholders", catalogPlaceholders.size > 0);
  for (const name of [...catalogPlaceholders].sort()) {
    const sample = samplePlaceholderValue(name);
    ok(
      `catalog placeholder {${name}} has a curated readable sample`,
      hasSamplePlaceholderValue(name) &&
        sample.trim().length > 0 &&
        !rawPlaceholderPattern.test(sample) &&
        !angleTokenPattern.test(sample),
      sample,
    );
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
  ok(
    'MessagesTab passes titleLines={open ? "none" : 2} to ListRow',
    messagesSource.includes('titleLines={open ? "none" : 2}'),
  );
  const listRowSource = readFileSync(join(ROOT, "frontend/src/components/ui/list-row.tsx"), "utf8");
  ok(
    "ListRow supports titleLines prop defaulting to 2 and allowing none",
    listRowSource.includes("titleLines = 2") && listRowSource.includes('none: ""'),
  );
}

section("F1: optimistic revision on Auto Reply saves and 409 CONFLICT recovery");

{
  equal("0 is a valid Auto Reply revision", isAutoReplyRevision(0), true);
  equal("7 is a valid Auto Reply revision", isAutoReplyRevision(7), true);
  equal("-1 is not a valid revision", isAutoReplyRevision(-1), false);
  equal("1.5 is not a valid revision", isAutoReplyRevision(1.5), false);
  equal("undefined is not a valid revision", isAutoReplyRevision(undefined), false);

  const baseDoc = normalizeAutoReplyConfig({
    schemaVersion: 1,
    enabled: true,
    killSwitch: false,
    globalPerHour: 30,
    scopeMode: "except",
    groupsEnabled: false,
    chats: [],
    excludedChats: [],
    policy: DEFAULT_AUTO_REPLY_POLICY,
    revision: 1,
  });
  equal("normalizeAutoReplyConfig preserves a valid revision", baseDoc.revision, 1);

  const withoutRevision = normalizeAutoReplyConfig({
    schemaVersion: 1,
    enabled: true,
    killSwitch: false,
    globalPerHour: 30,
    scopeMode: "except",
    groupsEnabled: false,
    chats: [],
  });
  equal(
    "normalizeAutoReplyConfig omits revision when runtime did not report one",
    Object.hasOwn(withoutRevision, "revision"),
    false,
  );

  // Tab A saves an exclusion (server moves from revision 1 to 2).
  // Tab B still holds revision 1 and flips groupsEnabled to true.
  let serverDoc = {
    ...baseDoc,
    excludedChats: ["201555555555@s.whatsapp.net"],
    revision: 2,
  };
  const puts = [];
  let loads = 0;

  const put = async (body) => {
    puts.push(body);
    if (body.revision !== serverDoc.revision) {
      const err = new Error("CONFLICT");
      err.code = "CONFLICT";
      throw err;
    }
    serverDoc = {
      ...body,
      revision: serverDoc.revision + 1,
    };
    return serverDoc;
  };
  const load = async () => {
    loads += 1;
    return serverDoc;
  };
  const isConflict = (err) => Boolean(err && err.code === "CONFLICT");

  const toggleOutcome = await saveAutoReplyPatch({
    current: baseDoc, // stale revision 1 with excludedChats: []
    patch: () => ({ groupsEnabled: true }),
    put,
    load,
    isConflict,
  });

  equal("toggle detected conflict and reloaded once", toggleOutcome.reloaded, true);
  equal("load called once on conflict", loads, 1);
  equal("put called twice (initial stale attempt + retry on fresh)", puts.length, 2);
  equal("first put carried stale revision 1", puts[0].revision, 1);
  equal("second put carried reloaded revision 2", puts[1].revision, 2);
  deepEqual(
    "toggle retry preserved Tab A's excludedChats instead of overwriting with stale []",
    toggleOutcome.config.excludedChats,
    ["201555555555@s.whatsapp.net"],
  );
  equal("toggle retry applied groupsEnabled: true", toggleOutcome.config.groupsEnabled, true);
  equal("toggle retry returned new revision 3", toggleOutcome.config.revision, 3);

  // Full-form save on stale revision: reloads without overwriting and reports conflict.
  const staleFormBase = { ...baseDoc, revision: 1 };
  const putCountBeforeForm = puts.length;
  const formConflict = await saveAutoReplyForm({
    current: staleFormBase,
    patch: () => ({ globalPerHour: 99, excludedChats: [] }),
    put,
    load,
    isConflict,
  });

  equal("full-form conflict returns ok: false", formConflict.ok, false);
  if (!formConflict.ok) {
    equal("full-form conflict sets conflict: true", formConflict.conflict, true);
    equal(
      "full-form conflict made only 1 PUT attempt (never overwrites silently)",
      puts.length,
      putCountBeforeForm + 1,
    );
    equal("full-form conflict returns reloaded server revision 3", formConflict.config.revision, 3);
    deepEqual(
      "full-form conflict returns server's excludedChats intact",
      formConflict.config.excludedChats,
      ["201555555555@s.whatsapp.net"],
    );
    equal("server globalPerHour was not overwritten by stale form", serverDoc.globalPerHour, 30);
  }

  // Full-form save with current revision succeeds cleanly.
  const formOk = await saveAutoReplyForm({
    current: serverDoc,
    patch: () => ({ globalPerHour: 75 }),
    put,
    load,
    isConflict,
  });
  equal("up-to-date full-form save returns ok: true", formOk.ok, true);
  equal("up-to-date full-form save updates globalPerHour", formOk.config.globalPerHour, 75);
  equal("up-to-date full-form save increments revision to 4", formOk.config.revision, 4);

  // Round-3 F1 exact scenario:
  // Tab A adds an exclusion; Tab B toggles groups and queues Save during conflict recovery;
  // A's exclusion survives.
  {
    const initialDoc = normalizeAutoReplyConfig({
      schemaVersion: 1,
      enabled: true,
      killSwitch: false,
      globalPerHour: 30,
      scopeMode: "except",
      groupsEnabled: false,
      chats: [],
      excludedChats: [],
      policy: DEFAULT_AUTO_REPLY_POLICY,
      revision: 1,
    });
    let liveServer = structuredClone(initialDoc);
    const serverPuts = [];

    // Both Tab A and Tab B loaded initialDoc (revision 1, excludedChats: []).
    const tabADoc = structuredClone(initialDoc);
    let tabBSavedRef = structuredClone(initialDoc);
    let tabBBaseline = autoReplyFormDataFrom(tabBSavedRef);
    let tabBDraft = {
      ...tabBBaseline,
      globalPerHour: 45, // Tab B has an unsaved form edit built on revision 1
    };
    const tabBQueue = createWriteQueue();

    // Deferred gate to pause Tab B's toggle inside its 409 conflict-recovery reload
    // while Tab B queues a full-form Save.
    let resolveToggleReload;
    const toggleReloadGate = new Promise((resolve) => {
      resolveToggleReload = resolve;
    });
    let notifyToggleEnteredRecovery;
    const toggleEnteredRecovery = new Promise((resolve) => {
      notifyToggleEnteredRecovery = resolve;
    });

    const serverPut = async (body) => {
      serverPuts.push(structuredClone(body));
      if (body.revision !== liveServer.revision) {
        const err = new Error("CONFLICT");
        err.code = "CONFLICT";
        throw err;
      }
      liveServer = normalizeAutoReplyConfig({
        ...body,
        revision: liveServer.revision + 1,
      });
      return structuredClone(liveServer);
    };

    // 1. Tab A adds an exclusion and saves (server moves from revision 1 to 2).
    const tabAExclusion = "201555555555@s.whatsapp.net";
    await serverPut({
      ...tabADoc,
      excludedChats: [tabAExclusion],
    });
    equal("Tab A save moved server to revision 2", liveServer.revision, 2);
    deepEqual("Tab A save stored the exclusion", liveServer.excludedChats, [tabAExclusion]);

    // 2. Tab B toggles groupsEnabled (starts conflict recovery after 409 on revision 1).
    let toggleReloadCount = 0;
    const togglePromise = tabBQueue
      .enqueue(() =>
        saveAutoReplyPatch({
          current: tabBSavedRef,
          patch: () => ({ groupsEnabled: true }),
          put: serverPut,
          load: async () => {
            toggleReloadCount += 1;
            notifyToggleEnteredRecovery();
            await toggleReloadGate;
            return structuredClone(liveServer);
          },
          isConflict,
        }),
      )
      .then(({ config: normalized }) => {
        tabBSavedRef = normalized;
        const prevBaseline = tabBBaseline;
        tabBBaseline = autoReplyFormDataFrom(normalized);
        tabBDraft = reconcileAutoReplyDraft({
          draft: tabBDraft,
          previousBaseline: prevBaseline,
          nextBaseline: tabBBaseline,
          submittedDraft: null,
          conflictReload: false,
        });
        return normalized;
      });

    await toggleEnteredRecovery;
    equal("Tab B toggle hit 409 and entered conflict recovery", toggleReloadCount, 1);

    // 3. While conflict recovery is in flight, Tab B queues a full-form Save.
    // The draft was built on revision 1 (with excludedChats: []).
    const submittedDraftSnapshot = structuredClone(tabBDraft);
    equal("queued Save draft baseRevision is 1", submittedDraftSnapshot.baseRevision, 1);

    const queuedSavePromise = tabBQueue.enqueue(() =>
      saveAutoReplyForm({
        current: tabBSavedRef,
        baseRevision: submittedDraftSnapshot.baseRevision,
        patch: (current) => ({
          scopeMode: submittedDraftSnapshot.scopeMode,
          globalPerHour: submittedDraftSnapshot.globalPerHour,
          chats: submittedDraftSnapshot.chats,
          excludedChats: submittedDraftSnapshot.excludedChats,
          policy: {
            ...submittedDraftSnapshot.policy,
            globalMemory: { read: current.policy?.globalMemory?.read ?? false },
          },
        }),
        put: serverPut,
        load: async () => structuredClone(liveServer),
        isConflict,
      }),
    );

    // Release toggle conflict recovery: toggle reloads rev 2 and saves rev 3 (groupsEnabled: true),
    // then the queued full-form Save runs.
    resolveToggleReload();
    const toggleResult = await togglePromise;
    equal("Tab B toggle succeeded at revision 3", toggleResult.revision, 3);
    equal("Tab B toggle enabled groups", toggleResult.groupsEnabled, true);
    deepEqual("Tab B toggle kept Tab A exclusion", toggleResult.excludedChats, [tabAExclusion]);
    equal(
      "dirty draft kept baseRevision 1 after toggle loaded concurrent form change",
      tabBDraft.baseRevision,
      1,
    );

    const saveOutcome = await queuedSavePromise;
    equal(
      "queued full-form Save bound to baseRevision 1 gets 409 (ok: false)",
      saveOutcome.ok,
      false,
    );
    if (!saveOutcome.ok) {
      equal("queued full-form Save reports conflict: true", saveOutcome.conflict, true);
      equal("queued full-form Save reloads revision 3", saveOutcome.config.revision, 3);
      deepEqual(
        "reloaded config after conflict preserves Tab A exclusion",
        saveOutcome.config.excludedChats,
        [tabAExclusion],
      );
      tabBSavedRef = saveOutcome.config;
      tabBBaseline = autoReplyFormDataFrom(saveOutcome.config);
      tabBDraft = autoReplyFormDataFrom(saveOutcome.config);
    }

    // Verify server state: Tab A's exclusion survived and was never reopened by Tab B's stale draft.
    deepEqual("Tab A's exclusion survives on the server", liveServer.excludedChats, [
      tabAExclusion,
    ]);
    equal("Tab B's toggle survives on the server", liveServer.groupsEnabled, true);
    equal("server globalPerHour was not overwritten by stale save", liveServer.globalPerHour, 30);
    equal("server revision remains 3", liveServer.revision, 3);
    equal("Tab B draft resets to baseRevision 3 after conflict reload", tabBDraft.baseRevision, 3);
    deepEqual("Tab B draft now has Tab A's exclusion", tabBDraft.excludedChats, [tabAExclusion]);
  }

  // Round-4 F1 exact scenario with two toggles:
  // Tab A excludes X; Tab B has a dirty exclusion list built on an older revision and
  // toggles groups; conflict recovery keeps B's old base; B's second toggle does NOT
  // advance B's base revision even though the previous and new server baselines match
  // apart from the toggled field; B's Save gets 409, reloads, and X survives.
  {
    const initialDoc = normalizeAutoReplyConfig({
      schemaVersion: 1,
      enabled: true,
      killSwitch: false,
      globalPerHour: 30,
      scopeMode: "except",
      groupsEnabled: false,
      chats: [],
      excludedChats: [],
      policy: DEFAULT_AUTO_REPLY_POLICY,
      revision: 1,
    });
    let liveServer = structuredClone(initialDoc);
    const tabAExclusion = "201555555555@s.whatsapp.net";
    const tabBDirtyExclusion = "201999999999@s.whatsapp.net";

    const serverPut = async (body) => {
      if (body.revision !== liveServer.revision) {
        const err = new Error("CONFLICT");
        err.code = "CONFLICT";
        throw err;
      }
      liveServer = normalizeAutoReplyConfig({
        ...body,
        revision: liveServer.revision + 1,
      });
      return structuredClone(liveServer);
    };
    const serverLoad = async () => structuredClone(liveServer);

    // Both Tab A and Tab B start at revision 1.
    const tabADoc = structuredClone(initialDoc);
    let tabBSavedRef = structuredClone(initialDoc);
    let tabBBaseline = autoReplyFormDataFrom(tabBSavedRef);
    // Tab B has a dirty exclusion list built on revision 1 (without X).
    let tabBDraft = {
      ...tabBBaseline,
      excludedChats: [tabBDirtyExclusion],
    };

    // 1. Tab A excludes X and saves (server moves from revision 1 to 2).
    await serverPut({
      ...tabADoc,
      excludedChats: [tabAExclusion],
    });
    equal("two-toggle F1: Tab A save moved server to revision 2", liveServer.revision, 2);
    deepEqual("two-toggle F1: Tab A excluded X on server", liveServer.excludedChats, [
      tabAExclusion,
    ]);

    // 2. Tab B's first toggle (groupsEnabled -> true): hits 409 on rev 1, reloads rev 2, saves rev 3.
    const firstToggle = await saveAutoReplyPatch({
      current: tabBSavedRef,
      patch: () => ({ groupsEnabled: true }),
      put: serverPut,
      load: serverLoad,
      isConflict,
    });
    equal("two-toggle F1: first toggle reloaded after conflict", firstToggle.reloaded, true);
    equal(
      "two-toggle F1: first toggle applied over reloaded rev 2",
      firstToggle.appliedBaseRevision,
      2,
    );
    equal("two-toggle F1: first toggle saved revision 3", firstToggle.config.revision, 3);
    tabBSavedRef = firstToggle.config;
    const prevAfterFirst = tabBBaseline;
    tabBBaseline = autoReplyFormDataFrom(firstToggle.config);
    tabBDraft = reconcileAutoReplyDraft({
      draft: tabBDraft,
      previousBaseline: prevAfterFirst,
      nextBaseline: tabBBaseline,
      submittedDraft: null,
      conflictReload: false,
      appliedBaseRevision: firstToggle.appliedBaseRevision,
    });
    equal(
      "two-toggle F1: conflict recovery keeps Tab B's old baseRevision 1",
      tabBDraft.baseRevision,
      1,
    );
    deepEqual(
      "two-toggle F1: Tab B still holds its dirty exclusion list in draft",
      tabBDraft.excludedChats,
      [tabBDirtyExclusion],
    );

    // 3. Tab B's second toggle (groupsEnabled -> false): applied over rev 3, saves rev 4 without conflict.
    // The previous (rev 3) and new (rev 4) server baselines have identical form fields ([X]).
    const secondToggle = await saveAutoReplyPatch({
      current: tabBSavedRef,
      patch: () => ({ groupsEnabled: false }),
      put: serverPut,
      load: serverLoad,
      isConflict,
    });
    equal("two-toggle F1: second toggle succeeded without conflict", secondToggle.reloaded, false);
    equal(
      "two-toggle F1: second toggle applied over revision 3",
      secondToggle.appliedBaseRevision,
      3,
    );
    equal("two-toggle F1: second toggle saved revision 4", secondToggle.config.revision, 4);
    tabBSavedRef = secondToggle.config;
    const prevAfterSecond = tabBBaseline;
    tabBBaseline = autoReplyFormDataFrom(secondToggle.config);
    tabBDraft = reconcileAutoReplyDraft({
      draft: tabBDraft,
      previousBaseline: prevAfterSecond,
      nextBaseline: tabBBaseline,
      submittedDraft: null,
      conflictReload: false,
      appliedBaseRevision: secondToggle.appliedBaseRevision,
    });
    equal(
      "two-toggle F1: second toggle does NOT advance stale draft baseRevision (stays 1, not 4)",
      tabBDraft.baseRevision,
      1,
    );

    // 4. Tab B clicks Save: bound to baseRevision 1, so the server (at rev 4) refuses with 409.
    const saveAfterTwoToggles = await saveAutoReplyForm({
      current: tabBSavedRef,
      baseRevision: tabBDraft.baseRevision,
      patch: (current) => ({
        scopeMode: tabBDraft.scopeMode,
        globalPerHour: tabBDraft.globalPerHour,
        chats: tabBDraft.chats,
        excludedChats: tabBDraft.excludedChats,
        policy: {
          ...tabBDraft.policy,
          globalMemory: { read: current.policy?.globalMemory?.read ?? false },
        },
      }),
      put: serverPut,
      load: serverLoad,
      isConflict,
    });
    equal(
      "two-toggle F1: Tab B's Save is refused with 409 (ok: false)",
      saveAfterTwoToggles.ok,
      false,
    );
    if (!saveAfterTwoToggles.ok) {
      equal("two-toggle F1: Save reports conflict: true", saveAfterTwoToggles.conflict, true);
      equal(
        "two-toggle F1: Save reloads latest revision 4",
        saveAfterTwoToggles.config.revision,
        4,
      );
      deepEqual(
        "two-toggle F1: reloaded config preserves Tab A's exclusion X",
        saveAfterTwoToggles.config.excludedChats,
        [tabAExclusion],
      );
      tabBSavedRef = saveAfterTwoToggles.config;
      tabBBaseline = autoReplyFormDataFrom(saveAfterTwoToggles.config);
      tabBDraft = reconcileAutoReplyDraft({
        draft: tabBDraft,
        previousBaseline: prevAfterSecond,
        nextBaseline: tabBBaseline,
        submittedDraft: null,
        conflictReload: true,
      });
    }
    deepEqual("two-toggle F1: X survives on the server", liveServer.excludedChats, [tabAExclusion]);
    equal("two-toggle F1: server revision remains 4", liveServer.revision, 4);
    equal(
      "two-toggle F1: Tab B draft resets to revision 4 after conflict reload",
      tabBDraft.baseRevision,
      4,
    );
    deepEqual("two-toggle F1: Tab B draft now shows Tab A's exclusion X", tabBDraft.excludedChats, [
      tabAExclusion,
    ]);
  }
}

section("F3: Auto Reply draft reconciliation and per-chat Apply label");

{
  const b0 = autoReplyFormDataFrom(
    normalizeAutoReplyConfig({
      schemaVersion: 1,
      enabled: true,
      killSwitch: false,
      globalPerHour: 30,
      scopeMode: "except",
      groupsEnabled: false,
      chats: [],
      excludedChats: [],
      policy: DEFAULT_AUTO_REPLY_POLICY,
      revision: 1,
    }),
  );

  // 1. User types instructions with trailing whitespace and submits; server trims it.
  const submitted = {
    ...b0,
    policy: { ...b0.policy, instructions: "Be concise.  " },
  };
  const b1 = {
    ...b0,
    policy: { ...b0.policy, instructions: "Be concise." },
  };
  const afterCleanSave = reconcileAutoReplyDraft({
    draft: submitted,
    previousBaseline: b0,
    nextBaseline: b1,
    submittedDraft: submitted,
    conflictReload: false,
  });
  equal(
    "clean save adopts server-trimmed instructions so form is not left dirty",
    afterCleanSave.policy.instructions,
    "Be concise.",
  );

  // 2. If a field changes while a Save is in flight, reconciliation against submittedDraft keeps it.
  const editedDuringSave = {
    ...submitted,
    scopeMode: "all",
  };
  const afterConcurrentEdit = reconcileAutoReplyDraft({
    draft: editedDuringSave,
    previousBaseline: b0,
    nextBaseline: b1,
    submittedDraft: submitted,
    conflictReload: false,
  });
  equal(
    "edit made after submission is preserved when the save response arrives",
    afterConcurrentEdit.scopeMode,
    "all",
  );
  equal(
    "unmodified field adopts the saved baseline",
    afterConcurrentEdit.policy.instructions,
    "Be concise.",
  );

  // 3. On a 409 conflict reload of a full-form save, the draft resets to the reloaded baseline.
  const reloadedBaseline = {
    ...b0,
    baseRevision: 3,
    excludedChats: ["201555555555@s.whatsapp.net"],
    globalPerHour: 45,
  };
  const afterConflictReload = reconcileAutoReplyDraft({
    draft: { ...b0, globalPerHour: 99 },
    previousBaseline: b0,
    nextBaseline: reloadedBaseline,
    submittedDraft: { ...b0, globalPerHour: 99 },
    conflictReload: true,
  });
  deepEqual(
    "conflict reload resets draft to the reloaded server baseline",
    afterConflictReload,
    reloadedBaseline,
  );

  // 4. When a toggle in the same tab bumps revision without changing any form fields,
  // a dirty draft keeps its edits and advances baseRevision to nextBaseline.baseRevision.
  const sameFieldsNewRev = { ...b0, baseRevision: 2 };
  const dirtyDraft = { ...b0, excludedChats: ["201999999999@s.whatsapp.net"] };
  const afterOwnToggle = reconcileAutoReplyDraft({
    draft: dirtyDraft,
    previousBaseline: b0,
    nextBaseline: sameFieldsNewRev,
    submittedDraft: null,
    conflictReload: false,
  });
  equal(
    "own toggle advances dirty draft baseRevision when form fields unchanged",
    afterOwnToggle.baseRevision,
    2,
  );
  deepEqual("own toggle preserves dirty draft exclusions", afterOwnToggle.excludedChats, [
    "201999999999@s.whatsapp.net",
  ]);

  // 5. When a toggle reloads form changes from another tab while this tab has unsaved
  // edits, reconcileAutoReplyDraft never merges list fields silently and keeps the
  // draft's old baseRevision so saving triggers 409 CONFLICT.
  const afterConcurrentToggleReload = reconcileAutoReplyDraft({
    draft: dirtyDraft,
    previousBaseline: b0,
    nextBaseline: reloadedBaseline,
    submittedDraft: null,
    conflictReload: false,
  });
  equal(
    "concurrent form change during toggle keeps draft bound to its original baseRevision",
    afterConcurrentToggleReload.baseRevision,
    1,
  );
  deepEqual(
    "concurrent form change during toggle never silently merges list fields",
    afterConcurrentToggleReload.excludedChats,
    ["201999999999@s.whatsapp.net"],
  );

  // 6. A second toggle after conflict recovery (where previousBaseline and nextBaseline
  // have identical form fields at revisions 3 and 4) still keeps the draft's old
  // baseRevision (1) because 1 !== 3 (the baseline the second toggle was applied over).
  const afterSecondToggleOnStaleDraft = reconcileAutoReplyDraft({
    draft: afterConcurrentToggleReload,
    previousBaseline: reloadedBaseline,
    nextBaseline: { ...reloadedBaseline, baseRevision: 4 },
    submittedDraft: null,
    conflictReload: false,
  });
  equal(
    "second toggle after conflict recovery does not advance stale draft baseRevision",
    afterSecondToggleOnStaleDraft.baseRevision,
    1,
  );
  deepEqual(
    "second toggle after conflict recovery keeps dirty draft exclusions unmerged",
    afterSecondToggleOnStaleDraft.excludedChats,
    ["201999999999@s.whatsapp.net"],
  );

  // Static checks on AutoReplyTab.tsx and AutoReplyChatEditor.tsx
  const autoReplyTabSource = readFileSync(
    join(ROOT, "frontend/src/views/plus/AutoReplyTab.tsx"),
    "utf8",
  );
  ok(
    "AutoReplyTab uses saveAutoReplyPatch for toggles",
    autoReplyTabSource.includes("saveAutoReplyPatch("),
  );
  ok(
    "AutoReplyTab uses saveAutoReplyForm for form saves",
    autoReplyTabSource.includes("saveAutoReplyForm("),
  );
  ok(
    "AutoReplyTab passes baseRevision to saveAutoReplyForm",
    /saveAutoReplyForm\(\{\s*current:\s*savedRef\.current,\s*baseRevision,/.test(
      autoReplyTabSource,
    ),
  );
  ok(
    "AutoReplyTab uses reconcileAutoReplyDraft",
    autoReplyTabSource.includes("reconcileAutoReplyDraft("),
  );
  ok(
    "AutoReplyTab disables draft controls while saving",
    autoReplyTabSource.includes("disabled={formSaving}"),
  );
  ok(
    "AutoReplyTab renders phone-number chat titles through CodeText (LTR), not UserText",
    autoReplyTabSource.includes("isPhoneTitle(peer.title)") &&
      autoReplyTabSource.includes("<CodeText>{peer.title}</CodeText>") &&
      !autoReplyTabSource.includes("title={<UserText>{peer.title}</UserText>}"),
  );

  const chatEditorSource = readFileSync(
    join(ROOT, "frontend/src/views/plus/AutoReplyChatEditor.tsx"),
    "utf8",
  );
  ok(
    "AutoReplyChatEditor labels its draft action with plusAutoReplyApply",
    chatEditorSource.includes('t("plusAutoReplyApply")') && !chatEditorSource.includes('t("save")'),
  );
  ok(
    "AutoReplyChatEditor renders phone-number chat titles through CodeText (LTR), not UserText",
    chatEditorSource.includes("isPhoneTitle(peer.title)") &&
      chatEditorSource.includes("<CodeText>{peer.title}</CodeText>") &&
      !chatEditorSource.includes("title={<UserText>{peer.title}</UserText>}"),
  );

  equal("isPhoneTitle recognizes formatted phone number", isPhoneTitle("+201 000 000 010"), true);
  equal("isPhoneTitle recognizes compact phone number", isPhoneTitle("+201222222222"), true);
  equal("isPhoneTitle rejects contact name", isPhoneTitle("Saved Contact"), false);
  equal("isPhoneTitle rejects group subject", isPhoneTitle("Project Group"), false);
  equal("isPhoneTitle rejects unknown contact fallback", isPhoneTitle("Unknown contact"), false);

  for (const loc of ["en", "ar", "pt-BR", "es-419"]) {
    const catalog = JSON.parse(readFileSync(join(ROOT, "i18n", loc, "dashboard.json"), "utf8"));
    ok(
      `${loc}: plusExtErrorConflict is translated`,
      typeof catalog.plusExtErrorConflict === "string" && catalog.plusExtErrorConflict.length > 0,
    );
    ok(
      `${loc}: plusAutoReplyApply is translated`,
      typeof catalog.plusAutoReplyApply === "string" && catalog.plusAutoReplyApply.length > 0,
    );
  }
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
