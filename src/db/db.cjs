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
  // v3 — persisted group names/sizes so the panel still shows them after a
  // restart, and so unlink can wipe the WhatsApp directory in one place.
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS group_directory (
        group_id TEXT PRIMARY KEY,
        subject TEXT,
        participant_count INTEGER,
        updated_at INTEGER NOT NULL
      );
    `);
  },
  // v4 — address-book name from the linked phone (Baileys `contact.name`),
  // distinct from the push name in display_name. Cleared with user_metadata
  // on unlink.
  (database) => {
    database.exec(`
      ALTER TABLE user_metadata ADD COLUMN saved_name TEXT;
    `);
  },
  // v5 — Sticker Studio. One row per sticker per owner; the WebP itself lives
  // outside the database, content-addressed by sha256, and is deleted only
  // when no row (any owner) still points at it. Pack items cascade so a
  // deleted sticker or pack cannot leave a dangling membership. Wiped on
  // unlink with the rest of the account.
  (database) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS stickers (
        id           TEXT PRIMARY KEY,
        owner        TEXT NOT NULL,
        sha256       TEXT NOT NULL,
        name         TEXT NOT NULL DEFAULT '',
        animated     INTEGER NOT NULL DEFAULT 0,
        width        INTEGER,
        height       INTEGER,
        duration_ms  INTEGER,
        file_size    INTEGER NOT NULL,
        source       TEXT NOT NULL,
        source_mime  TEXT,
        is_favorite  INTEGER NOT NULL DEFAULT 0,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        UNIQUE (owner, sha256)
      );
      CREATE INDEX IF NOT EXISTS idx_stickers_owner_created
        ON stickers (owner, created_at);
      CREATE INDEX IF NOT EXISTS idx_stickers_owner_name
        ON stickers (owner, name);
      CREATE INDEX IF NOT EXISTS idx_stickers_sha
        ON stickers (sha256);

      CREATE TABLE IF NOT EXISTS sticker_packs (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        name       TEXT NOT NULL,
        name_key   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner, name_key)
      );
      CREATE INDEX IF NOT EXISTS idx_sticker_packs_owner
        ON sticker_packs (owner, name_key);

      CREATE TABLE IF NOT EXISTS sticker_pack_items (
        pack_id    TEXT NOT NULL,
        sticker_id TEXT NOT NULL,
        position   INTEGER NOT NULL,
        added_at   INTEGER NOT NULL,
        PRIMARY KEY (pack_id, sticker_id),
        FOREIGN KEY (pack_id) REFERENCES sticker_packs (id) ON DELETE CASCADE,
        FOREIGN KEY (sticker_id) REFERENCES stickers (id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sticker_pack_items_sticker
        ON sticker_pack_items (sticker_id);
      CREATE INDEX IF NOT EXISTS idx_sticker_pack_items_order
        ON sticker_pack_items (pack_id, position);
    `);
  },
  // v6 — a sticker library belongs to sticker_owners.id, never a phone JID.
  // A legacy phone key is attached to a LID only when lid_mapping holds exactly
  // one normalized LID for that number. Zero or several stay unbound: the rows
  // are kept and no sender can open them. Keys that resolve to the same LID
  // are merged here. This step is frozen: it inlines its own JID normalization
  // and does not import the application.
  (database) => {
    const crypto = require("node:crypto");

    database.exec(`
      CREATE TABLE sticker_owners (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('self','user')),
        account    TEXT UNIQUE,
        legacy_key TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_sticker_owners_self
        ON sticker_owners (kind) WHERE kind = 'self';
    `);

    // Frozen copy of normalizeJid. A shipped migration cannot follow later edits.
    const normalizeJid = (jid) => {
      if (!jid) return jid;
      const text = String(jid);
      if (text.includes("@lid")) {
        if (text.includes(":")) return `${text.split(":")[0]}@lid`;
        return text;
      }
      if (text.includes(":")) return `${text.split(":")[0]}@${text.split("@")[1]}`;
      return text;
    };
    const isLid = (jid) => typeof jid === "string" && jid.includes("@lid");
    const isPn = (jid) => typeof jid === "string" && jid.includes("@s.whatsapp.net");

    const run = (sql, ...params) => database.prepare(sql).run(...params);
    const all = (sql, ...params) => database.prepare(sql).all(...params);

    // Same row set as store.getLidsForPn, then distinct normalized LIDs.
    const lidsForPn = (pn) => {
      if (!pn) return [];
      const found = new Set();
      const consider = (rows) => {
        for (const row of rows) {
          if (!row?.lid || !row?.pn) continue;
          if (normalizeJid(row.pn) !== pn && row.pn !== pn) continue;
          const lid = normalizeJid(row.lid);
          if (isLid(lid)) found.add(lid);
        }
      };
      consider(all("SELECT lid, pn FROM lid_mapping WHERE pn = ?", pn));
      if (!String(pn).includes(":")) {
        const at = String(pn).lastIndexOf("@");
        if (at > 0) {
          const user = String(pn).slice(0, at);
          consider(
            all("SELECT lid, pn FROM lid_mapping WHERE pn >= ? AND pn < ?", `${user}:`, `${user};`),
          );
        }
      }
      return [...found];
    };

    const classify = (legacy) => {
      if (legacy === "self") {
        return {
          bucket: "self",
          kind: "self",
          account: null,
          legacyKey: "self",
          normalized: "self",
          original: legacy,
        };
      }
      const norm = normalizeJid(legacy);
      if (isLid(norm)) {
        return {
          bucket: `account:${norm}`,
          kind: "user",
          account: norm,
          legacyKey: norm,
          normalized: norm,
          original: legacy,
        };
      }
      if (isPn(norm)) {
        const lids = lidsForPn(norm);
        if (lids.length === 1) {
          return {
            bucket: `account:${lids[0]}`,
            kind: "user",
            account: lids[0],
            legacyKey: norm,
            normalized: norm,
            original: legacy,
          };
        }
        return {
          bucket: `unbound-pn:${norm}`,
          kind: "user",
          account: null,
          legacyKey: norm,
          normalized: norm,
          original: legacy,
        };
      }
      return {
        bucket: `raw:${legacy}`,
        kind: "user",
        account: null,
        legacyKey: legacy,
        normalized: norm,
        original: legacy,
      };
    };

    const legacyOwners = all(
      `SELECT owner FROM stickers
       UNION
       SELECT owner FROM sticker_packs`,
    );
    if (!legacyOwners.length) return;

    const groups = new Map();
    for (const row of legacyOwners) {
      const info = classify(row.owner);
      const group = groups.get(info.bucket);
      if (group) group.entries.push(info);
      else groups.set(info.bucket, { kind: info.kind, account: info.account, entries: [info] });
    }

    const usedIds = new Set();
    const newId = () => {
      for (;;) {
        const id = crypto.randomBytes(8).toString("hex");
        if (!usedIds.has(id)) {
          usedIds.add(id);
          return id;
        }
      }
    };
    const now = Date.now();

    const renumberPack = (packId) => {
      const items = all(
        `SELECT sticker_id FROM sticker_pack_items
         WHERE pack_id = ?
         ORDER BY position ASC, added_at ASC, sticker_id ASC`,
        packId,
      );
      for (let index = 0; index < items.length; index += 1) {
        run(
          "UPDATE sticker_pack_items SET position = ? WHERE pack_id = ? AND sticker_id = ?",
          index,
          packId,
          items[index].sticker_id,
        );
      }
    };

    const retargetItems = (fromStickerId, toStickerId) => {
      const items = all(
        "SELECT pack_id FROM sticker_pack_items WHERE sticker_id = ?",
        fromStickerId,
      );
      for (const item of items) {
        const exists = database
          .prepare("SELECT 1 AS x FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?")
          .get(item.pack_id, toStickerId);
        if (exists) {
          run(
            "DELETE FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?",
            item.pack_id,
            fromStickerId,
          );
        } else {
          run(
            "UPDATE sticker_pack_items SET sticker_id = ? WHERE pack_id = ? AND sticker_id = ?",
            toStickerId,
            item.pack_id,
            fromStickerId,
          );
        }
        renumberPack(item.pack_id);
      }
    };

    const appendPack = (fromPackId, toPackId) => {
      const items = all(
        `SELECT sticker_id FROM sticker_pack_items
         WHERE pack_id = ?
         ORDER BY position ASC, added_at ASC`,
        fromPackId,
      );
      for (const item of items) {
        const exists = database
          .prepare("SELECT 1 AS x FROM sticker_pack_items WHERE pack_id = ? AND sticker_id = ?")
          .get(toPackId, item.sticker_id);
        if (exists) continue;
        const count = database
          .prepare("SELECT COUNT(*) AS n FROM sticker_pack_items WHERE pack_id = ?")
          .get(toPackId).n;
        run(
          `INSERT INTO sticker_pack_items (pack_id, sticker_id, position, added_at)
           VALUES (?, ?, ?, ?)`,
          toPackId,
          item.sticker_id,
          count,
          now,
        );
      }
    };

    const placeholders = (values) => values.map(() => "?").join(", ");

    const mergeStickers = (legacyKeys) => {
      if (legacyKeys.length < 2) return;
      const marks = placeholders(legacyKeys);
      const rows = all(`SELECT * FROM stickers WHERE owner IN (${marks})`, ...legacyKeys);
      const bySha = new Map();
      for (const row of rows) {
        const group = bySha.get(row.sha256);
        if (group) group.push(row);
        else bySha.set(row.sha256, [row]);
      }
      for (const group of bySha.values()) {
        if (group.length < 2) continue;
        group.sort(
          (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
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
          retargetItems(extra.id, keep.id);
          run("DELETE FROM stickers WHERE id = ?", extra.id);
        }
        run(
          `UPDATE stickers
           SET name = ?, is_favorite = ?, last_used_at = ?, created_at = ?
           WHERE id = ?`,
          name,
          favorite,
          lastUsed,
          created,
          keep.id,
        );
      }
    };

    const mergePacks = (legacyKeys) => {
      if (legacyKeys.length < 2) return;
      const marks = placeholders(legacyKeys);
      const packs = all(`SELECT * FROM sticker_packs WHERE owner IN (${marks})`, ...legacyKeys);
      const byName = new Map();
      for (const pack of packs) {
        const group = byName.get(pack.name_key);
        if (group) group.push(pack);
        else byName.set(pack.name_key, [pack]);
      }
      for (const group of byName.values()) {
        if (group.length < 2) continue;
        group.sort(
          (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
        const keep = group[0];
        for (const extra of group.slice(1)) {
          appendPack(extra.id, keep.id);
          run("DELETE FROM sticker_pack_items WHERE pack_id = ?", extra.id);
          run("DELETE FROM sticker_packs WHERE id = ?", extra.id);
          renumberPack(keep.id);
        }
      }
    };

    const repoint = (legacyKeys, ownerId) => {
      const marks = placeholders(legacyKeys);
      run(`UPDATE stickers SET owner = ? WHERE owner IN (${marks})`, ownerId, ...legacyKeys);
      run(`UPDATE sticker_packs SET owner = ? WHERE owner IN (${marks})`, ownerId, ...legacyKeys);
    };

    for (const group of groups.values()) {
      // Stickers still carry the v5 owner string. Merge and repoint those,
      // and only then give the survivor the new id.
      const originals = [...new Set(group.entries.map((entry) => entry.original))];
      const accountMatch = group.account
        ? group.entries.find((entry) => entry.normalized === group.account)
        : null;
      const legacyKey = accountMatch
        ? accountMatch.legacyKey
        : group.entries.map((entry) => entry.legacyKey).sort()[0];
      const id = newId();
      run(
        `INSERT INTO sticker_owners (id, kind, account, legacy_key, created_at)
         VALUES (?, ?, ?, ?, ?)`,
        id,
        group.kind,
        group.account,
        legacyKey,
        now,
      );
      mergeStickers(originals);
      mergePacks(originals);
      repoint(originals, id);
    }
  },
  // v6 — scheduled messages can carry one media file. The bytes live in
  // <data>/media/schedules/<job id>; this column holds the metadata the
  // delivery needs (kind, MIME type, file name).
  (database) => {
    database.exec(`ALTER TABLE schedules ADD COLUMN media TEXT;`);
  },
  // v8 — keyword auto-delete rules, plus an opt-in log of text/caption copies
  // of messages a rule actually deleted (never media bytes).
  (database) => {
    database.exec(`
      CREATE TABLE auto_delete_rules (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        name            TEXT,
        enabled         INTEGER NOT NULL DEFAULT 1,
        keywords        TEXT NOT NULL,
        match_mode      TEXT NOT NULL CHECK (match_mode IN ('contains','word','exact')),
        chat_scope      TEXT NOT NULL CHECK (chat_scope IN ('all','groups','private')),
        senders_mode    TEXT NOT NULL CHECK (senders_mode IN ('everyone','selected')),
        senders_list    TEXT NOT NULL DEFAULT '[]',
        include_own     INTEGER NOT NULL DEFAULT 0,
        for_everyone    INTEGER NOT NULL DEFAULT 1,
        keep_copy       INTEGER NOT NULL DEFAULT 0,
        deleted_count   INTEGER NOT NULL DEFAULT 0,
        last_deleted_at INTEGER,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX idx_auto_delete_rules_enabled
        ON auto_delete_rules (enabled, id);

      CREATE TABLE auto_delete_log (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id    INTEGER NOT NULL,
        chat_jid   TEXT NOT NULL,
        sender     TEXT,
        text       TEXT,
        media_type TEXT,
        mode       TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (rule_id) REFERENCES auto_delete_rules (id) ON DELETE CASCADE
      );
      CREATE INDEX idx_auto_delete_log_created ON auto_delete_log (created_at);
      CREATE INDEX idx_auto_delete_log_rule ON auto_delete_log (rule_id, created_at);
    `);
  },
];

function migrate(database, migrations = MIGRATIONS) {
  const { user_version: current } = database.prepare("PRAGMA user_version").get();

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
    const { changes } = q("DELETE FROM forward_scores WHERE expires_at < ?").run(Date.now());
    if (changes) logger.debug(`[DB] Swept ${changes} expired forward score(s)`);
  } catch (err) {
    logger.error({ err }, "[DB] sweep failed");
  }
  try {
    let days = 30;
    try {
      days = require("../config/settings.cjs").get("auto_delete_keep_days");
    } catch {
      days = 30;
    }
    const cutoff = Date.now() - Number(days || 30) * 24 * 60 * 60 * 1000;
    const { changes } = q("DELETE FROM auto_delete_log WHERE created_at < ?").run(cutoff);
    if (changes) logger.debug(`[DB] Swept ${changes} expired auto-delete copies`);
    q(
      `DELETE FROM auto_delete_log WHERE id NOT IN (
         SELECT id FROM auto_delete_log ORDER BY created_at DESC, id DESC LIMIT 5000
       )`,
    ).run();
  } catch (err) {
    logger.error({ err }, "[DB] auto-delete log sweep failed");
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
