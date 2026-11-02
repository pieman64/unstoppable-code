import { mkdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';

export type CodeGraphSqlValue = string | number | bigint | null;

export interface CodeGraphStatement {
  all(...params: CodeGraphSqlValue[]): unknown[];
  get(...params: CodeGraphSqlValue[]): unknown;
  run(...params: CodeGraphSqlValue[]): { changes: number | bigint };
}

export interface CodeGraphDatabase {
  exec(sql: string): void;
  prepare(sql: string): CodeGraphStatement;
  close(): void;
}

const activeWriteTransactions = new WeakSet<CodeGraphDatabase>();

/** Whether a shared immediate-transaction wrapper currently owns this writer. */
export function hasActiveCodeGraphWriteTransaction(
  db: CodeGraphDatabase,
): boolean {
  return activeWriteTransactions.has(db);
}

/**
 * How long a code-graph connection waits for another connection's lock. Pass
 * it as the `timeout` open option, never as a later `PRAGMA busy_timeout`: a
 * statement that runs first (the WAL switch included) would otherwise fail at
 * once with "database is locked" when another process holds the file.
 */
export const CODE_GRAPH_BUSY_TIMEOUT_MS = 5_000;

const WAL_SWITCH_RETRY_MS = 10;

export function isSqliteBusy(error: unknown): boolean {
  if (error === null || typeof error !== 'object') {
    return false;
  }
  const errcode: unknown = Reflect.get(error, 'errcode');
  return typeof errcode === 'number' && (errcode & 0xff) === 5;
}

export function openCodeGraphDatabase(dbPath: string): CodeGraphDatabase {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: CODE_GRAPH_BUSY_TIMEOUT_MS });
  try {
    switchToWriteAheadLog(db);
    db.exec('PRAGMA synchronous = FULL;');
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Converting a rollback-journal file to WAL upgrades a read lock to a write
 * lock. When two processes convert at once, SQLite skips the busy handler for
 * one of them to avoid a deadlock and fails it with SQLITE_BUSY, so the switch
 * is retried until the busy timeout runs out. A file already in WAL mode needs
 * only a read lock, which the busy handler covers.
 */
function switchToWriteAheadLog(db: DatabaseSync): void {
  const deadline = Date.now() + CODE_GRAPH_BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        WAL_SWITCH_RETRY_MS,
      );
    }
  }
}

export function withImmediateTransaction<T>(
  db: CodeGraphDatabase,
  fn: () => T,
): T {
  if (activeWriteTransactions.has(db)) {
    return fn();
  }
  db.exec('BEGIN IMMEDIATE;');
  activeWriteTransactions.add(db);
  try {
    const result = fn();
    db.exec('COMMIT;');
    activeWriteTransactions.delete(db);
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // The transaction may already be gone; the original error matters more.
    }
    activeWriteTransactions.delete(db);
    throw error;
  }
}

/** Holds one SQLite write transaction across asynchronous build work. */
export async function withImmediateTransactionAsync<T>(
  db: CodeGraphDatabase,
  fn: () => Promise<T>,
): Promise<T> {
  if (activeWriteTransactions.has(db)) {
    return fn();
  }
  db.exec('BEGIN IMMEDIATE;');
  activeWriteTransactions.add(db);
  try {
    const result = await fn();
    db.exec('COMMIT;');
    activeWriteTransactions.delete(db);
    return result;
  } catch (error) {
    try {
      db.exec('ROLLBACK;');
    } catch {
      // Preserve the build failure.
    }
    activeWriteTransactions.delete(db);
    throw error;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function requireRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('Expected a row object from sqlite');
  }
  return value;
}

export function requireString(
  row: Record<string, unknown>,
  key: string,
): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw new Error(`Expected string column "${key}"`);
  }
  return value;
}

export function requireNumber(
  row: Record<string, unknown>,
  key: string,
): number {
  const value = row[key];
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new Error(`Expected numeric column "${key}"`);
}

export function optionalString(
  row: Record<string, unknown>,
  key: string,
): string | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`Expected nullable string column "${key}"`);
  }
  return value;
}

export function optionalNumber(
  row: Record<string, unknown>,
  key: string,
): number | null {
  const value = row[key];
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  throw new Error(`Expected nullable numeric column "${key}"`);
}

export function getMetadataValue(
  db: CodeGraphDatabase,
  key: string,
): string | null {
  const row = db
    .prepare('SELECT value FROM graph_metadata WHERE key = ?')
    .get(key);
  if (row === undefined) {
    return null;
  }
  return requireString(requireRow(row), 'value');
}

/**
 * The metadata the code-graph scheduler compares before deciding whether a
 * worktree graph is stale, plus whether any build ever completed.
 */
export interface CodeGraphFingerprintMetadata {
  fingerprint: string | null;
  schemaVersion: number | null;
  extractorVersion: number | null;
  /** A completed (or legacy last-build) marker exists. */
  completed: boolean;
  /**
   * A build published without its derived analysis, and no derive has
   * answered it yet (its worker was superseded, canceled or stopped).
   */
  derivedPending?: boolean;
  /**
   * The last build's stamp: distinct for every build and seed of this
   * database, unchanged by deferred derived analysis.
   */
  lastBuildAt?: string | null;
}

function parseMetadataVersion(value: string | null): number | null {
  if (value === null) {
    return null;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Reads the staleness-comparison metadata from an already-open graph database.
 *
 * Shared by the read worker and the fingerprint module so both agree on how
 * the version columns are parsed. Callers on the Electron main thread must go
 * through the read worker rather than opening the database themselves: these
 * graphs reach hundreds of megabytes, and a synchronous open plus three
 * `StatementSync.get()` calls blocks the main thread on `pread`.
 */
export function readCodeGraphFingerprintMetadata(
  db: CodeGraphDatabase,
): CodeGraphFingerprintMetadata {
  return {
    fingerprint: getMetadataValue(db, 'worktree_fingerprint'),
    schemaVersion: parseMetadataVersion(getMetadataValue(db, 'schema_version')),
    extractorVersion: parseMetadataVersion(
      getMetadataValue(db, 'extractor_version'),
    ),
    completed:
      getMetadataValue(db, 'completed_build_at') !== null ||
      getMetadataValue(db, 'last_build_at') !== null,
    derivedPending: getMetadataValue(db, 'derived_pending') !== null,
    lastBuildAt: getMetadataValue(db, 'last_build_at'),
  };
}

export function setMetadataValue(
  db: CodeGraphDatabase,
  key: string,
  value: string,
): void {
  db.prepare(
    'INSERT INTO graph_metadata (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

export function deleteMetadataValue(db: CodeGraphDatabase, key: string): void {
  db.prepare('DELETE FROM graph_metadata WHERE key = ?').run(key);
}
