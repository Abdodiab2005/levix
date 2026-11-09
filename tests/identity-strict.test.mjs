import { equal, finish, ok, require, section, useTempDataDir } from "./harness.mjs";

useTempDataDir("levix-identity-strict");
const store = require("./src/db/store.cjs");
const { db } = require("./src/db/db.cjs");
const sync = require("./src/utils/permissions.cjs");
await sync.primePermissions();
const perms = await import("../src/utils/permissions.esm.js");
const { resolveSender, resolveVerifiedSender } = await import(
  "../src/middleware/permissions.middleware.js"
);
const { resolveCaller, authorize } = require("./src/services/aiToolAuth.cjs");
const group = require("./src/commands/group.cjs");
const moderation = require("./src/utils/moderationAction.cjs");
const GROUP = "120363075004@g.us";
const PN = "201234567890@s.whatsapp.net";
const LID = "201234567890@lid";
const BOT = "209999999999@s.whatsapp.net";
const MEMBER = "201111111111@s.whatsapp.net";
const sock = {
  user: { id: BOT },
  async groupMetadata() {
    return metadata;
  },
  async groupParticipantsUpdate() {
    return [{ status: "200" }];
  },
};
let metadata = { participants: [{ id: BOT, admin: "admin" }, { id: MEMBER }] };
function msg(id, alt, dm = false) {
  return {
    key: dm
      ? { remoteJid: id, remoteJidAlt: alt, fromMe: false }
      : { remoteJid: GROUP, participant: id, participantAlt: alt, fromMe: false },
    message: { conversation: "!ping" },
  };
}
function reset() {
  store.clearUserMetadata();
  store.clearLidMappings();
  perms.bootstrapOwners([]);
  perms.bootstrapAdmins([]);
}

section("role collisions");
for (const role of ["owner", "admin"]) {
  for (const [holder, stranger] of [
    [PN, LID],
    [LID, PN],
  ]) {
    for (const source of ["database", "bootstrap"]) {
      reset();
      if (source === "database") store.setUserRole(holder, role);
      else if (role === "owner") perms.bootstrapOwners([holder]);
      else perms.bootstrapAdmins([holder]);
      const label = `${role} ${holder} ${source}`;
      ok(`${label}: exact role survives`, perms.isBotAdminUser(holder));
      equal(`${label}: stranger is not owner`, perms.isOwnerJid(stranger), false);
      equal(`${label}: stranger is not bot admin`, sync.isBotAdminUserSync(stranger), false);
      equal(`${label}: store denies owner`, store.isUserOwner(stranger), false);
      equal(`${label}: store denies admin`, store.isUserBotAdmin(stranger), false);
      const resolved = resolveSender(msg(stranger), metadata, sock);
      equal(`${label}: dispatcher denies owner`, resolved.isOwner, false);
      equal(`${label}: dispatcher denies admin`, resolved.isBotAdmin, false);
      const caller = await resolveCaller({ msg: msg(stranger), sock, groupMetadata: metadata });
      equal(
        `${label}: AI owner gate denied`,
        authorize({ command: "perm", role: "owner" }, caller).allowed,
        false,
      );
      equal(
        `${label}: AI bot role gate denied`,
        authorize({ command: "memory", role: "botPrivileged" }, caller).allowed,
        false,
      );
      const nested = group.senderFor(msg(stranger), sock, metadata);
      equal(`${label}: nested denies owner`, nested.isOwner, false);
      equal(`${label}: nested denies admin`, nested.isBotAdmin, false);
      equal(
        `${label}: no kick protection`,
        moderation.isProtectedMember(sock, metadata, [stranger]),
        false,
      );
      const kick = await moderation.kickGroupMember(sock, {
        groupId: GROUP,
        targetCandidates: [MEMBER],
        requesterCandidates: [stranger],
        requesterRule: "nested",
      });
      equal(`${label}: requester cannot kick`, kick.error, "requester-not-admin");
    }
  }
}

section("revocation collisions");
for (const role of ["owner", "admin"]) {
  for (const [holder, stranger] of [
    [PN, LID],
    [LID, PN],
  ]) {
    reset();
    await perms.grantRole(holder, role);
    await perms.revokeRole(stranger, role);
    ok(`${role}: unrelated revoke preserves exact holder`, perms.isBotAdminUser(holder));
  }
}

