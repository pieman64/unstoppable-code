import {
  THREE_WAY_MERGE_MAX_BYTES,
  analyzeThreeWay,
  resolveOverlaps,
  type OverlapRegion,
} from '../three-way-conflicts';

const lines = (...values: string[]): string =>
  values.map((value) => `${value}\n`).join('');

function regionsOf(
  base: string,
  ours: string,
  theirs: string,
): readonly OverlapRegion[] {
  const analysis = analyzeThreeWay(base, ours, theirs);
  if (analysis.kind !== 'conflicts') {
    throw new Error(`expected conflicts, got ${analysis.kind}`);
  }
  return analysis.regions;
}

describe('analyzeThreeWay', () => {
  const base = lines('one', 'two', 'three', 'four', 'five');

  it('merges disjoint changes cleanly', () => {
    expect(
      analyzeThreeWay(
        base,
        lines('ONE', 'two', 'three', 'four', 'five'),
        lines('one', 'two', 'three', 'four', 'FIVE'),
      ),
    ).toEqual({
      kind: 'clean',
      content: lines('ONE', 'two', 'three', 'four', 'FIVE'),
    });
  });

  it('merges identical concurrent changes cleanly', () => {
    const same = lines('one', 'TWO', 'three', 'four', 'five');
    expect(analyzeThreeWay(base, same, same)).toEqual({
      kind: 'clean',
      content: same,
    });
  });

  it('reports a first-line overlap with both wordings and coordinates', () => {
    expect(
      regionsOf(
        base,
        lines('mine', 'two', 'three', 'four', 'five'),
        lines('agent', 'two', 'three', 'four', 'five'),
      ),
    ).toEqual([
      {
        index: 0,
        base: 'one\n',
        ours: 'mine\n',
        theirs: 'agent\n',
        baseLines: { line: 1, lineCount: 1 },
        oursLines: { line: 1, lineCount: 1 },
        theirsLines: { line: 1, lineCount: 1 },
      },
    ]);
  });

  it('includes the trimmed prefix in last-line coordinates', () => {
    const [region] = regionsOf(
      base,
      lines('one', 'two', 'three', 'four', 'Try it free'),
      lines('one', 'two', 'three', 'four', 'Start your trial'),
    );
    expect(region).toMatchObject({
      ours: 'Try it free\n',
      theirs: 'Start your trial\n',
      oursLines: { line: 5, lineCount: 1 },
      theirsLines: { line: 5, lineCount: 1 },
    });
  });

  it('orders multiple passages with side-specific line starts', () => {
    const regions = regionsOf(
      base,
      lines('ONE', 'extra', 'two', 'three', 'four', 'mine'),
      lines('uno', 'two', 'three', 'four', 'agent'),
    );
    expect(regions.map((region) => region.index)).toEqual([0, 1]);
    expect(regions[0]).toMatchObject({
      ours: 'ONE\nextra\n',
      theirs: 'uno\n',
      oursLines: { line: 1, lineCount: 2 },
      theirsLines: { line: 1, lineCount: 1 },
    });
    expect(regions[1]).toMatchObject({
      ours: 'mine\n',
      theirs: 'agent\n',
      oursLines: { line: 6, lineCount: 1 },
      theirsLines: { line: 5, lineCount: 1 },
    });
  });

  it('represents delete-versus-edit with a zero-length anchor', () => {
    const [region] = regionsOf(
      base,
      lines('one', 'two', 'four', 'five'),
      lines('one', 'two', 'THREE', 'four', 'five'),
    );
    expect(region).toMatchObject({
      base: 'three\n',
      ours: '',
      theirs: 'THREE\n',
      oursLines: { line: 3, lineCount: 0 },
      theirsLines: { line: 3, lineCount: 1 },
    });
  });

  it('reports different insertions at the same boundary', () => {
    const [region] = regionsOf(
      base,
      lines('one', 'two', 'mine', 'three', 'four', 'five'),
      lines('one', 'two', 'agent', 'three', 'four', 'five'),
    );
    expect(region).toMatchObject({
      base: '',
      ours: 'mine\n',
      theirs: 'agent\n',
      baseLines: { line: 3, lineCount: 0 },
    });
  });

  it('handles empty sides and documents', () => {
    expect(analyzeThreeWay('', '', 'new\n')).toEqual({
      kind: 'clean',
      content: 'new\n',
    });
    const [region] = regionsOf('', 'mine\n', 'agent\n');
    expect(region).toMatchObject({
      base: '',
      oursLines: { line: 1, lineCount: 1 },
      baseLines: { line: 1, lineCount: 0 },
    });
  });

  it('treats a trailing-newline difference as content', () => {
    const [region] = regionsOf('a\nb\n', 'a\nb', 'a\nB\n');
    expect(region).toMatchObject({ ours: 'b', theirs: 'B\n' });
  });

  it('preserves CRLF and mixed endings without normalizing', () => {
    const mixed = 'one\r\ntwo\nthree\r\n';
    const regions = regionsOf(
      mixed,
      'one\r\nTWO\nthree\r\n',
      'one\r\ntwo!\r\nthree\r\n',
    );
    expect(regions[0]).toMatchObject({ ours: 'TWO\n', theirs: 'two!\r\n' });
    expect(
      resolveOverlaps(
        mixed,
        'one\r\nTWO\nthree\r\n',
        'one\r\ntwo!\r\nthree\r\n',
        ['theirs'],
      ),
    ).toEqual({ kind: 'resolved', content: 'one\r\ntwo!\r\nthree\r\n' });
  });

  it('applies input guards', () => {
    expect(analyzeThreeWay('a\0', 'b', 'c')).toEqual({
      kind: 'skipped',
      reason: 'binary',
    });
  });
});

