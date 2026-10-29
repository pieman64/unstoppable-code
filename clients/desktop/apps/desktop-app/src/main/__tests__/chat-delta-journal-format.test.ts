/**
 * Delta-journal framing and index deltas.
 *
 * Framing: verified prefixes, torn tails of every shape, and corruption
 * followed by a valid frame. Index deltas: fixed-seed property tests that
 * applying `diff(a, b)` to `a` serializes exactly like `b` — key order,
 * integer-like keys, `__proto__`, omitted values, non-finite numbers, moved
 * and duplicated array elements — both in memory and after the record's JSON
 * round trip.
 */
import type { TranscriptDescriptor } from '@canopy/agent-transcript/transcript-storage';
import {
  ChatDeltaJournalIntegrityError,
  ChatStorageNewerFormatError,
  decodeDeltaJournalRecord,
  encodeDeltaJournalFrame,
  scanDeltaJournalFrames,
  type DeltaJournalCommitRecord,
} from '../lib/chat-delta-journal/format';
import {
  applyChatIndexDelta,
  diffChatIndexes,
  isIndexDelta,
  restoreTranscriptDescriptors,
  type DescribedIndexes,
  type IndexDelta,
} from '../lib/chat-delta-journal/index-delta';
import { pick, seededRandom } from './helpers/chat-delta-journal-harness';

function commitRecord(
  fromRevision: number,
  prev: string,
): DeltaJournalCommitRecord {
  return {
    type: 'commit',
    v: 1,
    prev,
    fromRevision,
    toRevision: fromRevision + 1,
    mutationIds: [`m${fromRevision}`],
    delta: {},
    transcripts: [],
  };
}