section("roster and bot collisions");
reset();
for (const [holder, stranger] of [
  [PN, LID],
  [LID, PN],
]) {
  const roster = { participants: [{ id: holder, admin: "admin" }] };
  equal("numeric coincidence is not sameUser", perms.sameUser(holder, stranger), false);
  equal("numeric coincidence is not group admin", perms.isAdminInGroup(roster, stranger), false);
  equal(
    "numeric coincidence has no participant",
    sync.findGroupParticipantSync(roster, stranger),
    null,
  );
  equal("roster fallback keeps namespace", sync.rosterJidForSync(roster, stranger), stranger);
  equal(
    "bot identity does not invent PN",
    perms.isBotAdminInGroup(roster, { user: { id: stranger } }),
    false,
  );
}

section("proven role identities");
for (const role of ["owner", "admin"]) {
  for (const [holder, alias] of [
    [PN, "700000001@lid"],
    ["700000001@lid", PN],
  ]) {
    reset();
    store.setUserRole(holder, role);
    store.storeLidPnMapping("700000001@lid", PN);
    ok("mapped role works in either direction", perms.isBotAdminUser(alias));
    ok(
      "mapped store role works",
      role === "owner" ? store.isUserOwner(alias) : store.isUserBotAdmin(alias),
    );
    ok("device suffix preserves identity", perms.sameUser(holder.replace("@", ":7@"), alias));
    ok("device suffix preserves role", perms.isBotAdminUser(holder.replace("@", ":7@")));
    await perms.revokeRole(alias, role);
    equal("mapped revocation clears role", perms.isBotAdminUser(holder), false);
  }
  reset();
  await perms.grantRole("201234567890", role);
  ok("bare phone grant matches PN", perms.isBotAdminUser(PN));
  for (const dm of [false, true]) {
    const sender = resolveSender(msg("700000002@lid", PN, dm), metadata, sock);
    ok("message alternate proves role without mapping", sender.isOwner || sender.isBotAdmin);
  }
}
const pairedRoster = { participants: [{ id: "700000002@lid", phoneNumber: PN, admin: "admin" }] };
ok("participant object proves admin identity", perms.isAdminInGroup(pairedRoster, PN));
equal(
  "participant object selects roster LID",
  perms.rosterJidFor(pairedRoster, PN),
  "700000002@lid",
);
ok("bare phone and PN share namespace", perms.sameUser("201234567890", PN));

section("roster pairs and live AI rechecks");
const rosterCache = require("./src/utils/groupMetadataCache.cjs");
for (const role of ["owner", "admin"]) {
  reset();
  await perms.grantRole(PN, role);
  const lid = "700000007@lid";
  metadata = {
    participants: [
      { id: BOT, admin: "admin" },
      { id: MEMBER },
      { id: lid, phoneNumber: PN, admin: null },
    ],
  };
  rosterCache.setCached(GROUP, metadata);
  const sender = resolveSender(msg(lid), metadata, sock);
  ok(`${role}: dispatcher accepts roster pair`, sender.isOwner || sender.isBotAdmin);
  const nested = group.senderFor(msg(lid), sock, metadata);
  ok(`${role}: nested accepts roster pair`, nested.isOwner || nested.isBotAdmin);
  ok(
    `${role}: roster pair protects privileged target`,
    moderation.isProtectedMember(sock, metadata, [lid]),
  );
  const kick = await moderation.kickGroupMember(sock, {
    groupId: GROUP,
    targetCandidates: [MEMBER],
    requesterCandidates: [lid],
    requesterRule: "nested",
  });
  ok(`${role}: roster pair admits requester`, kick.kicked);
  const caller = await resolveCaller({ msg: msg(lid), sock, groupMetadata: metadata });
  const access = { command: "memory", role: "botPrivileged" };
  ok(`${role}: AI accepts roster pair`, authorize(access, caller).allowed);
  metadata = { participants: [{ id: BOT, admin: "admin" }, { id: MEMBER }, { id: lid }] };
  rosterCache.setCached(GROUP, metadata);
  equal(`${role}: AI cannot retain removed roster pair`, authorize(access, caller).allowed, false);
}
metadata = { participants: [{ id: BOT, admin: "admin" }, { id: MEMBER }] };
rosterCache.setCached(GROUP, metadata);

