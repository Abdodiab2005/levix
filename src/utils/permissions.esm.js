// Centralized permissions module.
//
// Until now, owner detection was scattered across at least five places, each
// using a slightly different (and mutually inconsistent) check:
//   * permissions.middleware.js  — DB lookup + config.owners + fromMe
//   * group.cjs                  — config.owners only (always empty)
//   * group/media.cjs            — config.owners on a `{}` parameter (throws!)
//   * group/antilink.cjs         — same as media.cjs
//   * antispam.middleware.js     — a legacy owner mirror (only the bot itself)
//   * gemini.cjs                 — display-name match (fragile)
//
// This module is the single source of truth. It exposes:
//
//   bootstrapOwners(list)
//     Called once at connection time with the bot's own JID/LID plus every
//     owner already recorded in user_metadata. Stored in a Set so subsequent
//     checks are O(1) and don't hit the database on the hot path.
//
//   isOwnerJid(jidOrLidOrPhone)
//     Checks every direction we know about:
//       - bootstrap set
//       - user_metadata table (is_owner = 1) by jid, lid, or phone
//       - cross-format: if given a LID, look up its PN and recheck; vice versa
//       - phone-digit fallback (handles `:XX` device suffixes etc.)
//
//   isAdminInGroup(groupMetadata, jid)
//     LID/PN-aware admin check.
//
//   isBotAdminInGroup(groupMetadata, sock)
//     Same idea for the bot itself.
//
//   sameUser(a, b)
//     True if two identifiers refer to the same person (LID/PN/phone equiv).

import normalizeJid, {
  isLidJid,
  isPnJid,
} from "./normalizeJid.esm.js";
import {
  getAllOwners,
  getAllBotAdmins,
  isUserOwner as dbIsOwner,
  isUserBotAdmin as dbIsBotAdmin,
  setUserRole,
  getLidForPn,
  getPnForLid,
} from "./storage.esm.js";

// Two rosters, same mechanics:
//   owners      — full access, including OWNER_ONLY commands
//   bot admins  — treated as an admin in every chat (group admin OR this role
//                 satisfies ADMINS_ONLY / ADMINS_OWNER), but not OWNER_ONLY
const bootstrap = new Set();
const bootstrapAdminSet = new Set();

function digitsOnly(value) {
  if (!value) return null;
  const m = String(value).match(/\d+/);
  return m ? m[0] : null;
}