describe('delta journal framing', () => {
  const frames = [0, 1, 2].map((revision) =>
    encodeDeltaJournalFrame(commitRecord(revision, 'p'.repeat(64))),
  );
  const file = Buffer.concat(frames.map((frame) => frame.frame));

  it('returns every complete verified frame and its digest', () => {
    const scan = scanDeltaJournalFrames(file);
    expect(scan.tornTail).toBeUndefined();
    expect(scan.validEnd).toBe(file.length);
    expect(scan.frames.map((frame) => frame.digest)).toEqual(
      frames.map((frame) => frame.digest),
    );
    expect(decodeDeltaJournalRecord(scan.frames[2])).toEqual(
      commitRecord(2, 'p'.repeat(64)),
    );
  });

  it.each([
    ['a partial header', 10],
    ['a header without its payload', 40],
    ['a partial payload', 60],
    ['all but the last byte', frames[2].frame.length - 1],
  ])('treats %s at the end as a torn tail', (_label, keep) => {
    const end = frames[0].frame.length + frames[1].frame.length;
    const torn = file.subarray(0, end + keep);
    const scan = scanDeltaJournalFrames(torn);
    expect(scan.frames).toHaveLength(2);
    expect(scan.validEnd).toBe(end);
    expect(scan.tornTail).toEqual({
      offset: end,
      bytes: keep,
      reason: 'incomplete',
    });
  });

  it('distinguishes a complete but invalid final frame from a partial one', () => {
    // Full length, garbage content: a write the sync never completed.
    const damaged = Buffer.from(file);
    damaged[damaged.length - 3] ^= 0x20;
    const scan = scanDeltaJournalFrames(damaged);
    expect(scan.frames).toHaveLength(2);
    expect(scan.tornTail).toEqual({
      offset: file.length - frames[2].frame.length,
      bytes: frames[2].frame.length,
      reason: 'checksum_mismatch',
    });
    // A damaged stored checksum, not payload, is the same case.
    const badChecksum = Buffer.from(file);
    badChecksum[file.length - frames[2].frame.length + 8] ^= 0x01;
    expect(scanDeltaJournalFrames(badChecksum).tornTail?.reason).toBe(
      'checksum_mismatch',
    );
    // A complete header with no magic (zero fill) cannot be a partial frame.
    const zeroFilled = Buffer.concat([file, Buffer.alloc(4096)]);
    expect(scanDeltaJournalFrames(zeroFilled).tornTail).toEqual({
      offset: file.length,
      bytes: 4096,
      reason: 'checksum_mismatch',
    });
    // Fewer bytes than a header are always incomplete.
    expect(
      scanDeltaJournalFrames(Buffer.concat([file, Buffer.alloc(39)])).tornTail
        ?.reason,
    ).toBe('incomplete');
  });

  it('fails closed when a damaged frame precedes a valid one', () => {
    const damaged = Buffer.from(file);
    damaged[frames[0].frame.length + 50] ^= 0x01;
    expect(() => scanDeltaJournalFrames(damaged)).toThrow(
      ChatDeltaJournalIntegrityError,
    );
    const garbage = Buffer.concat([
      frames[0].frame,
      Buffer.from('not a frame'),
      frames[1].frame,
    ]);
    expect(() => scanDeltaJournalFrames(garbage)).toThrow('corrupt at byte');
  });

  describe('a batch appended with one write (group commit)', () => {
    // A segment-like first frame, one synced record, then a batch of three
    // written with one append: its first record carries no `batchStart`, the
    // others name the offset of that first record.
    const head = [0, 1].map((revision) =>
      encodeDeltaJournalFrame(commitRecord(revision, 'p'.repeat(64))),
    );
    const batchStart = head[0].frame.length + head[1].frame.length;
    const batch = [2, 3, 4].map((revision, index) =>
      encodeDeltaJournalFrame({
        ...commitRecord(revision, 'p'.repeat(64)),
        ...(index > 0 ? { batchStart } : {}),
      }),
    );
    const journal = Buffer.concat(
      [...head, ...batch].map((frame) => frame.frame),
    );

    it('round-trips the batch offset and keeps a clean batch whole', () => {
      const scan = scanDeltaJournalFrames(journal);
      expect(scan.tornTail).toBeUndefined();
      expect(scan.frames).toHaveLength(5);
      expect(
        scan.frames.map((frame) => {
          const record = decodeDeltaJournalRecord(frame);
          return record.type === 'commit' ? record.batchStart : undefined;
        }),
      ).toEqual([undefined, undefined, undefined, batchStart, batchStart]);
    });

    it('ends the log at a damaged frame its own batch follows', () => {
      // Power loss before the batch's sync: its first frame is garbage, the
      // two after it arrived intact. None of the batch was acknowledged.
      const damaged = Buffer.from(journal);
      damaged[batchStart + 50] ^= 0x01;
      const scan = scanDeltaJournalFrames(damaged);
      expect(scan.frames).toHaveLength(2);
      expect(scan.validEnd).toBe(batchStart);
      expect(scan.tornTail).toEqual({
        offset: batchStart,
        bytes: journal.length - batchStart,
        reason: 'checksum_mismatch',
      });
      // A damaged middle frame keeps the batch's verified prefix.
      const middle = Buffer.from(journal);
      const middleStart = batchStart + batch[0].frame.length;
      middle[middleStart + 50] ^= 0x01;
      const kept = scanDeltaJournalFrames(middle);
      expect(kept.frames).toHaveLength(3);
      expect(kept.tornTail).toEqual({
        offset: middleStart,
        bytes: journal.length - middleStart,
        reason: 'checksum_mismatch',
      });
    });

    it('still fails closed when a later batch follows the damage', () => {
      // The batch was synced and a new record was appended after it: the
      // damaged frame was acknowledged.
      const later = encodeDeltaJournalFrame(commitRecord(5, 'p'.repeat(64)));
      const damaged = Buffer.concat([journal, later.frame]);
      damaged[batchStart + 50] ^= 0x01;
      expect(() => scanDeltaJournalFrames(damaged)).toThrow(
        ChatDeltaJournalIntegrityError,
      );
      // So does damage before the batch: its records name a later offset.
      const before = Buffer.from(journal);
      before[head[0].frame.length + 50] ^= 0x01;
      expect(() => scanDeltaJournalFrames(before)).toThrow('corrupt at byte');
      // A follower of a second batch does not excuse damage in the first.
      const secondStart = journal.length;
      const second = [5, 6].map((revision, index) =>
        encodeDeltaJournalFrame({
          ...commitRecord(revision, 'p'.repeat(64)),
          ...(index > 0 ? { batchStart: secondStart } : {}),
        }),
      );
      const twoBatches = Buffer.concat([
        journal,
        ...second.map((frame) => frame.frame),
      ]);
      twoBatches[batchStart + 50] ^= 0x01;
      expect(() => scanDeltaJournalFrames(twoBatches)).toThrow(
        ChatDeltaJournalIntegrityError,
      );
    });

    it('rejects a batch offset that is not before its own frame', () => {
      const frame = (
        payload: unknown,
        offset: number,
      ): ReturnType<typeof scanDeltaJournalFrames>['frames'][number] => {
        const bytes = Buffer.from(JSON.stringify(payload));
        return {
          offset,
          end: offset + bytes.length + 40,
          digest: '',
          payload: bytes,
        };
      };
      expect(
        decodeDeltaJournalRecord(
          frame({ ...commitRecord(3, 'x'), batchStart: 80 }, 200),
        ),
      ).toMatchObject({ batchStart: 80 });
      for (const invalid of [200, 500, -1, 1.5, '80'])
        expect(() =>
          decodeDeltaJournalRecord(
            frame({ ...commitRecord(3, 'x'), batchStart: invalid }, 200),
          ),
        ).toThrow(ChatDeltaJournalIntegrityError);
    });
  });

  it('rejects unknown record versions and effect kinds as newer formats', () => {
    const frame = (
      payload: unknown,
    ): ReturnType<typeof scanDeltaJournalFrames>['frames'][number] => {
      const bytes = Buffer.from(JSON.stringify(payload));
      return { offset: 0, end: bytes.length + 40, digest: '', payload: bytes };
    };
    expect(() =>
      decodeDeltaJournalRecord(frame({ ...commitRecord(0, 'x'), v: 2 })),
    ).toThrow(ChatStorageNewerFormatError);
    expect(() =>
      decodeDeltaJournalRecord(
        frame({
          ...commitRecord(0, 'x'),
          transcripts: [{ chatId: 'c', kind: 'block-append' }],
        }),
      ),
    ).toThrow(ChatStorageNewerFormatError);
    expect(() =>
      decodeDeltaJournalRecord(
        frame({
          ...commitRecord(0, 'x'),
          transcripts: [
            { chatId: 'c', kind: 'delete' },
            { chatId: 'c', kind: 'delete' },
          ],
        }),
      ),
    ).toThrow('two effects for one chat');
    expect(() =>
      decodeDeltaJournalRecord(
        frame({ ...commitRecord(0, 'x'), toRevision: 0 }),
      ),
    ).toThrow(ChatDeltaJournalIntegrityError);
  });

  it('bounds the record size', () => {
    expect(() =>
      encodeDeltaJournalFrame({
        ...commitRecord(0, 'x'),
        mutationIds: ['x'.repeat(64 * 1024 * 1024)],
      }),
    ).toThrow('maximum record size');
  });
});

