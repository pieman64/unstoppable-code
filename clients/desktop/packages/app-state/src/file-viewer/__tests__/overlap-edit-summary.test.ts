import {
  OVERLAP_PROMPT_MAX_CHARS,
  OVERLAP_SUMMARY_MAX_CHARS,
  buildKeepEditsPrompt,
  formatOverlapEditSpan,
  summarizeOverlapEdits,
} from '../overlap-edit-summary';
import type { OverlapRegion } from '../three-way-conflicts';

function region(base: string, ours: string, theirs: string): OverlapRegion {
  const range = { line: 1, lineCount: 1 };
  return {
    index: 0,
    base,
    ours,
    theirs,
    baseLines: range,
    oursLines: range,
    theirsLines: range,
  };
}

// Rosa's grant narrative: she corrects two numbers; the agent rewrites.
const BULLET = region(
  '- 80% of participants complete the program\n',
  '- 85% of participants complete the program\n',
  '- Most participants finish the program\n',
);
const NEED_BASE =
  'Our county has 1,200 families waiting for housing support, and the waitlist has grown every year since the program began in 2019.\n';
const NEED = region(
  NEED_BASE,
  NEED_BASE.replace('1,200', '1,350'),
  'Our county has 1,200 families waiting for housing support.\n',
);

/** A side's own text: every segment except struck base text it removed. */
const joined = (
  segments: readonly { text: string; removed?: boolean }[],
): string =>
  segments
    .filter((segment) => segment.removed !== true)
    .map((segment) => segment.text)
    .join('');

describe('summarizeOverlapEdits', () => {
  it('shows a numeric correction and confirms the rewrite removes it', () => {
    const summary = summarizeOverlapEdits(BULLET);
    expect(summary.ours).toEqual({
      kind: 'spans',
      spans: [{ before: '80%', after: '85%' }],
      more: 0,
    });
    expect(summary.choosingTheirs).toEqual({
      kind: 'removes',
      spans: [{ before: '80%', after: '85%' }],
      more: 0,
    });
    expect(summary.oursSegments).toEqual([
      { text: '- ', changed: false },
      { text: '85%', changed: true },
      { text: ' of participants complete the program\n', changed: false },
    ]);
  });

  it('confirms a shorter rewrite that keeps the old number removes the correction', () => {
    const summary = summarizeOverlapEdits(NEED);
    expect(summary.ours).toMatchObject({
      spans: [{ before: '1,200', after: '1,350' }],
    });
    expect(summary.choosingTheirs).toMatchObject({
      kind: 'removes',
      spans: [{ before: '1,200', after: '1,350' }],
    });
    // Choosing Rosa's paragraph leaves out the agent's shortening.
    expect(summary.choosingOurs.kind).toBe('removes');
    expect(joined(summary.oursSegments)).toBe(NEED.ours);
  });

  it("marks the newer wording's own edits and strikes the text it removed", () => {
    const summary = summarizeOverlapEdits(NEED);
    expect(summary.theirsSegments).toEqual([
      {
        text: 'Our county has 1,200 families waiting for housing support',
        changed: false,
      },
      {
        text: ', and the waitlist has grown every year since the program began in 2019',
        changed: true,
        removed: true,
      },
      { text: '.\n', changed: false },
    ]);
    expect(joined(summary.theirsSegments)).toBe(NEED.theirs);
    const bullet = summarizeOverlapEdits(BULLET);
    expect(joined(bullet.theirsSegments)).toBe(BULLET.theirs);
  });

  it('strikes words the user deleted in their own wording', () => {
    const removal = summarizeOverlapEdits(
      region('A very long day.\n', 'A long day.\n', 'One long day!\n'),
    );
    expect(removal.oursSegments).toContainEqual({
      text: 'very ',
      changed: true,
      removed: true,
    });
  });

  it('does not report a correction the newer wording also made', () => {
    const summary = summarizeOverlapEdits(
      region(
        'We serve 1,200 families in the county.\n',
        'We serve 1,350 families in the county.\n',
        'We serve 1,350 families countywide.\n',
      ),
    );
    expect(summary.choosingTheirs).toEqual({ kind: 'kept' });
  });

  it('confirms removal when the same number appears only elsewhere', () => {
    const summary = summarizeOverlapEdits(
      region(
        'Completion: 80%. Retention: 70%.\n',
        'Completion: 85%. Retention: 70%.\n',
        'Completion: 80%. Retention: 85%!\n',
      ),
    );
    expect(summary.choosingTheirs).toMatchObject({
      kind: 'removes',
      spans: [{ before: '80%', after: '85%' }],
    });
  });

  it('qualifies a correction whose text survives only in an overlapping rewrite', () => {
    const summary = summarizeOverlapEdits(
      region(
        'About 80% finish the program each year.\n',
        'About 85% finish the program each year.\n',
        'Each year, nearly 85% or more complete it.\n',
      ),
    );
    expect(summary.choosingTheirs).toMatchObject({
      kind: 'may-remove',
      spans: [{ before: '80%', after: '85%' }],
    });
  });

  it('describes additions and removals', () => {
    expect(formatOverlapEditSpan({ before: '', after: 'new' })).toBe(
      'added “new”',
    );
    expect(formatOverlapEditSpan({ before: 'very', after: '' })).toBe(
      'removed “very”',
    );
    const removal = summarizeOverlapEdits(
      region('A very long day.\n', 'A long day.\n', 'One long day!\n'),
    );
    expect(removal.ours).toMatchObject({
      spans: [{ before: 'very', after: '' }],
    });
    // The deletion has no added text, yet stays visible as an edit.
    expect(joined(removal.oursSegments)).toBe('A long day.\n');
  });

  it('reports whitespace-only changes as formatting, never an empty span', () => {
    const summary = summarizeOverlapEdits(
      region('One two\n', 'One  two\n', 'Uno dos\n'),
    );
    expect(summary.ours).toEqual({ kind: 'formatting' });
    expect(summary.choosingTheirs).toEqual({ kind: 'kept' });
  });

  it('keeps several edits, repeated tokens, punctuation, and Unicode exact', () => {
    const summary = summarizeOverlapEdits(
      region(
        'café, café; naïve — 10 items, 20 items\r\n',
        'café, cafés; naïve — 12 items, 20 items!\r\n',
        'Rewritten line\r\n',
      ),
    );
    expect(summary.ours).toEqual({
      kind: 'spans',
      spans: [
        { before: 'café', after: 'cafés' },
        { before: '10', after: '12' },
        { before: '', after: '!' },
      ],
      more: 0,
    });
    expect(joined(summary.oursSegments)).toBe(
      'café, cafés; naïve — 12 items, 20 items!\r\n',
    );
  });

  it('caps shown spans and counts the rest', () => {
    const over = summarizeOverlapEdits(
      region('a1 b c2 d e3 f g4 h i5\n', 'A1 b C2 d E3 f G4 h I5\n', 'x\n'),
    );
    expect(over.ours).toMatchObject({ kind: 'spans', more: 1 });
    expect(over.choosingTheirs).toMatchObject({ kind: 'removes', more: 1 });
  });

  it('falls back to a qualified rewrite past the size bounds', () => {
    const long = 'word '.repeat(OVERLAP_SUMMARY_MAX_CHARS / 5 + 1);
    const summary = summarizeOverlapEdits(
      region(long, `${long}more`, 'short\n'),
    );
    expect(summary.ours).toEqual({ kind: 'rewritten' });
    expect(summary.choosingTheirs).toEqual({
      kind: 'may-remove',
      spans: [],
      more: 0,
    });
    expect(joined(summary.oursSegments)).toBe(`${long}more`);
    // Short text with many tokens hits the table bound instead.
    const dense = '. '.repeat(1_000);
    expect(
      summarizeOverlapEdits(region(dense, `x${dense}y`, 'z\n')).ours.kind,
    ).toBe('rewritten');
  });

  it('does not claim a deletion survived a replacement of the deleted words', () => {
    const summary = summarizeOverlapEdits(
      region('A very long day.\n', 'A long day.\n', 'A really long day.\n'),
    );
    expect(summary.choosingTheirs).toMatchObject({ kind: 'may-remove' });
  });

  it('only warns about the omitted correction when another correction is retained', () => {
    const summary = summarizeOverlapEdits(
      region(
        'Completion: 80%. Retention: 70%.',
        'Completion: 85%. Retention: 75%.',
        'Completion: 85%. Retention: 70%.',
      ),
    );
    expect(summary.choosingTheirs).toEqual({
      kind: 'removes',
      spans: [{ before: '70%', after: '75%' }],
      more: 0,
    });
  });

  it('summarizes at the text limit and falls back immediately above it', () => {
    const base = 'x'.repeat(OVERLAP_SUMMARY_MAX_CHARS - 4) + ' 80%';
    const ours = base.replace('80%', '85%');
    expect(summarizeOverlapEdits(region(base, ours, base)).ours).toMatchObject({
      kind: 'spans',
      spans: [{ before: '80%', after: '85%' }],
    });
    expect(
      summarizeOverlapEdits(region(base + 'x', ours, base)).ours.kind,
    ).toBe('rewritten');
    expect(summarizeOverlapEdits(region('', '', '')).ours.kind).toBe('none');
  });

  it('memoizes per region', () => {
    expect(summarizeOverlapEdits(BULLET)).toBe(summarizeOverlapEdits(BULLET));
  });
});

