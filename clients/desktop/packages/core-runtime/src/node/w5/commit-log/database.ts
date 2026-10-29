import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { W5CommitLogError } from './errors';

/** The schema this build writes; a newer database is never opened. */
export const W5_COMMIT_LOG_SCHEMA_VERSION = 2;

const SCHEMA = [
  `CREATE TABLE w5_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  // One monotonic revision per W5 resource (CAN-3799 D4). An absent row is
  // revision 0.
  `CREATE TABLE w5_revisions (
    resource TEXT PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision >= 1)
  ) STRICT`,
  // The commit decision of each change: committed here, applied to the JSON
  // files afterwards. `state` is `committed` until every file is written,
  // then `applied`; `recovery-required` when a file changed out of band.
  `CREATE TABLE w5_commits (
    commit_id INTEGER PRIMARY KEY AUTOINCREMENT,
    operation TEXT NOT NULL,
    outcome_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('committed', 'applied', 'recovery-required')),
    diagnostics_json TEXT,
    committed_at TEXT NOT NULL,
    completed_at TEXT,
    outcome_expired INTEGER NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1))
  ) STRICT`,
  `CREATE INDEX w5_commits_by_state ON w5_commits (state, commit_id)`,
  `CREATE INDEX w5_commits_to_compact ON w5_commits (completed_at, commit_id)
    WHERE state = 'applied' AND outcome_expired = 0`,
  // Both fingerprints survive application. Contents are NULL for a removal
  // or once applied; only committed/recovery-required images are read.
  `CREATE TABLE w5_commit_files (
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    path TEXT NOT NULL,
    previous_fingerprint TEXT,
    new_fingerprint TEXT,
    contents TEXT,
    PRIMARY KEY (commit_id, path)
  ) STRICT`,
  `CREATE INDEX w5_commit_files_by_path ON w5_commit_files (path, commit_id)`,
  // Retry identities survive for the lifetime of W5 state, even once the
  // joined commit's saved outcome expires.
  `CREATE TABLE w5_receipts (
    caller TEXT NOT NULL,
    operation TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    commit_id INTEGER NOT NULL REFERENCES w5_commits (commit_id),
    PRIMARY KEY (caller, operation, idempotency_key)
  ) STRICT`,
  // Pending operations that run uncertain effects (clone, git worktree add)
  // before they commit. Distinct from committed outcomes.
  `CREATE TABLE w5_reservations (
    reservation_id TEXT PRIMARY KEY,
    operation TEXT NOT NULL,
    caller TEXT,
    idempotency_key TEXT,
    fingerprint TEXT,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'recovery-required')),
    diagnostics_json TEXT NOT NULL,
    reserved_at TEXT NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX w5_reservations_by_key
    ON w5_reservations (caller, operation, idempotency_key)
    WHERE idempotency_key IS NOT NULL`,
];

function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // The connection is being discarded after a failure.
  }
}

/** SQLITE_BUSY or SQLITE_LOCKED: another connection holds the database. */
function isLockedError(error: unknown): boolean {
  // Checked structurally: node:sqlite raises its errors from another realm
  // under some hosts, so `instanceof Error` cannot be relied on.
  if (typeof error !== 'object' || error === null) return false;
  const code: unknown = Reflect.get(error, 'errcode');
  return typeof code === 'number' && (code & 0xff) >= 5 && (code & 0xff) <= 6;
}

function pragmaText(db: DatabaseSync, pragma: string, column: string): string {
  const value = db.prepare(`PRAGMA ${pragma}`).get()?.[column];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

function readSchemaVersion(db: DatabaseSync): number | null {
  const table = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'w5_meta'`,
    )
    .get();
  if (!table) return null;
  const value = db
    .prepare(`SELECT value FROM w5_meta WHERE key = 'schema_version'`)
    .get()?.value;
  return typeof value === 'string' ? Number(value) : null;
}

