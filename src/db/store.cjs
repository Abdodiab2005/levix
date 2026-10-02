// The bot's view of the database.
//
// Every read and every write in here is synchronous, because SQLite is
// synchronous and so are the ~40 call sites that use it — the anti-spam and
// blacklist middleware, the prefix lookup, every permission check all run
// inline on the per-message path with no `await` in sight.
//
// There is no cache and no write-behind queue: a query against a local SQLite
// file is a function call, not a round trip. What you read is what is on disk.
//
// The file itself, the schema and the migrations are in src/db/db.cjs.
//
// This module is CommonJS on purpose: both the CJS command files and the ESM
// handlers need the *same* singleton, and only a CJS module can be required
// synchronously from both sides.

const logger = require("../utils/logger.cjs");
const normalizeJid = require("../utils/normalizeJid.cjs");
const { db, q, parseJson, sweepExpired, checkpoint, DB_PATH } = require("./db.cjs");

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_FORWARD_TTL_DAYS = 30;

// ===================================================================
// --- Lifecycle ---
// ===================================================================
//
// The database is opened the moment db.cjs is required, so there is nothing
// to await. These exist because the rest of the codebase calls them; they now
// do the housekeeping the boot sequence needs: sweep, and report.

let sweepTimer = null;

function migrateSecretsAtRest() {
  const vault = require("../config/vault.cjs");
  const rows = q("SELECT key, value FROM baileys_auth").all();
  for (const row of rows) {
    if (row.value && !vault.isSealed(row.value)) {
      q("UPDATE baileys_auth SET value = ? WHERE key = ?").run(vault.seal(row.value), row.key);
    }
  }

  let secretKeys = [];
  try {
    secretKeys = require("../config/settings.cjs").SECRET_SETTING_KEYS || [];
  } catch {
    secretKeys = [];
  }
  for (const key of secretKeys) {
    const stored = getBotSetting(`setting:${key}`, null);
    if (typeof stored === "string" && stored && !vault.isSealed(stored)) {
      saveBotSetting(`setting:${key}`, vault.seal(stored));
    }
  }
}

async function initStore() {
  sweepExpired();
  try {
    // Stale sticker uploads and half-finished conversions from a crash.
    // The timer lives in uploads.cjs; this is the boot pass.
    require("../stickers/uploads.cjs").sweepStale();
  } catch (err) {
    logger.error({ err }, "[Store] sticker temp sweep failed");
  }
  try {
    migrateSecretsAtRest();
  } catch (err) {
    logger.error({ err }, "[Store] Failed to encrypt existing secrets at rest");
  }
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepExpired, 6 * 60 * 60 * 1000);
    sweepTimer.unref();
  }
  logger.info(
    `[Store] SQLite ready at ${DB_PATH} — ${countGroups()} group(s), ` +
      `${countUsers()} user(s), ${countNotes()} note(s), ${countLidMappings()} LID mapping(s)`,
  );
}

/** Nothing is ever in flight, but shutdown paths call this. Flush the WAL. */
async function flushStore() {
  checkpoint();
}

function isStoreReady() {
  return true;
}

/** Kept for the dashboard's health card. Always zero now. */
function pendingWrites() {
  return 0;
}

// ===================================================================
// --- Helpers ---
// ===================================================================

function digitsOf(value) {
  const match = String(value || "").match(/\d{5,}/);
  return match ? match[0] : null;
}

const bool = (value) => (value ? 1 : 0);

/** Forward-score retention. Read at call time so the dashboard can change it. */
function forwardExpiry() {
  let days = DEFAULT_FORWARD_TTL_DAYS;
  try {
    days = require("../config/settings.cjs").get("forward_score_ttl_days");
  } catch {
    // settings.cjs reads through this module; during its own load we take the
    // default rather than recursing.
  }
  return Date.now() + Number(days || DEFAULT_FORWARD_TTL_DAYS) * DAY_MS;
}

// ===================================================================
// --- Bot settings ---
// ===================================================================
//
// One table for the prefix, everything the dashboard saves ("setting:*"), the
// permission / alias / disabled override maps, and the generated secrets.
// Values are JSON, so an object or an array round-trips as itself.

function getBotSetting(key, defaultValue = null) {
  const row = q("SELECT value FROM bot_settings WHERE key = ?").get(key);
  if (!row) return defaultValue;
  const value = parseJson(row.value, undefined);
  return value === undefined ? defaultValue : value;
}

