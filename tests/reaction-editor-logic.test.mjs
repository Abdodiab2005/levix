import {
  DEFAULT_REACTION_COMMANDS,
  ORIGINAL_TYPES,
  buildCommandPickerItems,
  classifyReactionCommand,
  draftFromRule,
  draftToWrite,
  emptyReactionDraft,
  formatCommandToken,
  isReactionEmoji,
  issueBucket,
  peerLabel,
  quoteNoteKey,
  reactionDraftIssues,
  resolveSenderMode,
  selectReactionCommand,
  selectSenderMode,
  unsupportedReasonKey,
  validateReactionCommandArgs,
} from "../frontend/src/utils/reactionRules.ts";
import { equal, finish, ok, require, section, throws } from "./harness.mjs";

const { listReactionCommands, validateArgs } = require("./src/automation/commandEligibility.cjs");

const allTypes = ["text", "voice", "audio", "image", "video", "document", "sticker"];
const selected = ["text", "image"];
const draft = {
  ...emptyReactionDraft(),
  chatJid: "201000000001-1600000000@g.us",
  chatName: "Family",
  emoji: "👍🏽",
  action: "ping",
  originalTypes: [...selected],
};
const stored = (definition) => ({
  chatJid: draft.chatJid,
  chatName: draft.chatName,
  priority: draft.priority,
  definition,
});

section("new drafts require an action and offer all seven message types");
{
  const fresh = emptyReactionDraft();
  equal("action starts unset", fresh.action, "");
  equal("all types selected", JSON.stringify(fresh.originalTypes), JSON.stringify(allTypes));
  equal(
    "supported type catalog stays at seven",
    JSON.stringify(ORIGINAL_TYPES),
    JSON.stringify(allTypes),
  );
  ok(
    "unset action is a client error",
    reactionDraftIssues(fresh).some((issue) => issue.field === "definition.action"),
  );
  throws("unset action cannot become an API payload", () => draftToWrite(fresh));
  fresh.originalTypes.pop();
  equal("draft selections are independent", emptyReactionDraft().originalTypes.length, 7);
}

section("STT constrains the payload while preserving the Ping selection");
{
  const before = JSON.stringify(draft);
  const voiceDraft = { ...draft, action: "stt" };
  equal(
    "STT writes voice only",
    JSON.stringify(draftToWrite(voiceDraft).definition.originalTypes),
    '["voice"]',
  );
  equal(
    "STT leaves the selection intact",
    JSON.stringify(voiceDraft.originalTypes),
    JSON.stringify(selected),
  );
  equal(
    "returning to Ping restores the subset",
    JSON.stringify(draftToWrite({ ...voiceDraft, action: "ping" }).definition.originalTypes),
    JSON.stringify(selected),
  );
  equal("writing never mutates the draft", JSON.stringify(draft), before);
  const payload = draftToWrite(draft);
  payload.definition.originalTypes.push("video");
  equal(
    "payload types are an independent copy",
    JSON.stringify(draft.originalTypes),
    JSON.stringify(selected),
  );
}

section("stored message types round-trip without silently expanding");
{
  const payload = draftToWrite(draft);
  const loaded = draftFromRule(stored(payload.definition));
  equal(
    "Ping loads text and image unchanged",
    JSON.stringify(loaded.originalTypes),
    JSON.stringify(selected),
  );
  equal(
    "Ping round-trips the full write",
    JSON.stringify(draftToWrite(loaded)),
    JSON.stringify(payload),
  );
  const voice = {
    ...payload.definition,
    command: { name: "stt", args: [] },
    originalTypes: ["voice"],
  };
  delete voice.action;
  equal(
    "STT keeps stored voice",
    JSON.stringify(draftFromRule(stored(voice)).originalTypes),
    '["voice"]',
  );
  equal(
    "even an invalid stored STT subset stays visible in the draft",
    JSON.stringify(draftFromRule(stored({ ...voice, originalTypes: selected })).originalTypes),
    JSON.stringify(selected),
  );
  for (const originalTypes of [undefined, [], ["unsupported"]]) {
    equal(
      "Ping with no valid types falls back to all",
      JSON.stringify(draftFromRule(stored({ ...payload.definition, originalTypes })).originalTypes),
      JSON.stringify(allTypes),
    );
    equal(
      "STT with no valid types falls back to voice",
      JSON.stringify(draftFromRule(stored({ ...voice, originalTypes })).originalTypes),
      '["voice"]',
    );
  }
}