describe('analyzeThreeWay line refinement', () => {
  const heading = '## Outcomes';
  const base = lines(
    heading,
    '- 80% of participants complete the program',
    '- Twelve workshops per year',
    '- Quarterly reports to the board',
  );
  const oursOneBullet = lines(
    heading,
    '- 85% of participants complete the program',
    '- Twelve workshops per year',
    '- Quarterly reports to the board',
  );
  const theirsAllBullets = lines(
    heading,
    '- Most participants finish the program',
    '- A workshop every month',
    '- Board updates each quarter',
  );

  it('narrows a whole-list overlap to the one bullet both changed', () => {
    const regions = regionsOf(base, oursOneBullet, theirsAllBullets);
    expect(regions).toEqual([
      {
        index: 0,
        base: '- 80% of participants complete the program\n',
        ours: '- 85% of participants complete the program\n',
        theirs: '- Most participants finish the program\n',
        baseLines: { line: 2, lineCount: 1 },
        oursLines: { line: 2, lineCount: 1 },
        theirsLines: { line: 2, lineCount: 1 },
      },
    ]);
    expect(
      resolveOverlaps(base, oursOneBullet, theirsAllBullets, ['theirs']),
    ).toEqual({ kind: 'resolved', content: theirsAllBullets });
    expect(
      resolveOverlaps(base, oursOneBullet, theirsAllBullets, ['ours']),
    ).toEqual({
      kind: 'resolved',
      content: lines(
        heading,
        '- 85% of participants complete the program',
        '- A workshop every month',
        '- Board updates each quarter',
      ),
    });
  });

  it('splits non-adjacent conflicting bullets and merges the one between', () => {
    const ours = lines(
      heading,
      '- 85% of participants complete the program',
      '- Twelve workshops per year',
      '- Monthly reports to the board',
    );
    const regions = regionsOf(base, ours, theirsAllBullets);
    expect(regions.map((region) => region.index)).toEqual([0, 1]);
    expect(regions[1]).toMatchObject({
      ours: '- Monthly reports to the board\n',
      theirs: '- Board updates each quarter\n',
      oursLines: { line: 4, lineCount: 1 },
    });
    expect(
      resolveOverlaps(base, ours, theirsAllBullets, ['ours', 'ours']),
    ).toEqual({
      kind: 'resolved',
      content: lines(
        heading,
        '- 85% of participants complete the program',
        '- A workshop every month',
        '- Monthly reports to the board',
      ),
    });
  });

  it('keeps consecutive conflicting lines as one passage', () => {
    const ours = lines(
      heading,
      '- 85% of participants complete the program',
      '- Ten workshops per year',
      '- Quarterly reports to the board',
    );
    const [region, ...rest] = regionsOf(base, ours, theirsAllBullets);
    expect(rest).toEqual([]);
    expect(region).toMatchObject({
      ours: '- 85% of participants complete the program\n- Ten workshops per year\n',
      theirs:
        '- Most participants finish the program\n- A workshop every month\n',
      baseLines: { line: 2, lineCount: 2 },
    });
  });

  it('merges identical changes and unchanged separators inside a region', () => {
    const regionBase = lines('a', '', 'b', 'c');
    const ours = lines('A', '', 'B!', 'c');
    const theirs = lines('A', '', 'B?', 'C');
    const [region, ...rest] = regionsOf(regionBase, ours, theirs);
    expect(rest).toEqual([]);
    expect(region).toMatchObject({
      base: 'b\n',
      oursLines: { line: 3, lineCount: 1 },
    });
    expect(resolveOverlaps(regionBase, ours, theirs, ['ours'])).toEqual({
      kind: 'resolved',
      content: lines('A', '', 'B!', 'C'),
    });
  });

  it('merges adjacent one-sided line changes cleanly', () => {
    expect(
      analyzeThreeWay(lines('a', 'b'), lines('A', 'b'), lines('a', 'B')),
    ).toEqual({ kind: 'clean', content: lines('A', 'B') });
  });

  it('offsets each side independently after earlier insertions', () => {
    const regionBase = lines('intro', 'p', 'q', 'm1', 'm2', 'm3', 'x', 'y');
    // Earlier, ours inserts a line and theirs deletes one, so the refined
    // passage starts on a different line in each version.
    const ours = lines('intro', 'NEW', 'p', 'q', 'm1', 'm2', 'm3', 'X1', 'y');
    const theirs = lines('intro', 'p', 'm1', 'm2', 'm3', 'X2', 'Y2');
    expect(regionsOf(regionBase, ours, theirs)).toEqual([
      {
        index: 0,
        base: 'x\n',
        ours: 'X1\n',
        theirs: 'X2\n',
        baseLines: { line: 7, lineCount: 1 },
        oursLines: { line: 8, lineCount: 1 },
        theirsLines: { line: 6, lineCount: 1 },
      },
    ]);
    expect(resolveOverlaps(regionBase, ours, theirs, ['ours'])).toEqual({
      kind: 'resolved',
      content: lines('intro', 'NEW', 'p', 'm1', 'm2', 'm3', 'X1', 'Y2'),
    });
  });

  it('keeps the whole region when line counts differ', () => {
    const ours = lines(
      heading,
      '- 85% of participants complete the program',
      '- Twelve workshops per year',
      '- Quarterly reports to the board',
      '- A new bullet',
    );
    const [region] = regionsOf(base, ours, theirsAllBullets);
    expect(region?.baseLines).toEqual({ line: 2, lineCount: 3 });
  });

  it('keeps the whole region for equal-count moves and shifts', () => {
    const regionBase = lines('a', 'b', 'c');
    // ours reorders; theirs rewrites every line.
    const reordered = regionsOf(
      regionBase,
      lines('b', 'a', 'c!'),
      lines('1', '2', '3'),
    );
    expect(reordered).toHaveLength(1);
    expect(reordered[0]?.baseLines).toEqual({ line: 1, lineCount: 3 });
    // ours deletes "a" and appends "d": the same count, shifted lines.
    const shifted = regionsOf(
      regionBase,
      lines('b', 'c', 'd'),
      lines('1', '2', '3'),
    );
    expect(shifted).toHaveLength(1);
    expect(shifted[0]?.baseLines).toEqual({ line: 1, lineCount: 3 });
  });

  it('keeps the whole region when a repeated line matches elsewhere', () => {
    const regionBase = lines('x', 'x', 'y');
    const regions = regionsOf(
      regionBase,
      lines('z', 'x', 'y!'),
      lines('1', '2', '3'),
    );
    expect(regions).toHaveLength(1);
    expect(regions[0]?.baseLines).toEqual({ line: 1, lineCount: 3 });
  });

  it('refines without normalizing CRLF or a missing final newline', () => {
    const regionBase = 'a\r\nb\r\nc';
    const ours = 'A\r\nb\r\nc';
    const theirs = 'a2\r\nb2\r\nc2';
    const [region, ...rest] = regionsOf(regionBase, ours, theirs);
    expect(rest).toEqual([]);
    expect(region).toMatchObject({ ours: 'A\r\n', theirs: 'a2\r\n' });
    expect(resolveOverlaps(regionBase, ours, theirs, ['ours'])).toEqual({
      kind: 'resolved',
      content: 'A\r\nb2\r\nc2',
    });
  });
});

