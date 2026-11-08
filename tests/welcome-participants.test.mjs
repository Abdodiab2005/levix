// The welcome path on Baileys rc14.
//
// rc14 emits `group-participants.update` participants as objects
// ({ id, phoneNumber?, lid?, username?, admin }, Socket/messages-recv.js:637-645),
// not the bare JID strings older builds sent. src/handlers/group.handler.js used
// to call participant.split("@") in the welcome loop, which threw for an object;
// the catch swallowed it, so no welcome message went out. `group.join-request`
// also changed shape (participant/action instead of type/jid/from).
//
// These checks send the real rc14 shapes through a fake socket and read what
// would have reached WhatsApp.

import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-welcome-participants");

const store = require("./src/db/store.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const { handleGroupParticipantsUpdate, handleGroupJoinRequests } = await import(
  "../src/handlers/group.handler.js"
);

const WELCOME_GROUP = "120363000000007001@g.us";
const REQUEST_GROUP = "120363000000007002@g.us";

const LID_A = "200000000000001@lid";
const PN_A = "100000000000001@s.whatsapp.net";
const LID_B = "200000000000002@lid";
const PN_B = "100000000000002@s.whatsapp.net";
const PN_C = "100000000000003@s.whatsapp.net";
const PN_D = "100000000000004@s.whatsapp.net";

store.saveGroupSettings(WELCOME_GROUP, {
  welcome_system: { enabled: true, messages: ["Hi ${user}"] },
});
store.saveGroupSettings(REQUEST_GROUP, {
  join_requests: { auto_approve_enabled: true },
});

function makeSock() {
  const sent = [];
  const approvals = [];
  const sock = {
    async sendMessage(jid, payload) {
      sent.push({ jid, ...payload });
      return {};
    },
    // rc14's method: groupRequestParticipantsUpdate(jid, participants[], action)
    async groupRequestParticipantsUpdate(jid, participants, action) {
      approvals.push({ jid, participants: [...participants], action });
    },
  };
  return { sock, sent, approvals };
}

function userOf(jid) {
  return jid.split("@")[0];
}

section("rc14 participant objects reach the welcome message");
{
  const { sock, sent } = makeSock();

  await withLang("en", () =>
    handleGroupParticipantsUpdate(sock, {
      id: WELCOME_GROUP,
      participants: [
        { id: LID_A, phoneNumber: PN_A, admin: null },
        { id: PN_B, lid: LID_B },
        PN_C,
        // rc14 always sets id; an entry without one is not addressable.
        { phoneNumber: PN_D },
      ],
      action: "add",
    }),
  );

  equal("one welcome per usable participant", sent.length, 3);
  equal("every message goes to the group", sent[0]?.jid, WELCOME_GROUP);

  ok(
    "a LID object greets the object's id, not its phoneNumber",
    sent[0]?.text?.startsWith(`Hi @${userOf(LID_A)}`),
    sent[0]?.text,
  );
  equal(
    "a LID object is mentioned by id",
    JSON.stringify(sent[0]?.mentions),
    JSON.stringify([LID_A]),
  );

  ok(
    "a PN participant greets its PN id even when lid is present",
    sent[1]?.text?.startsWith(`Hi @${userOf(PN_B)}`),
    sent[1]?.text,
  );
  equal(
    "a PN participant is mentioned by PN id",
    JSON.stringify(sent[1]?.mentions),
    JSON.stringify([PN_B]),
  );

  ok(
    "a legacy string participant keeps working",
    sent[2]?.text?.startsWith(`Hi @${userOf(PN_C)}`),
    sent[2]?.text,
  );
  equal(
    "a legacy string is mentioned as-is",
    JSON.stringify(sent[2]?.mentions),
    JSON.stringify([PN_C]),
  );

  ok(
    "an object without an id is skipped, not greeted",
    sent.every((message) => !message.text?.includes(userOf(PN_D))),
  );
}

section("an entry with no usable id never throws out of the handler");
{
  const { sock, sent } = makeSock();
  let thrown = null;
  try {
    await withLang("en", () =>
      handleGroupParticipantsUpdate(sock, {
        id: WELCOME_GROUP,
        participants: [{ phoneNumber: PN_A, lid: LID_A }, null, "not-a-jid-but-a-string"],
        action: "add",
      }),
    );
  } catch (error) {
    thrown = error;
  }
  equal("no exception escapes", thrown, null);
  equal("only the string entry is welcomed", sent.length, 1);
  equal(
    "the string entry's mention is its own value",
    sent[0]?.mentions?.[0],
    "not-a-jid-but-a-string",
  );
}

section("rc14 group.join-request payloads auto-approve");
{
  const { sock, sent, approvals } = makeSock();

  await withLang("en", () =>
    handleGroupJoinRequests(sock, [
      // The exact rc14 shape (Utils/process-message.js:496).
      {
        id: REQUEST_GROUP,
        author: LID_B,
        participant: LID_A,
        participantPn: PN_A,
        action: "created",
        method: "invite_link",
      },
      // The requester as an object: read through the same accessor.
      { id: REQUEST_GROUP, author: LID_B, participant: { id: LID_B }, action: "created" },
      // The older shape stays working.
      { type: "request", jid: REQUEST_GROUP, from: PN_B },
      // A revoked/rejected request is not an approval.
      { id: REQUEST_GROUP, participant: LID_A, action: "revoked" },
    ]),
  );

  equal("three pending requests are approved", approvals.length, 3);
  equal("rc14 approves the LID participant", approvals[0]?.participants?.[0], LID_A);
  equal("the action is approve", approvals[0]?.action, "approve");
  equal("an object participant is read through id", approvals[1]?.participants?.[0], LID_B);
  equal("the legacy shape still approves", approvals[2]?.participants?.[0], PN_B);
  equal("the legacy request is addressed to its group", approvals[2]?.jid, REQUEST_GROUP);

  equal("each approval replies once", sent.length, 3);
  ok(
    "the approval reply names the member",
    sent[0]?.text?.includes(`@${userOf(LID_A)}`),
    sent[0]?.text,
  );
  equal(
    "the approval reply mentions the member",
    JSON.stringify(sent[0]?.mentions),
    JSON.stringify([LID_A]),
  );
}

section("auto-approve off changes nothing");
{
  const groupId = "120363000000007003@g.us";
  store.saveGroupSettings(groupId, { join_requests: { auto_approve_enabled: false } });
  const { sock, sent, approvals } = makeSock();
  await withLang("en", () =>
    handleGroupJoinRequests(sock, [
      { id: groupId, participant: LID_A, action: "created", method: "invite_link" },
    ]),
  );
  equal("no approval is sent", approvals.length, 0);
  equal("no reply is sent", sent.length, 0);
}

section("a single rc14 event object is accepted");
{
  // 'group.join-request' emits one object; the old event emitted an array.
  const { sock, sent, approvals } = makeSock();
  let thrown = null;
  try {
    await withLang("en", () =>
      handleGroupJoinRequests(sock, {
        id: REQUEST_GROUP,
        author: LID_B,
        participant: LID_A,
        participantPn: PN_A,
        action: "created",
        method: "linked_group_join",
      }),
    );
  } catch (error) {
    thrown = error;
  }
  equal("no exception escapes", thrown, null);
  equal("the single event is approved", approvals.length, 1);
  equal(
    "the approved participant is the rc14 participant field",
    approvals[0]?.participants?.[0],
    LID_A,
  );
  equal("the reply goes to this one request's group", sent.length, 1);
}

finish();
