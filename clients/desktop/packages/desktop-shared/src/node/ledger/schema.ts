import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import { rollbackQuietly } from './database';
import { LedgerStoreError } from './errors';
import { rowText } from './rows';

/** The schema version this build reads and writes. */
export const LEDGER_SCHEMA_VERSION = 4;

const SCHEMA_VERSION_KEY = 'schema_version';
const CURSOR_SECRET_KEY = 'cursor_secret';
const CREATED_AT_KEY = 'created_at';
const AUTHORITY_ID_KEY = 'authority_id';
const CURSOR_SECRET_BYTES = 32;

/**
 * Schema version 1.
 *
 * - `ledger_meta`: schema version, the per-database cursor secret and the
 *   writer authority ID, a UUID minted with the database. It is a durable
 *   logical writer identity, not a machine identity: it moves with the file.
 * - `ledger_scopes`: one logical ledger per container incarnation. The
 *   container tuple plus the container's creation time is the identity key,
 *   so a reused container ID with a new creation time gets a new ledger. A
 *   restore rebinds an archived ledger to the restored incarnation, and
 *   `lifecycle_state` follows the container (see `lifecycle.ts`).
 *   `sequence` is the scope sequence every event of the scope is numbered by.
 * - `ledger_actors`: host-registered actors, unique by origin key per ledger.
 * - `ledger_entries`: the current projection of each entry.
 * - `ledger_entry_versions`: the projection of every revision and the scope
 *   sequence it was committed at; snapshot search reads these. Projections
 *   are immutable once an event may have left this device. A pending-title
 *   Add may rewrite them locally before its first event is pushed.
 * - `ledger_mutations`: immutable create/update history.
 * - `ledger_command_receipts`: idempotency receipts keyed by ledger, caller
 *   actor, operation and key, with the normalized request hash and the exact
 *   response.
 * - `ledger_outbox`: replication events in contiguous scope sequence. Written
 *   here; drained by the sync phase.
 * - `ledger_search`: FTS5 over title, content and highlights, keyed by the
 *   entry's rowid. Entry text is immutable once an event may have left this
 *   device, except that a pending-title Add can rewrite its local title before
 *   the first push; each entry still has one row. The tokenizer folds case but
 *   keeps diacritics, matching the literal search contract.
 *
 * Enumerated columns are validated in code rather than with CHECK
 * constraints, so a later version can extend them without rebuilding tables.
 */
