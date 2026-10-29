import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type SqliteStatement = {
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): { changes: bigint | number };
};

export interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

export function ensureCanopyDir(cwd = process.cwd()): string {
  const canopyDir = path.resolve(cwd, '.canopy');
  fs.mkdirSync(canopyDir, { recursive: true });
  return canopyDir;
}

export function openSqliteDatabase(filePath: string): SqliteDatabase {
  return new DatabaseSync(filePath);
}