section("emoji uses one grapheme and accepts compound emoji");
for (const value of ["👍🏽", "❤️", "👨‍👩‍👧", "🇪🇬", "#️⃣"]) {
  equal(`accept ${value}`, isReactionEmoji(value), true);
  equal(
    `valid emoji passes client checks: ${value}`,
    reactionDraftIssues({ ...draft, emoji: value }).length,
    0,
  );
}
for (const value of ["👍h", "hi", "👍👍", "", " 👍", "👍 "]) {
  equal(`reject ${JSON.stringify(value)}`, isReactionEmoji(value), false);
  ok(
    `invalid emoji blocks submit: ${JSON.stringify(value)}`,
    reactionDraftIssues({ ...draft, emoji: value }).some(
      (issue) => issue.field === "definition.emoji",
    ),
  );
}

section("empty message types and transitions are errors in their own sections");
{
  const issues = reactionDraftIssues({ ...draft, originalTypes: [], transitions: [] });
  equal(
    "both sections need attention",
    issues
      .map((issue) => issueBucket(issue.field))
      .sort()
      .join(","),
    "originalTypes,transitions",
  );
  equal(
    "STT can run without changing the retained type selection",
    reactionDraftIssues({ ...draft, action: "stt", originalTypes: [] }).length,
    0,
  );
  for (const [field, bucket] of [
    ["chatJid", "chatJid"],
    ["definition.emoji", "emoji"],
    ["definition.originalTypes", "originalTypes"],
    ["definition.senders.ids", "senders"],
    ["definition.destination.mode", "destination"],
  ])
    equal(`bucket ${field}`, issueBucket(field), bucket);
}

section("unknown peer labels never display raw WhatsApp identifiers");
equal("unnamed legacy group has no raw fallback", peerLabel(draft.chatJid), "");
equal("unnamed LID has no raw fallback", peerLabel("123@lid"), "");
equal("phone numbers are readable", peerLabel("201000000001@s.whatsapp.net"), "+201000000001");
equal(
  "known names remain available",
  peerLabel(draft.chatJid, new Map([[draft.chatJid, "Family"]])),
  "Family",
);

section(
  "command picker lists all commands and keeps unsupported commands visible and disabled with a reason",
);
{
  const serverCatalog = listReactionCommands(null, "en");
  equal(
    "client fallback catalog covers every server command",
    DEFAULT_REACTION_COMMANDS.length,
    serverCatalog.length,
  );
  const items = buildCommandPickerItems(serverCatalog, "", "!");
  equal("picker keeps every command visible", items.length, serverCatalog.length);
  const supported = items.filter((item) => !item.disabled);
  const unsupported = items.filter((item) => item.disabled);
  ok("picker has supported commands", supported.length > 0);
  ok("picker has unsupported commands", unsupported.length > 0);
  for (const item of unsupported) {
    equal(`${item.key} is unsupported`, item.mode, "unsupported");
    ok(`${item.key} has a translated reason key`, Boolean(item.reasonKey));
    equal(`${item.key} token uses prefix`, item.token, formatCommandToken(item.name, "!"));
  }
  const expectedReasons = {
    SESSION_OR_ACCOUNT_ACTION: "reactionReasonSessionOrAccount",
    SETTINGS_CHANGE: "reactionReasonSettingsChange",
    DURABLE_JOB: "reactionReasonDurableJob",
    WRAPPER: "reactionReasonWrapper",
    KNOWN_DEFECT: "reactionReasonKnownDefect",
    NOT_IN_5_0_1: "reactionReasonNotIn501",
    REQUESTER_SCOPE: "reactionReasonRequesterScope",
    UNCLASSIFIED: "reactionReasonUnsupported",
    FUTURE_UNKNOWN_CODE: "reactionReasonUnsupported",
  };
  for (const [code, key] of Object.entries(expectedReasons)) {
    equal(`reason code ${code} maps to ${key}`, unsupportedReasonKey(code), key);
  }
  const searchBlock = buildCommandPickerItems(serverCatalog, "block", "/");
  ok(
    "searching for an unsupported command still shows it disabled",
    searchBlock.some((item) => item.key === "block" && item.disabled && item.token === "/block"),
  );
  equal(
    "selecting an unsupported command is ignored",
    selectReactionCommand(draft, "block", serverCatalog).action,
    "ping",
  );
  ok(
    "unsupported command in draft reports its reason code",
    reactionDraftIssues({ ...draft, action: "block" }, serverCatalog).some(
      (issue) =>
        issue.field === "definition.command.name" && issue.code === "SESSION_OR_ACCOUNT_ACTION",
    ),
  );
  equal("command.name buckets to action", issueBucket("definition.command.name"), "action");
  equal("command.args buckets to args", issueBucket("definition.command.args"), "args");
}

