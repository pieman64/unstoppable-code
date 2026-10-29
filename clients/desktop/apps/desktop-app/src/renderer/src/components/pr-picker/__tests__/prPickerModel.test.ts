import type { PrPickerOption } from '@/stores/navigationStore';
import {
  getFilteredPrPickerOptions,
  getSelectedPrPickerOption,
} from '../prPickerModel';

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
    expect(getFilteredPrPickerOptions(options, '  beta  ')).toEqual([
      options[1],
    ]);
    expect(getFilteredPrPickerOptions(options, '#10')).toEqual([options[0]]);
  });

  it('uses the latest query when resolving the enter selection', () => {
    expect(getSelectedPrPickerOption(options, 'beta', 0)).toEqual(options[1]);
  });

  it('returns undefined when the current query has no selected match', () => {
    expect(getSelectedPrPickerOption(options, 'missing', 0)).toBeUndefined();
    expect(getSelectedPrPickerOption(options, 'alpha', -1)).toBeUndefined();
  });
});
