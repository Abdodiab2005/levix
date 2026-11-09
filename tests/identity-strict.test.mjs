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

finish();
