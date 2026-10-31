const store = require("../db/store.cjs");
const { isLinkedCreds } = require("../utils/linkedCreds.cjs");
const { normalizedLid, normalizedPn } = require("../stickers/owner.cjs");

function readPairedAccount() {
  let creds;
  try { creds = JSON.parse(store.authRead("creds") || "null"); }
  catch { return null; }
  if (!isLinkedCreds(creds)) return null;
  const candidateLid = normalizedLid(creds.me.lid);
  const candidatePn = normalizedPn(creds.me.id);
  const lid = /^\d{1,32}@lid$/.test(candidateLid || "") ? candidateLid : null;
  const pn = /^\d{5,20}@s\.whatsapp\.net$/.test(candidatePn || "") ? candidatePn : null;
  return lid || pn ? { lid, pn } : null;
}

function maskAccount(account) {
  if (!account?.pn) return account ? "WhatsApp account" : null;
  const digits = account.pn.split("@")[0];
  return `+${digits.slice(0, 2)} ••• ••• ••${digits.slice(-2)}`;
}

function accountsMatch(backupAccount, pairedAccount) {
  if (!backupAccount || !pairedAccount) return false;
  if (backupAccount.lid && pairedAccount.lid) return backupAccount.lid === pairedAccount.lid;
  return !backupAccount.lid && !!backupAccount.pn && backupAccount.pn === pairedAccount.pn;
}

module.exports = { readPairedAccount, maskAccount, accountsMatch };
