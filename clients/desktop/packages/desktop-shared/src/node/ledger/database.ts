import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { LedgerStoreError, toLedgerStoreError } from './errors';

/** Default wait for another connection to release the database at open. */
export const LEDGER_DEFAULT_OPEN_BUSY_TIMEOUT_MS = 2_000;

/** Upper bound on the configurable open-time busy timeout. */
const MAX_OPEN_BUSY_TIMEOUT_MS = 60_000;

function pragmaValue(db: DatabaseSync, pragma: string, column: string): string {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  const value = row?.[column];
  return typeof value === 'string' ? value.toLowerCase() : '';
}

/** Rolls back an open transaction without masking the original failure. */
export function rollbackQuietly(db: DatabaseSync): void {
  try {
    if (db.isTransaction) db.exec('ROLLBACK');
  } catch {
    // SQLite may already have ended the transaction; the caller's error wins.
  }
}

export function closeQuietly(db: DatabaseSync): void {
  try {
    if (db.isOpen) db.close();
  } catch {
    // The connection is being discarded after a failure.
  }
}

function configureExclusiveWriter(
  db: DatabaseSync,
  openBusyTimeoutMs: number,
): void {
  db.exec(`PRAGMA busy_timeout = ${openBusyTimeoutMs}`);
  // Exclusive locking must precede WAL mode so the WAL index lives in heap
  // memory: no -shm file, and no other connection can read or write.
  if (
    pragmaValue(db, 'locking_mode = EXCLUSIVE', 'locking_mode') !== 'exclusive'
  ) {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'locking_mode',
    });
  }
  if (pragmaValue(db, 'journal_mode = WAL', 'journal_mode') !== 'wal') {
    throw new LedgerStoreError('STORAGE_UNAVAILABLE', {
      diagnosticCode: 'journal_mode',
    });
  }
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA foreign_keys = ON');
  // Take the write lock now and keep it: in exclusive mode SQLite never
  // releases it until the connection closes.
  db.exec('BEGIN IMMEDIATE');
  db.exec('COMMIT');
  // The busy timeout only covers acquiring the lock at open.
  db.exec('PRAGMA busy_timeout = 0');
}

/**
 * Opens the Ledger database as its single exclusive writer: WAL,
 * `synchronous=FULL`, foreign keys, `locking_mode=EXCLUSIVE`, and the write
 * lock taken before returning. When another connection or process holds the
 * database, this waits up to `openBusyTimeoutMs` and then fails with
 * `WRITER_UNAVAILABLE`, having written nothing.
 */
export function openExclusiveLedgerDatabase(
  databasePath: string,
  openBusyTimeoutMs: number,
): DatabaseSync {
  if (
    !Number.isSafeInteger(openBusyTimeoutMs) ||
    openBusyTimeoutMs < 0 ||
    openBusyTimeoutMs > MAX_OPEN_BUSY_TIMEOUT_MS
  ) {
    throw new LedgerStoreError('INVALID_INPUT', {
      field: 'openBusyTimeoutMs',
      limit: MAX_OPEN_BUSY_TIMEOUT_MS,
    });
  }
  let db: DatabaseSync;
  try {
    mkdirSync(dirname(databasePath), { recursive: true });
    db = new DatabaseSync(databasePath, { enableForeignKeyConstraints: true });
  } catch (error) {
    throw toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
  }
  try {
    configureExclusiveWriter(db, openBusyTimeoutMs);
    return db;
  } catch (error) {
    rollbackQuietly(db);
    closeQuietly(db);
    throw toLedgerStoreError(error, 'STORAGE_UNAVAILABLE');
  }
}
