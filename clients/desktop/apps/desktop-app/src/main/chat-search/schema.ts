import { mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { isSqliteRow } from './sqlite-rows';

/**
 * Version 1 shipped the title catalog. Version 2 backfills transcript bodies
 * into FTS. Version 3 adds tracked-plan docs (`source = 'plan'`) with a
 * `review_status` column. Version 4 adds archive expiry so stale retained
 * transcripts can be excluded synchronously. Version 5 separates document
 * kind (chat, plan, archived container) from storage source. Version 6 indexes
 * canonical JSONL and full outputs; version 7 tracks the indexed transcript
 * version so metadata updates can reuse its body; version 8 rebuilds transcript
 * bodies without hidden host-only messages. The database is
 * derived data, so every mismatch is rebuilt rather than migrated in place.
 * Nullable columns that existing rows can leave empty are the exception:
 * `addMissingColumns` adds them in place, because a rebuild re-reads every
 * transcript in the background after an upgrade.
 */
export const CHAT_SEARCH_SCHEMA_VERSION = 8;

const REQUIRED_TABLES = [
  'search_meta',
  'chat_docs',
  'source_files',
  'chat_fts',
];

const CREATE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE search_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE chat_docs (
    doc_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    worktree_id TEXT NOT NULL,
    chat_id TEXT NOT NULL,
    source TEXT NOT NULL,
    document_kind TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    provider_type TEXT,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER,
    expires_at INTEGER,
    message_count INTEGER NOT NULL DEFAULT 0,
    review_status TEXT,
    transcript_fingerprint TEXT,
    committed_fingerprint TEXT,
    active_fts_rowid INTEGER
  )`,
  `CREATE INDEX idx_chat_docs_scope ON chat_docs(project_id, worktree_id)`,
  `CREATE INDEX idx_chat_docs_updated ON chat_docs(updated_at DESC)`,
  `CREATE TABLE source_files (
    file_key TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL
  )`,
  `CREATE VIRTUAL TABLE chat_fts USING fts5(
    doc_id UNINDEXED,
    title,
    body,
    tokenize = 'porter unicode61'
  )`,
];

/**
 * Added after version 8 shipped. A live chat's committed transcript text and
 * its in-flight (active sidecar) text are separate `chat_fts` rows under one
 * `doc_id`; `committed_fingerprint` identifies the committed row's prefix and
 * `active_fts_rowid` locates the in-flight row. Rows written before these
 * columns existed leave them null and take the full projection path once.
 */
const ADDITIVE_CHAT_DOC_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['committed_fingerprint', 'TEXT'],
  ['active_fts_rowid', 'INTEGER'],
];

function addMissingColumns(db: DatabaseSync): void {
  const rows: unknown[] = db.prepare('PRAGMA table_info(chat_docs)').all();
  const existing = new Set(
    rows.flatMap((row) =>
      isSqliteRow(row) && typeof row.name === 'string' ? [row.name] : [],
    ),
  );
  for (const [name, type] of ADDITIVE_CHAT_DOC_COLUMNS)
    if (!existing.has(name))
      db.exec(`ALTER TABLE chat_docs ADD COLUMN ${name} ${type};`);
}

function tableExists(db: DatabaseSync, tableName: string): boolean {
  return (
    db
      .prepare(
        `SELECT 1
         FROM sqlite_master
         WHERE type = 'table' AND name = ?`,
      )
      .get(tableName) !== undefined
  );
}

function readSchemaVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, 'search_meta')) {
    return null;
  }
  const row: unknown = db
    .prepare(`SELECT value FROM search_meta WHERE key = 'schema_version'`)
    .get();
  if (!isSqliteRow(row) || typeof row.value !== 'string') {
    return null;
  }
  const version = Number(row.value);
  return Number.isInteger(version) ? version : null;
}

function rebuildSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.exec('DROP TABLE IF EXISTS chat_fts;');
    db.exec('DROP TABLE IF EXISTS source_files;');
    db.exec('DROP TABLE IF EXISTS chat_docs;');
    db.exec('DROP TABLE IF EXISTS search_meta;');
    for (const statement of CREATE_SCHEMA_STATEMENTS) {
      db.exec(statement);
    }
    db.prepare(
      `INSERT INTO search_meta (key, value) VALUES ('schema_version', ?)`,
    ).run(String(CHAT_SEARCH_SCHEMA_VERSION));
    db.exec('COMMIT;');
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Preserve the schema failure when SQLite already ended the transaction.
    }
    throw error;
  }
}

function initializeDatabase(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL;');
  // This index is derived from canonical transcripts. NORMAL preserves WAL
  // consistency while avoiding an fsync on Electron main for every update.
  // A power loss can discard recent index entries; the source scan rebuilds them.
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  if (
    readSchemaVersion(db) !== CHAT_SEARCH_SCHEMA_VERSION ||
    REQUIRED_TABLES.some((tableName) => !tableExists(db, tableName))
  ) {
    rebuildSchema(db);
  }
  addMissingColumns(db);
}

function closeQuietly(db: DatabaseSync | null): void {
  try {
    db?.close();
  } catch {
    // The derived database is already unusable; continue recovery.
  }
}

function removeDatabaseFiles(dbPath: string): void {
  for (const path of [dbPath, `${dbPath}-shm`, `${dbPath}-wal`]) {
    try {
      rmSync(path, { force: true });
    } catch {
      // A memory fallback below still keeps search usable.
    }
  }
}

export function openChatSearchDatabase(dbPath: string): DatabaseSync {
  let db: DatabaseSync | null = null;
  try {
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    initializeDatabase(db);
    return db;
  } catch {
    closeQuietly(db);
    removeDatabaseFiles(dbPath);
  }

  try {
    db = new DatabaseSync(dbPath);
    initializeDatabase(db);
    return db;
  } catch {
    closeQuietly(db);
    const fallback = new DatabaseSync(':memory:');
    initializeDatabase(fallback);
    return fallback;
  }
}
