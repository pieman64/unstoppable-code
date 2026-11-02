import {
  THREE_WAY_MERGE_MAX_BYTES,
  THREE_WAY_MERGE_MAX_LINES,
  threeWayMerge,
} from '../three-way-merge';

const lines = (...values: string[]): string =>
  values.map((value) => `${value}\n`).join('');

describe('threeWayMerge', () => {
  const base = lines('one', 'two', 'three', 'four', 'five');

  it.each([
    ['binary', 'a\0'],
    ['too-large', 'x'.repeat(THREE_WAY_MERGE_MAX_BYTES + 1)],
    ['too-large', 'x\n'.repeat(THREE_WAY_MERGE_MAX_LINES + 1)],
  ])('checks %s inputs before equality fast paths', (reason, input) => {
    expect(threeWayMerge(input, input, input)).toEqual({
      kind: 'skipped',
      reason,
    });
    expect(threeWayMerge(input, 'ours', 'theirs')).toEqual({
      kind: 'skipped',
      reason,
    });
  });

  it('combines disjoint edits', () => {
    expect(
      threeWayMerge(
        base,
        lines('ONE', 'two', 'three', 'four', 'five'),
        lines('one', 'two', 'three', 'four', 'FIVE'),
      ),
    ).toEqual({
      kind: 'clean',
      content: lines('ONE', 'two', 'three', 'four', 'FIVE'),
    });
  });

  it('combines several disjoint edits on both sides', () => {
    const many = Array.from({ length: 20 }, (_, index) => `line ${index}`);
    const ours = [...many];
    ours[1] = 'ours 1';
    ours[9] = 'ours 9';
    const theirs = [...many];
    theirs[5] = 'theirs 5';
    theirs[15] = 'theirs 15';
    const expected = [...many];
    expected[1] = 'ours 1';
    expected[9] = 'ours 9';
    expected[5] = 'theirs 5';
    expected[15] = 'theirs 15';
    expect(
      threeWayMerge(lines(...many), lines(...ours), lines(...theirs)),
    ).toEqual({ kind: 'clean', content: lines(...expected) });
  });

  it('treats identical edits as clean', () => {
    const edited = lines('one', 'TWO', 'three', 'four', 'five');
    expect(threeWayMerge(base, edited, edited)).toEqual({
      kind: 'clean',
      content: edited,
    });
    expect(
      threeWayMerge(
        base,
        lines('one', 'TWO', 'three', 'four', 'FIVE'),
        lines('one', 'TWO', 'three', 'four', 'five'),
      ),
    ).toEqual({
      kind: 'clean',
      content: lines('one', 'TWO', 'three', 'four', 'FIVE'),
    });
  });

  it('returns the exact input when only one side changed', () => {
    const ours = 'one\r\ntwo';
    expect(threeWayMerge('one\ntwo', ours, 'one\ntwo')).toEqual({
      kind: 'clean',
      content: ours,
    });
    expect(threeWayMerge('one\ntwo', 'one\ntwo', ours)).toEqual({
      kind: 'clean',
      content: ours,
    });
  });

  it.each([
    [
      'same line',
      lines('one', 'ours', 'three', 'four', 'five'),
      lines('one', 'theirs', 'three', 'four', 'five'),
    ],
    [
      'insertion at the same position',
      lines('one', 'two', 'ours', 'three', 'four', 'five'),
      lines('one', 'two', 'theirs', 'three', 'four', 'five'),
    ],
    [
      'deletion versus edit',
      lines('one', 'three', 'four', 'five'),
      lines('one', 'TWO', 'three', 'four', 'five'),
    ],
  ])('conflicts on %s', (_label, ours, theirs) => {
    expect(threeWayMerge(base, ours, theirs)).toEqual({ kind: 'conflict' });
  });

  it('merges one-sided edits to adjacent lines replaced in place', () => {
    expect(
      threeWayMerge(
        base,
        lines('one', 'TWO', 'three', 'four', 'five'),
        lines('one', 'two', 'THREE', 'four', 'five'),
      ),
    ).toEqual({
      kind: 'clean',
      content: lines('one', 'TWO', 'THREE', 'four', 'five'),
    });
  });

  it('handles empty inputs', () => {
    expect(threeWayMerge('', 'ours\n', '')).toEqual({
      kind: 'clean',
      content: 'ours\n',
    });
    expect(threeWayMerge('', 'ours\n', 'theirs\n')).toEqual({
      kind: 'conflict',
    });
    expect(
      threeWayMerge(lines('a', 'x', 'b'), lines('x', 'b'), lines('a', 'x')),
    ).toEqual({ kind: 'clean', content: lines('x') });
    // Adjacent deletions share a merge region and stay conservative.
    expect(threeWayMerge(lines('a', 'b'), lines('b'), lines('a'))).toEqual({
      kind: 'conflict',
    });
  });

  it('preserves CRLF and mixed terminators as content', () => {
    const crlf = 'one\r\ntwo\r\nthree\r\nfour\r\n';
    expect(
      threeWayMerge(
        crlf,
        'ONE\r\ntwo\r\nthree\r\nfour\r\n',
        'one\r\ntwo\r\nthree\nFOUR\r\n',
      ),
    ).toEqual({
      kind: 'clean',
      content: 'ONE\r\ntwo\r\nthree\nFOUR\r\n',
    });
    // A terminator change on a line the other side edited is an overlap.
    expect(
      threeWayMerge(
        crlf,
        'one\r\nTWO\r\nthree\r\nfour\r\n',
        'one\r\ntwo\nthree\r\nfour\r\n',
      ),
    ).toEqual({ kind: 'conflict' });
  });

  it('keeps final-newline additions and removals as changes', () => {
    expect(
      threeWayMerge('one\ntwo\nthree', 'ONE\ntwo\nthree', 'one\ntwo\nthree\n'),
    ).toEqual({ kind: 'clean', content: 'ONE\ntwo\nthree\n' });
    expect(
      threeWayMerge(
        'one\ntwo\nthree\n',
        'ONE\ntwo\nthree\n',
        'one\ntwo\nthree',
      ),
    ).toEqual({ kind: 'clean', content: 'ONE\ntwo\nthree' });
    expect(
      threeWayMerge('one\ntwo\nthree', 'one\ntwo\nTHREE', 'one\ntwo\nthree\n'),
    ).toEqual({ kind: 'conflict' });
  });

  it('skips binary content', () => {
    expect(threeWayMerge('a\n', 'a\0\n', 'b\n')).toEqual({
      kind: 'skipped',
      reason: 'binary',
    });
  });

  it('enforces the byte guard on multibyte text', () => {
    // Three-byte characters: within the UTF-16 length but over 2 MiB of UTF-8.
    const big = '€'.repeat(Math.floor(THREE_WAY_MERGE_MAX_BYTES / 3) + 1);
    expect(threeWayMerge('a\n', `${big}\n`, 'b\n')).toEqual({
      kind: 'skipped',
      reason: 'too-large',
    });
    const fits = '€'.repeat(Math.floor(THREE_WAY_MERGE_MAX_BYTES / 3) - 10);
    expect(
      threeWayMerge(`x\n${fits}\n`, `y\n${fits}\n`, `x\n${fits}\nz\n`),
    ).toEqual({ kind: 'clean', content: `y\n${fits}\nz\n` });
  });

  it('enforces the line guard', () => {
    const atLimit = lines(
      ...Array.from({ length: THREE_WAY_MERGE_MAX_LINES }, (_, i) => `${i}`),
    );
    expect(
      threeWayMerge(
        atLimit,
        atLimit.replace('\n10\n', '\nten\n'),
        atLimit.replace('\n20\n', '\ntwenty\n'),
      ).kind,
    ).toBe('clean');
    expect(threeWayMerge(atLimit, `${atLimit}a\n`, `b\n${atLimit}`)).toEqual({
      kind: 'skipped',
      reason: 'too-large',
    });
  });

  it('skips merged output above the byte guard', () => {
    const half = 'a'.repeat(THREE_WAY_MERGE_MAX_BYTES / 2 + 10);
    expect(
      threeWayMerge('base\n', `${half}\nbase\n`, `base\n${half}\n`),
    ).toEqual({ kind: 'skipped', reason: 'output-too-large' });
  });

  it('bounds repeated-line rewrites instead of running a quadratic diff', () => {
    const repeated = 'same\n'.repeat(20_000);
    const started = performance.now();
    const result = threeWayMerge(
      repeated,
      'ours\n'.repeat(10_000) + repeated.slice(0, 50_000),
      repeated.slice(0, 50_000) + 'theirs\n'.repeat(10_000),
    );
    expect(result).toEqual({ kind: 'skipped', reason: 'too-complex' });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('merges small edits in a near-limit file quickly', () => {
    const many = Array.from(
      { length: THREE_WAY_MERGE_MAX_LINES - 2 },
      (_, index) => (index % 5 === 0 ? '' : `line ${index}`),
    );
    const ours = [...many];
    ours[100] = 'ours';
    const theirs = [...many];
    theirs[300] = 'theirs';
    const expected = [...many];
    expected[100] = 'ours';
    expected[300] = 'theirs';
    const started = performance.now();
    expect(
      threeWayMerge(lines(...many), lines(...ours), lines(...theirs)),
    ).toEqual({ kind: 'clean', content: lines(...expected) });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('skips edits at both ends of a large repetitive file quickly', () => {
    const repeated = Array.from(
      { length: THREE_WAY_MERGE_MAX_LINES - 2 },
      () => 'same',
    );
    const started = performance.now();
    expect(
      threeWayMerge(
        lines(...repeated),
        lines('ours', ...repeated),
        lines(...repeated, 'theirs'),
      ),
    ).toEqual({ kind: 'skipped', reason: 'too-complex' });
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('measures the worst admitted middles', () => {
    // Just inside the work guard: the slowest cases the LCS may take.
    const repeated = Array.from({ length: 300 }, () => 'same');
    const unique = Array.from({ length: 5_000 }, (_, i) => `line ${i}`);
    for (const middle of [repeated, unique]) {
      const started = performance.now();
      const result = threeWayMerge(
        lines(...middle),
        lines('ours', ...middle.slice(1)),
        lines(...middle.slice(0, -1), 'theirs'),
      );
      // Repeated lines align ambiguously, so either outcome is acceptable;
      // the guard must only keep the work bounded.
      expect(result.kind).not.toBe('skipped');
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
