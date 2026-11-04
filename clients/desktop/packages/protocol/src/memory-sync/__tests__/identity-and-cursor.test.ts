import {
  MemoryChangesPageSchema,
  MemoryDocumentPathSchema,
  MemoryNoteFileKeySchema,
  MemoryUlidSchema,
  MemoryUuidSchema,
  checkMemoryChangesPage,
  compareMemoryChangeCursors,
  compareMemoryChangeSeq,
  createMemoryUlidFactory,
  encodeMemoryUlid,
  formatMemoryChangeCursor,
  initialMemoryChangeCursor,
  isMemoryUlid,
  isPortableFileName,
  memoryDocumentIdentity,
  memoryUlidTime,
  parseMemoryChangeCursor,
  type MemoryChangesPage,
} from '../index';

const SCOPE_ID = '00000000-0000-4000-8000-0000000000a1';
const OTHER_SCOPE_ID = '00000000-0000-4000-8000-0000000000a2';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function seededBytes(random: () => number): (length: number) => Uint8Array {
  return (length: number): Uint8Array =>
    Uint8Array.from({ length }, () => Math.floor(random() * 256));
}

describe('memory ULIDs', () => {
  it('encodes the reference timestamp and decodes it back', () => {
    const id = encodeMemoryUlid(1_469_918_176_385, new Uint8Array(10));
    expect(id.slice(0, 10)).toBe('01ARYZ6S41');
    expect(id).toBe('01ARYZ6S410000000000000000');
    expect(memoryUlidTime(id)).toBe(1_469_918_176_385);
  });

  it('accepts only canonical upper-case IDs within 48-bit time', () => {
    const id = encodeMemoryUlid(
      1_700_000_000_000,
      new Uint8Array(10).fill(255),
    );
    expect(isMemoryUlid(id)).toBe(true);
    expect(MemoryUlidSchema.safeParse(id.toLowerCase()).success).toBe(false);
    expect(MemoryUlidSchema.safeParse(`8${id.slice(1)}`).success).toBe(false);
    expect(MemoryUlidSchema.safeParse(`${id.slice(0, 25)}U`).success).toBe(
      false,
    );
    expect(MemoryUlidSchema.safeParse(`${id}0`).success).toBe(false);
    expect(() => encodeMemoryUlid(2 ** 48, new Uint8Array(10))).toThrow(
      RangeError,
    );
  });

  it('sorts IDs in the order a device minted them, even when the clock stalls or steps back', () => {
    const random = seededRandom(7);
    const clockSteps = [0, 0, 0, 5, -3, 0, 1, -100, 2];
    let clock = 1_700_000_000_000;
    let step = 0;
    const next = createMemoryUlidFactory({
      now: (): number => {
        clock += clockSteps[step % clockSteps.length] ?? 0;
        step += 1;
        return clock;
      },
      randomBytes: seededBytes(random),
    });
    const ids = Array.from({ length: 500 }, next);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    const times = ids.map((id) => memoryUlidTime(id) ?? -1);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index]).toBeGreaterThanOrEqual(times[index - 1] ?? 0);
    }
  });

  it('orders IDs from different milliseconds by time', () => {
    const random = seededRandom(11);
    for (let trial = 0; trial < 200; trial += 1) {
      const earlier = Math.floor(random() * 2 ** 40);
      const later = earlier + 1 + Math.floor(random() * 1_000);
      const a = encodeMemoryUlid(earlier, seededBytes(random)(10));
      const b = encodeMemoryUlid(later, seededBytes(random)(10));
      expect(a < b).toBe(true);
    }
  });

  it('refuses to wrap the random part within one millisecond', () => {
    const next = createMemoryUlidFactory({
      now: (): number => 1_700_000_000_000,
      randomBytes: (length: number): Uint8Array =>
        new Uint8Array(length).fill(255),
    });
    next();
    expect(next).toThrow(RangeError);
  });
});

