-- Frozen released schema, independently materialized from historical migrations.
-- v4.9.1: 6fb29798bba4fc08a199f7a92864781767d7f513
-- v4.9.2: 781eab56a1e6a46b7167edfe2143e2955a92173d
-- Both produce the identical schema below; synthetic data is seeded by v49-upgrade.test.mjs.

CREATE TABLE bot_settings (
        key   TEXT PRIMARY KEY,
        value TEXT
      );

CREATE TABLE group_settings (
        group_id TEXT PRIMARY KEY,
        settings TEXT NOT NULL DEFAULT '{}'
      );

CREATE TABLE warnings (
        group_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        warnings TEXT NOT NULL DEFAULT '[]',
        PRIMARY KEY (group_id, user_id)
      );

CREATE TABLE todos (
        user_id TEXT PRIMARY KEY,
        tasks   TEXT NOT NULL DEFAULT '[]'
      );

CREATE TABLE notes (
        group_id  TEXT NOT NULL,
        keyword   TEXT NOT NULL,
        note_text TEXT NOT NULL,
        PRIMARY KEY (group_id, keyword)
      );

CREATE TABLE qr_codes (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        qr_string TEXT NOT NULL
      );

CREATE TABLE lid_mapping (
        lid          TEXT PRIMARY KEY,
        pn           TEXT NOT NULL,
        device_index INTEGER NOT NULL DEFAULT 0,
        updated_at   INTEGER NOT NULL
      );

CREATE INDEX idx_lid_mapping_pn ON lid_mapping (pn);

CREATE TABLE user_metadata (
        user_jid     TEXT PRIMARY KEY,
        user_lid     TEXT,
        phone_number TEXT,
        is_owner     INTEGER NOT NULL DEFAULT 0,
        is_admin     INTEGER NOT NULL DEFAULT 0,
        first_seen   INTEGER NOT NULL,
        last_seen    INTEGER NOT NULL,
        display_name TEXT
      , saved_name TEXT);

CREATE INDEX idx_users_lid   ON user_metadata (user_lid);

CREATE INDEX idx_users_phone ON user_metadata (phone_number);

CREATE INDEX idx_users_owner ON user_metadata (is_owner);

CREATE INDEX idx_users_admin ON user_metadata (is_admin);

CREATE TABLE debts (
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

CREATE INDEX idx_debts_group ON debts (group_id, settled);

CREATE TABLE forward_scores (
        message_id         TEXT PRIMARY KEY,
        group_id           TEXT NOT NULL,
        original_sender    TEXT NOT NULL,
        forward_count      INTEGER NOT NULL DEFAULT 0,
        first_forwarded_at INTEGER NOT NULL,
        last_forwarded_at  INTEGER NOT NULL,
        expires_at         INTEGER NOT NULL
      );

CREATE INDEX idx_forward_group   ON forward_scores (group_id);

CREATE INDEX idx_forward_expires ON forward_scores (expires_at);

CREATE TABLE ai_history (
        chat_id    TEXT PRIMARY KEY,
        history    TEXT NOT NULL DEFAULT '[]',
        updated_at INTEGER NOT NULL
      );

CREATE TABLE baileys_auth (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

CREATE TABLE schedules (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL,             -- 'once' | 'recurring'
        target_jid  TEXT NOT NULL,
        message     TEXT NOT NULL,
        cron_string TEXT,                      -- recurring only
        date        TEXT,                      -- once only, ISO 8601
        status      TEXT NOT NULL DEFAULT 'pending',
        creator_jid TEXT,
        created_at  INTEGER NOT NULL
      , last_run_at INTEGER, last_delivery_status TEXT, last_error TEXT, media TEXT);

CREATE TABLE group_directory (
        group_id TEXT PRIMARY KEY,
        subject TEXT,
        participant_count INTEGER,
        updated_at INTEGER NOT NULL
      );

CREATE TABLE stickers (
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

CREATE INDEX idx_stickers_owner_created
        ON stickers (owner, created_at);

CREATE INDEX idx_stickers_owner_name
        ON stickers (owner, name);

CREATE INDEX idx_stickers_sha
        ON stickers (sha256);

CREATE TABLE sticker_packs (
        id         TEXT PRIMARY KEY,
        owner      TEXT NOT NULL,
        name       TEXT NOT NULL,
        name_key   TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE (owner, name_key)
      );

CREATE INDEX idx_sticker_packs_owner
        ON sticker_packs (owner, name_key);

CREATE TABLE sticker_pack_items (
        pack_id    TEXT NOT NULL,
        sticker_id TEXT NOT NULL,
        position   INTEGER NOT NULL,
        added_at   INTEGER NOT NULL,
        PRIMARY KEY (pack_id, sticker_id),
        FOREIGN KEY (pack_id) REFERENCES sticker_packs (id) ON DELETE CASCADE,
        FOREIGN KEY (sticker_id) REFERENCES stickers (id) ON DELETE CASCADE
      );

CREATE INDEX idx_sticker_pack_items_sticker
        ON sticker_pack_items (sticker_id);

CREATE INDEX idx_sticker_pack_items_order
        ON sticker_pack_items (pack_id, position);

CREATE TABLE sticker_owners (
        id         TEXT PRIMARY KEY,
        kind       TEXT NOT NULL CHECK (kind IN ('self','user')),
        account    TEXT UNIQUE,
        legacy_key TEXT,
        created_at INTEGER NOT NULL
      );

CREATE UNIQUE INDEX idx_sticker_owners_self
        ON sticker_owners (kind) WHERE kind = 'self';

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

CREATE TABLE moderation_flags (
        group_id   TEXT NOT NULL,
        user_id    TEXT NOT NULL,
        warn_count INTEGER NOT NULL DEFAULT 0,
        last_rule  TEXT,
        flagged_at INTEGER NOT NULL,
        reasons    TEXT NOT NULL DEFAULT '[]', last_notified_at INTEGER, repeat_points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (group_id, user_id)
      );

CREATE INDEX idx_moderation_flags_group ON moderation_flags (group_id, flagged_at);

CREATE TABLE moderation_applied (
        group_id    TEXT NOT NULL,
        message_id  TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        kicked      INTEGER NOT NULL DEFAULT 0,
        notified    INTEGER NOT NULL DEFAULT 0,
        applied_at  INTEGER NOT NULL,
        PRIMARY KEY (group_id, message_id)
      );

CREATE INDEX idx_moderation_applied_at ON moderation_applied (applied_at);

PRAGMA user_version = 10;