section("current mappings and bootstrap");
for (const role of ["owner", "admin"]) {
  reset();
  const oldLid = "700000003@lid";
  const newLid = "700000004@lid";
  store.storeLidPnMapping(oldLid, PN);
  await perms.grantRole(PN, role);
  store.saveUserMetadata({ jid: PN, lid: oldLid });
  const rows = role === "owner" ? store.getAllOwners() : store.getAllBotAdmins();
  const seeded = rows.flatMap((row) => [row.jid, row.lid]);
  if (role === "owner") perms.bootstrapOwners(seeded);
  else perms.bootstrapAdmins(seeded);
  ok("current LID inherits role", perms.isBotAdminUser(oldLid));
  store.storeLidPnMapping(newLid, PN);
  db.prepare("UPDATE lid_mapping SET updated_at=1 WHERE lid=?").run(oldLid);
  db.prepare("UPDATE lid_mapping SET updated_at=2 WHERE lid=?").run(newLid);
  equal("historical LID loses inherited role", perms.isBotAdminUser(oldLid), false);
  equal(
    "historical store lookup denied",
    store.isUserOwner(oldLid) || store.isUserBotAdmin(oldLid),
    false,
  );
  ok("new LID inherits role", perms.isBotAdminUser(newLid));
  const reaction = resolveVerifiedSender(msg(oldLid), metadata, sock);
  equal("reaction owner lookup excludes stale mapping", reaction.isOwner, false);
  equal("reaction admin lookup excludes stale mapping", reaction.isBotAdmin, false);
  equal("historical LID no longer equals phone", perms.sameUser(oldLid, PN), false);
  const target = moderation.targetFromCommand({
    message: {
      extendedTextMessage: {
        contextInfo: { mentionedJid: [oldLid] },
      },
    },
  });
  equal("kick target expansion excludes historical phone", target.candidates.includes(PN), false);
}

section("device and bare PN mappings");
reset();
store.setUserRole(PN, "owner");
store.storeLidPnMapping("700000010:3@lid", PN.replace("@", ":3@"));
ok("device suffixes in mapping match", perms.isOwnerJid("700000010@lid"));
ok("device mapping equivalence is symmetric", perms.sameUser(PN, "700000010@lid"));
reset();
store.setUserRole(PN, "owner");
store.storeLidPnMapping("700000011@lid", "201234567890");
ok("bare PN in mapping matches", perms.isOwnerJid("700000011@lid"));

section("reverse mappings and legacy primaries");
reset();
const historicalLid = "700000008@lid";
store.setUserRole(historicalLid, "owner");
store.storeLidPnMapping(historicalLid, PN);
ok("current phone inherits LID role", perms.isOwnerJid(PN));
store.storeLidPnMapping("700000009@lid", PN);
db.prepare("UPDATE lid_mapping SET updated_at=1 WHERE lid=?").run(historicalLid);
db.prepare("UPDATE lid_mapping SET updated_at=2 WHERE lid=?").run("700000009@lid");
equal("phone no longer inherits historical LID role", perms.isOwnerJid(PN), false);
ok("historical LID keeps its exact grant", perms.isOwnerJid(historicalLid));
reset();
store.setUserRole(PN, "admin");
db.prepare("UPDATE user_metadata SET user_jid=? WHERE user_jid=?").run(PN.replace("@", ":9@"), PN);
ok("device-suffixed legacy primary matches exact normalized PN", store.isUserBotAdmin(PN));
equal("device-suffixed legacy primary never matches LID digits", store.isUserBotAdmin(LID), false);
db.prepare("UPDATE user_metadata SET user_jid=?").run("201234567890");
ok("bare legacy primary matches PN namespace", store.isUserBotAdmin(PN));

section("ambiguous mappings");
reset();
store.setUserRole(PN, "owner");
store.storeLidPnMapping("700000005@lid", PN);
store.storeLidPnMapping("700000006@lid", PN);
db.prepare("UPDATE lid_mapping SET updated_at=1").run();
equal("tied first LID cannot inherit", perms.isOwnerJid("700000005@lid"), false);
equal("tied second LID cannot inherit", perms.isOwnerJid("700000006@lid"), false);
ok("primary identity still has role", perms.isOwnerJid(PN));

