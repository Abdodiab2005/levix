// Centralized role and WhatsApp identity checks. Numeric equality across the
// LID and PN namespaces is never evidence of identity.
import normalizeJid from "./normalizeJid.esm.js";
import { createRequire } from "node:module";
import {
  isUserBotAdmin as dbIsBotAdmin,
  isUserOwner as dbIsOwner,
  getAllBotAdmins,
  getAllOwners,
  setUserRole,
} from "./storage.esm.js";

const require = createRequire(import.meta.url);
const { roleIdentityAliases } = require("../db/store.cjs");

// Two rosters, same mechanics:
//   owners      — full access, including OWNER_ONLY commands
//   bot admins  — treated as an admin in every chat (group admin OR this role
//                 satisfies ADMINS_ONLY / ADMINS_OWNER), but not OWNER_ONLY
const bootstrap = new Set();
const bootstrapAdminSet = new Set();

function pushInto(set, value) {
  const norm = identityForms(value)[0];
  if (norm) set.add(norm);
}

// Connection bootstrap passes primary JIDs plus legacy user_lid columns.
// Do not freeze a secondary column into an independent grant. Current mapping
// aliases are resolved at check time, and unverified contact links grant nothing.
function replaceBootstrap(set, values, listAll) {
  set.clear();
  if (!Array.isArray(values)) return;
  const secondary = new Set();
  const primary = new Set();
  try {
    for (const row of listAll()) {
      const jid = identityForms(row.jid)[0];
      const lid = identityForms(row.lid)[0];
      if (jid) primary.add(jid);
      if (lid && lid !== jid && values.some((value) => identityForms(value)[0] === jid)) {
        secondary.add(lid);
      }
    }
  } catch {
    return; // A bootstrap list may contain unverified contact aliases.
  }
  for (const value of values) {
    const norm = identityForms(value)[0];
    if (!secondary.has(norm) || primary.has(norm)) pushInto(set, value);
  }
}

function pushBootstrap(value) {
  pushInto(bootstrap, value);
}

/**
 * Replace the bootstrap owner set. Pass an array of JIDs/LIDs/phones; we
 * normalize and de-dupe them.
 */
export function bootstrapOwners(values) {
  replaceBootstrap(bootstrap, values, getAllOwners);
}

/** Add an owner to the bootstrap set (does not touch the DB). */
export function addBootstrapOwner(value) {
  pushBootstrap(value);
}

export function getBootstrapOwners() {
  return [...bootstrap];
}

/** Same as bootstrapOwners, for the bot-admin roster. */
export function bootstrapAdmins(values) {
  replaceBootstrap(bootstrapAdminSet, values, getAllBotAdmins);
}

export function addBootstrapAdmin(value) {
  pushInto(bootstrapAdminSet, value);
}

export function getBootstrapAdmins() {
  return [...bootstrapAdminSet];
}

/** Exact normalized identity and its current authoritative mapping only. */
function identityForms(jid) {
  if (!jid) return [];
  try {
    return roleIdentityAliases(jid);
  } catch {
    // A failed mapping read cannot establish another identity.
    const norm = normalizeJid(jid);
    return norm?.includes("@") ? [norm] : [];
  }
}

function hasRole(jid, { set, dbCheck }, groupMetadata) {
  const forms = new Set(identityForms(jid));
  // A transport roster object carrying both forms is proof even before the
  // mapping table learns the pair. Never consult user_metadata aliases here.
  const participant = findGroupParticipant(groupMetadata, jid);
  for (const id of participantIds(participant)) {
    for (const form of identityForms(id)) forms.add(form);
  }
  for (const form of forms) {
    if (set.has(form)) return true;
    try {
      if (dbCheck(form)) return true;
    } catch {}
  }
  return false;
}

/** Owner check by exact primary identity or verified current mapping. */
export function isOwnerJid(jid, groupMetadata) {
  return hasRole(jid, { set: bootstrap, dbCheck: dbIsOwner }, groupMetadata);
}

/**
 * Bot-level admin role. This is NOT "admin of this WhatsApp group" — it is a
 * role the operator grants (`!perm add admin @user`, the dashboard, or by asking
 * the AI) that makes the user an admin everywhere the bot works.
 * Owners always pass.
 */
export function isBotAdminUser(jid, groupMetadata) {
  if (isOwnerJid(jid, groupMetadata)) return true;
  return hasRole(
    jid,
    {
      set: bootstrapAdminSet,
      dbCheck: dbIsBotAdmin,
    },
    groupMetadata,
  );
}

/** Owner or bot-admin — "this person may drive the bot". */
export function hasBotPrivileges(jid, groupMetadata) {
  return isOwnerJid(jid, groupMetadata) || isBotAdminUser(jid, groupMetadata);
}

/**
 * Grant a bot-level role and make it effective immediately (DB + in-memory
 * roster, so the very next message already sees it).
 *
 * @param {string} target - JID / LID / bare phone
 * @param {"owner"|"admin"} role
 * @returns {object|null} the stored user record
 */
export function grantRole(target, role = "admin") {
  const wanted = String(role).toLowerCase() === "owner" ? "owner" : "admin";
  const record = setUserRole(target, wanted, true);
  if (wanted === "owner") addBootstrapOwner(record?.jid || target);
  else addBootstrapAdmin(record?.jid || target);
  return record;
}

/**
 * Revoke a bot-level role and remove its proven aliases from the bootstrap
 * set so the revocation takes effect without a restart.
 *
 * @returns {object|null} the stored user record
 */
