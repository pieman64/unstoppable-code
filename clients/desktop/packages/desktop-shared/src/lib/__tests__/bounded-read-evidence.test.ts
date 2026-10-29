import { createBoundedReadEvidence } from '../bounded-read-evidence';

it('requires an identity-matched cursor, including for empty evidence', () => {
  const journal = createBoundedReadEvidence<{ outcome: string }>(2);
  const baseline = journal.snapshot();
  expect(baseline.complete).toBe(false);
  expect(journal.snapshot(null)).toMatchObject({
    complete: false,
    entries: [],
  });
  expect(journal.snapshot(baseline.cursor)).toMatchObject({
    complete: true,
    entries: [],
  });
  expect(
    journal.snapshot({ ...baseline.cursor, observerId: 'another' }).complete,
  ).toBe(false);
  for (const sequence of [-1, 1, 0.5, NaN, Infinity]) {
    expect(journal.snapshot({ ...baseline.cursor, sequence }).complete).toBe(
      false,
    );
  }
});

it('rejects overflow gaps, preserves sequence order, and returns detached evidence', () => {
  const journal = createBoundedReadEvidence<{ outcome: string }>(2);
  const baseline = journal.snapshot().cursor;
  expect(journal.record({ outcome: 'started' })).toBe(1);
  const first = journal.snapshot(baseline).cursor;
  journal.record({ outcome: 'success' });
  journal.record({ outcome: 'started' });
  expect(journal.snapshot(baseline)).toMatchObject({
    complete: false,
    dropped: 1,
    entries: [],
  });
  const result = journal.snapshot(first);
  expect(result.entries.map((entry) => entry.sequence)).toEqual([2, 3]);
  const entry = result.entries[0];
  if (!entry) throw new Error('Missing retained event');
  entry.outcome = 'tampered';
  expect(journal.snapshot(first).entries[0]?.outcome).toBe('success');
  expect(() => createBoundedReadEvidence(0)).toThrow();
});