const KEYS = ['a', 'b', 'c', 'id', '0', '7', '10', '__proto__', 'toJSON', 'é'];
const NUMBERS = [0, -0, 1, -1.5, 1e21, Number.NaN, Infinity, 2 ** 53];
const STRINGS = ['', 'x', 'line\nbreak', ' ', '\ud800', '🌲'];

function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function randomValue(random: () => number, depth: number): unknown {
  const roll = random();
  if (depth > 3 || roll < 0.45) {
    const scalar = random();
    if (scalar < 0.1) return null;
    if (scalar < 0.15) return undefined;
    if (scalar < 0.3) return random() < 0.5;
    if (scalar < 0.55) return pick(random, NUMBERS);
    return pick(random, STRINGS);
  }
  if (roll < 0.7)
    return Array.from({ length: Math.floor(random() * 5) }, () =>
      randomValue(random, depth + 1),
    );
  const value = {};
  for (let index = Math.floor(random() * 5); index > 0; index -= 1)
    define(value, pick(random, KEYS), randomValue(random, depth + 1));
  return value;
}

function isList(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A changed copy: edits, insertions, deletions, moves and reorders. */
function mutate(random: () => number, value: unknown, depth: number): unknown {
  if (random() < 0.15) return randomValue(random, depth);
  if (isList(value)) {
    const next: unknown[] = [...value];
    const edits = Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit += 1) {
      const kind = random();
      const at = Math.floor(random() * (next.length + 1));
      if (kind < 0.25) next.splice(at, 0, randomValue(random, depth + 1));
      else if (kind < 0.45 && next.length) next.splice(at % next.length, 1);
      else if (kind < 0.65 && next.length) {
        const [moved] = next.splice(at % next.length, 1);
        next.splice(Math.floor(random() * (next.length + 1)), 0, moved);
      } else if (kind < 0.8 && next.length) next.push(next[at % next.length]);
      else if (next.length)
        next[at % next.length] = mutate(
          random,
          next[at % next.length],
          depth + 1,
        );
    }
    return next;
  }
  if (isObject(value)) {
    let keys = Object.keys(value);
    if (random() < 0.3) keys = keys.reverse();
    const next = {};
    for (const key of keys) {
      if (random() < 0.15) continue;
      define(
        next,
        key,
        random() < 0.4 ? mutate(random, value[key], depth + 1) : value[key],
      );
    }
    if (random() < 0.4)
      define(next, pick(random, KEYS), randomValue(random, depth + 1));
    return next;
  }
  return random() < 0.5 ? value : randomValue(random, depth);
}

function wrap(recovery: unknown): DescribedIndexes {
  return {
    live: { tabs: [] },
    archive: { archived: [] },
    recovery: { value: recovery },
  };
}

function roundTrip(delta: IndexDelta): IndexDelta {
  const parsed: unknown = JSON.parse(JSON.stringify(delta));
  if (!isIndexDelta(parsed)) throw new Error('Delta did not survive JSON');
  return parsed;
}