section("legacy metadata isolation");
reset();
store.saveUserMetadata({ jid: LID, isOwner: true, isAdmin: true });
db.prepare("UPDATE user_metadata SET phone_number=? WHERE user_jid=?").run("201234567890", LID);
equal("legacy LID phone column does not grant PN owner", store.isUserOwner(PN), false);
equal("legacy LID phone column does not grant PN admin", store.isUserBotAdmin(PN), false);
store.saveUserMetadata({ jid: PN, displayName: "unrelated phone" });
equal("metadata merge does not move owner", store.isUserOwner(PN), false);
equal("metadata merge does not copy admin", store.isUserBotAdmin(PN), false);
ok("original LID role remains", store.isUserOwner(LID));
await perms.revokeRole(PN, "owner");
ok("unrelated revocation leaves LID owner", store.isUserOwner(LID));
reset();
store.saveUserMetadata({ jid: PN, isOwner: true, isAdmin: true });
db.prepare("UPDATE user_metadata SET user_lid=? WHERE user_jid=?").run(LID, PN);
perms.bootstrapOwners(store.getAllOwners().flatMap((row) => [row.jid, row.lid]));
perms.bootstrapAdmins(store.getAllBotAdmins().flatMap((row) => [row.jid, row.lid]));
equal("legacy secondary LID cannot seed bootstrap owner", perms.isOwnerJid(LID), false);
equal("legacy secondary LID cannot seed bootstrap admin", perms.isBotAdminUser(LID), false);
store.saveUserMetadata({ jid: LID, displayName: "unrelated LID" });
equal("legacy secondary LID cannot move primary role", store.isUserOwner(LID), false);
reset();
const lidRecord = store.setUserRole(LID, "admin");
equal("LID grant stores no invented phone", lidRecord.phone, null);

section("delta roster-proven revocation clears DB and bootstrap grants");
const permCommand = require("./src/commands/perm.cjs");
const { runTool } = require("./src/services/aiTools.cjs");
const { timing } = await import("../src/utils/sendBotMessage.esm.js");
const originalSleep = timing.sleep;
timing.sleep = async () => {};
const sent = [];
const commandSock = {
  ...sock,
  async sendMessage(jid, payload) {
    sent.push({ jid, ...payload });
    return { key: { remoteJid: jid, id: `reply-${sent.length}` } };
  },
};
const ACTOR = "202000000075@s.whatsapp.net";
const targetLid = "700000075@lid";
for (const via of ["command", "AI"]) {
  reset();
  await perms.grantRole(ACTOR, "owner");
  await perms.grantRole(PN, "admin");
  store.saveUserMetadata({ jid: targetLid });
  metadata = { participants: [{ id: ACTOR }, { id: targetLid, phoneNumber: PN }] };
  rosterCache.setCached(GROUP, metadata);
  ok(`${via}: roster pair initially has admin`, perms.isBotAdminUser(targetLid, metadata));
  const request = msg(ACTOR);
  request.message = {
    extendedTextMessage: {
      text: "!perm remove admin @target",
      contextInfo: { mentionedJid: [targetLid] },
    },
  };
  if (via === "command") {
    await permCommand.execute(commandSock, request, ["remove", "admin", "@target"], "", metadata);
  } else {
    const caller = await resolveCaller({
      msg: request,
      sock: commandSock,
      groupMetadata: metadata,
    });
    const result = await runTool(
      "revoke_role",
      { target: targetLid, role: "admin" },
      {
        caller,
        sock: commandSock,
      },
    );
    equal("AI reports completed revocation", result.revoked, true);
  }
  for (const id of [PN, targetLid]) {
    equal(`${via}: ${id} no longer privileged`, perms.isBotAdminUser(id, metadata), false);
    equal(
      `${via}: ${id} DB grant cleared`,
      db.prepare("SELECT is_admin FROM user_metadata WHERE user_jid=?").get(id)?.is_admin,
      0,
    );
    equal(`${via}: ${id} bootstrap grant cleared`, perms.getBootstrapAdmins().includes(id), false);
  }
}

