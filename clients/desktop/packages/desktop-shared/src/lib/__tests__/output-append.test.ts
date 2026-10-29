import {
  OutputAppendEncoder,
  OutputReassembler,
  applyOutputAppend,
  clampOutputTail,
  findOutputAppend,
  type OutputEncoding,
} from '../output-append';

const NOTICE = '[truncated earlier output]\n';
const LIMIT = 64;
const clamp = (value: string): string => clampOutputTail(value, LIMIT, NOTICE);

/** What the emitter does: each raw delta is appended, then clamped. */
function emitterValues(deltas: readonly string[]): string[] {
  const values: string[] = [];
  let value = '';
  for (const delta of deltas) {
    value = clamp(`${value}${delta}`);
    values.push(value);
  }
  return values;
}

function revCounter(): () => number {
  let rev = 0;
  return () => ++rev;
}

/** Encode every value and reassemble it on the other side. */
function roundTrip(
  values: readonly string[],
  heads: readonly string[] = [NOTICE],
): { encodings: OutputEncoding[]; decoded: string[] } {
  const encoder = new OutputAppendEncoder<string>({
    heads,
    nextRev: revCounter(),
  });
  const reassembler = new OutputReassembler<string>();
  const encodings: OutputEncoding[] = [];
  const decoded: string[] = [];
  for (const value of values) {
    const encoding = encoder.encode('item', value);
    encodings.push(encoding);
    if (encoding.kind === 'full') {
      reassembler.full('item', value, encoding.rev);
      decoded.push(value);
      continue;
    }
    const result = reassembler.apply('item', encoding.append);
    if (result.status !== 'applied') throw new Error(result.status);
    decoded.push(result.value);
  }
  return { encodings, decoded };
}

describe('clampOutputTail', () => {
  it('keeps the newest characters behind the notice', () => {
    expect(clamp('a'.repeat(LIMIT))).toBe('a'.repeat(LIMIT));
    expect(clamp(`b${'a'.repeat(LIMIT)}`)).toBe(
      `${NOTICE}${'a'.repeat(LIMIT)}`,
    );
  });

  it('clamping an already clamped value with more text equals clamping the raw stream', () => {
    const raw = Array.from({ length: 50 }, (_, index) => `line ${index}\n`);
    let incremental = '';
    let all = '';
    for (const delta of raw) {
      incremental = clamp(`${incremental}${delta}`);
      all += delta;
      expect(incremental).toBe(clamp(all));
    }
  });
});

describe('applyOutputAppend', () => {
  it('appends, slides past a kept head, and rejects ranges outside the base', () => {
    expect(
      applyOutputAppend('abc', { baseLength: 3, keep: 0, from: 0, text: 'de' }),
    ).toBe('abcde');
    expect(
      applyOutputAppend('Nabcdef', {
        baseLength: 7,
        keep: 1,
        from: 3,
        text: 'gh',
      }),
    ).toBe('Ncdefgh');
    expect(
      applyOutputAppend('abc', { baseLength: 4, keep: 0, from: 0, text: 'd' }),
    ).toBeUndefined();
    expect(
      applyOutputAppend('abc', { baseLength: 3, keep: 2, from: 1, text: '' }),
    ).toBeUndefined();
    expect(
      applyOutputAppend('abc', { baseLength: 3, keep: 0, from: 4, text: '' }),
    ).toBeUndefined();
    expect(
      applyOutputAppend('abc', { baseLength: 3, keep: 0, from: 1.5, text: '' }),
    ).toBeUndefined();
  });
});

describe('findOutputAppend', () => {
  it('finds a plain append, and nothing when the head changed without a known notice', () => {
    expect(findOutputAppend('abc', 'abcdef', [])).toEqual({
      keep: 0,
      from: 0,
      text: 'def',
    });
    expect(findOutputAppend('abc', 'xbcdef', [])).toBeUndefined();
  });

  it('only returns appends that reproduce the next value exactly', () => {
    const repetitive = emitterValues(
      Array.from({ length: 40 }, () => 'oooo\n'),
    );
    for (let index = 1; index < repetitive.length; index += 1) {
      const previous = repetitive[index - 1] ?? '';
      const next = repetitive[index] ?? '';
      const found = findOutputAppend(previous, next, [NOTICE]);
      if (!found) continue;
      expect(
        applyOutputAppend(previous, { ...found, baseLength: previous.length }),
      ).toBe(next);
    }
  });
});

