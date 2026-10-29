import {
  fileScopeIsAllowlist,
  selectDefaultRunScripts,
} from '../lib/shared-container-scope-mode';

describe('shared-container scope mode', () => {
  it('never treats a code worktree as an allowlist', () => {
    expect(
      fileScopeIsAllowlist('CODE_WORKTREE', {
        includedPaths: ['legacy.txt'],
        legacyAllowlist: true,
      }),
    ).toBe(false);
    expect(
      fileScopeIsAllowlist('COWORK_WORK_ENTRY', {
        includedPaths: ['legacy.txt'],
      }),
    ).toBe(true);
  });

  it('selects every candidate when fewer than eight are available', () => {
    expect(
      selectDefaultRunScripts(['custom', 'launch'], { includedPaths: [] }),
    ).toEqual(['launch', 'custom']);
  });

  it('selects up to eight scripts lifecycle-first', () => {
    expect(
      selectDefaultRunScripts(
        [
          'zulu',
          'echo',
          'delta',
          'charlie',
          'bravo',
          'alpha',
          'teardown',
          'launch',
          'setup',
        ],
        { includedPaths: [] },
      ),
    ).toEqual([
      'setup',
      'launch',
      'teardown',
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
    ]);
  });

  it('promotes the next script after an exclusion and honors disablement', () => {
    const candidates = [
      'setup',
      'launch',
      'teardown',
      'alpha',
      'bravo',
      'charlie',
      'delta',
      'echo',
      'zulu',
    ];
    expect(
      selectDefaultRunScripts(candidates, {
        includedPaths: [],
        excludedRunScripts: ['alpha'],
      }),
    ).toContain('zulu');
    expect(
      selectDefaultRunScripts(candidates, {
        includedPaths: [],
        runSharingDisabled: true,
      }),
    ).toEqual([]);
  });
});
