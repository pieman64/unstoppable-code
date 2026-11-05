import type { SQLOutputValue } from 'node:sqlite';

import {
  LedgerLeftOpenSchema,
  type LedgerLeftOpen,
} from '@canopy/protocol/canopy-core';

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

/** Metadata belongs to the mutation of the selected revision, not its entry. */
export function rowLeftOpen(row: LedgerSqlRow): LedgerLeftOpen | undefined {
  const reason = rowNullableText(row, 'left_open_reason');
  if (reason === null) return undefined;
  const parsed = LedgerLeftOpenSchema.safeParse({
    reason,
    at: rowText(row, 'left_open_at'),
  });
  if (!parsed.success) throw malformedRow();
  return parsed.data;
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