export function revokeRole(target, role = "admin") {
  const wanted = String(role).toLowerCase() === "owner" ? "owner" : "admin";
  const record = setUserRole(target, wanted, false);

  const forms = identityForms(target);
  const set = wanted === "owner" ? bootstrap : bootstrapAdminSet;
  for (const form of forms) {
    set.delete(form);
  }
  return record;
}

/** Everyone currently holding a bot-level role. */
export function listRoles() {
  let owners = [];
  let admins = [];
  try {
    owners = getAllOwners();
  } catch {}
  try {
    admins = getAllBotAdmins();
  } catch {}
  return {
    owners,
    admins,
    bootstrapOwners: getBootstrapOwners(),
    bootstrapAdmins: getBootstrapAdmins(),
  };
}

/**
 * Exact identity (including bare PN/device suffix forms) or a current mapping.
 */
export function sameUser(a, b) {
  if (!a || !b) return false;
  const forms = identityForms(a);
  const other = identityForms(b)[0];
  return Boolean(other) && forms.includes(other);
}

/**
 * Check whether `jid` is admin in the given group metadata.
 * Compares using sameUser so LID/PN mismatches don't fool us.
 *
 * v7/LID note: a group participant can expose the user under several fields —
 * `id` (LID or PN, whichever is preferred), plus `lid` and `phoneNumber`. We
 * match `jid` against ALL of them so admin detection works whether the caller
 * hands us a LID or a PN, even before the lid_mapping table is populated.
 */
export function participantIds(participant) {
  if (!participant) return [];
  return [participant.id, participant.lid, participant.phoneNumber, participant.jid].filter(
    Boolean,
  );
}

export function isAdminInGroup(groupMetadata, jid) {
  if (!groupMetadata?.participants || !jid) return false;
  const target = normalizeJid(jid);
  return groupMetadata.participants.some((p) => {
    if (!["admin", "superadmin"].includes(p.admin)) return false;
    return participantIds(p).some((pid) => normalizeJid(pid) === target || sameUser(pid, jid));
  });
}

/**
 * The group-roster row for this person, matching LID / PN / phone across
 * `id`, `lid`, `phoneNumber` and `jid`.
 */
export function findGroupParticipant(groupMetadata, jidOrList) {
  const targets = (Array.isArray(jidOrList) ? jidOrList : [jidOrList]).filter(Boolean);
  if (!groupMetadata?.participants || !targets.length) return null;
  return (
    groupMetadata.participants.find((p) =>
      participantIds(p).some((pid) => targets.some((target) => sameUser(pid, target))),
    ) || null
  );
}

/**
 * The JID WhatsApp expects in `groupParticipantsUpdate` — the roster `id`,
 * not the mention / sender form which may be the other of LID vs PN.
 */
export function rosterJidFor(groupMetadata, jidOrList) {
  const found = findGroupParticipant(groupMetadata, jidOrList);
  if (found?.id) return found.id;
  const targets = (Array.isArray(jidOrList) ? jidOrList : [jidOrList]).filter(Boolean);
  return normalizeJid(targets[0]) || targets[0] || null;
}

/** Every identifier we know for the linked WhatsApp account. */
export function botIdentityCandidates(sock) {
  const raw = [sock?.user?.id, sock?.user?.lid].filter(Boolean);
  const out = [];
  for (const value of raw) {
    for (const form of identityForms(value)) {
      if (!out.includes(form)) out.push(form);
    }
  }
  return out;
}

/**
 * Check whether the bot itself is admin in the group. We check both the
 * bot's PN and its LID (and lid_mapping aliases) since either form may be
 * stored on the participant.
 */
export function isBotAdminInGroup(groupMetadata, sock) {
  if (!groupMetadata?.participants || !sock) return false;
  return botIdentityCandidates(sock).some((candidate) => isAdminInGroup(groupMetadata, candidate));
}

/**
 * Resolve the sender's identifier from a Baileys message, normalized.
 * Used by callers that previously did this themselves with subtle bugs.
 */
export function getSenderId(msg, sock) {
  if (!msg) return null;
  if (msg.key?.fromMe && sock?.user?.id) return normalizeJid(sock.user.id);
  if (msg.key?.remoteJid?.endsWith("@g.us")) {
    return normalizeJid(msg.key.participant);
  }
  return normalizeJid(msg.key?.remoteJid);
}

/**
 * Resolve EVERY identifier that could refer to the sender, normalized and
 * de-duped. Baileys v7 delivers both a LID and its PN alternate on the message
 * key (`participant` + `participantAlt` in groups, `remoteJid` + `remoteJidAlt`
 * in DMs, plus the older `participantPn`/`senderPn` variants). Owner/admin
 * checks should try all of them so a member listed by PN is still recognised
 * when they message under a LID (and vice-versa) — without waiting for the
 * lid_mapping table to fill in.
 */
export function getSenderCandidates(msg, sock) {
  if (!msg) return [];
  const key = msg.key || {};

  let raw;
  if (key.fromMe) {
    raw = [sock?.user?.id, sock?.user?.lid];
  } else if (key.remoteJid?.endsWith("@g.us")) {
    raw = [key.participant, key.participantAlt, key.participantPn, key.senderPn];
  } else {
    raw = [key.remoteJid, key.remoteJidAlt, key.senderPn];
  }

  const seen = new Set();
  const out = [];
  for (const value of raw) {
    const norm = normalizeJid(value);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
  }
  return out;
}
