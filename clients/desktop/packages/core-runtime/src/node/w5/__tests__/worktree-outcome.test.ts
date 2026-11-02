import {
  decodeW5WorktreeBranchRenameOutcome,
  decodeW5WorktreeHooksPausedOutcome,
  decodeW5WorktreeOutcome,
  decodeW5WorktreeUpdateOutcome,
  W5OutcomeDecodeError,
} from '../worktree-outcome';

// Desktop's w5-worktree-outcome-parity test compares every case against the
// zod schemas these decoders replaced; this pins the projection on its own.

const row = { id: 'wt', branchName: 'main', createdAt: '2026-10-01' };

function refusal(decode: () => unknown): W5OutcomeDecodeError {
  try {
    decode();
  } catch (error) {
    if (error instanceof W5OutcomeDecodeError) return error;
    throw error;
  }
  throw new Error('Expected a decode refusal');
}

describe('decodeW5WorktreeOutcome', () => {
  it('projects a stored row in shape order and strips unknown fields', () => {
    const decoded = decodeW5WorktreeOutcome(
      JSON.parse(
        '{"setupPhase":"git-ready","replica":{"state":"present"},"trackedBaseBranch":null,"label":"Fix","createdAt":"2026-10-01","branchName":"main","id":"wt","trackedRepoBaseBranches":{"__proto__":"x","r":"main"}}',
      ),
    );
    expect(JSON.stringify(decoded)).toBe(
      '{"id":"wt","branchName":"main","createdAt":"2026-10-01","label":"Fix","trackedBaseBranch":null,"trackedRepoBaseBranches":{"r":"main"},"setupPhase":"git-ready"}',
    );
  });

  it('keeps a present undefined optional key and omits an absent one', () => {
    const decoded = decodeW5WorktreeOutcome({ ...row, label: undefined });
    expect(Object.keys(decoded)).toEqual([
      'id',
      'branchName',
      'createdAt',
      'label',
    ]);
    expect(decoded.label).toBeUndefined();
    expect('trackedBaseBranch' in decodeW5WorktreeOutcome(row)).toBe(false);
  });

  it.each<[string, unknown, string]>([
    ['a non-object row', [], ''],
    ['a missing required field', { branchName: 'b', createdAt: 'c' }, 'id'],
    ['a null optional field', { ...row, label: null }, 'label'],
    [
      'an unaccepted enum',
      { ...row, branchGroupingOverride: 'auto' },
      'branchGroupingOverride',
    ],
    [
      'a non-string list item',
      { ...row, includedRepoIds: ['r', 1] },
      'includedRepoIds.1',
    ],
    [
      'a non-plain record',
      { ...row, trackedRepoBaseBranches: new Map() },
      'trackedRepoBaseBranches',
    ],
    [
      'a non-string record value',
      { ...row, trackedRepoBaseBranches: { r: 1 } },
      'trackedRepoBaseBranches.r',
    ],
  ])('refuses %s and names its path', (_name, value, path) => {
    const error = refusal(() => decodeW5WorktreeOutcome(value));
    expect(error.path).toBe(path);
    expect(error.name).toBe('W5OutcomeDecodeError');
  });
});

describe('outcome decoders', () => {
  it('decode each saved outcome and refuse a malformed nested row', () => {
    expect(
      decodeW5WorktreeUpdateOutcome({ worktree: row, changed: false, x: 1 }),
    ).toEqual({
      worktree: row,
      changed: false,
    });
    expect(
      decodeW5WorktreeBranchRenameOutcome({ branchName: 'b', worktree: null }),
    ).toEqual({
      branchName: 'b',
      worktree: null,
    });
    expect(
      decodeW5WorktreeHooksPausedOutcome({
        changed: true,
        pausedHookKeys: ['a'],
        worktree: { pausedHookKeys: ['a'], ...row },
      }),
    ).toEqual({
      worktree: { ...row, pausedHookKeys: ['a'] },
      pausedHookKeys: ['a'],
      changed: true,
    });
    expect(
      refusal(() => decodeW5WorktreeBranchRenameOutcome({ branchName: 'b' }))
        .path,
    ).toBe('worktree');
    expect(
      refusal(() =>
        decodeW5WorktreeHooksPausedOutcome({
          worktree: { ...row, pausedHookKeys: null },
          pausedHookKeys: [],
          changed: true,
        }),
      ).path,
    ).toBe('worktree.pausedHookKeys');
  });
});
