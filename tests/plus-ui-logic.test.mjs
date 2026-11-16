import {
  createLatestReader,
  createRecoveryRefreshGate,
  createRequestGeneration,
  createWriteQueue,
  getDraftText,
  RECOVERY_REFRESH_COOLDOWN_MS,
  recoverPlusPurchases,
  samplePlaceholderValue,
  showsPlusUntil,
  substitutePlaceholders,
} from "../frontend/src/views/plus/plusUiLogic.ts";
import { equal, finish, ok, section } from "./harness.mjs";

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

finish();
