import {
  isSimilarSignature,
  signatureSimilarity,
  taskSignature,
  taskSimilarity,
} from '../similarity';

describe('repeat task similarity', () => {
  it('ignores dates, numbers, weekdays, months, relative dates, and URLs', () => {
    const first =
      'Please review the report on March 1, 2025 and update the retention dashboard every Monday today. https://example.com/first';
    const second =
      'Review the report in October 28, 2030 and update the retention dashboard every Friday tomorrow. https://another.example/second';

    expect(taskSignature(first)).toEqual(taskSignature(second));
    expect(taskSimilarity(first, second)).toBe(1);
  });

  it('does not treat one changed key noun in a short task as similar', () => {
    const first = 'Review the account security report';
    const second = 'Review the account security billing';

    expect(taskSignature(first)).toHaveLength(4);
    expect(taskSimilarity(first, second)).toBeLessThan(0.8);
    expect(
      isSimilarSignature(taskSignature(first), taskSignature(second)),
    ).toBe(false);
  });

  it('returns zero when either signature has fewer than three distinct tokens', () => {
    expect(taskSignature('Fix the build')).toEqual(['build', 'fix']);
    expect(
      signatureSimilarity(['fix', 'build', 'tests'], ['fix', 'build']),
    ).toBe(0);
    expect(taskSimilarity('Fix the build', 'Fix the build')).toBe(0);
  });

  it('includes the similarity threshold boundary', () => {
    expect(
      signatureSimilarity(
        ['alpha', 'bravo', 'charlie', 'delta'],
        ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      ),
    ).toBe(0.8);
    expect(
      isSimilarSignature(
        ['alpha', 'bravo', 'charlie', 'delta'],
        ['alpha', 'bravo', 'charlie', 'delta', 'echo'],
      ),
    ).toBe(true);
    expect(
      signatureSimilarity(
        ['alpha', 'bravo', 'charlie'],
        ['alpha', 'bravo', 'charlie', 'delta'],
      ),
    ).toBe(0.75);
    expect(
      isSimilarSignature(
        ['alpha', 'bravo', 'charlie'],
        ['alpha', 'bravo', 'charlie', 'delta'],
      ),
    ).toBe(false);
  });

  it('normalizes compatibility forms and case before tokenizing', () => {
    expect(taskSignature('ＦＩＸ caching, Café, reports')).toEqual(
      taskSignature('fix CAFE\u0301 reports caching'),
    );
    expect(taskSignature('may improve the release quality')).toEqual([
      'improve',
      'quality',
      'release',
    ]);
  });

  it('returns sorted unique tokens and ignores text after the prompt limit', () => {
    expect(taskSignature('Review report review report tests')).toEqual([
      'report',
      'review',
      'tests',
    ]);
    const capped = `${'alpha '.repeat(800)}ignored trailing words`;
    expect(taskSignature(capped)).not.toContain('trailing');
  });
});