section("legacy role is shown as custom; Selected participants requires at least one person");
{
  for (const senders of [
    { role: "bot_admin", ids: [] },
    { role: "member", ids: [] },
    { role: "owner", ids: ["1001@lid"] },
    { role: "group_admin", ids: ["201000000002@s.whatsapp.net"] },
  ]) {
    const loaded = draftFromRule(
      stored({
        version: 2,
        emoji: "👍🏽",
        transitions: ["add"],
        originalTypes: ["text"],
        senders,
        command: { name: "ping", args: [] },
        destination: { mode: "same_chat" },
      }),
    );
    equal(
      `legacy ${senders.role}+${senders.ids.length} loads as custom`,
      resolveSenderMode(loaded),
      "custom",
    );
    equal(
      `untouched custom ${senders.role} preserves stored senders on write`,
      JSON.stringify(draftToWrite(loaded).definition.senders),
      JSON.stringify(senders),
    );
    const switched = selectSenderMode(loaded, "owner_group_admin");
    equal(
      "picking a standard choice leaves custom",
      resolveSenderMode(switched),
      "owner_group_admin",
    );
    equal(
      "picking a standard choice clears ids and sets role",
      JSON.stringify(draftToWrite(switched).definition.senders),
      JSON.stringify({ role: "owner_group_admin", ids: [] }),
    );
  }

  const emptySelected = selectSenderMode(draft, "selected");
  equal("selected mode with no ids is selected", resolveSenderMode(emptySelected), "selected");
  ok(
    "Selected participants with zero people fails validation",
    reactionDraftIssues(emptySelected).some(
      (issue) => issue.field === "definition.senders.ids" && issue.code === "required",
    ),
  );
  throws("Selected participants with zero people cannot write", () => draftToWrite(emptySelected));

  const withPerson = { ...emptySelected, senderIds: ["1001@lid"] };
  equal(
    "Selected participants with one person is valid",
    reactionDraftIssues(withPerson).length,
    0,
  );
  equal(
    "Selected participants writes role any with ids",
    JSON.stringify(draftToWrite(withPerson).definition.senders),
    JSON.stringify({ role: "any", ids: ["1001@lid"] }),
  );
  const reloadedSelected = draftFromRule(stored(draftToWrite(withPerson).definition));
  equal(
    "reloaded role any + ids is selected mode",
    resolveSenderMode(reloadedSelected),
    "selected",
  );
}

