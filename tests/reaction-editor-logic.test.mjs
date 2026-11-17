import {
  ORIGINAL_TYPES,
  draftFromRule,
  draftToWrite,
  emptyReactionDraft,
  isReactionEmoji,
  issueBucket,
  peerLabel,
  reactionDraftIssues,
} from "../frontend/src/utils/reactionRules.ts";
import { equal, finish, ok, section, throws } from "./harness.mjs";

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
  const voice = { ...payload.definition, action: "stt", originalTypes: ["voice"] };
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
    reactionDraftIssues({ ...draft, emoji: value }).some((issue) => issue.field === "definition.emoji"),
  );
}

section("empty message types and transitions are errors in their own sections");
{
  const issues = reactionDraftIssues({ ...draft, originalTypes: [], transitions: [] });
  equal(
    "both sections need attention",
    issues.map((issue) => issueBucket(issue.field)).sort().join(","),
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
  ]) equal(`bucket ${field}`, issueBucket(field), bucket);
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

finish();
