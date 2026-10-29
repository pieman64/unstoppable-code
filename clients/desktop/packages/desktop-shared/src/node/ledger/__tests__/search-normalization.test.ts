import { LEDGER_LIMITS } from '@canopy/protocol/canopy-core';

import {
  buildLedgerFtsQuery,
  normalizeLedgerSearch,
  splitLedgerSearchWords,
} from '../search';
import type { LedgerSearchEntriesInput } from '../types';
import { captureLedgerError } from './ledger-test-harness';

const LEDGER_ID = '00000000-0000-4000-8000-000000000001';
const ACTOR_ID = '00000000-0000-4000-8000-000000000002';

function search(
  overrides: Omit<Partial<LedgerSearchEntriesInput>, 'ledgerId'>,
): LedgerSearchEntriesInput {
  return { ledgerId: LEDGER_ID, ...overrides };
}

describe('ledger search normalization', () => {
  it('splits queries into literal words and drops unindexable ones', () => {
    expect(
      splitLedgerSearchWords('  Alpha\t"beta"  --  NEAR(x  café ( * '),
    ).toEqual(['Alpha', '"beta"', 'NEAR(x', 'café']);
    expect(splitLedgerSearchWords('( ) * " -')).toEqual([]);
  });

  it('quotes every word so FTS syntax stays literal, matching its start', () => {
    expect(buildLedgerFtsQuery(['AND', 'say"hi"', 'col:umn'])).toBe(
      '"AND"* "say""hi"""* "col:umn"*',
    );
  });

  it('applies defaults', () => {
    const normalized = normalizeLedgerSearch(search({}));
    expect(normalized.sort).toBe('created_desc');
    expect(normalized.limit).toBe(LEDGER_LIMITS.searchPageDefault);
    expect(normalized.words).toBeNull();
  });

  it('rejects empty filter arrays instead of treating them as unrestricted', () => {
    for (const overrides of [
      { types: [] },
      { statuses: [] },
      { attribution: [] },
      { entryIds: [] },
    ] satisfies Omit<Partial<LedgerSearchEntriesInput>, 'ledgerId'>[]) {
      expect(
        captureLedgerError(() => normalizeLedgerSearch(search(overrides))),
      ).toMatchObject({
        reason: 'INVALID_INPUT',
        field: Object.keys(overrides)[0],
      });
    }
  });

  it('rejects out-of-range limits and malformed filters', () => {
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(
          search({ limit: LEDGER_LIMITS.searchPageMax + 1 }),
        ),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'limit' });
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(search({ ownerActorId: 'not-a-uuid' })),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'ownerActorId' });
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(search({ createdAfter: 'yesterday' })),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'createdAfter' });
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(search({ query: 'x'.repeat(257) })),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'query' });
  });

  it('rejects empty and inverted time ranges', () => {
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(
          search({
            createdAfter: '2026-09-28T12:00:00Z',
            createdBefore: '2026-09-28T14:00:00+02:00',
          }),
        ),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'createdBefore' });
    expect(
      captureLedgerError(() =>
        normalizeLedgerSearch(
          search({
            updatedAfter: '2026-09-28T12:00:01Z',
            updatedBefore: '2026-09-28T12:00:00Z',
          }),
        ),
      ),
    ).toMatchObject({ reason: 'INVALID_INPUT', field: 'updatedBefore' });
  });

  it('hashes filters independently of array order, offsets and page size', () => {
    const first = normalizeLedgerSearch(
      search({
        statuses: ['TODO', 'BLOCKED', 'TODO'],
        types: ['TASK', 'ACTION'],
        ownerActorId: ACTOR_ID,
        createdAfter: '2026-09-28T14:00:00+02:00',
        limit: 5,
      }),
    );
    const second = normalizeLedgerSearch(
      search({
        statuses: ['BLOCKED', 'TODO'],
        types: ['ACTION', 'TASK'],
        ownerActorId: ACTOR_ID,
        createdAfter: '2026-09-28T12:00:00.000Z',
        limit: 50,
      }),
    );
    expect(first.filterHash).toBe(second.filterHash);
    expect(first.statuses).toEqual(['BLOCKED', 'TODO']);
    expect(first.createdAfter).toBe('2026-09-28T12:00:00.000Z');
  });

  it('changes the filter hash when any filter or the sort changes', () => {
    const base = normalizeLedgerSearch(search({ query: 'alpha' }));
    const variants: Omit<Partial<LedgerSearchEntriesInput>, 'ledgerId'>[] = [
      { query: 'beta' },
      { query: 'alpha', statuses: ['TODO'] },
      { query: 'alpha', authorActorId: ACTOR_ID },
      { query: 'alpha', sort: 'updated_desc' },
      { query: 'alpha', updatedBefore: '2026-09-28T12:00:00Z' },
    ];
    for (const variant of variants) {
      expect(normalizeLedgerSearch(search(variant)).filterHash).not.toBe(
        base.filterHash,
      );
    }
  });
});
