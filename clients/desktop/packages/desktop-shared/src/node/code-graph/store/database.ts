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

export function openCodeGraphDatabase(dbPath: string): CodeGraphDatabase {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
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
