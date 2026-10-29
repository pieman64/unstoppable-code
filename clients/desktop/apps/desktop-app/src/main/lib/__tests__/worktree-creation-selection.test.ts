// CAN-3810: the typed branch and base selections of the worktree creation
// boundary, their projection to and from the service's loose request fields,
// and the refusals of invalid combinations with the existing messages.
import {
  projectWorktreeCreationSelection,
  requestedBranchNames,
  resolveWorktreeCreationSelection,
  WorktreeCreationRefusedError,
  type WorktreeCreationSelection,
  type WorktreeCreationWorkspaceKind,
  type WorktreeSelectionFields,
} from '../worktree-creation-selection';

const KINDS: WorktreeCreationWorkspaceKind[] = ['single-repo', 'multi-repo'];

const SHARED_SELECTIONS: Array<{
  name: string;
  fields: WorktreeSelectionFields;
  selection: WorktreeCreationSelection;
}> = [
  {
    name: 'the default branch from the repository default base',
    fields: {},
    selection: {
      branch: { kind: 'default' },
      base: { kind: 'repository-default' },
    },
  },
  {
    name: 'a new named branch',
    fields: { branchName: ' feature/x ' },
    selection: {
      branch: { kind: 'new', branchName: 'feature/x' },
      base: { kind: 'repository-default' },
    },
  },
  {
    name: 'an existing branch tracking a base branch',
    fields: { existingBranch: 'feature/x', baseBranch: 'main' },
    selection: {
      branch: { kind: 'existing', branchName: 'feature/x' },
      base: { kind: 'branch', baseBranch: 'main' },
    },
  },
  {
    name: 'a suggested branch from a remote base',
    fields: { suggestedBranch: 'feature/x', baseBranch: 'origin/main' },
    selection: {
      branch: { kind: 'suggested', branchName: 'feature/x' },
      base: { kind: 'branch', baseBranch: 'origin/main' },
    },
  },
  {
    name: 'the default branch from a base worktree',
    fields: { baseWorktreeId: 'otter' },
    selection: {
      branch: { kind: 'default' },
      base: { kind: 'worktree', baseWorktreeId: 'otter' },
    },
  },
  {
    name: 'a new branch from a base worktree',
    fields: { branchName: 'feature/x', baseWorktreeId: 'otter' },
    selection: {
      branch: { kind: 'new', branchName: 'feature/x' },
      base: { kind: 'worktree', baseWorktreeId: 'otter' },
    },
  },
];

const MULTI_REPO_SELECTIONS: typeof SHARED_SELECTIONS = [
  {
    name: 'per-repository bases',
    fields: { baseBranchesByRepo: { api: 'main', web: 'develop' } },
    selection: {
      branch: { kind: 'default' },
      base: {
        kind: 'per-repository',
        baseBranches: { api: 'main', web: 'develop' },
      },
    },
  },
  {
    name: 'an existing branch restored into some repositories',
    fields: {
      existingBranch: 'feature/x',
      existingBranchRepoPaths: ['/repos/api'],
      baseBranchesByRepo: { api: 'main' },
    },
    selection: {
      branch: {
        kind: 'existing',
        branchName: 'feature/x',
        restoreRepoPaths: ['/repos/api'],
      },
      base: { kind: 'per-repository', baseBranches: { api: 'main' } },
    },
  },
];

function refusalOf(action: () => unknown): WorktreeCreationRefusedError {
  try {
    action();
  } catch (error) {
    if (error instanceof WorktreeCreationRefusedError) return error;
    throw error;
  }
  throw new Error('Expected a refusal');
}