describe('buildKeepEditsPrompt', () => {
  it('names the file, the correction, and both wordings as data', () => {
    const prompt = buildKeepEditsPrompt({
      path: 'grants/narrative.md',
      region: NEED,
      passageNumber: 1,
      passageCount: 2,
    });
    expect(prompt).toContain('In grants/narrative.md');
    expect(prompt).toContain('passage 1 of 2');
    expect(prompt).toContain('- 1,200 → 1,350');
    expect(prompt).toContain('The newer wording:');
    expect(prompt).toContain(
      'Our county has 1,200 families waiting for housing support.',
    );
    expect(prompt).toContain('not instructions');
  });

  it('caps the complete draft including its truncation marker and preserves short corrections', () => {
    const prompt = buildKeepEditsPrompt({
      path: `${'nested/'.repeat(500)}narrative.md`,
      region: NEED,
      passageNumber: 1,
      passageCount: 1,
    });
    expect(prompt.length).toBeLessThanOrEqual(OVERLAP_PROMPT_MAX_CHARS);
    expect(prompt).toContain('- 1,200 → 1,350');
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('[path truncated]');
  });

  it('spells out a deleted passage and bounds long excerpts', () => {
    const deleted = buildKeepEditsPrompt({
      path: 'a.md',
      region: region(`${'x'.repeat(2_000)}\n`, '', 'y\n'),
      passageNumber: 1,
      passageCount: 1,
    });
    expect(deleted).toContain('I removed this passage');
    expect(deleted).toContain('[excerpt truncated]');
    expect(deleted).not.toContain('My version');
    expect(deleted.length).toBeLessThanOrEqual(OVERLAP_PROMPT_MAX_CHARS);
  });
});