const SCHEMA_VERSION_1_STATEMENTS: readonly string[] = [
  `CREATE TABLE ledger_meta (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
  ) STRICT`,
  `CREATE TABLE ledger_scopes (
    ledger_id TEXT PRIMARY KEY NOT NULL,
    authority_id TEXT NOT NULL,
    container_kind TEXT NOT NULL,
    container_parent_id TEXT NOT NULL,
    container_item_id TEXT NOT NULL,
    container_created_at TEXT NOT NULL,
    account_id TEXT,
    lifecycle_state TEXT NOT NULL DEFAULT 'active',
    sequence INTEGER NOT NULL DEFAULT 0 CHECK (sequence >= 0),
    created_at TEXT NOT NULL,
    UNIQUE (container_kind, container_parent_id, container_item_id, container_created_at)
  ) STRICT`,
  `CREATE TABLE ledger_actors (
    actor_id TEXT PRIMARY KEY NOT NULL,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    authority_id TEXT NOT NULL,
    origin_key TEXT NOT NULL,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (ledger_id, actor_id),
    UNIQUE (ledger_id, origin_key)
  ) STRICT`,
  `CREATE TABLE ledger_entries (
    entry_rowid INTEGER PRIMARY KEY,
    entry_id TEXT NOT NULL UNIQUE,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    scope_sequence INTEGER NOT NULL CHECK (scope_sequence >= 1),
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    author_actor_id TEXT NOT NULL,
    owner_actor_id TEXT NOT NULL,
    attribution_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    supersedes_entry_id TEXT,
    projection_json TEXT NOT NULL,
    FOREIGN KEY (ledger_id, author_actor_id) REFERENCES ledger_actors (ledger_id, actor_id),
    FOREIGN KEY (ledger_id, owner_actor_id) REFERENCES ledger_actors (ledger_id, actor_id)
  ) STRICT`,
  `CREATE INDEX ledger_entries_by_created
    ON ledger_entries (ledger_id, created_at DESC, entry_id DESC)`,
  `CREATE INDEX ledger_entries_by_updated
    ON ledger_entries (ledger_id, updated_at DESC, entry_id DESC)`,
  `CREATE INDEX ledger_entries_by_owner_status
    ON ledger_entries (ledger_id, owner_actor_id, status)`,
  `CREATE INDEX ledger_entries_by_author
    ON ledger_entries (ledger_id, author_actor_id)`,
  `CREATE INDEX ledger_entries_by_type_status
    ON ledger_entries (ledger_id, type, status)`,
  `CREATE TABLE ledger_entry_versions (
    version_rowid INTEGER PRIMARY KEY,
    entry_rowid INTEGER NOT NULL REFERENCES ledger_entries (entry_rowid) ON DELETE CASCADE,
    entry_id TEXT NOT NULL,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    scope_sequence INTEGER NOT NULL CHECK (scope_sequence >= 1),
    mutation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    author_actor_id TEXT NOT NULL,
    owner_actor_id TEXT NOT NULL,
    attribution_kind TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    projection_json TEXT NOT NULL,
    UNIQUE (entry_id, revision),
    UNIQUE (ledger_id, scope_sequence)
  ) STRICT`,
  `CREATE INDEX ledger_entry_versions_by_snapshot
    ON ledger_entry_versions (entry_rowid, scope_sequence)`,
  `CREATE TABLE ledger_mutations (
    mutation_rowid INTEGER PRIMARY KEY,
    mutation_id TEXT NOT NULL UNIQUE,
    entry_rowid INTEGER NOT NULL REFERENCES ledger_entries (entry_rowid) ON DELETE CASCADE,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    previous_revision INTEGER,
    scope_sequence INTEGER NOT NULL CHECK (scope_sequence >= 1),
    effective_actor_id TEXT NOT NULL,
    recorded_by_actor_id TEXT NOT NULL,
    occurred_at TEXT NOT NULL,
    mutation_json TEXT NOT NULL,
    UNIQUE (entry_rowid, revision),
    FOREIGN KEY (ledger_id, effective_actor_id) REFERENCES ledger_actors (ledger_id, actor_id),
    FOREIGN KEY (ledger_id, recorded_by_actor_id) REFERENCES ledger_actors (ledger_id, actor_id)
  ) STRICT`,
  `CREATE TABLE ledger_command_receipts (
    receipt_rowid INTEGER PRIMARY KEY,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    actor_id TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    mutation_id TEXT,
    response_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (ledger_id, actor_id, operation, idempotency_key),
    FOREIGN KEY (ledger_id, actor_id) REFERENCES ledger_actors (ledger_id, actor_id)
  ) STRICT`,
  `CREATE TABLE ledger_outbox (
    outbox_rowid INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    ledger_id TEXT NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    scope_sequence INTEGER NOT NULL CHECK (scope_sequence >= 1),
    kind TEXT NOT NULL,
    entry_id TEXT,
    entry_revision INTEGER,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TEXT,
    UNIQUE (ledger_id, scope_sequence)
  ) STRICT`,
  `CREATE VIRTUAL TABLE ledger_search USING fts5 (
    title,
    content,
    highlights,
    tokenize = 'unicode61 remove_diacritics 0'
  )`,
];

interface LedgerMigrationContext {
  /** Creation time recorded for a new database. */
  readonly createdAt: string;
}

interface LedgerSchemaMigration {
  /** Version the database has after this step commits. */
  readonly toVersion: number;
  readonly apply: (db: DatabaseSync, context: LedgerMigrationContext) => void;
}

function createSchemaVersion1(
  db: DatabaseSync,
  context: LedgerMigrationContext,
): void {
  for (const statement of SCHEMA_VERSION_1_STATEMENTS) {
    db.exec(statement);
  }
  const insert = db.prepare(
    'INSERT INTO ledger_meta (key, value) VALUES (?, ?)',
  );
  insert.run(
    CURSOR_SECRET_KEY,
    randomBytes(CURSOR_SECRET_BYTES).toString('base64url'),
  );
  insert.run(CREATED_AT_KEY, context.createdAt);
  insert.run(AUTHORITY_ID_KEY, randomUUID());
}

/**
 * Schema version 2 indexes the actor references of `ledger_mutations`.
 * Removing an actor or a scope, as a purge does, makes SQLite look up the
 * mutations that reference it; without these indexes each lookup scans every
 * scope's mutations. The step only adds indexes and rewrites no data, so it
 * needs no copy of the database first. `IF NOT EXISTS` keeps it safe on a
 * version 1 database whose build already created them.
 */
const SCHEMA_VERSION_2_STATEMENTS: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS ledger_mutations_by_effective_actor
    ON ledger_mutations (ledger_id, effective_actor_id)`,
  `CREATE INDEX IF NOT EXISTS ledger_mutations_by_recorded_by
    ON ledger_mutations (ledger_id, recorded_by_actor_id)`,
];

function indexMutationActors(db: DatabaseSync): void {
  for (const statement of SCHEMA_VERSION_2_STATEMENTS) {
    db.exec(statement);
  }
}

/**
 * Schema version 3 adds each scope's sync bookkeeping, `ledger_scope_sync`:
 * how far the mirror acknowledged the scope's events, the audience the mirror
 * last confirmed and when, and why the scope stopped syncing, if it did. A
 * scope with no row has synced nothing. The step only adds a table and
 * rewrites no data, so it needs no copy of the database first.
 */
const SCHEMA_VERSION_3_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS ledger_scope_sync (
    ledger_id TEXT PRIMARY KEY NOT NULL REFERENCES ledger_scopes (ledger_id) ON DELETE CASCADE,
    acknowledged_sequence INTEGER NOT NULL DEFAULT 0 CHECK (acknowledged_sequence >= 0),
    mirror_audience_json TEXT,
    audience_confirmed_at TEXT,
    repair_reason TEXT,
    updated_at TEXT NOT NULL
  ) STRICT`,
];

