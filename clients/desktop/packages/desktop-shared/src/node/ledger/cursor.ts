import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  LEDGER_LIMITS,
  LEDGER_SEARCH_SORTS,
  LedgerSequenceSchema,
  LedgerTimestampSchema,
  LedgerUuidSchema,
  type LedgerSearchSort,
} from '@canopy/protocol/canopy-core';

/**
 * Opaque local cursors: `base64url(JSON payload) + '.' + base64url(HMAC)`.
 * The HMAC-SHA256 key is the per-database secret stored in `ledger_meta`, so a
 * cursor is valid only for the database that issued it. The repository checks
 * every binding (ledger, schema version, filters, sort, watermark) and the
 * ten-minute lifetime, and reports any mismatch as `CURSOR_EXPIRED`.
 */

const CURSOR_FORMAT_VERSION = 1;

interface LedgerCursorBase {
  readonly ledgerId: string;
  readonly schemaVersion: number;
  /** Issue time in epoch milliseconds. */
  readonly issuedAtMs: number;
}

/** Position in a snapshot search. */
export interface LedgerSearchCursorState extends LedgerCursorBase {
  readonly kind: 'search';
  /** Scope-sequence watermark captured by the first page (decimal string). */
  readonly watermark: string;
  readonly sort: LedgerSearchSort;
  /** SHA-256 of the normalized filters and sort. */
  readonly filterHash: string;
  /** Sort timestamp of the last returned item. */
  readonly lastSortValue: string;
  readonly lastEntryId: string;
}

/** Position in an entry's mutation history (ascending revisions). */
export interface LedgerHistoryCursorState extends LedgerCursorBase {
  readonly kind: 'history';
  readonly entryId: string;
  readonly afterRevision: number;
}

/** Position in a cross-scope rollup page, pinned to each scope's snapshot. */
export interface LedgerRollupsCursorState extends LedgerCursorBase {
  readonly kind: 'rollups';
  /** SHA-256 of the ordered scope IDs and host-resolved caller actor IDs. */
  readonly filterHash: string;
  /** Scope sequence captured for each requested ledger, in request order. */
  readonly watermarks: readonly string[];
  /** Keyset ordering position: open first, then newest activity. */
  readonly lastOpenRank: number;
  readonly lastActivityAt: string;
  readonly lastScopeOrder: number;
  readonly lastEntryId: string;
}

export type LedgerCursorState =
  | LedgerSearchCursorState
  | LedgerHistoryCursorState
  | LedgerRollupsCursorState;

function sign(payload: string, secret: Buffer): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

