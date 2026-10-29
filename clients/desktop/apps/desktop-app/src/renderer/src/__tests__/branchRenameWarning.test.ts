import type { RepoBranchInfo } from '@canopy/desktop-shared/types';
import { shouldWarnBranchNotRenamed } from '@/lib/branchRenameWarning';

function makeBranchInfo(
  overrides: Partial<RepoBranchInfo> = {},
): RepoBranchInfo {
  return {
    repoId: 'repo-a',
    repoName: 'Repo A',
    branch: 'feature/test',
    ...overrides,
  };
}

describe('shouldWarnBranchNotRenamed', () => {
  describe('single-repo', () => {
    it('warns when branch matches worktree id and has not been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: false,
        hasBranchBeenPushed: false,
      });
      expect(result.shouldWarn).toBe(true);
      expect(result.unrenamedRepos).toEqual([]);
    });

    it('warns when branch is the timestamped default branch and has not been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse-1713571200123',
        isMultiRepo: false,
        hasBranchBeenPushed: false,
      });
      expect(result.shouldWarn).toBe(true);
      expect(result.unrenamedRepos).toEqual([]);
    });

    it('does not warn when branch has been renamed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'feature/my-feature',
        isMultiRepo: false,
        hasBranchBeenPushed: false,
      });
      expect(result.shouldWarn).toBe(false);
    });

    it('does not warn when branch has already been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: false,
        hasBranchBeenPushed: true,
      });
      expect(result.shouldWarn).toBe(false);
    });

    it('does not warn when branch is renamed and pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'feature/my-feature',
        isMultiRepo: false,
        hasBranchBeenPushed: true,
      });
      expect(result.shouldWarn).toBe(false);
    });
  });

  describe('multi-repo', () => {
    it('warns when any repo branch matches worktree id and has not been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [
          makeBranchInfo({
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'dormouse',
            hasBranchBeenPushed: false,
          }),
          makeBranchInfo({
            repoId: 'repo-b',
            repoName: 'Repo B',
            branch: 'feature/renamed',
            hasBranchBeenPushed: false,
          }),
        ],
      });
      expect(result.shouldWarn).toBe(true);
      expect(result.unrenamedRepos).toEqual([
        { repoId: 'repo-a', repoName: 'Repo A', branchName: 'dormouse' },
      ]);
    });

    it('warns when any repo branch is the timestamped default branch and has not been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse-1713571200123',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [
          makeBranchInfo({
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'dormouse-1713571200123',
            hasBranchBeenPushed: false,
          }),
        ],
      });
      expect(result.shouldWarn).toBe(true);
      expect(result.unrenamedRepos).toEqual([
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          branchName: 'dormouse-1713571200123',
        },
      ]);
    });

    it('does not warn when all repo branches have been renamed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [
          makeBranchInfo({
            branch: 'feature/renamed-a',
            hasBranchBeenPushed: false,
          }),
          makeBranchInfo({
            branch: 'feature/renamed-b',
            hasBranchBeenPushed: false,
          }),
        ],
      });
      expect(result.shouldWarn).toBe(false);
      expect(result.unrenamedRepos).toEqual([]);
    });

    it('does not warn when matching branches have already been pushed', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [
          makeBranchInfo({
            branch: 'dormouse',
            hasBranchBeenPushed: true,
          }),
        ],
      });
      expect(result.shouldWarn).toBe(false);
      expect(result.unrenamedRepos).toEqual([]);
    });

    it('lists only unrenamed unpushed repos', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [
          makeBranchInfo({
            repoId: 'repo-a',
            repoName: 'Repo A',
            branch: 'dormouse',
            hasBranchBeenPushed: false,
          }),
          makeBranchInfo({
            repoId: 'repo-b',
            repoName: 'Repo B',
            branch: 'dormouse',
            hasBranchBeenPushed: true,
          }),
          makeBranchInfo({
            repoId: 'repo-c',
            repoName: 'Repo C',
            branch: 'feature/renamed',
            hasBranchBeenPushed: false,
          }),
        ],
      });
      expect(result.shouldWarn).toBe(true);
      expect(result.unrenamedRepos).toEqual([
        { repoId: 'repo-a', repoName: 'Repo A', branchName: 'dormouse' },
      ]);
    });

    it('handles empty repoBranches', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
        repoBranches: [],
      });
      expect(result.shouldWarn).toBe(false);
      expect(result.unrenamedRepos).toEqual([]);
    });

    it('handles undefined repoBranches', () => {
      const result = shouldWarnBranchNotRenamed({
        worktreeId: 'dormouse',
        worktreeBranchName: 'dormouse',
        isMultiRepo: true,
        hasBranchBeenPushed: false,
      });
      expect(result.shouldWarn).toBe(false);
      expect(result.unrenamedRepos).toEqual([]);
    });
  });
});