describe('output appends end to end', () => {
  it('reassembles in-order appends exactly, sending each new character once', () => {
    const values = emitterValues(['hello ', 'world', '\n', 'second line\n']);
    const { encodings, decoded } = roundTrip(values);

    expect(decoded).toEqual(values);
    expect(encodings[0]).toEqual({ kind: 'full', rev: 1 });
    expect(
      encodings
        .slice(1)
        .map((encoding) =>
          encoding.kind === 'append' ? encoding.append.text : null,
        ),
    ).toEqual(['world', '\n', 'second line\n']);
  });

  it('reassembles through the clamp: one full value when the notice appears, then slides', () => {
    const deltas = Array.from(
      { length: 40 },
      (_, index) => `${String(index).padStart(2, '0')}xyz\n`,
    );
    const values = emitterValues(deltas);
    const { encodings, decoded } = roundTrip(values);

    expect(decoded).toEqual(values);
    const firstClamped = values.findIndex((value) => value.startsWith(NOTICE));
    expect(firstClamped).toBeGreaterThan(0);
    const fullIndexes = encodings
      .map((encoding, index) => (encoding.kind === 'full' ? index : -1))
      .filter((index) => index >= 0);
    expect(fullIndexes).toEqual([0, firstClamped]);
    for (const encoding of encodings.slice(firstClamped + 1)) {
      expect(encoding.kind).toBe('append');
      if (encoding.kind === 'append') {
        expect(encoding.append.keep).toBe(NOTICE.length);
        expect(encoding.append.text.length).toBeLessThanOrEqual(6);
      }
    }
  });

  it('reassembles repetitive and multi-delta updates through the clamp', () => {
    const deltas = Array.from({ length: 60 }, (_, index) =>
      'o'.repeat(1 + (index % 7)),
    );
    // Updates batch several raw deltas, as the 100 ms / 16 KB throttle does.
    const all = emitterValues(deltas);
    const values = all.filter((_, index) => index % 3 === 2);
    expect(roundTrip(values).decoded).toEqual(values);
  });

  it('sends a full value when a delta is longer than the clamp window', () => {
    const values = [
      clamp('a'.repeat(LIMIT + 5)),
      clamp(`${'a'.repeat(LIMIT + 5)}${'b'.repeat(LIMIT * 2)}`),
    ];
    const { encodings, decoded } = roundTrip(values);
    expect(decoded).toEqual(values);
    expect(encodings.map((encoding) => encoding.kind)).toEqual([
      'full',
      'full',
    ]);
  });

  it('sends a full value when the output is replaced rather than grown', () => {
    const values = ['first output', 'first output more', 'another'];
    const { encodings, decoded } = roundTrip(values);
    expect(decoded).toEqual(values);
    expect(encodings.map((encoding) => encoding.kind)).toEqual([
      'full',
      'append',
      'full',
    ]);
  });
});

