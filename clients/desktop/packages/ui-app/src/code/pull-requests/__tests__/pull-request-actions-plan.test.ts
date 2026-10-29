import { getCreatePrActionName } from '../pull-request-actions-copy';
import {
  IDLE_PULL_REQUEST_ACTIVITY,
  planPullRequestActions,
  type PullRequestActionsActivity,
  type PullRequestActionsFacts,
  type PullRequestActionsPlan,
  type PullRequestCreatePlan,
  type PullRequestActionsPr,
  type PullRequestActionsRepo,
} from '../pull-request-actions-plan';
import type { PullRequestBranchFacts } from '../branch-actions';

const CLEAN: PullRequestBranchFacts = {
  repoId: 'repo-1',
  commitsAhead: true,
  hasUncommittedChanges: false,
  hasUnpushedCommits: false,
  hasUnpulledCommits: false,
  hasRemoteTrackingBranch: true,
  hasOriginRemote: true,
  baseBranchExistsLocally: true,
};

function pr(
  overrides: Partial<PullRequestActionsPr> = {},
): PullRequestActionsPr {
  return {
    number: 7,
    url: 'https://github.com/o/r/pull/7',
    state: 'open',
    checkStatus: 'passing',
    checkDetails: [{ name: 'unit', status: 'passing', detailsUrl: null }],
    readyToMerge: true,
    inMergeQueue: false,
    hasConflicts: false,
    reviewThreadsWarning: false,
    mergeRoute: 'direct',
    ...overrides,
  };
}

function repo(
  pull: PullRequestActionsPr | null,
  repoId = 'repo-1',
): PullRequestActionsRepo {
  return { repoId, repoName: repoId, pr: pull };
}

function facts(
  overrides: Partial<PullRequestActionsFacts> = {},
): PullRequestActionsFacts {
  return {
    isMultiRepo: false,
    repos: [repo(null)],
    worktree: CLEAN,
    splitPr: null,
    agentHelpers: true,
    ...overrides,
  };
}

function plan(
  input: Partial<PullRequestActionsFacts> = {},
  activity: Partial<PullRequestActionsActivity> = {},
): PullRequestActionsPlan {
  return planPullRequestActions(facts(input), {
    ...IDLE_PULL_REQUEST_ACTIVITY,
    ...activity,
  });
}

function actionName(create: PullRequestCreatePlan | null): string {
  if (create === null) throw new Error('Create PR is not offered');
  return getCreatePrActionName(create.label);
}