function pushInto(set, value) {
  if (!value) return;
  const norm = normalizeJid(value);
  if (norm) set.add(norm);
  const phone = digitsOnly(value);
  if (phone) {
    set.add(`${phone}@s.whatsapp.net`);
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
  bootstrap.clear();
  if (!Array.isArray(values)) return;
  values.forEach(pushBootstrap);
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
  bootstrapAdminSet.clear();
  if (!Array.isArray(values)) return;
  values.forEach((value) => pushInto(bootstrapAdminSet, value));
}

export function addBootstrapAdmin(value) {
  pushInto(bootstrapAdminSet, value);
}

export function getBootstrapAdmins() {
  return [...bootstrapAdminSet];
}

/**
 * Every identifier that could stand for the same person: the normalized form,
 * its LID/PN counterpart, and the bare-phone JID. Both role checks walk this
 * list so a user granted a role by phone still matches when they message under
 * a LID (and vice-versa).
 */
function identityForms(jid) {
  const forms = [];
  const push = (value) => {
    const norm = normalizeJid(value);
    if (norm && !forms.includes(norm)) forms.push(norm);
  };

  const norm = normalizeJid(jid);
  if (!norm) return forms;
  push(norm);

  if (isLidJid(norm)) {
    try {
      push(getPnForLid(norm));
    } catch {}
  }
  if (isPnJid(norm)) {
    try {
      push(getLidForPn(norm));
    } catch {}
  }

  const phone = digitsOnly(norm);
  if (phone) push(`${phone}@s.whatsapp.net`);

  return forms;
}

/**
 * Shared role resolution: bootstrap set, then the DB, then a phone-digit walk
 * over the stored roster (covers rows saved with only a phone or only a LID).
 */
function hasRole(jid, { set, dbCheck, listAll }) {
  if (!jid) return false;
  const forms = identityForms(jid);
  if (!forms.length) return false;

  for (const form of forms) {
    if (set.has(form)) return true;
    try {
      if (dbCheck(form)) return true;
    } catch {}
  }

  const phone = digitsOnly(forms[0]);
  if (phone) {
    try {
      for (const entry of listAll()) {
        const entryPhone =
          digitsOnly(entry.phone) ||
          digitsOnly(entry.jid) ||
          digitsOnly(entry.lid);
        if (entryPhone && entryPhone === phone) return true;
      }
    } catch {}
  }

  return false;
}

/**
 * Comprehensive owner check (bootstrap set + user_metadata + LID/PN
 * cross-lookup + phone-digit fallback).
 */
export function isOwnerJid(jid) {
  return hasRole(jid, {
    set: bootstrap,
    dbCheck: dbIsOwner,
    listAll: getAllOwners,
  });
}

/**
 * Bot-level admin role. This is NOT "admin of this WhatsApp group" — it is a
 * role the operator grants (`!perm add admin @user`, the dashboard, or by asking
 * the AI) that makes the user an admin everywhere the bot works.
 * Owners always pass.
 */
export function isBotAdminUser(jid) {
  if (isOwnerJid(jid)) return true;
  return hasRole(jid, {
    set: bootstrapAdminSet,
    dbCheck: dbIsBotAdmin,
    listAll: getAllBotAdmins,
  });
}

/** Owner or bot-admin — "this person may drive the bot". */
export function hasBotPrivileges(jid) {
  return isOwnerJid(jid) || isBotAdminUser(jid);
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
 * Revoke a bot-level role. The in-memory roster is rebuilt from what's left so
 * a revoked user stops matching without a restart.
 *
 * @returns {object|null} the stored user record
 */
export function revokeRole(target, role = "admin") {
  const wanted = String(role).toLowerCase() === "owner" ? "owner" : "admin";
  const record = setUserRole(target, wanted, false);

  const forms = identityForms(record?.jid || target);
  const set = wanted === "owner" ? bootstrap : bootstrapAdminSet;
  for (const form of forms) {
    set.delete(form);
    const phone = digitsOnly(form);
    if (phone) set.delete(`${phone}@s.whatsapp.net`);
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
 * True if the two identifiers refer to the same physical user — handles LID
 * vs PN vs phone-with-device-suffix confusion.
 */
export function sameUser(a, b) {
  if (!a || !b) return false;
  const na = normalizeJid(a);
  const nb = normalizeJid(b);
  if (na === nb) return true;
  const da = digitsOnly(na);
  const db = digitsOnly(nb);
  if (da && db && da === db) return true;
  // Cross-format lookup
  try {
    if (isLidJid(na)) {
      const pn = getPnForLid(na);
      if (pn && normalizeJid(pn) === nb) return true;
    }
    if (isLidJid(nb)) {
      const pn = getPnForLid(nb);
      if (pn && normalizeJid(pn) === na) return true;
    }
    if (isPnJid(na)) {
      const lid = getLidForPn(na);
      if (lid && normalizeJid(lid) === nb) return true;
    }
    if (isPnJid(nb)) {
      const lid = getLidForPn(nb);
      if (lid && normalizeJid(lid) === na) return true;
    }
  } catch {}
  return false;
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
export function isAdminInGroup(groupMetadata, jid) {
  if (!groupMetadata?.participants || !jid) return false;
  const target = normalizeJid(jid);
  return groupMetadata.participants.some((p) => {
    if (!["admin", "superadmin"].includes(p.admin)) return false;
    const participantIds = [p.id, p.lid, p.phoneNumber, p.jid].filter(Boolean);
    return participantIds.some(
      (pid) => normalizeJid(pid) === target || sameUser(pid, jid)
    );
  });
}

/**
 * Check whether the bot itself is admin in the group. We check both the
 * bot's PN and its LID since either form may be stored on the participant.
 */
export function isBotAdminInGroup(groupMetadata, sock) {
  if (!groupMetadata?.participants || !sock) return false;
  const candidates = [sock.user?.id, sock.user?.lid].filter(Boolean);
  for (const candidate of candidates) {
    if (isAdminInGroup(groupMetadata, candidate)) return true;
  }
  return false;
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