describe('memory identifiers', () => {
  it('accepts the document paths the local store round-trips', () => {
    for (const path of ['MEMORY.md', 'topics/build.md', 'topics/A.b-c_d.md']) {
      expect(MemoryDocumentPathSchema.safeParse(path).success).toBe(true);
    }
    for (const path of [
      'memory.md',
      'MEMORY.MD',
      'topics/.hidden.md',
      'topics/release.md.md',
      'topics/../MEMORY.md',
      'topics/sub/topic.md',
      'topics/has space.md',
      'topics/.md',
      'inbox/note.md',
      `topics/${'a'.repeat(198)}.md`,
    ]) {
      expect(MemoryDocumentPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('folds topic identity but keeps the index path', () => {
    expect(memoryDocumentIdentity('topics/Build.md')).toBe('topics/build.md');
    expect(memoryDocumentIdentity('MEMORY.md')).toBe('MEMORY.md');
  });

  it('accepts note file keys only in their folders', () => {
    expect(
      MemoryNoteFileKeySchema.safeParse(
        'inbox/2026-10-27T10-00-00-prefer-pnpm.md',
      ).success,
    ).toBe(true);
    expect(
      MemoryNoteFileKeySchema.safeParse('imported/claude-notes-0123abcd.md')
        .success,
    ).toBe(true);
    for (const key of [
      'inbox/.consolidated/x.md',
      'topics/x.md',
      'inbox/../MEMORY.md',
      'inbox/x.txt',
    ]) {
      expect(MemoryNoteFileKeySchema.safeParse(key).success).toBe(false);
    }
  });

  it('refuses names Windows maps to a device', () => {
    for (const path of [
      'topics/CON.md',
      'topics/nul.md',
      'topics/Aux.notes.md',
      'topics/com0.md',
      'topics/LPT9.md',
    ]) {
      expect(MemoryDocumentPathSchema.safeParse(path).success).toBe(false);
    }
    for (const key of ['inbox/NUL.md', 'inbox/prn.md', 'imported/con.md']) {
      expect(MemoryNoteFileKeySchema.safeParse(key).success).toBe(false);
    }
    for (const path of ['topics/console.md', 'topics/com10.md']) {
      expect(MemoryDocumentPathSchema.safeParse(path).success).toBe(true);
    }
  });

  it('refuses names Windows stores without their trailing dot or space', () => {
    for (const name of ['repo.', 'repo ', 'repo. .']) {
      expect(isPortableFileName(name)).toBe(false);
    }
    expect(isPortableFileName('repo.d')).toBe(true);
  });

  it('requires lower-case UUIDs so replica directories have one spelling', () => {
    expect(MemoryUuidSchema.safeParse(SCOPE_ID).success).toBe(true);
    expect(MemoryUuidSchema.safeParse(SCOPE_ID.toUpperCase()).success).toBe(
      false,
    );
  });
});

describe('memory change cursors', () => {
  it('round-trips and rejects malformed cursors', () => {
    const cursor = { scopeId: SCOPE_ID, generation: 3, seq: '42' };
    expect(parseMemoryChangeCursor(formatMemoryChangeCursor(cursor))).toEqual(
      cursor,
    );
    for (const value of [
      '',
      `mc2.${SCOPE_ID}.1.0`,
      `mc1.${SCOPE_ID}.0.0`,
      `mc1.${SCOPE_ID}.1.01`,
      `mc1.${SCOPE_ID}.1.-1`,
      `mc1.${SCOPE_ID.toUpperCase()}.1.0`,
      `mc1.${SCOPE_ID}.1.0.extra`,
      `mc1.${SCOPE_ID}.1.${'9'.repeat(19)}`,
    ]) {
      expect(parseMemoryChangeCursor(value)).toBeNull();
    }
  });

  it('orders sequences numerically, not as text', () => {
    expect(compareMemoryChangeSeq('9', '10')).toBe(-1);
    const random = seededRandom(3);
    for (let trial = 0; trial < 500; trial += 1) {
      const a = BigInt(Math.floor(random() * 1e15)) * BigInt(1_000);
      const b = BigInt(Math.floor(random() * 1e15)) * BigInt(1_000);
      const expected = a === b ? 0 : a < b ? -1 : 1;
      expect(compareMemoryChangeSeq(a.toString(), b.toString())).toBe(expected);
    }
  });

  it('never compares positions from another scope or feed generation', () => {
    const base = initialMemoryChangeCursor(SCOPE_ID, 1);
    const later = formatMemoryChangeCursor({
      scopeId: SCOPE_ID,
      generation: 1,
      seq: '5',
    });
    expect(compareMemoryChangeCursors(base, later)).toBe(-1);
    expect(
      compareMemoryChangeCursors(base, initialMemoryChangeCursor(SCOPE_ID, 2)),
    ).toBeNull();
    expect(
      compareMemoryChangeCursors(
        base,
        initialMemoryChangeCursor(OTHER_SCOPE_ID, 1),
      ),
    ).toBeNull();
  });
});

describe('memory change pages', () => {
  const removal = (seq: string): MemoryChangesPage['changes'][number] => ({
    kind: 'note_removed',
    seq,
    noteId: '01JB0000000000000000000000',
    reason: 'tombstoned',
    at: '2026-10-27T10:00:00.000Z',
  });
  const page = (
    seqs: string[],
    nextSeq: string,
    overrides: Partial<MemoryChangesPage> = {},
  ): MemoryChangesPage => ({
    scopeId: SCOPE_ID,
    changes: seqs.map(removal),
    nextCursor: formatMemoryChangeCursor({
      scopeId: SCOPE_ID,
      generation: 1,
      seq: nextSeq,
    }),
    hasMore: false,
    headRevision: 4,
    ...overrides,
  });
  const from = formatMemoryChangeCursor({
    scopeId: SCOPE_ID,
    generation: 1,
    seq: '10',
  });

  it('refuses pages whose changes are not strictly increasing', () => {
    expect(
      MemoryChangesPageSchema.safeParse(page(['11', '12'], '12')).success,
    ).toBe(true);
    expect(
      MemoryChangesPageSchema.safeParse(page(['12', '12'], '12')).success,
    ).toBe(false);
    expect(
      MemoryChangesPageSchema.safeParse(page(['12', '11'], '12')).success,
    ).toBe(false);
  });

  it('accepts a page that continues from its request cursor', () => {
    expect(checkMemoryChangesPage(from, page(['11', '15'], '15'))).toBeNull();
    expect(checkMemoryChangesPage(from, page([], '10'))).toBeNull();
  });

  it('names every way a page could make a replica skip or replay changes', () => {
    expect(checkMemoryChangesPage(from, page(['10', '11'], '11'))).toBe(
      'change_not_after_cursor',
    );
    expect(checkMemoryChangesPage(from, page(['11', '20'], '15'))).toBe(
      'change_after_next_cursor',
    );
    expect(checkMemoryChangesPage(from, page([], '9'))).toBe(
      'cursor_moved_backwards',
    );
    expect(
      checkMemoryChangesPage(from, page([], '10', { hasMore: true })),
    ).toBe('empty_page_with_more');
    expect(
      checkMemoryChangesPage(
        from,
        page([], '10', {
          nextCursor: initialMemoryChangeCursor(SCOPE_ID, 2),
        }),
      ),
    ).toBe('generation_changed');
    expect(
      checkMemoryChangesPage(from, page([], '10', { scopeId: OTHER_SCOPE_ID })),
    ).toBe('scope_mismatch');
    expect(checkMemoryChangesPage('not-a-cursor', page([], '10'))).toBe(
      'unparseable_cursor',
    );
  });
});