describe('resolveOverlaps', () => {
  const base = lines('one', 'two', 'three', 'four', 'five');
  const ours = lines('ONE', 'two', 'mine', 'four', 'five');
  const theirs = lines('uno', 'two', 'three', 'four', 'FIVE');

  it('applies mixed choices and keeps every disjoint change', () => {
    // The first line overlaps; line 3 is ours alone; line 5 is theirs alone.
    expect(resolveOverlaps(base, ours, theirs, ['theirs'])).toEqual({
      kind: 'resolved',
      content: lines('uno', 'two', 'mine', 'four', 'FIVE'),
    });
    expect(resolveOverlaps(base, ours, theirs, ['ours'])).toEqual({
      kind: 'resolved',
      content: lines('ONE', 'two', 'mine', 'four', 'FIVE'),
    });
  });

  it('resolves each passage independently', () => {
    const multiOurs = lines('A', 'two', 'three', 'four', 'E');
    const multiTheirs = lines('a', 'two', 'three', 'four', 'e');
    expect(
      resolveOverlaps(base, multiOurs, multiTheirs, ['ours', 'theirs']),
    ).toEqual({
      kind: 'resolved',
      content: lines('A', 'two', 'three', 'four', 'e'),
    });
  });

  it('rejects missing, extra, and invalid choices', () => {
    expect(resolveOverlaps(base, ours, theirs, [])).toEqual({
      kind: 'invalid',
    });
    expect(resolveOverlaps(base, ours, theirs, ['ours', 'ours'])).toEqual({
      kind: 'invalid',
    });
    const bogus = JSON.parse('["both"]') as readonly ['ours'];
    expect(resolveOverlaps(base, ours, theirs, bogus)).toEqual({
      kind: 'invalid',
    });
  });

  it('guards the merged and resolved output size', () => {
    // Each input fits; the disjoint additions together do not.
    const big = 'x'.repeat(Math.ceil(THREE_WAY_MERGE_MAX_BYTES * 0.6));
    const guardBase = 'a\nm\nz\n';
    const guardOurs = `a\nmine\nz\n${big}\n`;
    const guardTheirs = `${big}\na\nagent\nz\n`;
    expect(analyzeThreeWay(guardBase, guardOurs, guardTheirs).kind).toBe(
      'conflicts',
    );
    expect(
      resolveOverlaps(guardBase, guardOurs, guardTheirs, ['ours']),
    ).toEqual({ kind: 'skipped', reason: 'output-too-large' });
    expect(
      analyzeThreeWay('a\nz\n', `a\nz\n${big}\n`, `${big}\na\nz\n`),
    ).toEqual({ kind: 'skipped', reason: 'output-too-large' });
  });
});
