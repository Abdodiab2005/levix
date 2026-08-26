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
const { q, parseJson, sweepExpired, checkpoint, DB_PATH } = require("./db.cjs");

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

async function initStore() {
  sweepExpired();
  if (!sweepTimer) {
    sweepTimer = setInterval(sweepExpired, 6 * 60 * 60 * 1000);
    sweepTimer.unref();
  }
  logger.info(
    `[Store] SQLite ready at ${DB_PATH} — ${countGroups()} group(s), ` +
      `${countUsers()} user(s), ${countNotes()} note(s), ${countLidMappings()} LID mapping(s)`
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
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, JSON.stringify(value ?? null));
}

function deleteBotSetting(key) {
  q("DELETE FROM bot_settings WHERE key = ?").run(key);
}

// ===================================================================
// --- Group settings ---
// ===================================================================

function getGroupSettings(groupId) {
  const row = q("SELECT settings FROM group_settings WHERE group_id = ?").get(
    groupId
  );
  return row ? parseJson(row.settings, {}) : {};
}

function saveGroupSettings(groupId, settings) {
  q(
    `INSERT INTO group_settings (group_id, settings) VALUES (?, ?)
     ON CONFLICT(group_id) DO UPDATE SET settings = excluded.settings`
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

// ===================================================================
// --- Warnings ---
// ===================================================================

function getUserWarnings(groupId, userId) {
  const row = q(
    "SELECT warnings FROM warnings WHERE group_id = ? AND user_id = ?"
  ).get(groupId, userId);
  return row ? parseJson(row.warnings, []) : [];
}

function saveUserWarnings(groupId, userId, warningsArray) {
  q(
    `INSERT INTO warnings (group_id, user_id, warnings) VALUES (?, ?, ?)
     ON CONFLICT(group_id, user_id) DO UPDATE SET warnings = excluded.warnings`
  ).run(groupId, userId, JSON.stringify(warningsArray || []));
}

function clearUserWarnings(groupId, userId) {
  q("DELETE FROM warnings WHERE group_id = ? AND user_id = ?").run(
    groupId,
    userId
  );
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
     ON CONFLICT(user_id) DO UPDATE SET tasks = excluded.tasks`
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
     ON CONFLICT(group_id, keyword) DO UPDATE SET note_text = excluded.note_text`
  ).run(groupId, keyword, text);
}

function getNote(groupId, keyword) {
  const row = q(
    "SELECT note_text FROM notes WHERE group_id = ? AND keyword = ?"
  ).get(groupId, keyword);
  return row ? row.note_text : null;
}

function getAllNotes(groupId) {
  return q("SELECT keyword FROM notes WHERE group_id = ? ORDER BY keyword")
    .all(groupId)
    .map((row) => row.keyword);
}

function deleteNote(groupId, keyword) {
  const { changes } = q(
    "DELETE FROM notes WHERE group_id = ? AND keyword = ?"
  ).run(groupId, keyword);
  return changes > 0;
}

function getAllNotesFlat(limit = 100) {
  return q(
    `SELECT group_id, keyword, note_text FROM notes
     ORDER BY group_id, keyword LIMIT ?`
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
     ON CONFLICT(id) DO UPDATE SET qr_string = excluded.qr_string`
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
       updated_at = excluded.updated_at`
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
  };
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
 * @param {object} userData - { jid, lid?, phone?, isOwner?, isAdmin?, displayName? }
 */
function saveUserMetadata(userData) {
  if (!userData?.jid) return;
  const now = Date.now();
  const existing = userRow(userData.jid);

  const row = {
    user_jid: userData.jid,
    user_lid: userData.lid || existing?.user_lid || null,
    phone_number: userData.phone || existing?.phone_number || null,
    is_owner:
      userData.isOwner === undefined
        ? existing?.is_owner === 1
          ? 1
          : 0
        : bool(userData.isOwner),
    is_admin:
      userData.isAdmin === undefined
        ? existing?.is_admin === 1
          ? 1
          : 0
        : bool(userData.isAdmin),
    first_seen: existing?.first_seen ?? now,
    last_seen: now,
    display_name: userData.displayName || existing?.display_name || null,
  };

  q(
    `INSERT INTO user_metadata
       (user_jid, user_lid, phone_number, is_owner, is_admin, first_seen, last_seen, display_name)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_jid) DO UPDATE SET
       user_lid     = excluded.user_lid,
       phone_number = excluded.phone_number,
       is_owner     = excluded.is_owner,
       is_admin     = excluded.is_admin,
       last_seen    = excluded.last_seen,
       display_name = excluded.display_name`
  ).run(
    row.user_jid,
    row.user_lid,
    row.phone_number,
    row.is_owner,
    row.is_admin,
    row.first_seen,
    row.last_seen,
    row.display_name
  );
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
    row = q("SELECT * FROM user_metadata WHERE phone_number = ?").get(
      identifier
    );
  }

  if (!row) {
    const phone = digitsOf(identifier);
    if (phone) {
      row =
        q("SELECT * FROM user_metadata WHERE phone_number = ?").get(phone) ||
        q(
          `SELECT * FROM user_metadata
           WHERE user_jid LIKE ? OR user_lid LIKE ?
           LIMIT 1`
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
  return q("SELECT * FROM user_metadata WHERE is_owner = 1")
    .all()
    .map(rowToUser);
}

function getAllBotAdmins() {
  return q("SELECT * FROM user_metadata WHERE is_admin = 1")
    .all()
    .map(rowToUser);
}

function getAllUsers() {
  return q("SELECT * FROM user_metadata ORDER BY last_seen DESC")
    .all()
    .map(rowToUser);
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
    lid:
      existing?.lid || (String(identifier).endsWith("@lid") ? identifier : null),
    phone: existing?.phone || digitsOf(identifier),
    displayName: existing?.displayName || null,
    [wanted]: !!enabled,
  });

  return getUserMetadata(jid);
}

function updateUserLastSeen(jid) {
  q("UPDATE user_metadata SET last_seen = ? WHERE user_jid = ?").run(
    Date.now(),
    jid
  );
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
       expires_at        = excluded.expires_at`
  ).run(messageId, groupId, senderId, now, now, forwardExpiry());

  return (
    q("SELECT forward_count FROM forward_scores WHERE message_id = ?").get(
      messageId
    )?.forward_count ?? 1
  );
}

function getForwardScore(messageId) {
  const row = q("SELECT * FROM forward_scores WHERE message_id = ?").get(
    messageId
  );
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
     LIMIT ?`
  ).all(groupId, limit);
}

// ===================================================================
// --- Debts ---
// ===================================================================

function debtRow(row) {
  if (!row) return null;
  return { ...row, settled: row.settled === 1 };
}

function addDebt({
  groupId,
  debtorId,
  creditorId,
  amount,
  currency = "USD",
  description = null,
}) {
  const createdAt = Date.now();
  const { lastInsertRowid } = q(
    `INSERT INTO debts
       (group_id, debtor_id, creditor_id, amount, currency, description, created_at, settled, settled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL)`
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
     ORDER BY created_at DESC`
  )
    .all(groupId, bool(settled))
    .map(debtRow);
}

function getRecentDebts(limit = 50) {
  return q("SELECT * FROM debts ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(debtRow);
}

function countDebts(settled = false) {
  return q("SELECT COUNT(*) AS n FROM debts WHERE settled = ?").get(
    bool(settled)
  ).n;
}

// ===================================================================
// --- Scheduled messages ---
// ===================================================================
//
// Used to be config/schedule.json. In the database the dashboard can list
// them, and a crash in the middle of a write can't truncate the file.
//
// A job is `{ id, type, targetJid, message, cronString?, date?, status,
// creatorJid }` — the shape !schedule and !autoschedule have always built.

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
       (id, type, target_jid, message, cron_string, date, status, creator_jid, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       type        = excluded.type,
       target_jid  = excluded.target_jid,
       message     = excluded.message,
       cron_string = excluded.cron_string,
       date        = excluded.date,
       status      = excluded.status,
       creator_jid = excluded.creator_jid`
  ).run(
    String(job.id),
    job.type,
    job.targetJid,
    job.message,
    job.cronString ?? null,
    job.date ?? null,
    job.status || "pending",
    job.creatorJid ?? null,
    job.createdAt ?? Date.now()
  );
  return getSchedule(job.id);
}

function setScheduleStatus(id, status) {
  q("UPDATE schedules SET status = ? WHERE id = ?").run(status, String(id));
}

function deleteSchedule(id) {
  const { changes } = q("DELETE FROM schedules WHERE id = ?").run(String(id));
  return changes > 0;
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
       updated_at = excluded.updated_at`
  ).run(chatId, JSON.stringify(historyArray || []), Date.now());
}

function deleteChatHistory(chatId) {
  const { changes } = q("DELETE FROM ai_history WHERE chat_id = ?").run(chatId);
  return changes > 0;
}

function deleteAllChatHistories() {
  q("DELETE FROM ai_history").run();
}

// ===================================================================
// --- Baileys auth ---
// ===================================================================
//
// Values arrive already serialized by BufferJSON (see auth-storage.cjs), so
// they are stored as text and handed back as text.

function authRead(key) {
  const row = q("SELECT value FROM baileys_auth WHERE key = ?").get(key);
  return row ? row.value : null;
}

function authWrite(key, serialized) {
  q(
    `INSERT INTO baileys_auth (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, serialized);
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
  getLidsForPns,
  getPnForLid,
  getAllLidMappings,
  // User metadata & roles
  saveUserMetadata,
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
  deleteSchedule,
  countSchedules,
  // AI history
  getChatHistory,
  saveChatHistory,
  deleteChatHistory,
  deleteAllChatHistories,
  // Baileys auth
  authRead,
  authWrite,
  authRemove,
  authClearAll,
  hasCredentials,
};