section("destructive command locks transitions to add; originalTypes preselect and cannot widen");
{
  const multiTransition = { ...draft, transitions: ["add", "change", "remove"] };
  const kickDraft = selectReactionCommand(multiTransition, "group:kick");
  equal(
    "picking group:kick locks transitions to add",
    JSON.stringify(kickDraft.transitions),
    '["add"]',
  );
  equal(
    "writing group:kick forces add transition",
    JSON.stringify(
      draftToWrite({ ...kickDraft, transitions: ["add", "remove"] }).definition.transitions,
    ),
    '["add"]',
  );
  ok(
    "non-add transition on destructive command fails client check",
    reactionDraftIssues({ ...kickDraft, transitions: ["add", "remove"] }).some(
      (issue) => issue.field === "definition.transitions" && issue.code === "add_only",
    ),
  );
  const storedKick = draftFromRule(
    stored({
      version: 2,
      emoji: "👍🏽",
      transitions: ["add", "remove"],
      originalTypes: ["text"],
      senders: { role: "owner", ids: [] },
      command: { name: "group:kick", args: [] },
      destination: { mode: "same_chat" },
    }),
  );
  equal(
    "loading destructive rule locks transitions to add",
    JSON.stringify(storedKick.transitions),
    '["add"]',
  );

  const toimageDraft = selectReactionCommand(draft, "toimage");
  equal(
    "picking toimage preselects sticker only",
    JSON.stringify(toimageDraft.originalTypes),
    '["sticker"]',
  );
  ok(
    "widening toimage beyond sticker is rejected",
    reactionDraftIssues({ ...toimageDraft, originalTypes: ["sticker", "text"] }).some(
      (issue) => issue.field === "definition.originalTypes",
    ),
  );

  equal(
    "new draft defaults allowOthersOnLinkedMessages to false",
    emptyReactionDraft().allowOthersOnLinkedMessages,
    false,
  );
  const linkedAllowed = draftToWrite({ ...draft, allowOthersOnLinkedMessages: true });
  equal(
    "enabled allowOthersOnLinkedMessages writes true",
    linkedAllowed.definition.allowOthersOnLinkedMessages,
    true,
  );
  equal(
    "loaded rule preserves allowOthersOnLinkedMessages true",
    draftFromRule(stored(linkedAllowed.definition)).allowOthersOnLinkedMessages,
    true,
  );

  equal("stt quote note", quoteNoteKey(classifyReactionCommand("stt")), "reactionQuoteVoice");
  equal(
    "toimage quote note",
    quoteNoteKey(classifyReactionCommand("toimage")),
    "reactionQuoteSticker",
  );
  equal(
    "kick quote note",
    quoteNoteKey(classifyReactionCommand("group:kick")),
    "reactionQuoteTargetAuthor",
  );
  equal("calc quote note", quoteNoteKey(classifyReactionCommand("calc")), "reactionQuoteMessage");
  equal(
    "gemini quote note",
    quoteNoteKey(classifyReactionCommand("gemini")),
    "reactionQuoteMessage",
  );
  equal("ping has no quote note", quoteNoteKey(classifyReactionCommand("ping")), null);
}

section("args validation mirrors the server rules in commandEligibility.cjs");
{
  const vectors = [
    ["ping", []],
    ["ping", ["extra"]],
    ["setprefix", ["!"]],
    ["stt", []],
    ["stt", ["ar"]],
    ["gemini", ["Summarize this message"]],
    ["gemini", ["ask what time is it"]],
    ["gemini", [""]],
    ["gemini", []],
    ["gemini", ["line 1\nline 2"]],
    ["gemini", ["x".repeat(2001)]],
    ["gemini", ["add something"]],
    ["gemini", ["send"]],
    ["gemini", ["show"]],
    ["gemini", ["clear"]],
    ["gemini", ["del"]],
    ["gemini", ["delall"]],
    ["gemini", ["resetai"]],
    ["gemini", ["generate a cat"]],
    ["gemini", ["Add uppercase"]],
    ["group:note", ["#rules_1"]],
    ["group:note", ["rules_1"]],
    ["group:note", ["#"]],
    ["group:note", [`#${"a".repeat(41)}`]],
    ["group:note", [""]],
    ["weather", ["Cairo"]],
    ["weather", [""]],
    ["weather", ["Cairo\nEgypt"]],
    ["weather", ["x".repeat(81)]],
    ["prayer", ["Alexandria"]],
    ["prayer", [""]],
    ["qr", ["https://levix.leviro.net"]],
    ["qr", [""]],
    ["qr", ["x".repeat(501)]],
    ["translate", []],
    ["translate", [""]],
    ["translate", ["en"]],
    ["translate", ["x".repeat(33)]],
    ["mod", ["status"]],
    ["mod", ["other"]],
    ["mod", [""]],
    ["block", []],
    ["group:promote", []],
    ["unknowncmd", []],
  ];
  for (const [cmd, args] of vectors) {
    const client = validateReactionCommandArgs(cmd, args);
    const server = validateArgs(cmd, args);
    equal(`args ok parity for ${cmd} ${JSON.stringify(args)}`, client.ok, server.ok);
    equal(
      `args errors parity for ${cmd} ${JSON.stringify(args)}`,
      JSON.stringify(client.errors),
      JSON.stringify(server.errors),
    );
  }
}

finish();
