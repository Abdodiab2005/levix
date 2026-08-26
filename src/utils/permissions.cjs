// CommonJS shim around permissions.esm.js.
//
// Same gotcha as sendBotMessage.cjs: we can't `require` the ESM module
// directly, so we lazy-import on first call and cache the bindings.
//
// To avoid making every call site async (a lot of legacy .cjs commands are
// synchronous in their permission gates), we also expose **synchronous**
// variants `isOwnerJidSync` / `isAdminInGroupSync`. Those rely on a snapshot
// of the ESM module that we eagerly populate during connection bootstrap by
// calling `primePermissions()` once. If the snapshot isn't ready yet the sync
// variant falls back to the conservative `false` so we never grant a
// permission we can't verify.

const logger = require("./logger.cjs");

let mod = null;

async function getMod() {
  if (mod) return mod;
  mod = await import("./permissions.esm.js");
  return mod;
}

/** Eagerly load the ESM module so the sync variants below can use it. */
async function primePermissions() {
  try {
    await getMod();
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] prime failed");
  }
}

function isOwnerJidSync(jid) {
  if (!mod) return false;
  try {
    return mod.isOwnerJid(jid);
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] isOwnerJidSync failed");
    return false;
  }
}

function isBotAdminUserSync(jid) {
  if (!mod) return false;
  try {
    return mod.isBotAdminUser(jid);
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] isBotAdminUserSync failed");
    return false;
  }
}

function hasBotPrivilegesSync(jid) {
  if (!mod) return false;
  try {
    return mod.hasBotPrivileges(jid);
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] hasBotPrivilegesSync failed");
    return false;
  }
}

function isAdminInGroupSync(groupMetadata, jid) {
  if (!mod) return false;
  try {
    return mod.isAdminInGroup(groupMetadata, jid);
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] isAdminInGroupSync failed");
    return false;
  }
}

function isBotAdminInGroupSync(groupMetadata, sock) {
  if (!mod) return false;
  try {
    return mod.isBotAdminInGroup(groupMetadata, sock);
  } catch (err) {
    logger.error({ err }, "[permissions.cjs] isBotAdminInGroupSync failed");
    return false;
  }
}

function sameUserSync(a, b) {
  if (!mod) return false;
  try {
    return mod.sameUser(a, b);
  } catch {
    return false;
  }
}

async function isOwnerJid(jid) {
  const m = await getMod();
  return m.isOwnerJid(jid);
}

async function isAdminInGroup(groupMetadata, jid) {
  const m = await getMod();
  return m.isAdminInGroup(groupMetadata, jid);
}

async function isBotAdminInGroup(groupMetadata, sock) {
  const m = await getMod();
  return m.isBotAdminInGroup(groupMetadata, sock);
}

async function bootstrapOwners(values) {
  const m = await getMod();
  return m.bootstrapOwners(values);
}

async function addBootstrapOwner(value) {
  const m = await getMod();
  return m.addBootstrapOwner(value);
}

async function isBotAdminUser(jid) {
  const m = await getMod();
  return m.isBotAdminUser(jid);
}

async function grantRole(target, role) {
  const m = await getMod();
  return m.grantRole(target, role);
}

async function revokeRole(target, role) {
  const m = await getMod();
  return m.revokeRole(target, role);
}

async function listRoles() {
  const m = await getMod();
  return m.listRoles();
}

module.exports = {
  primePermissions,
  isOwnerJid,
  isAdminInGroup,
  isBotAdminInGroup,
  bootstrapOwners,
  addBootstrapOwner,
  isBotAdminUser,
  grantRole,
  revokeRole,
  listRoles,
  isOwnerJidSync,
  isBotAdminUserSync,
  hasBotPrivilegesSync,
  isAdminInGroupSync,
  isBotAdminInGroupSync,
  sameUserSync,
};
