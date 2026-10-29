import type { SQLOutputValue } from 'node:sqlite';

import { LedgerStoreError } from './errors';

export type LedgerSqlRow = Record<string, SQLOutputValue>;

function malformedRow(): LedgerStoreError {
  return new LedgerStoreError('STORAGE_UNAVAILABLE', {
    diagnosticCode: 'malformed_row',
  });
}

export function rowText(row: LedgerSqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string') throw malformedRow();
  return value;
}

export function rowNullableText(
  row: LedgerSqlRow,
  column: string,
): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw malformedRow();
  return value;
}

export function rowInteger(row: LedgerSqlRow, column: string): number {
  const value = row[column];
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'bigint') {
    const converted = Number(value);
    if (Number.isSafeInteger(converted)) return converted;
  }
  throw malformedRow();
}

/** Parses stored JSON text; a parse failure is a storage fault. */
export function parseStoredJson(textValue: string): unknown {
  try {
    const parsed: unknown = JSON.parse(textValue);
    return parsed;
  } catch {
    throw malformedRow();
  }
}