describe('index deltas', () => {
  it.each([1, 2, 3, 4, 5])(
    'reproduce arbitrary JSON byte for byte (seed %i)',
    (seed) => {
      const random = seededRandom(seed);
      for (let iteration = 0; iteration < 300; iteration += 1) {
        const before = randomValue(random, 0);
        const after = mutate(random, before, 0);
        const delta = diffChatIndexes(wrap(before), wrap(after));
        const expected = JSON.stringify(wrap(after));
        expect(JSON.stringify(applyChatIndexDelta(wrap(before), delta))).toBe(
          expected,
        );
        expect(
          JSON.stringify(applyChatIndexDelta(wrap(before), roundTrip(delta))),
        ).toBe(expected);
        if (JSON.stringify(wrap(before)) === expected)
          expect(delta).toEqual({});
      }
    },
  );

  const descriptor = (revision: number): TranscriptDescriptor => ({
    format: 'complete-message-jsonl-v1',
    committedMessageCount: revision,
    committedByteLength: revision * 10,
    transcriptRevision: revision,
    hasActiveSidecar: false,
  });

  function indexes(
    live: Array<{ id: string; title: string; revision: number }>,
    archived: Array<{ id: string; turnCount: number; revision: number }>,
  ): DescribedIndexes {
    return {
      live: {
        tabs: live.map(({ id, title, revision }) => ({
          id,
          title,
          transcript: descriptor(revision),
        })),
      },
      archive: {
        archived: archived.map(({ id, turnCount, revision }) => ({
          tab: { id, transcript: descriptor(revision) },
          turnCount,
        })),
      },
      recovery: { mutationIds: [] },
    };
  }

  it('never records transcript descriptors and carries them by chat id', () => {
    const before = indexes(
      [
        { id: 'a', title: 'A', revision: 1 },
        { id: 'b', title: 'B', revision: 2 },
      ],
      [{ id: 'c', turnCount: 1, revision: 3 }],
    );
    // Descriptors alone changing is no delta at all.
    const describedOnly = indexes(
      [
        { id: 'a', title: 'A', revision: 9 },
        { id: 'b', title: 'B', revision: 9 },
      ],
      [{ id: 'c', turnCount: 1, revision: 9 }],
    );
    expect(diffChatIndexes(before, describedOnly)).toEqual({});
    // b is archived, c restored, d created, a renamed and moved last.
    const after = indexes(
      [
        { id: 'c', title: 'C', revision: 0 },
        { id: 'd', title: 'D', revision: 0 },
        { id: 'a', title: 'A2', revision: 0 },
      ],
      [{ id: 'b', turnCount: 4, revision: 0 }],
    );
    const delta = diffChatIndexes(before, after);
    expect(JSON.stringify(delta)).not.toContain('committedByteLength');
    const restored = restoreTranscriptDescriptors(
      applyChatIndexDelta(before, roundTrip(delta)),
      before,
    );
    expect(restored).toEqual({
      live: {
        tabs: [
          { id: 'c', title: 'C', transcript: descriptor(3) },
          {
            id: 'd',
            title: 'D',
            transcript: { ...descriptor(0) },
          },
          { id: 'a', title: 'A2', transcript: descriptor(1) },
        ],
      },
      archive: {
        archived: [
          { tab: { id: 'b', transcript: descriptor(2) }, turnCount: 4 },
        ],
      },
      recovery: { mutationIds: [] },
    });
  });

  it('records a bounded mutation-id window as an O(1) change', () => {
    const ids = Array.from({ length: 4096 }, (_, index) => `mutation-${index}`);
    const before: DescribedIndexes = {
      live: { tabs: [] },
      archive: { archived: [] },
      recovery: { mutationIds: ids },
    };
    const after: DescribedIndexes = {
      ...before,
      recovery: { mutationIds: [...ids.slice(1), 'mutation-4096'] },
    };
    const delta = diffChatIndexes(before, after);
    expect(JSON.stringify(delta).length).toBeLessThan(200);
    expect(JSON.stringify(applyChatIndexDelta(before, roundTrip(delta)))).toBe(
      JSON.stringify(after),
    );
  });

  it('refuses a delta that does not apply to its base', () => {
    const before = wrap({ list: [1, 2, 3] });
    const delta = diffChatIndexes(before, wrap({ list: [3, 2, 1, 0] }));
    expect(() => applyChatIndexDelta(wrap({ list: [1] }), delta)).toThrow(
      'does not apply',
    );
    expect(() => applyChatIndexDelta(wrap('scalar'), delta)).toThrow(
      'does not apply',
    );
  });

  it('rejects values JSON cannot represent faithfully', () => {
    class Entry {
      public readonly id = 'x';
    }
    expect(() =>
      diffChatIndexes(wrap({}), wrap({ entry: new Entry() })),
    ).toThrow('not plain JSON data');
    expect(() =>
      diffChatIndexes(wrap({}), wrap({ when: new Date(0) })),
    ).toThrow('not plain JSON data');
  });
});
