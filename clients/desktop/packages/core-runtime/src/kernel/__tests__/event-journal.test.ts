import { CanopyStreamCursorSchema } from '@canopy/protocol/canopy-core';
import { createEventJournal, type JournalEntry } from '../event-journal';

const cursor = (
  sequence: number,
  daemonEpoch = 'e1',
): { daemonEpoch: string; sequence: number } => ({
  daemonEpoch,
  sequence,
});
const seqs = (entries: readonly JournalEntry<string>[]): number[] =>
  entries.map((entry) => entry.cursor.sequence);

describe('createEventJournal', () => {
  it('rejects invalid capacity and allocates sequential cursors', () => {
    expect(() => createEventJournal({ epoch: 'e1', maxEntries: 0 })).toThrow(
      RangeError,
    );
    expect(() => createEventJournal({ epoch: 'e1', maxEntries: 1.5 })).toThrow(
      RangeError,
    );
    const journal = createEventJournal<string>({ epoch: 'e1' });
    expect(journal.head()).toBeNull();
    expect(journal.append('a').cursor).toEqual(cursor(1));
    expect(journal.append('b').cursor).toEqual(cursor(2));
    expect(journal.head()).toEqual(cursor(2));
  });

  it('accepts only epochs that produce protocol-valid cursors', () => {
    for (const epoch of ['', 'e'.repeat(513)]) {
      expect(() => createEventJournal({ epoch })).toThrow(RangeError);
    }
    const epoch = 'e'.repeat(512);
    const journal = createEventJournal<string>({ epoch });
    const emitted = journal.append('a').cursor;
    expect(emitted).toEqual({ daemonEpoch: epoch, sequence: 1 });
    expect(CanopyStreamCursorSchema.safeParse(emitted).success).toBe(true);
  });

  it('bounds history and classifies resume cursors', () => {
    const journal = createEventJournal<string>({ epoch: 'e1', maxEntries: 3 });
    expect(journal.resume(cursor(0))).toEqual({ kind: 'replay', entries: [] });
    for (const event of ['a', 'b', 'c']) journal.append(event);
    expect(journal.resume(cursor(0))).toMatchObject({ kind: 'replay' });
    journal.append('d');
    journal.append('e'); // retains 3..5
    expect(journal.size).toBe(3);
    expect(journal.resume(cursor(0))).toEqual({
      kind: 'snapshot_required',
      reason: 'expired',
    });
    expect(journal.resume(cursor(1))).toMatchObject({
      reason: 'expired',
    });
    const replay = journal.resume(cursor(2));
    expect(replay.kind === 'replay' && seqs(replay.entries)).toEqual([3, 4, 5]);
    expect(journal.resume(cursor(5))).toEqual({ kind: 'replay', entries: [] });
    expect(journal.resume(cursor(6))).toMatchObject({ reason: 'ahead' });
    expect(journal.resume(cursor(1, 'other'))).toMatchObject({
      reason: 'foreign_epoch',
    });
  });

  it('replays only the latest entry for a null or omitted cursor', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    expect(journal.resume(null)).toEqual({ kind: 'replay', entries: [] });
    journal.append('a');
    journal.append('b');
    for (const result of [journal.resume(null), journal.resume()]) {
      expect(result.kind === 'replay' && result.entries).toEqual([
        { cursor: cursor(2), event: 'b' },
      ]);
    }
  });

  it('does not let callers mutate retained cursors', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    const entry = journal.append('a');
    entry.cursor.sequence = 99;
    const head = journal.head();
    if (head) head.sequence = 99;
    const replay = journal.resume(null);
    if (replay.kind === 'replay') replay.entries[0].cursor.sequence = 99;
    expect(journal.head()).toEqual(cursor(1));
    expect(journal.resume(cursor(1))).toEqual({ kind: 'replay', entries: [] });
  });

  it('replays then streams live entries until unsubscribed', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    journal.append('a');
    journal.append('b');
    const seen: string[] = [];
    const sub = journal.subscribe(cursor(1), (entry) => seen.push(entry.event));
    journal.append('c');
    if (sub.kind === 'subscribed') sub.unsubscribe();
    journal.append('d');
    expect(seen).toEqual(['b', 'c']);
    expect(journal.subscribe(cursor(9), () => undefined)).toEqual({
      kind: 'snapshot_required',
      reason: 'ahead',
    });
  });

  it('keeps order without gaps or duplicates across reentrant appends', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    journal.append('a');
    const first: string[] = [];
    const second: string[] = [];
    journal.subscribe(cursor(0), (entry) => {
      first.push(entry.event);
      if (entry.event === 'a') {
        journal.append('b');
        journal.append('c');
      }
      if (entry.event === 'b') journal.append('d');
    });
    journal.subscribe(null, (entry) => second.push(entry.event));
    journal.append('e');
    expect(first).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(second.at(-1)).toBe('e');
    expect(new Set(second).size).toBe(second.length);
  });

  it('delivers reentrant appends to every live subscriber in order', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    const a: string[] = [];
    const b: string[] = [];
    journal.subscribe(null, (entry) => {
      a.push(entry.event);
      if (entry.event === '1') journal.append('2');
      if (entry.event === '2') journal.append('3');
    });
    journal.subscribe(null, (entry) => b.push(entry.event));
    journal.append('1');
    expect(a).toEqual(['1', '2', '3']);
    expect(b).toEqual(['1', '2', '3']);
  });

  it('isolates and removes a throwing listener', () => {
    const journal = createEventJournal<string>({ epoch: 'e1' });
    const bad = jest.fn(() => {
      throw new Error('boom');
    });
    const good: string[] = [];
    journal.subscribe(null, bad);
    journal.subscribe(null, (entry) => good.push(entry.event));
    expect(() => journal.append('a')).not.toThrow();
    journal.append('b');
    expect(bad).toHaveBeenCalledTimes(1);
    expect(good).toEqual(['a', 'b']);
  });
});