function saveBotSetting(key, value) {
  q(
    `INSERT INTO bot_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, JSON.stringify(value ?? null));
}

function deleteBotSetting(key) {
  q("DELETE FROM bot_settings WHERE key = ?").run(key);
}

// ===================================================================
// --- Group settings ---
// ===================================================================

function getGroupSettings(groupId) {
  const row = q("SELECT settings FROM group_settings WHERE group_id = ?").get(groupId);
  return row ? parseJson(row.settings, {}) : {};
}

function saveGroupSettings(groupId, settings) {
  q(
    `INSERT INTO group_settings (group_id, settings) VALUES (?, ?)
     ON CONFLICT(group_id) DO UPDATE SET settings = excluded.settings`,
  ).run(groupId, JSON.stringify(settings || {}));
}

function getAllGroupSettings() {
  return q("SELECT group_id, settings FROM group_settings")
    .all()
    .map((row) => ({
      group_id: row.group_id,
      settings: parseJson(row.settings, {}),
    }));
}

function countGroups() {
  return q("SELECT COUNT(*) AS n FROM group_settings").get().n;
}

function upsertGroupDirectory(groupId, { subject = null, participantCount = null } = {}) {
  if (!groupId) return;
  const existing = q(
    "SELECT subject, participant_count FROM group_directory WHERE group_id = ?",
  ).get(groupId);
  q(
    `INSERT INTO group_directory (group_id, subject, participant_count, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(group_id) DO UPDATE SET
       subject = COALESCE(excluded.subject, group_directory.subject),
       participant_count = COALESCE(excluded.participant_count, group_directory.participant_count),
       updated_at = excluded.updated_at`,
  ).run(
    groupId,
    subject || existing?.subject || null,
    participantCount == null ? (existing?.participant_count ?? null) : participantCount,
    Date.now(),
  );
}

function getGroupDirectory(groupId) {
  return q(
    "SELECT group_id, subject, participant_count, updated_at FROM group_directory WHERE group_id = ?",
  ).get(groupId);
}

function getAllGroupDirectory() {
  return q(
    "SELECT group_id, subject, participant_count, updated_at FROM group_directory ORDER BY subject COLLATE NOCASE",
  ).all();
}

function clearGroupDirectory() {
  q("DELETE FROM group_directory").run();
}

function clearGroupSettings() {
  q("DELETE FROM group_settings").run();
}

function clearUserMetadata() {
  q("DELETE FROM user_metadata").run();
}

function clearLidMappings() {
  q("DELETE FROM lid_mapping").run();
}

/** Drop WhatsApp-derived directory data after unlink / logged-out. */
function clearWhatsAppDirectory() {
  clearGroupDirectory();
  clearGroupSettings();
  clearUserMetadata();
  clearLidMappings();
}

// ===================================================================
// --- Warnings ---
// ===================================================================

function getUserWarnings(groupId, userId) {
  const row = q("SELECT warnings FROM warnings WHERE group_id = ? AND user_id = ?").get(
    groupId,
    userId,
  );
  return row ? parseJson(row.warnings, []) : [];
}

function saveUserWarnings(groupId, userId, warningsArray) {
  q(
    `INSERT INTO warnings (group_id, user_id, warnings) VALUES (?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET warnings = excluded.warnings`,
  ).run(groupId, userId, JSON.stringify(warningsArray || []));
}

function clearUserWarnings(groupId, userId) {
  q("DELETE FROM warnings WHERE group_id = ? AND user_id = ?").run(groupId, userId);
}

function getAllWarnings() {
  return q("SELECT group_id, user_id, warnings FROM warnings")
    .all()
    .map((row) => ({
      group_id: row.group_id,
      user_id: row.user_id,
      warnings: parseJson(row.warnings, []),
    }));
}

function countWarnings() {
  return q("SELECT COUNT(*) AS n FROM warnings").get().n;
}

// ===================================================================
// --- Todos ---
// ===================================================================

function getUserTodos(userId) {
  const row = q("SELECT tasks FROM todos WHERE user_id = ?").get(userId);
  return row ? parseJson(row.tasks, []) : [];
}

function saveUserTodos(userId, tasksArray) {
  q(
    `INSERT INTO todos (user_id, tasks) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET tasks = excluded.tasks`,
  ).run(userId, JSON.stringify(tasksArray || []));
}

function getAllTodos() {
  return q("SELECT user_id, tasks FROM todos")
    .all()
    .map((row) => ({ user_id: row.user_id, tasks: parseJson(row.tasks, []) }));
}

function countTodos() {
  return q("SELECT COUNT(*) AS n FROM todos").get().n;
}

// ===================================================================
// --- Notes ---
// ===================================================================

function saveNote(groupId, keyword, text) {
  q(
    `INSERT INTO notes (group_id, keyword, note_text) VALUES (?, ?, ?)
     ON CONFLICT(group_id, keyword) DO UPDATE SET note_text = excluded.note_text`,
  ).run(groupId, keyword, text);
}

function getNote(groupId, keyword) {
  const row = q("SELECT note_text FROM notes WHERE group_id = ? AND keyword = ?").get(
    groupId,
    keyword,
  );
  return row ? row.note_text : null;
}

function getAllNotes(groupId) {
  return q("SELECT keyword FROM notes WHERE group_id = ? ORDER BY keyword")
    .all(groupId)
    .map((row) => row.keyword);
}

function deleteNote(groupId, keyword) {
  const { changes } = q("DELETE FROM notes WHERE group_id = ? AND keyword = ?").run(
    groupId,
    keyword,
  );
  return changes > 0;
}

function getAllNotesFlat(limit = 100) {
  return q(
    `SELECT group_id, keyword, note_text FROM notes
     ORDER BY group_id, keyword LIMIT ?`,
  ).all(limit);
}

function countNotes() {
  return q("SELECT COUNT(*) AS n FROM notes").get().n;
}

// ===================================================================
// --- Pairing QR ---
// ===================================================================

function saveQrCode(qr) {
  q(
    `INSERT INTO qr_codes (id, qr_string) VALUES (1, ?)
     ON CONFLICT(id) DO UPDATE SET qr_string = excluded.qr_string`,
  ).run(qr);
}

function getQrCode() {
  const row = q("SELECT qr_string FROM qr_codes WHERE id = 1").get();
  return row ? row.qr_string : null;
}

function deleteQrCode() {
  q("DELETE FROM qr_codes WHERE id = 1").run();
}

// ===================================================================
// --- LID <-> phone number (Baileys v7) ---
// ===================================================================

function storeLidPnMapping(lid, pn, deviceIndex = 0) {
  q(
    `INSERT INTO lid_mapping (lid, pn, device_index, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(lid) DO UPDATE SET
       pn = excluded.pn,
       device_index = excluded.device_index,
       updated_at = excluded.updated_at`,
  ).run(lid, pn, deviceIndex, Date.now());
  logger.debug(`[LID] Stored mapping: ${lid} <-> ${pn}`);
}

function storeLidPnMappings(mappings) {
  if (!mappings?.length) return;
  for (const { lid, pn, deviceIndex = 0 } of mappings) {
    storeLidPnMapping(lid, pn, deviceIndex);
  }
  logger.info(`[LID] Stored ${mappings.length} mappings`);
}

function getLidForPn(pn) {
  const row = q("SELECT lid FROM lid_mapping WHERE pn = ?").get(pn);
  return row ? row.lid : null;
}

// Every LID stored for this phone. Writers persist the pn they are given
// (storeLidPnMapping); a device suffix is the only form normalizeJid folds
// onto the same number, so the lookup is an index read of that pn plus the
// `user:` prefix, not a scan of the table.
function getLidsForPn(pn) {
  if (!pn) return [];
  const found = new Map();
  const consider = (rows) => {
    for (const row of rows) {
      if (!row?.lid || !row?.pn || found.has(row.lid)) continue;
      if (normalizeJid(row.pn) !== pn && row.pn !== pn) continue;
      found.set(row.lid, row.lid);
    }
  };
  consider(q("SELECT lid, pn FROM lid_mapping WHERE pn = ?").all(pn));
  if (!String(pn).includes(":")) {
    const at = String(pn).lastIndexOf("@");
    if (at > 0) {
      const user = String(pn).slice(0, at);
      consider(
        q("SELECT lid, pn FROM lid_mapping WHERE pn >= ? AND pn < ?").all(`${user}:`, `${user};`),
      );
    }
  }
  return [...found.keys()];
}

function getLidsForPns(pns) {
  const map = new Map();
  if (!pns?.length) return map;
  for (const pn of pns) {
    const lid = getLidForPn(pn);
    if (lid) map.set(pn, lid);
  }
  return map;
}

function getPnForLid(lid) {
  const row = q("SELECT pn FROM lid_mapping WHERE lid = ?").get(lid);
  return row ? row.pn : null;
}

function getAllLidMappings() {
  return q("SELECT lid, pn, device_index FROM lid_mapping").all();
}

function countLidMappings() {
  return q("SELECT COUNT(*) AS n FROM lid_mapping").get().n;
}

// ===================================================================
// --- User metadata & bot roles ---
// ===================================================================

function rowToUser(row) {
  if (!row) return null;
  return {
    jid: row.user_jid,
    lid: row.user_lid ?? null,
    phone: row.phone_number ?? null,
    isOwner: row.is_owner === 1,
    isAdmin: row.is_admin === 1,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    displayName: row.display_name ?? null,
    savedName: row.saved_name ?? null,
  };
}

function isLidJid(value) {
  return String(value || "").includes("@lid");
}

function isGroupJid(value) {
  return String(value || "").endsWith("@g.us");
}

function asLidJid(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const local = raw.split(":")[0].split("@")[0];
  if (!local) return null;
  if (raw.includes("@lid") || (!raw.includes("@") && !/^\d{8,15}$/.test(local))) {
    return `${local}@lid`;
  }
  return null;
}

function asPnJid(value) {
  const phone = digitsOf(value);
  if (!phone || phone.length < 8 || phone.length > 15) return null;
  return `${phone}@s.whatsapp.net`;
}

function personName(value) {
  const text = String(value || "").trim();
  if (!text || text.includes("@")) return null;
  return text.slice(0, 128);
}

function lidLocalPart(value) {
  if (!isLidJid(value)) return null;
  return String(value).split("@")[0].split(":")[0];
}

/**
 * Find the existing user_metadata row for a person named by any mix of JID,
 * LID and phone, including the lid_mapping table, so a LID and a phone JID
 * of the same person land on one record.
 */
function resolveExistingUser(userData) {
  const candidates = [];
  const add = (value) => {
    if (value && !candidates.includes(value)) candidates.push(value);
  };
  add(userData?.jid);
  add(userData?.lid);
  add(userData?.phone);
  if (userData?.jid) {
    add(getPnForLid(userData.jid));
    add(getLidForPn(userData.jid));
    if (!isLidJid(userData.jid)) add(asPnJid(userData.jid));
  }
  if (userData?.lid) {
    add(getPnForLid(userData.lid));
    add(asLidJid(userData.lid));
  }
  if (userData?.phone) {
    const pnJid = asPnJid(userData.phone);
    add(pnJid);
    if (pnJid) add(getLidForPn(pnJid));
  }
  for (const identifier of candidates) {
    const found = getUserMetadata(identifier);
    if (found) return found;
  }
  return null;
}

function userRow(jid) {
  return q("SELECT * FROM user_metadata WHERE user_jid = ?").get(jid);
}

/**
 * Save or update user metadata.
 *
 * Role flags (`isOwner` / `isAdmin`) are written ONLY when the caller passes
 * them. The message handler calls this for every incoming message without any
 * role information, and resetting the flags there demoted real owners on their
 * next message. Same story for `lid` / `phone` / `displayName`: a missing
 * field keeps whatever we already knew instead of nulling it out.
 *
 * @param {object} userData - { jid, lid?, phone?, isOwner?, isAdmin?, displayName?, savedName? }
 */
function saveUserMetadata(userData) {
  if (!userData?.jid) return;
  const now = Date.now();
  const resolved = resolveExistingUser(userData);
  const jid =
    resolved?.jid ||
    (isLidJid(userData.jid) ? userData.jid : asPnJid(userData.jid) || userData.jid);
  const existing = userRow(jid) || (resolved ? userRow(resolved.jid) : null);

  let phone = userData.phone || existing?.phone_number || null;
  const lidDigits = lidLocalPart(userData.jid);
  if (phone && lidDigits && String(phone).replace(/\D/g, "") === lidDigits) {
    phone = existing?.phone_number || null;
  }
  if (phone && isLidJid(phone)) phone = existing?.phone_number || null;

  const incomingSaved = personName(userData.savedName);
  const incomingPush = personName(userData.displayName);

  const row = {
    user_jid: jid,
    user_lid: userData.lid || existing?.user_lid || (isLidJid(userData.jid) ? userData.jid : null),
    phone_number: phone,
    is_owner:
      userData.isOwner === undefined ? (existing?.is_owner === 1 ? 1 : 0) : bool(userData.isOwner),
    is_admin:
      userData.isAdmin === undefined ? (existing?.is_admin === 1 ? 1 : 0) : bool(userData.isAdmin),
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    display_name: incomingPush || existing?.display_name || null,
    saved_name: incomingSaved || existing?.saved_name || null,
  };

  q(
    `INSERT INTO user_metadata
       (user_jid, user_lid, phone_number, is_owner, is_admin, first_seen, last_seen, display_name, saved_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_jid) DO UPDATE SET
       user_lid     = excluded.user_lid,
       phone_number = excluded.phone_number,
       is_owner     = excluded.is_owner,
       is_admin     = excluded.is_admin,
       last_seen    = excluded.last_seen,
       display_name = excluded.display_name,
       saved_name   = excluded.saved_name`,
  ).run(
    row.user_jid,
    row.user_lid,
    row.phone_number,
    row.is_owner,
    row.is_admin,
    row.first_seen,
    row.last_seen,
    row.display_name,
    row.saved_name,
  );
}

/**
 * Store an address-book name for a number only when none is saved yet.
 * Used when the panel creates a schedule from a picked phone-book contact.
 */
function rememberSavedName(identifier, name) {
  const savedName = personName(name);
  if (!identifier || !savedName) return null;
  const existing = getUserMetadata(identifier);
  if (existing?.savedName) return existing;
  let jid = existing?.jid;
  if (!jid) {
    if (String(identifier).includes("@")) jid = identifier;
    else {
      const phone = digitsOf(identifier);
      jid = phone ? `${phone}@s.whatsapp.net` : identifier;
    }
  }
  saveUserMetadata({
    jid,
    lid: existing?.lid || (isLidJid(identifier) ? identifier : null),
    phone: existing?.phone || digitsOf(identifier),
    savedName,
  });
  return getUserMetadata(jid);
}

function isIgnoredContactId(id) {
  const value = String(id || "");
  if (!value) return true;
  if (value.endsWith("@g.us")) return true;
  if (value.includes("@broadcast") || value.includes("@newsletter")) return true;
  if (value === "status@broadcast") return true;
  return false;
}

/**
 * Persist a Baileys v7 contact record from `contacts.upsert` / `contacts.update`.
 * `name` is the address-book name; `notify` is the push name. Never writes a
 * push name into saved_name.
 */
function applyContactRecord(contact) {
  if (!contact?.id || isIgnoredContactId(contact.id) || isGroupJid(contact.id)) return;

  const id = String(contact.id);
  const lid = asLidJid(contact.lid) || (isLidJid(id) ? asLidJid(id) : null);
  const pnJid = asPnJid(contact.phoneNumber) || (!isLidJid(id) ? asPnJid(id) : null);
  if (lid && pnJid) storeLidPnMapping(lid, pnJid);

  const jid = pnJid || lid || id;
  if (isIgnoredContactId(jid)) return;

  const savedName = personName(contact.name);
  const pushName = personName(contact.notify) || personName(contact.verifiedName);
  saveUserMetadata({
    jid,
    lid,
    phone: pnJid ? digitsOf(pnJid) : null,
    ...(savedName ? { savedName } : {}),
    ...(pushName ? { displayName: pushName } : {}),
  });
}

/**
 * Get user metadata by JID, LID, or bare phone number. Four steps, in order:
 * exact JID, then LID, then phone, then a digits-only match against either
 * identifier (which is what handles the `:12` device suffixes).
 */
function getUserMetadata(identifier) {
  if (!identifier) return null;

  let row = userRow(identifier);

  if (!row) {
    row = q("SELECT * FROM user_metadata WHERE user_lid = ?").get(identifier);
  }

  if (!row) {
    row = q("SELECT * FROM user_metadata WHERE phone_number = ?").get(identifier);
  }

  if (!row) {
    const phone = digitsOf(identifier);
    if (phone) {
      row =
        q("SELECT * FROM user_metadata WHERE phone_number = ?").get(phone) ||
        q(
          `SELECT * FROM user_metadata
           WHERE user_jid LIKE ? OR user_lid LIKE ?
           LIMIT 1`,
        ).get(`${phone}@%`, `${phone}@%`);
    }
  }

  return rowToUser(row);
}

function isUserOwner(identifier) {
  return getUserMetadata(identifier)?.isOwner === true;
}

/**
 * Check if user carries the bot-level admin role (not the same thing as being
 * an admin of a WhatsApp group).
 */
function isUserBotAdmin(identifier) {
  return getUserMetadata(identifier)?.isAdmin === true;
}

function getAllOwners() {
  return q("SELECT * FROM user_metadata WHERE is_owner = 1").all().map(rowToUser);
}

function getAllBotAdmins() {
  return q("SELECT * FROM user_metadata WHERE is_admin = 1").all().map(rowToUser);
}

function getAllUsers() {
  return q("SELECT * FROM user_metadata ORDER BY last_seen DESC").all().map(rowToUser);
}

function countUsers() {
  return q("SELECT COUNT(*) AS n FROM user_metadata").get().n;
}

/**
 * Grant or revoke a bot-level role, creating the user record when needed.
 *
 * @param {string} identifier - JID / LID / phone
 * @param {"owner"|"admin"} role
 * @param {boolean} enabled
 * @returns {object|null} the stored user record
 */
function setUserRole(identifier, role, enabled = true) {
  if (!identifier) return null;

  const wanted = String(role).toLowerCase() === "owner" ? "isOwner" : "isAdmin";
  const existing = getUserMetadata(identifier);

  // Keep LIDs as LIDs; anything else becomes a PN JID so the roster stays
  // comparable with what the permission checks resolve senders to.
  let jid = existing?.jid;
  if (!jid) {
    if (String(identifier).includes("@")) jid = identifier;
    else {
      const phone = digitsOf(identifier);
      jid = phone ? `${phone}@s.whatsapp.net` : identifier;
    }
  }

  saveUserMetadata({
    jid,
    lid: existing?.lid || (String(identifier).endsWith("@lid") ? identifier : null),
    phone: existing?.phone || digitsOf(identifier),
    displayName: existing?.displayName || null,
    [wanted]: !!enabled,
  });

  return getUserMetadata(jid);
}

function updateUserLastSeen(jid) {
  q("UPDATE user_metadata SET last_seen = ? WHERE user_jid = ?").run(Date.now(), jid);
}

// ===================================================================
// --- Forward scores ---
// ===================================================================

function incrementForwardScore(messageId, groupId, senderId) {
  const now = Date.now();
  q(
    `INSERT INTO forward_scores
       (message_id, group_id, original_sender, forward_count,
        first_forwarded_at, last_forwarded_at, expires_at)
     VALUES (?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET
       forward_count     = forward_count + 1,
       last_forwarded_at = excluded.last_forwarded_at,
       expires_at        = excluded.expires_at`,
  ).run(messageId, groupId, senderId, now, now, forwardExpiry());

  return (
    q("SELECT forward_count FROM forward_scores WHERE message_id = ?").get(messageId)
      ?.forward_count ?? 1
  );
}

function getForwardScore(messageId) {
  const row = q("SELECT * FROM forward_scores WHERE message_id = ?").get(messageId);
  return row
    ? {
        count: row.forward_count,
        sender: row.original_sender,
        firstForwardedAt: row.first_forwarded_at,
        lastForwardedAt: row.last_forwarded_at,
      }
    : null;
}

function getTopForwardedMessages(groupId, limit = 10) {
  return q(
    `SELECT message_id, original_sender, forward_count, first_forwarded_at
     FROM forward_scores
     WHERE group_id = ?
     ORDER BY forward_count DESC
     LIMIT ?`,
  ).all(groupId, limit);
}

// ===================================================================
// --- Debts ---
// ===================================================================

function debtRow(row) {
  if (!row) return null;
  return { ...row, settled: row.settled === 1 };
}

function addDebt({ groupId, debtorId, creditorId, amount, currency = "USD", description = null }) {
  const createdAt = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO debts
       (group_id, debtor_id, creditor_id, amount, currency, description, created_at, settled, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
  ).run(groupId, debtorId, creditorId, amount, currency, description, createdAt);

  return getDebt(Number(lastInsertRowid));
}

function getDebt(id) {
  return debtRow(q("SELECT * FROM debts WHERE id = ?").get(id));
}

function deleteDebt(id) {
  const { changes } = q("DELETE FROM debts WHERE id = ?").run(id);
  return changes > 0;
}

function listDebts(groupId, { settled = false } = {}) {
  return q(
    `SELECT * FROM debts WHERE group_id = ? AND settled = ?
     ORDER BY created_at DESC`,
  )
    .all(groupId, bool(settled))
    .map(debtRow);
}

function getRecentDebts(limit = 50) {
  return q("SELECT * FROM debts ORDER BY created_at DESC LIMIT ?").all(limit).map(debtRow);
}

function countDebts(settled = false) {
  return q("SELECT COUNT(*) AS n FROM debts WHERE settled = ?").get(bool(settled)).n;
}

// ===================================================================
// --- Scheduled messages ---
// ===================================================================
//
// Used to be config/schedule.json. In the database the dashboard can list
// them, and a crash in the middle of a write can't truncate the file.
//
// A job is `{ id, type, targetJid, message, cronString?, date?, status,
// creatorJid, lastRunAt?, lastDeliveryStatus?, lastError? }`.

function scheduleRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    targetJid: row.target_jid,
    message: row.message,
    cronString: row.cron_string ?? undefined,
    date: row.date ?? undefined,
    status: row.status,
    creatorJid: row.creator_jid ?? null,
    createdAt: row.created_at,
    lastRunAt: row.last_run_at ?? null,
    lastDeliveryStatus: row.last_delivery_status ?? null,
    lastError: row.last_error ?? null,
  };
}

function getSchedules() {
  return q("SELECT * FROM schedules ORDER BY created_at").all().map(scheduleRow);
}

function getSchedule(id) {
  return scheduleRow(q("SELECT * FROM schedules WHERE id = ?").get(String(id)));
}

function saveSchedule(job) {
  q(
    `INSERT INTO schedules
       (id, type, target_jid, message, cron_string, date, status, creator_jid,
        created_at, last_run_at, last_delivery_status, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type        = excluded.type,
       target_jid  = excluded.target_jid,
       message     = excluded.message,
       cron_string = excluded.cron_string,
       date        = excluded.date,
       status      = excluded.status,
       creator_jid = excluded.creator_jid,
       last_run_at = excluded.last_run_at,
       last_delivery_status = excluded.last_delivery_status,
       last_error = excluded.last_error`,
  ).run(
    String(job.id),
    job.type,
    job.targetJid,
    job.message,
    job.cronString ?? null,
    job.date ?? null,
    job.status || "pending",
    job.creatorJid ?? null,
    job.createdAt ?? Date.now(),
    job.lastRunAt ?? null,
    job.lastDeliveryStatus ?? null,
    job.lastError ?? null,
  );
  return getSchedule(job.id);
}

function setScheduleStatus(id, status) {
  q("UPDATE schedules SET status = ? WHERE id = ?").run(status, String(id));
}

function setScheduleDelivery(id, status, runAt, error = null) {
  q(
    `UPDATE schedules
        SET last_delivery_status = ?, last_run_at = ?, last_error = ?
      WHERE id = ?`,
  ).run(status, runAt, error, String(id));
  return getSchedule(id);
}

function deleteSchedule(id) {
  const { changes } = q("DELETE FROM schedules WHERE id = ?").run(String(id));
  return changes > 0;
}

/** Keep old jobs visible after unlink, but never arm them for a new account. */
function pauseAllSchedules() {
  return q("UPDATE schedules SET status = 'paused' WHERE status IN ('active', 'pending')").run()
    .changes;
}

function countSchedules() {
  return q("SELECT COUNT(*) AS n FROM schedules").get().n;
}

// ===================================================================
// --- AI conversation history ---
// ===================================================================
//
// One row per chat, no expiry. `!del` clears one chat, `!delall` clears the
// table. The callers are async (they always were, back when this was a
// separate database), so storage-hub keeps the async signatures.

function getChatHistory(chatId) {
  const row = q("SELECT history FROM ai_history WHERE chat_id = ?").get(chatId);
  return row ? parseJson(row.history, []) : [];
}

function saveChatHistory(chatId, historyArray) {
  q(
    `INSERT INTO ai_history (chat_id, history, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET
       history = excluded.history,
       updated_at = excluded.updated_at`,
  ).run(chatId, JSON.stringify(historyArray || []), Date.now());
}

function deleteChatHistory(chatId) {
  const { changes } = q("DELETE FROM ai_history WHERE chat_id = ?").run(chatId);
  return changes > 0;
}

function deleteAllChatHistories() {
  q("DELETE FROM ai_history").run();
}

// Read-only views for the dashboard's conversation inspector: which chats
// have stored history (no message content), and one chat's history with its
// last-updated stamp. `json_array_length` counts the stored turns without
// parsing the blob in JavaScript.
function listChatHistories() {
  return q(
    `SELECT chat_id AS chatId,
            updated_at AS updatedAt,
            json_array_length(history) AS turns
     FROM ai_history
     ORDER BY updated_at DESC`,
  ).all();
}

function getChatHistoryWithMeta(chatId) {
  const row = q("SELECT history, updated_at AS updatedAt FROM ai_history WHERE chat_id = ?").get(
    chatId,
  );
  if (!row) return null;
  return { history: parseJson(row.history, []), updatedAt: row.updatedAt };
}

// ===================================================================
// --- Baileys auth ---
// ===================================================================
//
// Values arrive already serialized by BufferJSON (see auth-storage.cjs), so
// they are stored as text and handed back as text.

function authRead(key) {
  const row = q("SELECT value FROM baileys_auth WHERE key = ?").get(key);
  if (!row) return null;
  const vault = require("../config/vault.cjs");
  return vault.open(row.value);
}

function authWrite(key, serialized) {
  const vault = require("../config/vault.cjs");
  const payload = serialized == null ? "" : String(serialized);
  const stored = vault.isSealed(payload) ? payload : vault.seal(payload);
  q(
    `INSERT INTO baileys_auth (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, stored);
}

function authRemove(key) {
  q("DELETE FROM baileys_auth WHERE key = ?").run(key);
}

function authClearAll() {
  q("DELETE FROM baileys_auth").run();
}

function hasCredentials() {
  return !!q("SELECT 1 AS x FROM baileys_auth WHERE key = 'creds'").get();
}

/**
 * A finished pairing — not merely that a creds row exists. Baileys writes
 * creds on the first socket, and requestPairingCode fills me.id before the
 * phone accepts, so only `registered !== false` plus a me.id is proof.
 */
function isPairedSession() {
  const text = authRead("creds");
  if (!text) return false;
  try {
    const creds = JSON.parse(text);
    const meId = creds?.me?.id;
    if (!meId) return false;
    return creds.registered !== false;
  } catch {
    return false;
  }
}

function resolveUserPhone(jid) {
  if (!jid || String(jid).endsWith("@g.us")) return null;
  const meta = getUserMetadata(jid);
  if (meta?.phone) return String(meta.phone).replace(/\D/g, "");
  const raw = String(jid);
  const local = raw.split("@")[0].split(":")[0];
  if (raw.includes("@lid") || !/^\d{8,15}$/.test(local)) {
    for (const candidate of [raw, local, `${local}@lid`]) {
      const pn = getPnForLid(candidate);
      if (!pn) continue;
      const digits = String(pn).split("@")[0].replace(/\D/g, "");
      if (digits) return digits;
    }
    if (raw.includes("@lid")) return null;
  }
  if (/^\d{8,15}$/.test(local)) return local;
  return null;
}

function describePeer(jid) {
  const id = String(jid || "");
  if (!id) {
    return {
      jid: "",
      kind: "unknown",
      label: "",
      phone: null,
      savedName: null,
      pushName: null,
      memberCount: null,
    };
  }
  if (id.endsWith("@g.us")) {
    const dir = getGroupDirectory(id);
    const label = personName(dir?.subject) || "Group";
    return {
      jid: id,
      kind: "group",
      label,
      phone: null,
      savedName: null,
      pushName: null,
      memberCount: dir?.participant_count ?? null,
    };
  }
  const phone = resolveUserPhone(id);
  const meta = getUserMetadata(id);
  const savedName = personName(meta?.savedName);
  const pushName = personName(meta?.displayName);
  const phoneLabel = phone ? `+${phone}` : null;
  const label = savedName || pushName || phoneLabel || "Contact";
  return {
    jid: id,
    kind: "contact",
    label,
    phone: phoneLabel,
    savedName,
    pushName,
    memberCount: null,
  };
}

// ===================================================================
// --- Sticker Studio ---
// ===================================================================
//
// Every statement the library uses lives here. Multi-row changes run inside
// withImmediateTransaction so a crash cannot leave a pack half-merged or a
// sticker deleted while its pack positions still have a hole. The WebP files
// themselves are not in SQLite — the library writes them beside the row, on
// the same thread, with no await in between.

function withImmediateTransaction(fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // The statement that failed may already have rolled the transaction back.
    }
    throw error;
  }
}

function sqlIn(values) {
  return values.map(() => "?").join(", ");
}

function stickerRekey(candidates, key) {
  const from = candidates.filter((owner) => owner !== key);
  if (!from.length || !key) return;

  const stray = q(
    `SELECT 1 AS x FROM stickers WHERE owner IN (${sqlIn(from)})
     UNION ALL
     SELECT 1 AS x FROM sticker_packs WHERE owner IN (${sqlIn(from)})
     LIMIT 1`,
  ).get(...from, ...from);
  if (!stray) return;

  withImmediateTransaction(() => {
    const rows = q(`SELECT * FROM stickers WHERE owner IN (${sqlIn(candidates)})`).all(
      ...candidates,
    );
    const bySha = new Map();
    for (const row of rows) {
      const group = bySha.get(row.sha256);
      if (group) group.push(row);
      else bySha.set(row.sha256, [row]);
    }
    for (const group of bySha.values()) {
      group.sort((a, b) => {
        if ((a.owner === key) !== (b.owner === key)) return a.owner === key ? -1 : 1;
        return a.created_at - b.created_at;
      });
      const keep = group[0];
      let name = keep.name;
      let favorite = keep.is_favorite;
      let lastUsed = keep.last_used_at;
      let created = keep.created_at;
      for (const extra of group.slice(1)) {
        if (!name && extra.name) name = extra.name;
        if (extra.is_favorite) favorite = 1;
        if (extra.last_used_at != null && (lastUsed == null || extra.last_used_at > lastUsed)) {
          lastUsed = extra.last_used_at;
        }
        if (extra.created_at < created) created = extra.created_at;
        stickerRetargetItems(extra.id, keep.id);
        q("DELETE FROM stickers WHERE id = ?").run(extra.id);
      }
      q(
        `UPDATE stickers
         SET owner = ?, name = ?, is_favorite = ?, last_used_at = ?, created_at = ?
         WHERE id = ?`,
      ).run(key, name, favorite, lastUsed, created, keep.id);
    }

    const packs = q(`SELECT * FROM sticker_packs WHERE owner IN (${sqlIn(candidates)})`).all(
      ...candidates,
    );
    const byName = new Map();
    for (const pack of packs) {
      const group = byName.get(pack.name_key);
      if (group) group.push(pack);
      else byName.set(pack.name_key, [pack]);
    }
    for (const group of byName.values()) {
      group.sort((a, b) => {
        if ((a.owner === key) !== (b.owner === key)) return a.owner === key ? -1 : 1;
        return a.created_at - b.created_at;
      });
      const keep = group[0];
      for (const extra of group.slice(1)) {
        stickerAppendPack(extra.id, keep.id);
        q("DELETE FROM sticker_packs WHERE id = ?").run(extra.id);
        stickerPackRenumber(keep.id);
      }
      if (keep.owner !== key) {
        q("UPDATE sticker_packs SET owner = ? WHERE id = ?").run(key, keep.id);
      }
    }
  });
}

function stickerRetargetItems(fromStickerId, toStickerId) {
  const items = q("SELECT pack_id FROM sticker_pack_items WHERE sticker_id = ?").all(fromStickerId);
  for (const item of items) {
    const exists = q(
      "SELECT 1 AS x FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?",
    ).get(item.pack_id, toStickerId);
    if (exists) {
      q("DELETE FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?").run(
        item.pack_id,
        fromStickerId,
      );
    } else {
      q("UPDATE sticker_pack_items SET sticker_id = ? WHERE pack_id = ? AND sticker_id = ?").run(
        toStickerId,
        item.pack_id,
        fromStickerId,
      );
    }
    stickerPackRenumber(item.pack_id);
  }
}

function stickerAppendPack(fromPackId, toPackId) {
  const items = q(
    `SELECT sticker_id FROM sticker_pack_items
     WHERE pack_id = ? ORDER BY position ASC, added_at ASC`,
  ).all(fromPackId);
  const now = Date.now();
  for (const item of items) stickerPackAdd(toPackId, item.sticker_id, now);
}

function stickerCount(candidates) {
  if (!candidates.length) return 0;
  return q(`SELECT COUNT(*) AS n FROM stickers WHERE owner IN (${sqlIn(candidates)})`).get(
    ...candidates,
  ).n;
}

function stickerFindBySha(candidates, sha) {
  if (!candidates.length) return null;
  return (
    q(
      `SELECT * FROM stickers WHERE sha256 = ? AND owner IN (${sqlIn(candidates)})
       ORDER BY created_at ASC LIMIT 1`,
    ).get(sha, ...candidates) || null
  );
}

function stickerGet(candidates, id) {
  if (!candidates.length) return null;
  return (
    q(`SELECT * FROM stickers WHERE id = ? AND owner IN (${sqlIn(candidates)})`).get(
      id,
      ...candidates,
    ) || null
  );
}

function stickerInsert(row) {
  q(
    `INSERT INTO stickers (
       id, owner, sha256, name, animated, width, height, duration_ms, file_size,
       source, source_mime, is_favorite, created_at, updated_at, last_used_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.owner,
    row.sha256,
    row.name,
    row.animated ? 1 : 0,
    row.width,
    row.height,
    row.durationMs,
    row.fileSize,
    row.source,
    row.sourceMime,
    row.favorite ? 1 : 0,
    row.createdAt,
    row.updatedAt,
    row.lastUsedAt,
  );
}

function stickerUpdate(id, fields) {
  const sets = [];
  const params = [];
  if (fields.name !== undefined) {
    sets.push("name = ?");
    params.push(fields.name);
  }
  if (fields.isFavorite !== undefined) {
    sets.push("is_favorite = ?");
    params.push(fields.isFavorite ? 1 : 0);
  }
  if (fields.updatedAt !== undefined) {
    sets.push("updated_at = ?");
    params.push(fields.updatedAt);
  }
  if (fields.lastUsedAt !== undefined) {
    sets.push("last_used_at = ?");
    params.push(fields.lastUsedAt);
  }
  if (!sets.length) return;
  params.push(id);
  q(`UPDATE stickers SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

function stickerDelete(id) {
  q("DELETE FROM stickers WHERE id = ?").run(id);
}

function stickerShaCount(sha) {
  return q("SELECT COUNT(*) AS n FROM stickers WHERE sha256 = ?").get(sha).n;
}

const STICKER_SORTS = {
  newest: "s.created_at DESC, s.id DESC",
  oldest: "s.created_at ASC, s.id ASC",
  name: "s.name COLLATE NOCASE ASC, s.id ASC",
  recent: "COALESCE(s.last_used_at, s.created_at) DESC, s.id DESC",
};

function stickerQuery(candidates, filter) {
  if (!candidates.length) return { rows: [], total: 0 };
  const clauses = [`s.owner IN (${sqlIn(candidates)})`];
  const params = [...candidates];

  const text = String(filter.q || "")
    .trim()
    .toLowerCase();
  if (text) {
    const escaped = text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    clauses.push("LOWER(s.name) LIKE ? ESCAPE '\\'");
    params.push(`%${escaped}%`);
  }
  if (filter.filter === "favorites") clauses.push("s.is_favorite = 1");
  if (filter.filter === "animated") clauses.push("s.animated = 1");
  if (filter.filter === "static") clauses.push("s.animated = 0");
  if (filter.filter === "recent") {
    clauses.push("COALESCE(s.last_used_at, s.created_at) >= ?");
    params.push(Date.now() - 30 * 24 * 60 * 60 * 1000);
  }
  if (filter.pack === "none") {
    clauses.push(
      `NOT EXISTS (
         SELECT 1 FROM sticker_pack_items i
         JOIN sticker_packs p ON p.id = i.pack_id
         WHERE i.sticker_id = s.id AND p.owner IN (${sqlIn(candidates)})
       )`,
    );
    params.push(...candidates);
  } else if (filter.pack) {
    clauses.push(
      `EXISTS (
         SELECT 1 FROM sticker_pack_items i
         JOIN sticker_packs p ON p.id = i.pack_id
         WHERE i.sticker_id = s.id AND i.pack_id = ? AND p.owner IN (${sqlIn(candidates)})
       )`,
    );
    params.push(filter.pack, ...candidates);
  }

  const where = clauses.join(" AND ");
  const total = q(`SELECT COUNT(*) AS n FROM stickers s WHERE ${where}`).get(...params).n;
  const sort =
    filter.filter === "recent"
      ? STICKER_SORTS.recent
      : STICKER_SORTS[filter.sort] || STICKER_SORTS.newest;
  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 60));
  const offset = Math.max(0, Number(filter.offset) || 0);
  const rows = q(`SELECT s.* FROM stickers s WHERE ${where} ORDER BY ${sort} LIMIT ? OFFSET ?`).all(
    ...params,
    limit,
    offset,
  );
  return { rows, total };
}

function stickerPackMembership(candidates, stickerIds) {
  const map = new Map();
  if (!candidates.length || !stickerIds.length) return map;
  const rows = q(
    `SELECT i.sticker_id, i.pack_id
     FROM sticker_pack_items i
     JOIN sticker_packs p ON p.id = i.pack_id
     WHERE i.sticker_id IN (${sqlIn(stickerIds)}) AND p.owner IN (${sqlIn(candidates)})
     ORDER BY i.added_at ASC, i.pack_id ASC`,
  ).all(...stickerIds, ...candidates);
  for (const row of rows) {
    const list = map.get(row.sticker_id);
    if (list) list.push(row.pack_id);
    else map.set(row.sticker_id, [row.pack_id]);
  }
  return map;
}

function stickerPacksUsing(candidates, stickerId) {
  if (!candidates.length) return [];
  return q(
    `SELECT p.id, p.name
     FROM sticker_pack_items i
     JOIN sticker_packs p ON p.id = i.pack_id
     WHERE i.sticker_id = ? AND p.owner IN (${sqlIn(candidates)})
     ORDER BY LOWER(p.name) ASC, p.id ASC`,
  ).all(stickerId, ...candidates);
}

function stickerPackIdsOf(stickerId) {
  return q("SELECT pack_id FROM sticker_pack_items WHERE sticker_id = ?").all(stickerId);
}

function stickerClearAll() {
  return withImmediateTransaction(() => {
    const shas = q("SELECT DISTINCT sha256 FROM stickers")
      .all()
      .map((row) => row.sha256);
    q("DELETE FROM stickers").run();
    q("DELETE FROM sticker_packs").run();
    return shas;
  });
}

function stickerPackCount(candidates) {
  if (!candidates.length) return 0;
  return q(`SELECT COUNT(*) AS n FROM sticker_packs WHERE owner IN (${sqlIn(candidates)})`).get(
    ...candidates,
  ).n;
}

function stickerPackList(candidates) {
  if (!candidates.length) return [];
  return q(
    `SELECT p.*,
       (SELECT COUNT(*) FROM sticker_pack_items i WHERE i.pack_id = p.id) AS item_count,
       (SELECT i.sticker_id FROM sticker_pack_items i
         WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_id,
       (SELECT s.sha256 FROM sticker_pack_items i
         JOIN stickers s ON s.id = i.sticker_id
         WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_sha
     FROM sticker_packs p
     WHERE p.owner IN (${sqlIn(candidates)})
     ORDER BY p.name COLLATE NOCASE ASC, p.id ASC`,
  ).all(...candidates);
}

function stickerPackGet(candidates, id) {
  if (!candidates.length) return null;
  return (
    q(
      `SELECT p.*,
         (SELECT COUNT(*) FROM sticker_pack_items i WHERE i.pack_id = p.id) AS item_count,
         (SELECT i.sticker_id FROM sticker_pack_items i
           WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_id,
         (SELECT s.sha256 FROM sticker_pack_items i
           JOIN stickers s ON s.id = i.sticker_id
           WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_sha
       FROM sticker_packs p
       WHERE p.id = ? AND p.owner IN (${sqlIn(candidates)})`,
    ).get(id, ...candidates) || null
  );
}

function stickerPackByKey(candidates, nameKey) {
  if (!candidates.length) return null;
  return (
    q(
      `SELECT p.*,
         (SELECT COUNT(*) FROM sticker_pack_items i WHERE i.pack_id = p.id) AS item_count,
         (SELECT i.sticker_id FROM sticker_pack_items i
           WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_id,
         (SELECT s.sha256 FROM sticker_pack_items i
           JOIN stickers s ON s.id = i.sticker_id
           WHERE i.pack_id = p.id ORDER BY i.position ASC, i.added_at ASC LIMIT 1) AS cover_sha
       FROM sticker_packs p
       WHERE p.name_key = ? AND p.owner IN (${sqlIn(candidates)})`,
    ).get(nameKey, ...candidates) || null
  );
}

function stickerPackInsert(row) {
  q(
    `INSERT INTO sticker_packs (id, owner, name, name_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.owner, row.name, row.nameKey, row.createdAt, row.updatedAt);
}

function stickerPackRename(id, name, nameKey, updatedAt) {
  q("UPDATE sticker_packs SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(
    name,
    nameKey,
    updatedAt,
    id,
  );
}

function stickerPackDelete(id) {
  q("DELETE FROM sticker_packs WHERE id = ?").run(id);
}

function stickerPackItems(packId) {
  return q(
    `SELECT s.* FROM sticker_pack_items i
     JOIN stickers s ON s.id = i.sticker_id
     WHERE i.pack_id = ?
     ORDER BY i.position ASC, i.added_at ASC, s.id ASC`,
  ).all(packId);
}

function stickerPackAdd(packId, stickerId, now) {
  const exists = q(
    "SELECT 1 AS x FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?",
  ).get(packId, stickerId);
  if (exists) return false;
  const count = q("SELECT COUNT(*) AS n FROM sticker_pack_items WHERE pack_id = ?").get(packId).n;
  q(
    `INSERT INTO sticker_pack_items (pack_id, sticker_id, position, added_at)
     VALUES (?, ?, ?, ?)`,
  ).run(packId, stickerId, count, now);
  return true;
}

function stickerPackRemoveItem(packId, stickerId) {
  const result = q("DELETE FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?").run(
    packId,
    stickerId,
  );
  if (result.changes) stickerPackRenumber(packId);
  return result.changes > 0;
}

function stickerPackRenumber(packId) {
  const rows = q(
    `SELECT sticker_id FROM sticker_pack_items
     WHERE pack_id = ?
     ORDER BY position ASC, added_at ASC, sticker_id ASC`,
  ).all(packId);
  for (let index = 0; index < rows.length; index += 1) {
    q("UPDATE sticker_pack_items SET position = ? WHERE pack_id = ? AND sticker_id = ?").run(
      index,
      packId,
      rows[index].sticker_id,
    );
  }
}

function stickerPackReorder(packId, ids) {
  const current = q(
    "SELECT sticker_id FROM sticker_pack_items WHERE pack_id = ? ORDER BY position ASC, added_at ASC",
  )
    .all(packId)
    .map((row) => row.sticker_id);
  if (current.length !== ids.length || new Set(ids).size !== ids.length) return false;
  const have = new Set(current);
  if (ids.some((id) => !have.has(id))) return false;
  for (let index = 0; index < ids.length; index += 1) {
    q("UPDATE sticker_pack_items SET position = ? WHERE pack_id = ? AND sticker_id = ?").run(
      index,
      packId,
      ids[index],
    );
  }
  return true;
}

function stickerPackExclusive(packId) {
  return q(
    `SELECT i.sticker_id AS id, s.sha256 AS sha256
     FROM sticker_pack_items i
     JOIN stickers s ON s.id = i.sticker_id
     WHERE i.pack_id = ?
       AND (SELECT COUNT(*) FROM sticker_pack_items j WHERE j.sticker_id = i.sticker_id) = 1
     ORDER BY i.position ASC`,
  ).all(packId);
}

function stickerPackItemCount(packId) {
  return q("SELECT COUNT(*) AS n FROM sticker_pack_items WHERE pack_id = ?").get(packId).n;
}

module.exports = {
  // Lifecycle
  initStore,
  flushStore,
  isStoreReady,
  pendingWrites,
  // Bot settings
  getBotSetting,
  saveBotSetting,
  deleteBotSetting,
  // Group settings
  getGroupSettings,
  saveGroupSettings,
  getAllGroupSettings,
  countGroups,
  upsertGroupDirectory,
  getGroupDirectory,
  getAllGroupDirectory,
  clearGroupDirectory,
  clearGroupSettings,
  clearUserMetadata,
  clearLidMappings,
  clearWhatsAppDirectory,
  // Warnings
  getUserWarnings,
  saveUserWarnings,
  clearUserWarnings,
  getAllWarnings,
  countWarnings,
  // Todos
  getUserTodos,
  saveUserTodos,
  countTodos,
  getAllTodos,
  // Notes
  saveNote,
  getNote,
  getAllNotes,
  deleteNote,
  getAllNotesFlat,
  countNotes,
  // QR
  saveQrCode,
  getQrCode,
  deleteQrCode,
  // LID mapping
  storeLidPnMapping,
  storeLidPnMappings,
  getLidForPn,
  getLidsForPn,
  getLidsForPns,
  getPnForLid,
  getAllLidMappings,
  // User metadata & roles
  saveUserMetadata,
  rememberSavedName,
  applyContactRecord,
  getUserMetadata,
  isUserOwner,
  isUserBotAdmin,
  getAllOwners,
  getAllBotAdmins,
  getAllUsers,
  countUsers,
  setUserRole,
  updateUserLastSeen,
  // Forward scores
  incrementForwardScore,
  getForwardScore,
  getTopForwardedMessages,
  // Debts
  addDebt,
  getDebt,
  deleteDebt,
  listDebts,
  getRecentDebts,
  countDebts,
  // Schedules
  getSchedules,
  getSchedule,
  saveSchedule,
  setScheduleStatus,
  setScheduleDelivery,
  deleteSchedule,
  pauseAllSchedules,
  countSchedules,
  // AI history
  getChatHistory,
  getChatHistoryWithMeta,
  listChatHistories,
  saveChatHistory,
  deleteChatHistory,
  deleteAllChatHistories,
  // Baileys auth
  authRead,
  authWrite,
  authRemove,
  authClearAll,
  hasCredentials,
  isPairedSession,
  resolveUserPhone,
  describePeer,
  migrateSecretsAtRest,
  // Sticker Studio
  withImmediateTransaction,
  stickerRekey,
  stickerCount,
  stickerFindBySha,
  stickerGet,
  stickerInsert,
  stickerUpdate,
  stickerDelete,
  stickerShaCount,
  stickerQuery,
  stickerPackMembership,
  stickerPacksUsing,
  stickerPackIdsOf,
  stickerClearAll,
  stickerPackCount,
  stickerPackList,
  stickerPackGet,
  stickerPackByKey,
  stickerPackInsert,
  stickerPackRename,
  stickerPackDelete,
  stickerPackItems,
  stickerPackAdd,
  stickerPackRemoveItem,
  stickerPackRenumber,
  stickerPackReorder,
  stickerPackExclusive,
  stickerPackItemCount,
};