function addScopeSync(db: DatabaseSync): void {
  for (const statement of SCHEMA_VERSION_3_STATEMENTS) {
    db.exec(statement);
  }
}

/**
 * Schema version 4 tracks entries whose provisional title is still being
 * generated locally. The marker is keyed by entry and follows its lifecycle
 * through the entry's cascading foreign key; it is never part of the
 * canonical entry projection or the mirror payload.
 */
const SCHEMA_VERSION_4_STATEMENTS: readonly string[] = [
  `CREATE TABLE ledger_pending_titles (
    entry_id TEXT PRIMARY KEY NOT NULL REFERENCES ledger_entries (entry_id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_attempt_at TEXT
  ) STRICT`,
  `CREATE INDEX ledger_pending_titles_by_created
    ON ledger_pending_titles (created_at, entry_id)`,
];

function addPendingTitles(db: DatabaseSync): void {
  for (const statement of SCHEMA_VERSION_4_STATEMENTS) {
    db.exec(statement);
  }
}

/**
 * Ordered migration steps. Each runs in its own `BEGIN IMMEDIATE` transaction
 * that also records the new version, so a failure leaves the previous version
 * intact. A step that rewrites existing data must first copy the database
 * aside (for example with `VACUUM INTO`) so a failed upgrade is recoverable.
 * A new database runs every step.
 */
const LEDGER_SCHEMA_MIGRATIONS: readonly LedgerSchemaMigration[] = [
  { toVersion: 1, apply: createSchemaVersion1 },
  { toVersion: 2, apply: indexMutationActors },
  { toVersion: 3, apply: addScopeSync },
  { toVersion: 4, apply: addPendingTitles },
];

function tableExists(db: DatabaseSync, name: string): boolean {
  return (
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
      .get(name) !== undefined
  );
}

function readMetaValue(db: DatabaseSync, key: string): string | null {
  const row = db
    .prepare('SELECT value FROM ledger_meta WHERE key = ?')
    .get(key);
  return row === undefined ? null : rowText(row, 'value');
}

/**
 * The recorded schema version: 0 for a database without Ledger tables. A
 * missing or malformed version on an existing Ledger database is a storage
 * fault, never a reason to recreate the schema.
 */
export function readLedgerSchemaVersion(db: DatabaseSync): number {
  if (!tableExists(db, 'ledger_meta')) return 0;
  const value = readMetaValue(db, SCHEMA_VERSION_KEY);
  const version = value === null ? Number.NaN : Number(value);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'schema_version_unreadable',
    });
  }
  return version;
}

function runMigration(
  db: DatabaseSync,
  migration: LedgerSchemaMigration,
  context: LedgerMigrationContext,
): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    migration.apply(db, context);
    db.prepare(
      'INSERT INTO ledger_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    ).run(SCHEMA_VERSION_KEY, String(migration.toVersion));
    db.exec('COMMIT');
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

export interface LedgerMigrationResult {
  readonly version: number;
  /** True when the database is newer than this build and must stay read-only. */
  readonly newer: boolean;
}

/**
 * Migration entry point. Brings the database up to `LEDGER_SCHEMA_VERSION`.
 * A database from a newer build is left untouched and reported as `newer`;
 * the caller then opens it read-only.
 */
export function migrateLedgerSchema(
  db: DatabaseSync,
  context: LedgerMigrationContext,
): LedgerMigrationResult {
  const current = readLedgerSchemaVersion(db);
  if (current > LEDGER_SCHEMA_VERSION) {
    return { version: current, newer: true };
  }
  for (const migration of LEDGER_SCHEMA_MIGRATIONS) {
    if (migration.toVersion > current) runMigration(db, migration, context);
  }
  return { version: LEDGER_SCHEMA_VERSION, newer: false };
}

/** The per-database HMAC key for cursors, or null when it is missing. */
export function readLedgerCursorSecret(db: DatabaseSync): Buffer | null {
  const value = readMetaValue(db, CURSOR_SECRET_KEY);
  if (value === null) return null;
  const secret = Buffer.from(value, 'base64url');
  return secret.length === CURSOR_SECRET_BYTES ? secret : null;
}

const AUTHORITY_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The writer authority ID minted with the database, or null when invalid. */
export function readLedgerAuthorityId(db: DatabaseSync): string | null {
  const value = readMetaValue(db, AUTHORITY_ID_KEY);
  return value !== null && AUTHORITY_ID_PATTERN.test(value) ? value : null;
}

/** An in-memory secret for a read-only database that lacks one. */
export function createEphemeralLedgerCursorSecret(): Buffer {
  return randomBytes(CURSOR_SECRET_BYTES);
}
