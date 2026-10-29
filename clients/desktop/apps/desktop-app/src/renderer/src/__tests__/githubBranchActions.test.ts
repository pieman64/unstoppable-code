import type { RepoBranchInfo } from '@canopy/desktop-shared/types';
import {
  getMultiRepoBranchSyncVisibility,
  getSingleRepoGitAction,
  getSingleRepoBranchSyncVisibility,
  repoHasChanges,
  repoCanCreatePr,
  repoRequiresCommitAndPush,
  repoRequiresPush,
} from '@/lib/githubBranchActions';

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

describe('githubBranchActions', () => {
  it('matches the single-repo button state matrix', () => {
    expect(
      getSingleRepoGitAction({
        hasOpenPr: false,
        hasAnyChanges: false,
        hasRemoteTracking: false,
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        hasUnpulledCommits: false,
      }),
    ).toBe('none');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: false,
        hasAnyChanges: true,
        hasRemoteTracking: false,
        hasUncommittedChanges: true,
        hasUnpushedCommits: false,
        hasUnpulledCommits: false,
      }),
    ).toBe('create-pr');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: false,
        hasAnyChanges: true,
        hasRemoteTracking: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: false,
        hasUnpulledCommits: false,
      }),
    ).toBe('create-pr');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: true,
        hasAnyChanges: true,
        hasRemoteTracking: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: true,
        hasUnpulledCommits: false,
      }),
    ).toBe('commit-and-push');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: true,
        hasAnyChanges: true,
        hasRemoteTracking: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: true,
        hasUnpulledCommits: false,
      }),
    ).toBe('push');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: true,
        hasAnyChanges: true,
        hasRemoteTracking: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: false,
        hasUnpulledCommits: true,
      }),
    ).toBe('pull-commit-and-push');

    expect(
      getSingleRepoGitAction({
        hasOpenPr: true,
        hasAnyChanges: false,
        hasRemoteTracking: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        hasUnpulledCommits: true,
      }),
    ).toBe('pull');
  });

  it('shows only Commit & Push for tracked branches with uncommitted changes', () => {
    expect(
      getSingleRepoBranchSyncVisibility({
        hasRemoteTracking: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: true,
        hasUnpulledCommits: false,
      }),
    ).toEqual({
      showCommit: false,
      showCommitAndPush: true,
      showPullCommitAndPush: false,
      showPush: false,
      showPull: false,
    });
  });

  it('shows only Push for tracked branches with committed but unpushed changes', () => {
    expect(
      getSingleRepoBranchSyncVisibility({
        hasRemoteTracking: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: true,
        hasUnpulledCommits: false,
      }),
    ).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: false,
      showPush: true,
      showPull: false,
    });
  });

  it('shows Pull when tracked branches are behind remote with no uncommitted changes', () => {
    expect(
      getSingleRepoBranchSyncVisibility({
        hasRemoteTracking: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        hasUnpulledCommits: true,
      }),
    ).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: false,
      showPush: false,
      showPull: true,
    });
  });

  it('hides Pull once the remote tracking branch is gone', () => {
    expect(
      getSingleRepoBranchSyncVisibility({
        hasRemoteTracking: false,
        hasUncommittedChanges: false,
        hasUnpushedCommits: false,
        hasUnpulledCommits: true,
      }),
    ).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: false,
      showPush: false,
      showPull: false,
    });
  });

  it('keeps Pull visible for clean diverged branches', () => {
    const params = {
      hasOpenPr: true,
      hasAnyChanges: true,
      hasRemoteTracking: true,
      hasUncommittedChanges: false,
      hasUnpushedCommits: true,
      hasUnpulledCommits: true,
    };

    expect(getSingleRepoGitAction(params)).toBe('pull');
    expect(getSingleRepoBranchSyncVisibility(params)).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: false,
      showPush: false,
      showPull: true,
    });
  });

  it('shows Pull, Commit & Push when tracked branches are behind remote with uncommitted changes', () => {
    expect(
      getSingleRepoBranchSyncVisibility({
        hasRemoteTracking: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: false,
        hasUnpulledCommits: true,
      }),
    ).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: true,
      showPush: false,
      showPull: false,
    });
  });

  it('keeps create-pr eligibility for untracked branches with committed changes', () => {
    const branch = makeBranchInfo({
      commitsAhead: true,
      hasRemoteTrackingBranch: false,
      hasUncommittedChanges: false,
      hasUnpushedCommits: false,
    });

    expect(repoRequiresCommitAndPush(branch)).toBe(false);
    expect(repoRequiresPush(branch)).toBe(false);
    expect(repoCanCreatePr(branch)).toBe(true);
  });

  it('treats uncommitted or unpushed flags as changes even without diff stats', () => {
    expect(
      repoHasChanges(
        makeBranchInfo({
          commitsAhead: false,
          insertions: 0,
          deletions: 0,
          hasUncommittedChanges: true,
          hasUnpushedCommits: false,
        }),
      ),
    ).toBe(true);

    expect(
      repoHasChanges(
        makeBranchInfo({
          commitsAhead: false,
          insertions: 0,
          deletions: 0,
          hasUncommittedChanges: false,
          hasUnpushedCommits: true,
        }),
      ),
    ).toBe(true);
  });

  it('removes create-pr eligibility until tracked branches are synced', () => {
    const uncommittedTracked = makeBranchInfo({
      commitsAhead: true,
      hasRemoteTrackingBranch: true,
      hasUncommittedChanges: true,
      hasUnpushedCommits: true,
    });
    const unpushedTracked = makeBranchInfo({
      commitsAhead: true,
      hasRemoteTrackingBranch: true,
      hasUncommittedChanges: false,
      hasUnpushedCommits: true,
    });

    expect(repoCanCreatePr(uncommittedTracked)).toBe(false);
    expect(repoCanCreatePr(unpushedTracked)).toBe(false);
  });

  it('shows both sync actions in multi-repo worktrees when different repos need each action', () => {
    const visibility = getMultiRepoBranchSyncVisibility([
      makeBranchInfo({
        repoId: 'repo-a',
        hasRemoteTrackingBranch: true,
        hasUncommittedChanges: true,
        hasUnpushedCommits: true,
      }),
      makeBranchInfo({
        repoId: 'repo-b',
        hasRemoteTrackingBranch: true,
        hasUncommittedChanges: false,
        hasUnpushedCommits: true,
      }),
    ]);

    expect(visibility).toEqual({
      showCommit: false,
      showCommitAndPush: true,
      showPullCommitAndPush: false,
      showPush: true,
      showPull: false,
    });
  });

  it('can scope multi-repo sync visibility to only the repos tied to open PRs', () => {
    const visibility = getMultiRepoBranchSyncVisibility(
      [
        makeBranchInfo({
          repoId: 'repo-a',
          hasRemoteTrackingBranch: true,
          hasUncommittedChanges: false,
          hasUnpushedCommits: false,
        }),
        makeBranchInfo({
          repoId: 'repo-b',
          hasRemoteTrackingBranch: true,
          hasUncommittedChanges: true,
          hasUnpushedCommits: true,
        }),
      ],
      ['repo-a'],
    );

    expect(visibility).toEqual({
      showCommit: false,
      showCommitAndPush: false,
      showPullCommitAndPush: false,
      showPush: false,
      showPull: false,
    });
  });

  describe('local-only repos', () => {
    it('returns commit when local-only repo has uncommitted changes', () => {
      expect(
        getSingleRepoGitAction({
          hasOpenPr: false,
          hasAnyChanges: true,
          hasRemoteTracking: false,
          hasOriginRemote: false,
          hasUncommittedChanges: true,
          hasUnpushedCommits: false,
          hasUnpulledCommits: false,
        }),
      ).toBe('commit');
    });

    it('returns merge when local-only repo has commits ahead of base', () => {
      expect(
        getSingleRepoGitAction({
          hasOpenPr: false,
          hasAnyChanges: true,
          hasRemoteTracking: false,
          hasOriginRemote: false,
          hasUncommittedChanges: false,
          hasUnpushedCommits: false,
          hasUnpulledCommits: false,
          commitsAhead: true,
          baseBranchExistsLocally: true,
        }),
      ).toBe('merge');
    });

    it('returns none when local-only and base branch is missing locally', () => {
      expect(
        getSingleRepoGitAction({
          hasOpenPr: false,
          hasAnyChanges: true,
          hasRemoteTracking: false,
          hasOriginRemote: false,
          hasUncommittedChanges: false,
          hasUnpushedCommits: false,
          hasUnpulledCommits: false,
          commitsAhead: true,
          baseBranchExistsLocally: false,
        }),
      ).toBe('none');
    });

    it('local-only committed repo is not PR-eligible', () => {
      const branch = makeBranchInfo({
        commitsAhead: true,
        hasRemoteTrackingBranch: false,
        hasUncommittedChanges: false,
        hasOriginRemote: false,
        baseBranchExistsLocally: true,
      });
      expect(repoCanCreatePr(branch)).toBe(false);
    });

    it('multi-repo visibility surfaces showCommit when any local-only repo has uncommitted changes', () => {
      const visibility = getMultiRepoBranchSyncVisibility([
        makeBranchInfo({
          repoId: 'repo-a',
          hasRemoteTrackingBranch: false,
          hasOriginRemote: false,
          hasUncommittedChanges: true,
        }),
        makeBranchInfo({
          repoId: 'repo-b',
          hasRemoteTrackingBranch: true,
          hasUncommittedChanges: false,
        }),
      ]);

      expect(visibility.showCommit).toBe(true);
      // Remote-backed repo with no uncommitted changes does not require
      // commit-and-push.
      expect(visibility.showCommitAndPush).toBe(false);
    });
  });
});
