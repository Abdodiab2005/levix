// What a restore changes on this install. The preview builds the plan from the
// digests in the backup manifest; the restore job builds it again from the
// staged rows, so a crafted manifest cannot hide a change. Both use buildPlan.
//
// A restore only adds and replaces. A setting, an API key or the persona that
// the backup does not contain keeps its current value here. A change that
// overwrites a value this install already has is destructive and needs an
// explicit confirmation from the operator.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { db } = require("../db/db.cjs");
const settings = require("../config/settings.cjs");
const { dataPath } = require("../config/paths.cjs");
const { ACCOUNT_TABLES, RESTORABLE_BOT_KEYS } = require("./content.cjs");
const { readPairedAccount, maskAccount, accountsMatch } = require("./account.cjs");

const digest = (text) => crypto.createHash("sha256").update(String(text)).digest("hex");

/** Digests of the restorable bot_settings rows and of the plain API key values. */
function digestsFrom(rows, secretValues = {}) {
  const result = { settings: {}, apiKeys: {} };
  for (const { key, value } of rows) {
    if (RESTORABLE_BOT_KEYS.includes(key)) result.settings[key] = digest(value);
  }
  for (const [name, value] of Object.entries(secretValues)) {
    if (settings.SECRET_SETTING_KEYS.includes(name)) result.apiKeys[name] = digest(value);
  }
  return result;
}

function restorableRows(database) {
  const keys = RESTORABLE_BOT_KEYS;
  return database.prepare(
    `SELECT key, value FROM bot_settings WHERE key IN (${keys.map(() => "?").join(",")})`,
  ).all(...keys);
}

function currentDigests() {
  const apiKeys = {};
  for (const name of settings.SECRET_SETTING_KEYS) {
    if (settings.sourceOf(name) !== "dashboard") continue;
    const value = settings.get(name);
    if (value) apiKeys[name] = digest(value);
  }
  return { settings: digestsFrom(restorableRows(db)).settings, apiKeys };
}

function compare(source, target) {
  const result = { added: [], replaced: [], removed: [], unchanged: [], kept: [] };
  for (const [key, hash] of Object.entries(source)) {
    if (!Object.hasOwn(target, key)) result.added.push(key);
    else if (target[key] === hash) result.unchanged.push(key);
    else result.replaced.push(key);
  }
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) result.kept.push(key);
  for (const list of Object.values(result)) list.sort();
  return result;
}

function personaChange(backupSha) {
  let current = null;
  try { current = digest(fs.readFileSync(dataPath("ai-persona.md"))); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!backupSha) return current ? "kept" : "none";
  if (!current) return "added";
  return current === backupSha ? "unchanged" : "replaced";
}

function hasAccountData() {
  for (const table of ACCOUNT_TABLES) {
    if (db.prepare(`SELECT 1 AS x FROM "${table}" LIMIT 1`).get()) return true;
  }
  const memoryRoot = dataPath("memory");
  const walk = (folder) => {
    let entries;
    try { entries = fs.readdirSync(folder, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    return entries.some((entry) => entry.isDirectory()
      ? walk(path.join(folder, entry.name)) : entry.name.endsWith(".md"));
  };
  return walk(memoryRoot);
}

function waitingAccount() {
  try {
    return JSON.parse(fs.readFileSync(dataPath("restore", "pending", "pending.json"), "utf8")).account ?? null;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * @param {object} input
 * @param {{settings: object, apiKeys: object} | null} input.digests source digests, null when unknown
 * @param {string[]} input.apiKeyNames names of the API keys in the backup
 * @param {string | null} input.personaSha sha256 of the backup's persona.md, null when absent
 * @param {{lid: string|null, pn: string|null} | null} input.account the backup's WhatsApp account
 */
function buildPlan({ digests, apiKeyNames = [], personaSha = null, account = null }) {
  const current = currentDigests();
  const exact = Boolean(digests);
  const settingsPlan = exact ? compare(digests.settings, current.settings)
    : { added: [], replaced: [], removed: [], unchanged: [], kept: [] };
  const apiKeySource = exact ? digests.apiKeys
    : Object.fromEntries(apiKeyNames.map((name) => [name, null]));
  const apiKeys = compare(apiKeySource, current.apiKeys);
  const persona = personaChange(personaSha);
  let accountData = null;
  if (account) {
    const paired = readPairedAccount();
    const waiting = waitingAccount();
    accountData = {
      replacesCurrent: Boolean(paired && accountsMatch(account, paired) && hasAccountData()),
      replacesWaiting: waiting ? maskAccount(waiting) : null,
    };
  }
  const destructive = !exact || settingsPlan.replaced.length > 0 || apiKeys.replaced.length > 0 ||
    settingsPlan.removed.length > 0 || apiKeys.removed.length > 0 ||
    persona === "replaced" || Boolean(accountData?.replacesCurrent || accountData?.replacesWaiting);
  return { exact, destructive, settings: settingsPlan, apiKeys, persona, accountData };
}

/**
 * The plan of a restore that has run inside an open transaction: before and
 * after are currentDigests() on each side of it, source the backup's digests.
 * A value that changed only as a side effect (a capability guard that turns
 * speech or vision off) counts as replaced, so it needs confirmation too.
 */
function appliedPlan({ before, after, source, base }) {
  const section = (was, now, from) => {
    const result = { added: [], replaced: [], removed: [], unchanged: [], kept: [] };
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      const had = Object.hasOwn(was, key);
      const has = Object.hasOwn(now, key);
      if (!had) result.added.push(key);
      else if (!has) result.removed.push(key);
      else if (was[key] !== now[key]) result.replaced.push(key);
      else if (Object.hasOwn(from, key)) result.unchanged.push(key);
      else result.kept.push(key);
    }
    for (const list of Object.values(result)) list.sort();
    return result;
  };
  const settingsPlan = section(before.settings, after.settings, source.settings);
  const apiKeys = section(before.apiKeys, after.apiKeys, source.apiKeys);
  const destructive = [settingsPlan, apiKeys].some((part) => part.replaced.length + part.removed.length > 0) ||
    base.persona === "replaced" || Boolean(base.accountData?.replacesCurrent || base.accountData?.replacesWaiting);
  return { exact: true, destructive, settings: settingsPlan, apiKeys, persona: base.persona, accountData: base.accountData };
}

/** The plan as the panel sees it: names only, never a value or a digest. */
function publicPlan(plan) {
  const names = (list) => list.map((key) => key.startsWith("setting:") ? key.slice(8) : key);
  const section = (part) => ({ added: names(part.added), replaced: names(part.replaced),
    removed: names(part.removed), unchanged: part.unchanged.length, kept: names(part.kept) });
  return { exact: plan.exact, destructive: plan.destructive, settings: section(plan.settings),
    apiKeys: section(plan.apiKeys), persona: plan.persona, accountData: plan.accountData };
}

module.exports = { digest, digestsFrom, restorableRows, currentDigests, buildPlan, appliedPlan, publicPlan };
