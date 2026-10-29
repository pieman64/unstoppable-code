import { getWorktreeBranchDisplayName } from '@/lib/worktreeDisplayName';

describe('getWorktreeBranchDisplayName', () => {
  const getBranchDisplayName = jest.fn((branchName: string) =>
    branchName.toUpperCase(),
  );

  beforeEach(() => {
    getBranchDisplayName.mockClear();
  });

  it('shows New Task for legacy generated branch names', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'dormouse',
        worktreeId: 'dormouse',
        hasMultipleBranches: false,
        getBranchDisplayName,
      }),
    ).toBe('New Task');
    expect(getBranchDisplayName).not.toHaveBeenCalled();
  });

  it('shows New Task for timestamped generated branch names', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'dormouse-1713571200123',
        worktreeId: 'dormouse',
        hasMultipleBranches: false,
        getBranchDisplayName,
      }),
    ).toBe('New Task');
    expect(getBranchDisplayName).not.toHaveBeenCalled();
  });

  it('shows New Task for legacy numeric collision branch names', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'dormouse-2',
        worktreeId: 'dormouse',
        hasMultipleBranches: false,
        getBranchDisplayName,
      }),
    ).toBe('New Task');
    expect(getBranchDisplayName).not.toHaveBeenCalled();
  });

  it('uses the caller default name for generated branch names', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'dormouse-1713571200123',
        worktreeId: 'dormouse',
        hasMultipleBranches: false,
        getBranchDisplayName,
        defaultDisplayName: 'New worktree',
      }),
    ).toBe('New worktree');
    expect(getBranchDisplayName).not.toHaveBeenCalled();
  });

  it('keeps the synthetic multi-branch label unchanged', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'Multiple branches',
        worktreeId: 'dormouse',
        hasMultipleBranches: true,
        getBranchDisplayName,
      }),
    ).toBe('Multiple branches');
    expect(getBranchDisplayName).not.toHaveBeenCalled();
  });

  it('applies branch display mappings for renamed branches', () => {
    expect(
      getWorktreeBranchDisplayName({
        rawBranch: 'feature/ship-it',
        worktreeId: 'dormouse',
        hasMultipleBranches: false,
        getBranchDisplayName,
      }),
    ).toBe('FEATURE/SHIP-IT');
    expect(getBranchDisplayName).toHaveBeenCalledWith('feature/ship-it');
  });
});