export function encodeLedgerCursor(
  state: LedgerCursorState,
  secret: Buffer,
): string {
  const payload = Buffer.from(
    JSON.stringify({ v: CURSOR_FORMAT_VERSION, ...state }),
    'utf8',
  ).toString('base64url');
  return `${payload}.${sign(payload, secret)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function integer(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value)
    ? value
    : null;
}

function searchSort(value: string | null): LedgerSearchSort | null {
  return LEDGER_SEARCH_SORTS.find((sort) => sort === value) ?? null;
}

function parseSearchCursor(
  record: Record<string, unknown>,
  base: LedgerCursorBase,
): LedgerSearchCursorState | null {
  const watermark = text(record, 'watermark');
  const sort = searchSort(text(record, 'sort'));
  const filterHash = text(record, 'filterHash');
  const lastSortValue = text(record, 'lastSortValue');
  const lastEntryId = text(record, 'lastEntryId');
  if (
    watermark === null ||
    sort === null ||
    filterHash === null ||
    lastSortValue === null ||
    lastEntryId === null
  ) {
    return null;
  }
  return {
    kind: 'search',
    ...base,
    watermark,
    sort,
    filterHash,
    lastSortValue,
    lastEntryId,
  };
}

function parseHistoryCursor(
  record: Record<string, unknown>,
  base: LedgerCursorBase,
): LedgerHistoryCursorState | null {
  const entryId = text(record, 'entryId');
  const afterRevision = integer(record, 'afterRevision');
  if (entryId === null || afterRevision === null || afterRevision < 1) {
    return null;
  }
  return { kind: 'history', ...base, entryId, afterRevision };
}

function parseRollupsCursor(
  record: Record<string, unknown>,
  base: LedgerCursorBase,
): LedgerRollupsCursorState | null {
  const filterHash = text(record, 'filterHash');
  const lastOpenRank = integer(record, 'lastOpenRank');
  const lastActivityAt = text(record, 'lastActivityAt');
  const lastScopeOrder = integer(record, 'lastScopeOrder');
  const lastEntryId = text(record, 'lastEntryId');
  const watermarks = record.watermarks;
  if (
    filterHash === null ||
    !/^[0-9a-f]{64}$/.test(filterHash) ||
    (lastOpenRank !== 0 && lastOpenRank !== 1) ||
    lastActivityAt === null ||
    !LedgerTimestampSchema.safeParse(lastActivityAt).success ||
    lastScopeOrder === null ||
    lastScopeOrder < 0 ||
    lastScopeOrder >= LEDGER_LIMITS.rollupsLedgerIdsMax ||
    lastEntryId === null ||
    !LedgerUuidSchema.safeParse(lastEntryId).success ||
    !Array.isArray(watermarks) ||
    watermarks.length < 1 ||
    watermarks.length > LEDGER_LIMITS.rollupsLedgerIdsMax
  ) {
    return null;
  }

  const parsedWatermarks: string[] = [];
  for (const value of watermarks) {
    if (
      typeof value !== 'string' ||
      !LedgerSequenceSchema.safeParse(value).success
    )
      return null;
    parsedWatermarks.push(value);
  }

  return {
    kind: 'rollups',
    ...base,
    filterHash,
    watermarks: parsedWatermarks,
    lastOpenRank,
    lastActivityAt,
    lastScopeOrder,
    lastEntryId,
  };
}

function parseCursorState(value: unknown): LedgerCursorState | null {
  if (!isRecord(value) || value.v !== CURSOR_FORMAT_VERSION) return null;
  const ledgerId = text(value, 'ledgerId');
  const schemaVersion = integer(value, 'schemaVersion');
  const issuedAtMs = integer(value, 'issuedAtMs');
  if (ledgerId === null || schemaVersion === null || issuedAtMs === null) {
    return null;
  }
  const base: LedgerCursorBase = { ledgerId, schemaVersion, issuedAtMs };
  if (value.kind === 'search') return parseSearchCursor(value, base);
  if (value.kind === 'history') return parseHistoryCursor(value, base);
  if (value.kind === 'rollups') return parseRollupsCursor(value, base);
  return null;
}

/**
 * Verifies the signature and decodes a cursor. Returns null for anything
 * malformed, tampered with or signed by another database.
 */
export function decodeLedgerCursor(
  cursor: string,
  secret: Buffer,
): LedgerCursorState | null {
  if (cursor.length > LEDGER_LIMITS.cursorMaxLength) return null;
  const separator = cursor.indexOf('.');
  if (separator <= 0 || separator !== cursor.lastIndexOf('.')) return null;
  const payload = cursor.slice(0, separator);
  const signature = Buffer.from(cursor.slice(separator + 1), 'utf8');
  const expected = Buffer.from(sign(payload, secret), 'utf8');
  if (
    signature.length !== expected.length ||
    !timingSafeEqual(signature, expected)
  ) {
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    );
    return parseCursorState(decoded);
  } catch {
    return null;
  }
}

/** True while a cursor issued at `issuedAtMs` is inside its lifetime. */
export function isLedgerCursorFresh(
  issuedAtMs: number,
  nowMs: number,
): boolean {
  const age = nowMs - issuedAtMs;
  return (
    age <= LEDGER_LIMITS.cursorLifetimeMs &&
    age >= -LEDGER_LIMITS.cursorLifetimeMs
  );
}
