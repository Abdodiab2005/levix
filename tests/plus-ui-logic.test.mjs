import {
  createWriteQueue,
  getDraftText,
  samplePlaceholderValue,
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

finish();