describe('worktree creation selection', () => {
  describe.each(KINDS)('%s', (kind) => {
    const cases =
      kind === 'multi-repo'
        ? [...SHARED_SELECTIONS, ...MULTI_REPO_SELECTIONS]
        : SHARED_SELECTIONS;

    it.each(cases)('resolves $name', ({ fields, selection }) => {
      expect(resolveWorktreeCreationSelection(fields, kind)).toEqual(selection);
    });

    it.each(cases)('round-trips $name', ({ selection }) => {
      expect(
        resolveWorktreeCreationSelection(
          projectWorktreeCreationSelection(selection),
          kind,
        ),
      ).toEqual(selection);
    });

    it.each([
      {
        fields: { branchName: 'a', existingBranch: 'b' },
        message:
          'existingBranch, branchName, and suggestedBranch cannot be combined',
      },
      {
        fields: { existingBranch: 'a', suggestedBranch: 'b' },
        message:
          'existingBranch, branchName, and suggestedBranch cannot be combined',
      },
      {
        fields: { branchName: '   ' },
        message: 'Branch name must be a non-empty value',
      },
      {
        fields: { suggestedBranch: '-x' },
        message: 'Branch name must be a non-empty value',
      },
      {
        fields: { existingBranchRepoPaths: ['/repos/api'] },
        message: 'existingBranchRepoPaths requires existingBranch',
      },
      {
        fields: { baseWorktreeId: 'otter', baseBranch: 'main' },
        message:
          'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
      },
      {
        fields: { baseWorktreeId: 'otter', existingBranch: 'feature/x' },
        message:
          'baseWorktreeId is mutually exclusive with baseBranch and existingBranch',
      },
    ])('refuses $fields with the existing message', ({ fields, message }) => {
      const refusal = refusalOf(() =>
        resolveWorktreeCreationSelection(fields, kind),
      );
      expect(refusal.reason).toBe('invalid-selection');
      expect(refusal.message).toBe(message);
      // The message a renderer sees through IPC keeps the plain prefix.
      expect(String(refusal)).toBe(`Error: ${message}`);
    });
  });

  it('refuses per-repository bases for a single-repository project', () => {
    for (const fields of [
      { baseBranchesByRepo: { api: 'main' } },
      { baseBranchesByRepo: {} },
    ]) {
      const refusal = refusalOf(() =>
        resolveWorktreeCreationSelection(fields, 'single-repo'),
      );
      expect(refusal.reason).toBe('invalid-selection');
      expect(refusal.message).toBe(
        'baseBranchesByRepo is only supported for multi-repository projects',
      );
    }
  });

  it('refuses per-repository bases combined with another base', () => {
    for (const fields of [
      { baseBranchesByRepo: { api: 'main' }, baseBranch: 'main' },
      { baseBranchesByRepo: { api: 'main' }, baseWorktreeId: 'otter' },
    ]) {
      expect(
        refusalOf(() => resolveWorktreeCreationSelection(fields, 'multi-repo'))
          .message,
      ).toBe(
        'baseBranchesByRepo cannot be combined with baseBranch or baseWorktreeId',
      );
    }
  });

  it('treats an empty per-repository map as no multi-repository base', () => {
    expect(
      resolveWorktreeCreationSelection(
        { baseBranchesByRepo: {}, baseBranch: 'main' },
        'multi-repo',
      ).base,
    ).toEqual({ kind: 'branch', baseBranch: 'main' });
  });

  it('splits a branch selection into the requested branch names', () => {
    expect(requestedBranchNames({ kind: 'default' })).toEqual({
      explicitBranch: null,
      existingBranch: null,
      suggestedBranch: null,
    });
    expect(requestedBranchNames({ kind: 'new', branchName: 'a' })).toEqual({
      explicitBranch: 'a',
      existingBranch: null,
      suggestedBranch: null,
    });
    expect(requestedBranchNames({ kind: 'existing', branchName: 'b' })).toEqual(
      {
        explicitBranch: null,
        existingBranch: 'b',
        suggestedBranch: null,
      },
    );
    expect(
      requestedBranchNames({ kind: 'suggested', branchName: 'c' }),
    ).toEqual({
      explicitBranch: null,
      existingBranch: null,
      suggestedBranch: 'c',
    });
  });
});
