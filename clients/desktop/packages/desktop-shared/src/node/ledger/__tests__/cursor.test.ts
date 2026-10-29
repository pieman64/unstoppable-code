import { randomBytes } from 'node:crypto';

import { LEDGER_LIMITS } from '@canopy/protocol/canopy-core';

import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  isLedgerCursorFresh,
  type LedgerHistoryCursorState,
  type LedgerSearchCursorState,
} from '../cursor';
import { canonicalizeLedgerInstant, normalizeLedgerTimeBound } from '../time';

const SECRET = randomBytes(32);

const SEARCH_STATE: LedgerSearchCursorState = {
  kind: 'search',
  ledgerId: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1,
  issuedAtMs: Date.parse('2026-09-28T12:00:00.000Z'),
  watermark: '42',
  sort: 'created_desc',
  filterHash: 'a'.repeat(64),
  lastSortValue: '2026-09-28T11:59:00.000Z',
  lastEntryId: '00000000-0000-4000-8000-000000000009',
};

const HISTORY_STATE: LedgerHistoryCursorState = {
  kind: 'history',
  ledgerId: '00000000-0000-4000-8000-000000000001',
  schemaVersion: 1,
  issuedAtMs: Date.parse('2026-09-28T12:00:00.000Z'),
  entryId: '00000000-0000-4000-8000-000000000009',
  afterRevision: 3,
};

function replaceCharacter(value: string, index: number): string {
  const replacement = value[index] === 'A' ? 'B' : 'A';
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`;
}

describe('ledger cursors', () => {
  it('round-trips search and history positions', () => {
    const search = encodeLedgerCursor(SEARCH_STATE, SECRET);
    const history = encodeLedgerCursor(HISTORY_STATE, SECRET);
    expect(search.length).toBeLessThanOrEqual(LEDGER_LIMITS.cursorMaxLength);
    expect(decodeLedgerCursor(search, SECRET)).toEqual(SEARCH_STATE);
    expect(decodeLedgerCursor(history, SECRET)).toEqual(HISTORY_STATE);
  });

  it('rejects tampered payloads and signatures', () => {
    const cursor = encodeLedgerCursor(SEARCH_STATE, SECRET);
    const separator = cursor.indexOf('.');
    expect(decodeLedgerCursor(replaceCharacter(cursor, 5), SECRET)).toBeNull();
    expect(
      decodeLedgerCursor(replaceCharacter(cursor, separator + 3), SECRET),
    ).toBeNull();
    const forgedPayload = Buffer.from(
      JSON.stringify({ v: 1, ...SEARCH_STATE, watermark: '999' }),
      'utf8',
    ).toString('base64url');
    expect(
      decodeLedgerCursor(`${forgedPayload}${cursor.slice(separator)}`, SECRET),
    ).toBeNull();
  });

  it('rejects cursors signed by another database', () => {
    const cursor = encodeLedgerCursor(SEARCH_STATE, randomBytes(32));
    expect(decodeLedgerCursor(cursor, SECRET)).toBeNull();
  });

  it('rejects malformed and oversized cursors', () => {
    const cursor = encodeLedgerCursor(SEARCH_STATE, SECRET);
    expect(decodeLedgerCursor('', SECRET)).toBeNull();
    expect(decodeLedgerCursor('no-separator', SECRET)).toBeNull();
    expect(decodeLedgerCursor(`${cursor}.extra`, SECRET)).toBeNull();
    expect(decodeLedgerCursor(`.${cursor}`, SECRET)).toBeNull();
    expect(
      decodeLedgerCursor('x'.repeat(LEDGER_LIMITS.cursorMaxLength + 1), SECRET),
    ).toBeNull();
  });

  it('expires ten minutes after issue', () => {
    const issued = SEARCH_STATE.issuedAtMs;
    expect(isLedgerCursorFresh(issued, issued)).toBe(true);
    expect(
      isLedgerCursorFresh(issued, issued + LEDGER_LIMITS.cursorLifetimeMs),
    ).toBe(true);
    expect(
      isLedgerCursorFresh(issued, issued + LEDGER_LIMITS.cursorLifetimeMs + 1),
    ).toBe(false);
    expect(
      isLedgerCursorFresh(issued, issued - LEDGER_LIMITS.cursorLifetimeMs - 1),
    ).toBe(false);
  });
});

describe('ledger time normalization', () => {
  it('canonicalizes instants to UTC without losing precision', () => {
    expect(canonicalizeLedgerInstant('2026-09-26T14:00:00+02:00')).toBe(
      '2026-09-26T12:00:00.000Z',
    );
    expect(canonicalizeLedgerInstant('2026-09-26T12:00Z')).toBe(
      '2026-09-26T12:00:00.000Z',
    );
    expect(canonicalizeLedgerInstant('2026-09-26T12:00:00.5Z')).toBe(
      '2026-09-26T12:00:00.500Z',
    );
    expect(canonicalizeLedgerInstant('2026-09-26T12:00:00.1234560Z')).toBe(
      '2026-09-26T12:00:00.123456Z',
    );
    expect(canonicalizeLedgerInstant('2026-09-26T13:30:00.123456+01:30')).toBe(
      '2026-09-26T12:00:00.123456Z',
    );
  });

  it('rejects values that are not RFC 3339 instants', () => {
    for (const value of [
      '',
      '2026-09-26',
      '2026-02-30T12:00:00Z',
      '2026-09-26T12:00:00',
      '2026-09-26 12:00:00Z',
      'yesterday',
    ]) {
      expect(canonicalizeLedgerInstant(value)).toBeNull();
      expect(normalizeLedgerTimeBound(value)).toBeNull();
    }
  });

  it('rounds search bounds up to the stored millisecond precision', () => {
    expect(normalizeLedgerTimeBound('2026-09-26T12:00:00.123Z')).toBe(
      '2026-09-26T12:00:00.123Z',
    );
    expect(normalizeLedgerTimeBound('2026-09-26T12:00:00.1231Z')).toBe(
      '2026-09-26T12:00:00.124Z',
    );
    expect(normalizeLedgerTimeBound('2026-09-26T12:00:00.1230000Z')).toBe(
      '2026-09-26T12:00:00.123Z',
    );
    expect(normalizeLedgerTimeBound('2026-09-26T08:00:00-04:00')).toBe(
      '2026-09-26T12:00:00.000Z',
    );
  });

  it('clamps search bounds to the storable range', () => {
    expect(normalizeLedgerTimeBound('9999-12-31T23:59:00-23:59')).toBe(
      '9999-12-31T23:59:59.999Z',
    );
    expect(normalizeLedgerTimeBound('0000-01-01T00:00:00+01:00')).toBe(
      '0000-01-01T00:00:00.000Z',
    );
  });
});
