/** The schema this build writes; a newer or foreign database is never opened. */
export const VAULT_STORE_SCHEMA_VERSION = 1;

/*
 * Plan r4 Q5 rule 3. Committed rows hold the authenticated fields plus the
 * ciphertext. Intents hold no secret and no key: a put carries its receipt
 * MAC, a delete its keyless receipt hash. One AUTOINCREMENT sequence orders
 * every intent and is never reused, even after retention removes rows.
 * Caller text that may hold a NUL (entry ID, label, idempotency key) is a
 * UTF-8 BLOB: node:sqlite cuts TEXT reads at the first NUL.
 * Open compares the stored SQL with this text exactly: any edit, whitespace
 * included, needs a new schema version.
 */
export const VAULT_STORE_SCHEMA: readonly string[] = [
  `CREATE TABLE vault_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE vault_header (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    format_version INTEGER NOT NULL,
    vault_id TEXT NOT NULL,
    wrap_nonce BLOB NOT NULL,
    wrap_ciphertext BLOB NOT NULL,
    wrap_tag BLOB NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE vault_entries (
    entry_id BLOB PRIMARY KEY,
    family TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    expires_at TEXT,
    label BLOB NOT NULL,
    nonce BLOB NOT NULL,
    ciphertext BLOB NOT NULL,
    tag BLOB NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT`,
  // `outcome_revision` is the committed pin or tombstone revision, kept so
  // an accepted key can replay its outcome.
  `CREATE TABLE vault_intents (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('put', 'delete')),
    family TEXT NOT NULL,
    idempotency_key BLOB NOT NULL,
    entry_id BLOB NOT NULL,
    expected_revision INTEGER CHECK (expected_revision >= 0),
    receipt BLOB NOT NULL CHECK (length(receipt) = 32),
    state TEXT NOT NULL CHECK (state IN ('pending', 'committed')),
    outcome_revision INTEGER CHECK (outcome_revision >= 0),
    recorded_at TEXT NOT NULL,
    CHECK (kind = 'put' OR expected_revision IS NOT NULL),
    CHECK ((state = 'pending') = (outcome_revision IS NULL)),
    UNIQUE (family, idempotency_key)
  ) STRICT`,
  `CREATE INDEX vault_intents_by_entry ON vault_intents (entry_id, sequence)`,
  // `committed_at` starts the 30-day retention (2026-10-29 checkpoint).
  `CREATE TABLE vault_tombstones (
    entry_id BLOB PRIMARY KEY,
    family TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 0),
    sequence INTEGER NOT NULL,
    committed_at TEXT NOT NULL
  ) STRICT`,
  // A tombstoned entry ID is never written again.
  `CREATE TRIGGER vault_entries_not_tombstoned
    BEFORE INSERT ON vault_entries
    WHEN EXISTS (SELECT 1 FROM vault_tombstones WHERE entry_id = NEW.entry_id)
    BEGIN SELECT RAISE(ABORT, 'vault entry is tombstoned'); END`,
];
