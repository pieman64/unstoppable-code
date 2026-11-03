import type { PrPickerOption } from '@/stores/navigationStore';
import { prPickerOptionMatches } from '../prPickerModel';

function buildOption(
  repoId: string,
  repoName: string,
  prNumber: number,
  prTitle: string,
): PrPickerOption {
  return {
    repoId,
    repoName,
    prNumber,
    prTitle,
    prState: 'open',
    prUrl: `https://github.com/example/${repoName}/pull/${prNumber}`,
  };
}

describe('prPickerModel', () => {
  const options: PrPickerOption[] = [
    buildOption('repo-a', 'alpha', 10, 'Alpha feature'),
    buildOption('repo-b', 'beta', 42, 'Beta bugfix'),
  ];

  it('filters options by the current query', () => {
    const filter = (query: string): PrPickerOption[] =>
      options.filter((option) => prPickerOptionMatches(option, query));
    expect(filter('  beta  ')).toEqual([options[1]]);
    expect(filter('#10')).toEqual([options[0]]);
  });

  it('matches one option by repo, title, number or state', () => {
    expect(prPickerOptionMatches(options[0], '  ALPHA ')).toBe(true);
    expect(prPickerOptionMatches(options[0], '#10')).toBe(true);
    expect(prPickerOptionMatches(options[0], 'open')).toBe(true);
    expect(prPickerOptionMatches(options[0], 'beta')).toBe(false);
    expect(prPickerOptionMatches(options[0], '   ')).toBe(true);
  });
});