describe('OutputReassembler', () => {
  function encodeAll(values: readonly string[]): OutputEncoding[] {
    const encoder = new OutputAppendEncoder<string>({
      heads: [NOTICE],
      nextRev: revCounter(),
    });
    return values.map((value) => encoder.encode('item', value));
  }

  it('drops a duplicate append without changing the value', () => {
    const encodings = encodeAll(['a', 'ab', 'abc']);
    const reassembler = new OutputReassembler<string>();
    reassembler.full('item', 'a', 1);
    const second = encodings[1];
    const third = encodings[2];
    if (second?.kind !== 'append' || third?.kind !== 'append')
      throw new Error('expected appends');

    expect(reassembler.apply('item', second.append)).toEqual({
      status: 'applied',
      value: 'ab',
    });
    expect(reassembler.apply('item', second.append)).toEqual({
      status: 'duplicate',
    });
    expect(reassembler.apply('item', third.append)).toEqual({
      status: 'applied',
      value: 'abc',
    });
    expect(reassembler.value('item')).toBe('abc');
  });

  it('rejects an out-of-order append as a gap and never guesses', () => {
    const encodings = encodeAll(['a', 'ab', 'abc']);
    const reassembler = new OutputReassembler<string>();
    reassembler.full('item', 'a', 1);
    const second = encodings[1];
    const third = encodings[2];
    if (second?.kind !== 'append' || third?.kind !== 'append')
      throw new Error('expected appends');

    expect(reassembler.apply('item', third.append)).toEqual({ status: 'gap' });
    expect(reassembler.value('item')).toBe('a');
    // The late one still applies to the base it names.
    expect(reassembler.apply('item', second.append)).toEqual({
      status: 'applied',
      value: 'ab',
    });
  });

  it('rejects an append for an unknown base, a plain full value, or a changed base length', () => {
    const encodings = encodeAll(['a', 'ab']);
    const second = encodings[1];
    if (second?.kind !== 'append') throw new Error('expected an append');

    const fresh = new OutputReassembler<string>();
    expect(fresh.apply('item', second.append)).toEqual({ status: 'gap' });

    const plain = new OutputReassembler<string>();
    plain.full('item', 'a');
    expect(plain.apply('item', second.append)).toEqual({ status: 'gap' });

    const mismatched = new OutputReassembler<string>();
    mismatched.full('item', 'xx', 1);
    expect(mismatched.apply('item', second.append)).toEqual({ status: 'gap' });
  });

  it('lets the completed full value win over every earlier and later append', () => {
    const encodings = encodeAll(['a', 'ab', 'abc']);
    const reassembler = new OutputReassembler<string>();
    reassembler.full('item', 'a', 1);
    const second = encodings[1];
    const third = encodings[2];
    if (second?.kind !== 'append' || third?.kind !== 'append')
      throw new Error('expected appends');
    reassembler.apply('item', second.append);

    reassembler.full('item', 'final output');
    expect(reassembler.value('item')).toBe('final output');
    expect(reassembler.apply('item', third.append)).toEqual({ status: 'gap' });
    expect(reassembler.value('item')).toBe('final output');
  });

  it('forgets the oldest key past its bound, which turns a later append into a gap', () => {
    const reassembler = new OutputReassembler<string>({ maxKeys: 2 });
    reassembler.full('a', 'a', 1);
    reassembler.full('b', 'b', 2);
    reassembler.full('c', 'c', 3);
    expect(reassembler.value('a')).toBeUndefined();
    expect(
      reassembler.apply('a', {
        rev: 4,
        baseRev: 1,
        baseLength: 1,
        keep: 0,
        from: 0,
        text: 'x',
      }),
    ).toEqual({ status: 'gap' });
  });
});

describe('OutputAppendEncoder', () => {
  it('sends a full value again after a key is forgotten, cleared or evicted', () => {
    const encoder = new OutputAppendEncoder<string>({
      nextRev: revCounter(),
      maxKeys: 2,
    });
    expect(encoder.encode('a', 'x').kind).toBe('full');
    expect(encoder.encode('a', 'xy').kind).toBe('append');
    encoder.forget('a');
    expect(encoder.encode('a', 'xyz').kind).toBe('full');
    encoder.clear();
    expect(encoder.encode('a', 'xyzw').kind).toBe('full');
    encoder.encode('b', 'b');
    encoder.encode('c', 'c');
    expect(encoder.encode('a', 'xyzwv').kind).toBe('full');
    encoder.forgetWhere((key) => key === 'c');
    expect(encoder.encode('c', 'cc').kind).toBe('full');
  });

  it('numbers revisions from the shared counter so a base is never confused', () => {
    const next = revCounter();
    const first = new OutputAppendEncoder<string>({ nextRev: next });
    const second = new OutputAppendEncoder<string>({ nextRev: next });
    expect(first.encode('item', 'a')).toEqual({ kind: 'full', rev: 1 });
    expect(second.encode('item', 'a')).toEqual({ kind: 'full', rev: 2 });
    expect(first.encode('item', 'ab')).toEqual({
      kind: 'append',
      append: {
        rev: 3,
        baseRev: 1,
        baseLength: 1,
        keep: 0,
        from: 0,
        text: 'b',
      },
    });
  });
});
