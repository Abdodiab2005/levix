// The database. One SQLite file, opened synchronously, no server to install.
//
// WHY node:sqlite
// ---------------
// Node 22.5+ ships SQLite in the standard library, so this costs zero
// dependencies: nothing to compile, nothing to `npm install`, no daemon to
// start. That matters here because the bot is meant to be handed to someone
// who is not a developer — "install Node, run levix" has to be the whole
// story.
//
// It is also synchronous, which is what the rest of the codebase already
// assumes: ~40 storage call sites (the anti-spam and blacklist middleware, the
// prefix lookup, every permission check) read inline with no `await`.
//
// The file lives in the data directory (src/config/paths.cjs), together with
// everything else the bot writes. The schema is created on open and versioned
// with `PRAGMA user_version`, so upgrading never asks the operator to run a
// migration by hand.

const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const logger = require("../utils/logger.cjs");
const { DATA_DIR, dataPath } = require("../config/paths.cjs");

const DB_PATH = path.join(DATA_DIR, "levix.db");

// ===================================================================
// --- Open ---
// ===================================================================

const db = new DatabaseSync(DB_PATH);

// WAL: a reader never blocks the writer. The bot is a single process, but the
// scheduler and the HTTP handlers do interleave.
db.exec("PRAGMA journal_mode = WAL");
// NORMAL is the WAL-appropriate setting: a crash can lose the last commit or
// two, never the file. FULL would fsync on every warning counter.
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA foreign_keys = ON");
// Wait instead of throwing SQLITE_BUSY if the checkpointer holds the lock.
db.exec("PRAGMA busy_timeout = 5000");

// ===================================================================
// --- Schema ---
// ===================================================================
//
// Every migration is a function that takes the database from version N-1 to N.
// `PRAGMA user_version` records where we are; new versions are appended to the
// array and run on the next start. Never edit a migration that has shipped.

const MIGRATIONS = [
  // v1 — the initial schema.
  (database) => {
    database.exec(`
      -- Bot-wide key/value. Holds the prefix, every dashboard setting
      -- ("setting:*"), the command permission/alias/disabled override maps,
      -- and the generated secrets. Values are JSON so an object round-trips.
      CREATE TABLE IF NOT EXISTS bot_settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

      CREATE TABLE IF NOT EXISTS group_settings (
        group_id TEXT PRIMARY KEY,
        settings TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS warnings (
        group_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        warnings TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS todos (
        user_id TEXT PRIMARY KEY,
        tasks   TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS notes (
        group_id  TEXT NOT NULL,
        keyword   TEXT NOT NULL,
        note_text TEXT NOT NULL,
        PRIMARY KEY (group_id, keyword)
      );

      -- There is only ever one pairing QR.
      CREATE TABLE IF NOT EXISTS qr_codes (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        qr_string TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS lid_mapping (
        lid          TEXT PRIMARY KEY,
        pn           TEXT NOT NULL,
        device_index INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_lid_mapping_pn ON lid_mapping (pn);

      CREATE TABLE IF NOT EXISTS user_metadata (
        user_jid     TEXT PRIMARY KEY,
        user_lid     TEXT,
        phone_number TEXT,
        is_owner     INTEGER NOT NULL DEFAULT 0,
        is_admin     INTEGER NOT NULL DEFAULT 0,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        display_name TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_users_lid   ON user_metadata (user_lid);
      CREATE INDEX IF NOT EXISTS idx_users_phone ON user_metadata (phone_number);
      CREATE INDEX IF NOT EXISTS idx_users_owner ON user_metadata (is_owner);
      CREATE INDEX IF NOT EXISTS idx_users_admin ON user_metadata (is_admin);

      CREATE TABLE IF NOT EXISTS debts (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id    TEXT NOT NULL,
        debtor_id   TEXT NOT NULL,
        creditor_id TEXT NOT NULL,
        amount      REAL NOT NULL,
        currency    TEXT NOT NULL DEFAULT 'USD',
        description TEXT,
        created_at  INTEGER NOT NULL,
        settled     INTEGER NOT NULL DEFAULT 0,
        settled_at  INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_debts_group ON debts (group_id, settled);

      -- Forward counters. One row per forwarded message, so this one expires;
      -- the sweep runs at boot and every few hours (see sweepExpired()).
      CREATE TABLE IF NOT EXISTS forward_scores (
        message_id         TEXT PRIMARY KEY,
        group_id           TEXT NOT NULL,
        original_sender    TEXT NOT NULL,
        forward_count      INTEGER NOT NULL DEFAULT 0,
        first_forwarded_at INTEGER NOT NULL,
        last_forwarded_at  INTEGER NOT NULL,
        expires_at         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_forward_group   ON forward_scores (group_id);
      CREATE INDEX IF NOT EXISTS idx_forward_expires ON forward_scores (expires_at);

      -- Gemini conversation history, one row per chat. No expiry: wiped with
      -- !del / !delall only.
      CREATE TABLE IF NOT EXISTS ai_history (
        chat_id    TEXT PRIMARY KEY,
        history    TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

      -- Baileys credentials and session keys. No expiry either: losing these
      -- means scanning the QR again.
      CREATE TABLE IF NOT EXISTS baileys_auth (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- Scheduled messages (!schedule / !autoschedule). Used to be
      -- config/schedule.json, which the dashboard couldn't see and a crash
      -- mid-write could truncate.
      CREATE TABLE IF NOT EXISTS schedules (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,             -- 'once' | 'recurring'
        target_jid  TEXT NOT NULL,
        message     TEXT NOT NULL,
        cron_string TEXT,                      -- recurring only
        date        TEXT,                      -- once only, ISO 8601
        status      TEXT NOT NULL DEFAULT 'pending',
        creator_jid TEXT,
        created_at  INTEGER NOT NULL
      );
    `);
  },
  // v2 — delivery history for truthful schedule status and manual retries.
  (database) => {
    database.exec(`
      ALTER TABLE schedules ADD COLUMN last_run_at INTEGER;
      ALTER TABLE schedules ADD COLUMN last_delivery_status TEXT;
      ALTER TABLE schedules ADD COLUMN last_error TEXT;
    `);
  },
];