function migrateV1(db: DatabaseSync, migratedAt: string): void {
  db.exec('ALTER TABLE w5_commits ADD COLUMN completed_at TEXT');
  db.exec(`ALTER TABLE w5_commits ADD COLUMN outcome_expired INTEGER
    NOT NULL DEFAULT 0 CHECK (outcome_expired IN (0, 1))`);
  db.exec('ALTER TABLE w5_commit_files ADD COLUMN new_fingerprint TEXT');
  // v1 did not record completion time. Give its applied receipts a full
  // window from migration rather than guess when they finished applying.
  db.prepare(
    `UPDATE w5_commits SET completed_at = ? WHERE state = 'applied'`,
  ).run(migratedAt);
  const update = db.prepare(`UPDATE w5_commit_files SET new_fingerprint = ?,
    contents = CASE WHEN ? = 'applied' THEN NULL ELSE contents END
    WHERE commit_id = ? AND path = ?`);
  const rows = db
    .prepare(
      `SELECT f.commit_id, f.path, f.contents, c.state
    FROM w5_commit_files f JOIN w5_commits c USING (commit_id)`,
    )
    .iterate();
  for (let next = rows.next(); !next.done; next = rows.next()) {
    const row = next.value;
    const fingerprint =
      typeof row.contents === 'string'
        ? createHash('sha256').update(row.contents, 'utf8').digest('hex')
        : null;
    update.run(fingerprint, row.state, row.commit_id, row.path);
  }
  db.exec(`CREATE INDEX w5_commits_to_compact ON w5_commits (completed_at, commit_id)
    WHERE state = 'applied' AND outcome_expired = 0`);
}

function migrate(db: DatabaseSync, migratedAt: string): void {
  const version = readSchemaVersion(db);
  if (version === W5_COMMIT_LOG_SCHEMA_VERSION) return;
  if (version !== null && version !== 1) {
    throw new W5CommitLogError(
      'UNSUPPORTED_SCHEMA',
      `The W5 commit log has schema ${String(version)}; this build reads ${String(W5_COMMIT_LOG_SCHEMA_VERSION)}.`,
    );
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    if (version === 1) {
      migrateV1(db, migratedAt);
    } else {
      for (const statement of SCHEMA) db.exec(statement);
    }
    db.prepare(
      `INSERT INTO w5_meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    ).run(String(W5_COMMIT_LOG_SCHEMA_VERSION));
    db.exec('COMMIT');
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens the W5 commit log as its single exclusive writer: WAL,
 * `synchronous=FULL`, `locking_mode=EXCLUSIVE` and the write lock taken
 * before returning, as the Agent Ledger store does. Another connection or
 * process makes the open fail with `WRITER_UNAVAILABLE` after
 * `openBusyTimeoutMs`, having written nothing.
 */
export function openW5CommitLogDatabase(
  databasePath: string,
  openBusyTimeoutMs = 2_000,
  migratedAt = new Date().toISOString(),
): DatabaseSync {
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'Could not open the W5 commit log.',
      error,
    );
  }
  try {
    db.exec(`PRAGMA busy_timeout = ${String(openBusyTimeoutMs)}`);
    if (
      pragmaText(db, 'locking_mode = EXCLUSIVE', 'locking_mode') !== 'exclusive'
    ) {
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'Exclusive locking is unavailable.',
      );
    }
    if (pragmaText(db, 'journal_mode = WAL', 'journal_mode') !== 'wal') {
      throw new W5CommitLogError(
        'STORAGE_UNAVAILABLE',
        'WAL journaling is unavailable.',
      );
    }
    db.exec('PRAGMA synchronous = FULL');
    db.exec('PRAGMA foreign_keys = ON');
    // Take the write lock now and keep it: in exclusive mode SQLite never
    // releases it until the connection closes.
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    db.exec('PRAGMA busy_timeout = 0');
    migrate(db, migratedAt);
    return db;
  } catch (error) {
    closeQuietly(db);
    if (error instanceof W5CommitLogError) throw error;
    if (isLockedError(error)) {
      throw new W5CommitLogError(
        'WRITER_UNAVAILABLE',
        'Another writer holds the W5 commit log.',
        error,
      );
    }
    throw new W5CommitLogError(
      'STORAGE_UNAVAILABLE',
      'Could not open the W5 commit log.',
      error,
    );
  }
}