describe('planPullRequestActions (desktop header rules)', () => {
  it.each([
    [
      { checkStatus: 'pending' as const },
      'Wait for the checks to finish to merge.',
    ],
    [{ checkStatus: 'failing' as const }, 'Fix the failing checks to merge.'],
    [
      { state: 'draft' as const },
      'Mark the pull request ready for review to merge.',
    ],
    [{ hasConflicts: true }, 'Resolve the conflicts to merge.'],
    [
      { reviewStatus: 'changes_requested' as const },
      'Get an approving review to merge.',
    ],
    [{}, 'GitHub reports this pull request cannot merge yet.'],
  ])(
    'keeps Merge for an open PR that waits, disabled with why (%j)',
    (overrides, reason) => {
      const result = plan({
        repos: [repo(pr({ readyToMerge: false, ...overrides }))],
      });
      expect(result.merge).toMatchObject({
        blockedReason: reason,
        help: reason,
      });
    },
  );

  it('offers no Merge without an open PR', () => {
    expect(plan().merge).toBeNull();
  });

  it('waits for a running action before Merge', () => {
    const result = plan(
      { repos: [repo(pr())] },
      { mergingLocalBranches: true },
    );
    expect(result.merge?.blockedReason).toBe(
      'Wait for the running action to finish.',
    );
  });

  it('shows Split PR waiting on its blockers, and only where it applies', () => {
    expect(
      plan({ splitPr: { blockedReason: 'Push local commits first' } }).splitPr,
    ).toEqual({ blockedReason: 'Push local commits first' });
    expect(plan({ splitPr: null }).splitPr).toBeNull();
  });

  it('shows the agent helpers unavailable on a host without them', () => {
    const result = plan({
      agentHelpers: false,
      repos: [
        repo(
          pr({
            readyToMerge: false,
            hasConflicts: true,
            checkStatus: 'failing',
            checkDetails: [
              { name: 'lint', status: 'failing', detailsUrl: null },
            ],
          }),
        ),
      ],
    });
    expect(result.fixCi).toEqual({
      blockedReason: "Fixing checks with an agent isn't available here yet.",
    });
    expect(result.resolveConflicts).toEqual({
      blockedReason:
        "Resolving conflicts with an agent isn't available here yet.",
    });
  });

  it('keeps Resolve conflicts waiting for a clean worktree', () => {
    const result = plan({
      repos: [repo(pr({ readyToMerge: false, hasConflicts: true }))],
      worktree: { ...CLEAN, hasUncommittedChanges: true },
    });
    expect(result.resolveConflicts?.blockedReason).toBe(
      'Commit and push the local changes to resolve the conflicts.',
    );
  });

  it('offers Create PR with the commit and push it implies', () => {
    const result = plan({
      worktree: { ...CLEAN, hasUncommittedChanges: true },
    });
    expect(result.createPr).not.toBeNull();
    expect(actionName(result.createPr)).toBe('Commit, push & create PR');
    expect(result.branchSync).toEqual([]);
    expect(result.merge).toBeNull();
  });

  it.each([false, true])(
    'keeps an active Create PR when git facts disappear (multi-repo: %s)',
    (isMultiRepo) => {
      const result = plan(
        { isMultiRepo, worktree: { repoId: 'repo-1' }, repoBranches: [] },
        { creatingPr: true },
      );
      expect(result.createPr).not.toBeNull();
      expect(result.additionalCreatePr).toBeNull();
    },
  );

  it('keeps an additional Create PR when another repository already has a PR', () => {
    const result = plan(
      {
        isMultiRepo: true,
        repos: [repo(pr()), repo(null, 'repo-2')],
        worktree: { repoId: 'repo-1' },
        repoBranches: [],
      },
      { creatingPr: true },
    );
    expect(result.createPr).toBeNull();
    expect(result.additionalCreatePr).not.toBeNull();
  });

  it('keeps an active Create PR while its snapshot refreshes', () => {
    expect(plan({ repos: null }, { creatingPr: true }).createPr).not.toBeNull();
  });

  it('names Push & Create PR for unpushed commits', () => {
    const result = plan({ worktree: { ...CLEAN, hasUnpushedCommits: true } });
    expect(actionName(result.createPr)).toBe('Push & create PR');
  });

  it('offers nothing before the host has a PR snapshot', () => {
    const result = plan({
      repos: null,
      worktree: { ...CLEAN, hasUncommittedChanges: true },
    });
    expect(result.createPr).toBeNull();
    expect(result.badges).toBeNull();
  });

  it('commits and pushes onto an open PR, and holds Merge until it is clean', () => {
    const result = plan({
      repos: [repo(pr())],
      worktree: { ...CLEAN, hasUncommittedChanges: true },
    });
    expect(result.branchSync).toEqual(['commit-and-push']);
    expect(result.merge?.blockedReason).toBe(
      'Commit and push the local changes to merge.',
    );
    expect(result.createPr).toBeNull();
  });

  it('pulls first when the open PR branch is also behind', () => {
    const result = plan({
      repos: [repo(pr())],
      worktree: {
        ...CLEAN,
        hasUncommittedChanges: true,
        hasUnpulledCommits: true,
      },
    });
    expect(result.branchSync).toEqual(['pull-commit-and-push']);
  });

  it('pushes unpushed commits onto an open PR', () => {
    const result = plan({
      repos: [repo(pr())],
      worktree: { ...CLEAN, hasUnpushedCommits: true },
    });
    expect(result.branchSync).toEqual(['push']);
  });

  it('pulls a clean branch that is behind, with or without a PR', () => {
    expect(
      plan({ worktree: { ...CLEAN, hasUnpulledCommits: true } }).branchSync,
    ).toEqual(['pull']);
  });

  it('merges a ready PR on a clean worktree, tinted when threads are unresolved', () => {
    expect(plan({ repos: [repo(pr())] }).merge).toEqual({
      via: 'direct',
      help: 'Merge the pull request',
      warning: false,
      onlyStartsChat: false,
    });
    expect(
      plan({ repos: [repo(pr({ reviewThreadsWarning: true }))] }).merge
        ?.warning,
    ).toBe(true);
  });

  it('shows the merge queue status instead of Merge', () => {
    const result = plan({
      repos: [
        repo(
          pr({
            readyToMerge: false,
            inMergeQueue: true,
            mergeQueuePosition: 2,
          }),
        ),
      ],
    });
    expect(result.merge).toBeNull();
    expect(result.mergeQueue).toEqual({ label: 'In merge queue (#2)' });
  });

  it('offers conflict resolution and Fix for settled failing checks', () => {
    const result = plan({
      repos: [
        repo(
          pr({
            readyToMerge: false,
            hasConflicts: true,
            checkStatus: 'failing',
            checkDetails: [
              { name: 'lint', status: 'failing', detailsUrl: null },
            ],
          }),
        ),
      ],
    });
    expect(result.resolveConflicts).toEqual({});
    expect(result.fixCi).toEqual({});
  });

  it('keeps the merged PR badge and offers no PR actions on a clean branch', () => {
    const result = plan({
      repos: [repo(pr({ state: 'merged', readyToMerge: false }))],
      worktree: { ...CLEAN, commitsAhead: false },
    });
    expect(result.badges?.pr?.state).toBe('merged');
    expect(result.merge).toBeNull();
    expect(result.createPr).toBeNull();
  });

  it('commits locally in a repository without a remote', () => {
    const result = plan({
      worktree: {
        ...CLEAN,
        hasOriginRemote: false,
        hasUncommittedChanges: true,
      },
    });
    expect(result.localCommit).toEqual({ repoIds: undefined });
    expect(result.createPr).toBeNull();
  });

  it('shows only the running branch-sync action while it runs', () => {
    const result = plan(
      {
        repos: [repo(pr())],
        worktree: { ...CLEAN, hasUncommittedChanges: true },
      },
      { committingAndPushing: true, activeBranchSyncAction: 'push' },
    );
    expect(result.branchSync).toEqual(['push']);
    expect(result.merge?.blockedReason).toBe(
      'Commit and push the local changes to merge.',
    );
  });

  it('opens PRs for the multi-repo repositories that still need one', () => {
    const result = plan({
      isMultiRepo: true,
      repos: [repo(pr(), 'api'), repo(null, 'web')],
      repoBranches: [
        { ...CLEAN, repoId: 'api' },
        { ...CLEAN, repoId: 'web', hasUncommittedChanges: true },
      ],
    });
    expect(result.badges?.openRepos.map((r) => r.repoId)).toEqual(['api']);
    expect(result.additionalCreatePr?.repoIds).toEqual(['web']);
    expect(actionName(result.additionalCreatePr)).toBe(
      'Commit, push & create PR',
    );
  });
});