function migrate(database, migrations = MIGRATIONS) {
  const { user_version: current } = database
    .prepare("PRAGMA user_version")
    .get();

  if (current >= migrations.length) return;

  for (let version = current; version < migrations.length; version += 1) {
    // One transaction per migration, covering the version stamp as well.
    // `user_version` lives in the database header and is written inside the
    // transaction like anything else, so a crash or a power cut halfway
    // through rolls the whole step back: the next start sees the old version
    // and runs it again from a known state. Without this a half-applied
    // migration would be recorded as complete.
    database.exec("BEGIN IMMEDIATE");
    try {
      migrations[version](database);
      // PRAGMA takes no bound parameter; the value is a loop counter, not
      // anything a user can reach.
      database.exec(`PRAGMA user_version = ${version + 1}`);
      database.exec("COMMIT");
    } catch (err) {
      try {
        database.exec("ROLLBACK");
      } catch {}
      logger.error({ err }, `[DB] Migration to v${version + 1} failed and was rolled back`);
      throw err;
    }
    logger.info(`[DB] Migrated to schema v${version + 1}`);
  }
}

migrate(db);

// ===================================================================
// --- Helpers shared by the store ---
// ===================================================================

// Prepared statements are cached: the hot path (a permission check per
// message) shouldn't re-parse the same SQL every time.
const statementCache = new Map();

function q(sql) {
  let statement = statementCache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statementCache.set(sql, statement);
  }
  return statement;
}

/** JSON that survives a corrupt/legacy row instead of taking the bot down. */
function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** Delete whatever has aged out. Cheap; called at boot and on a timer. */
function sweepExpired() {
  try {
    const { changes } = q("DELETE FROM forward_scores WHERE expires_at < ?").run(
      Date.now()
    );
    if (changes) logger.debug(`[DB] Swept ${changes} expired forward score(s)`);
  } catch (err) {
    logger.error({ err }, "[DB] sweep failed");
  }
}

/** Flush the WAL into the main file — called on shutdown and after a backup. */
function checkpoint() {
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (err) {
    logger.error({ err }, "[DB] checkpoint failed");
  }
}

function close() {
  checkpoint();
  try {
    db.close();
  } catch {}
}

module.exports = {
  db,
  q,
  // Exported so the migration tests can drive the real machinery against a
  // scratch database — including a deliberately failing step, which is the
  // only way to prove the rollback works.
  migrate,
  MIGRATIONS,
  parseJson,
  sweepExpired,
  checkpoint,
  close,
  DATA_DIR,
  DB_PATH,
  dataPath,
};