section("delta bootstrap retains only verified linked-self secondary identities");
reset();
const selfLid = "700000076@lid";
store.saveUserMetadata({ jid: PN, lid: selfLid, isOwner: true });
store.saveUserMetadata({ jid: ACTOR, lid: targetLid, isOwner: true });
const selfSocket = { user: { id: PN.replace("@", ":4@"), lid: selfLid.replace("@", ":4@") } };
await sync.bootstrapOwners(
  store.getAllOwners().flatMap((row) => [row.jid, row.lid]),
  [selfSocket.user.id, selfSocket.user.lid],
);
ok("verified self LID remains owner without mapping", perms.isOwnerJid(selfLid));
equal("same-digit unrelated LID is not self owner", perms.isOwnerJid(LID), false);
equal("other secondary columns remain filtered", perms.isOwnerJid(targetLid), false);
equal(
  "bootstrap does not create mapping rows",
  db.prepare("SELECT COUNT(*) AS count FROM lid_mapping").get().count,
  0,
);

section("delta five local gates preserve transport and roster proof");
const memoryCommand = require("./src/commands/memory.cjs");
const geminiCommand = require("./src/commands/gemini.cjs");
const langCommand = require("./src/commands/lang.cjs");
const statusCommand = require("./src/commands/status.cjs");
const memoryStore = require("./src/utils/memory.cjs");
const settings = require("./src/config/settings.cjs");
const { withLang } = require("./src/utils/i18n.cjs");
const originalAdd = memoryStore.addMemory;
const originalProbes = statusCommand.probes.gather;
let memoryWrites = 0;
let probeCalls = 0;
memoryStore.addMemory = () => {
  memoryWrites++;
  return { id: "isolated-entry" };
};
statusCommand.probes.gather = async () => {
  probeCalls++;
  return {};
};
try {
  settings.set("bot_language", "ar");
  await langCommand.execute(commandSock, msg(selfLid), ["en"]);
  equal("verified self LID passes lang without fromMe", settings.get("bot_language"), "en");
  for (const name of ["perm", "memory", "gemini", "lang", "status"]) {
    const proofs = ["group alternate", "private alternate", "roster", "collision", "stale roster"];
    for (const proof of proofs) {
      reset();
      await perms.grantRole(PN, "owner");
      const accepted = proof !== "collision" && proof !== "stale roster";
      const sender = proof === "collision" ? LID : "700000077@lid";
      const dm = proof === "private alternate";
      const alternate = proof.includes("alternate") ? PN : undefined;
      const request = msg(sender, alternate, dm);
      metadata = {
        participants: [
          { id: sender, ...(proof.endsWith("roster") ? { phoneNumber: PN } : {}) },
          { id: MEMBER },
        ],
      };
      rosterCache.setCached(GROUP, metadata);
      const ctx = { authGroupMetadata: dm || proof === "stale roster" ? null : metadata };
      sent.length = 0;
      if (name === "perm") {
        request.message = {
          extendedTextMessage: {
            text: "!perm add owner @member",
            contextInfo: { mentionedJid: [MEMBER] },
          },
        };
        await permCommand.execute(
          commandSock,
          request,
          ["add", "owner", "@member"],
          "",
          metadata,
          ctx,
        );
        equal(`${name} ${proof}: owner grant gate`, store.isUserOwner(MEMBER), accepted);
      } else if (name === "memory") {
        const before = memoryWrites;
        await memoryCommand.execute(
          commandSock,
          request,
          ["add", "global", "fact"],
          "",
          metadata,
          ctx,
        );
        equal(`${name} ${proof}: global write gate`, memoryWrites - before, accepted ? 1 : 0);
      } else if (name === "gemini") {
        store.saveChatHistory(request.key.remoteJid, [
          { role: "user", parts: [{ text: "sentinel" }] },
        ]);
        await geminiCommand.execute(commandSock, request, ["del"], "", metadata, ctx);
        equal(
          `${name} ${proof}: history deletion gate`,
          store.getChatHistory(request.key.remoteJid).length,
          accepted ? 0 : 1,
        );
      } else if (name === "lang") {
        settings.set("bot_language", "ar");
        await langCommand.execute(commandSock, request, ["en"], "", metadata, ctx);
        equal(
          `${name} ${proof}: setting gate`,
          settings.get("bot_language"),
          accepted ? "en" : "ar",
        );
      } else {
        const before = probeCalls;
        await withLang("en", () =>
          statusCommand.execute(commandSock, request, ["debug"], "", metadata, ctx),
        );
        equal(`${name} ${proof}: debug gate`, probeCalls - before, accepted ? 1 : 0);
      }
    }
  }
} finally {
  timing.sleep = originalSleep;
  memoryStore.addMemory = originalAdd;
  statusCommand.probes.gather = originalProbes;
}

finish();
