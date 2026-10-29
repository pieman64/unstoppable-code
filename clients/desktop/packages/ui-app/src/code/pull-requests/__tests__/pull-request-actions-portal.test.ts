import type {
  PortalPrStatus,
  PortalWorktreePrActionsState,
} from '@canopy/protocol/portal';
import {
  planPullRequestActions,
  type PullRequestActionsPlan,
} from '../pull-request-actions-plan';
import {
  portalPlannedSteps,
  portalPullRequestActionPayload,
  portalPullRequestActionsFacts,
  portalPullRequestActivity,
  portalPullRequestProgress,
  type PortalPullRequestActionsRow,
} from '../pull-request-actions-portal';

const HEAD = 'a'.repeat(40);
const TARGET = {
  workspaceLocalId: 'cloud:ws:1',
  worktreeLocalId: 'cloud:wt:1',
};

type Repo = PortalWorktreePrActionsState['repos'][number];

function repo(overrides: Partial<Repo> = {}): Repo {
  return {
    repoId: 'wtr-1',
    repoName: 'app',
    baseBranch: 'main',
    headBranch: 'feature/login',
    headSha: HEAD,
    dirty: false,
    ahead: 0,
    behind: 0,
    published: true,
    commitsAhead: true,
    canCreate: true,
    canMerge: false,
    mergeWarning: false,
    status: null,
    ...overrides,
  };
}

function prStatus(overrides: Record<string, unknown> = {}): PortalPrStatus {
  return {
    worktreeLocalId: TARGET.worktreeLocalId,
    number: 12,
    state: 'open',
    repos: [
      {
        repoId: 'wtr-1',
        repoName: 'app',
        status: {
          number: 12,
          url: 'https://github.com/acme/app/pull/12',
          state: 'open',
          baseRefName: 'main',
          title: 'Add login',
          checkStatus: 'passing',
          checkDetails: [{ name: 'unit', status: 'success' }],
          reviewStatus: 'none',
          hasConflicts: false,
          commentCount: 0,
          mergeReady: true,
          unresolvedReviewThreadCount: 0,
          ...overrides,
        },
      },
    ],
  };
}

const IDLE_ROW: PortalPullRequestActionsRow = {
  repo: repo(),
  pendingPayload: null,
  plannedSteps: [],
  pendingStep: null,
  cancellationRequested: false,
};

function plan(r: Repo, status?: PortalPrStatus): PullRequestActionsPlan {
  return planPullRequestActions(
    portalPullRequestActionsFacts(r, status),
    portalPullRequestActivity(IDLE_ROW),
  );
}

describe('portal PR actions: facts', () => {
  it('offers Create PR for a published branch with commits and no PR', () => {
    expect(plan(repo()).createPr).not.toBeNull();
  });

  it('offers nothing for a branch with nothing ahead of its base', () => {
    const result = plan(repo({ commitsAhead: false }));
    expect(result.createPr).toBeNull();
    expect(result.branchSync).toEqual([]);
  });

  it('counts an unpublished branch’s own commits as unpushed', () => {
    const facts = portalPullRequestActionsFacts(
      repo({ published: false, ahead: null }),
      undefined,
    );
    expect(facts.worktree.hasUnpushedCommits).toBe(true);
  });

  it('merges a ready PR and warns on unresolved or unknown threads', () => {
    expect(plan(repo(), prStatus()).merge?.warning).toBe(false);
    expect(
      plan(repo(), prStatus({ unresolvedReviewThreadCount: 2 })).merge?.warning,
    ).toBe(true);
    expect(
      plan(repo(), prStatus({ unresolvedReviewThreadCount: undefined })).merge
        ?.warning,
    ).toBe(true);
  });

  it('commits and pushes onto an open PR', () => {
    expect(plan(repo({ dirty: true }), prStatus()).branchSync).toEqual([
      'commit-and-push',
    ]);
  });

  it('maps the Portal check vocabulary onto the badge', () => {
    const badges = plan(repo(), prStatus()).badges;
    expect(badges?.pr?.number).toBe(12);
    expect(badges?.checkDetails).toEqual([
      { name: 'unit', status: 'passing', detailsUrl: null },
    ]);
  });
});

describe('portal PR actions: activity and progress', () => {
  it('offers to cancel Create PR until its own create call runs', () => {
    const creating = {
      pendingPayload: {
        ...TARGET,
        action: 'create_auto' as const,
        expectedBaseBranch: 'main',
        expectedHeadBranch: 'feature/login',
      },
      cancellationRequested: false,
    };
    expect(
      portalPullRequestActivity({ ...creating, pendingStep: 'push' })
        .createCancellable,
    ).toBe(true);
    expect(
      portalPullRequestActivity({ ...creating, pendingStep: 'create' })
        .createCancellable,
    ).toBe(false);
  });

  it('names the running branch sync and never offers to cancel a merge', () => {
    const pulling = portalPullRequestActivity({
      ...IDLE_ROW,
      pendingPayload: {
        ...TARGET,
        action: 'commit',
        push: true,
        pullFirst: true,
      },
    });
    expect(pulling.activeBranchSyncAction).toBe('pull-commit-and-push');
    expect(pulling.mergeCancellable).toBe(false);
    const merging = portalPullRequestActivity({
      ...IDLE_ROW,
      pendingPayload: {
        ...TARGET,
        action: 'merge',
        expectedPrNumber: 12,
        expectedBaseBranch: 'main',
        expectedHeadBranch: 'feature/login',
      },
    });
    expect(merging.mergingPr).toBe(true);
  });

  it('plans Create PR from what the user acted on', () => {
    const create = {
      ...TARGET,
      action: 'create_auto' as const,
      expectedBaseBranch: 'main',
      expectedHeadBranch: 'feature/login',
    };
    expect(portalPlannedSteps(create, repo({ dirty: true }))).toEqual([
      'commit',
      'push',
      'create',
    ]);
    expect(portalPlannedSteps(create, repo())).toEqual(['create']);
    expect(portalPlannedSteps(create, repo({ ahead: 2 }))).toEqual([
      'push',
      'create',
    ]);
    expect(portalPlannedSteps(create, repo({ behind: 1 }))).toEqual([
      'pull',
      'push',
      'create',
    ]);
    expect(
      portalPlannedSteps(create, repo({ behind: 1, dirty: true })),
    ).toEqual(['pull', 'commit', 'push', 'create']);
  });

  it('checks off the steps before the one the server reports', () => {
    const model = portalPullRequestProgress(
      { type: 'create-pr' },
      {
        ...IDLE_ROW,
        pendingPayload: {
          ...TARGET,
          action: 'create_auto',
          expectedBaseBranch: 'main',
          expectedHeadBranch: 'feature/login',
        },
        plannedSteps: ['commit', 'push', 'create'],
        pendingStep: 'push',
      },
    );
    expect(model?.steps.map((step) => [step.label, step.status])).toEqual([
      ['Committing', 'completed'],
      ['Pushing', 'active'],
      ['Creating pull request', 'pending'],
    ]);
    expect(
      portalPullRequestProgress({ type: 'merge-pr' }, IDLE_ROW),
    ).toBeNull();
  });
});

describe('portal PR actions: payloads', () => {
  it('pins every action to the head the user saw', () => {
    expect(
      portalPullRequestActionPayload(
        { kind: 'branch-sync', action: 'pull-commit-and-push' },
        repo(),
        undefined,
        TARGET,
      ),
    ).toEqual({
      ...TARGET,
      expectedHeadSha: HEAD,
      action: 'commit',
      push: true,
      pullFirst: true,
    });
    expect(
      portalPullRequestActionPayload(
        { kind: 'create-pr', repoIds: undefined },
        repo(),
        undefined,
        TARGET,
      ),
    ).toEqual({
      ...TARGET,
      expectedHeadSha: HEAD,
      action: 'create_auto',
      expectedBaseBranch: 'main',
      expectedHeadBranch: 'feature/login',
    });
  });

  it('merges and aligns with the PR the user saw, on its own base', () => {
    const status = prStatus({ baseRefName: 'release' });
    expect(
      portalPullRequestActionPayload({ kind: 'merge' }, repo(), status, TARGET),
    ).toMatchObject({
      action: 'merge',
      expectedPrNumber: 12,
      expectedBaseBranch: 'release',
    });
    expect(
      portalPullRequestActionPayload(
        { kind: 'align-base' },
        repo(),
        status,
        TARGET,
      ),
    ).toMatchObject({ action: 'update_base_branch', baseBranch: 'release' });
  });

  it("merges the PR's own head, not the worktree's", () => {
    const prHead = 'f'.repeat(40);
    expect(
      portalPullRequestActionPayload(
        { kind: 'merge' },
        repo({ prHeadSha: prHead }),
        prStatus(),
        TARGET,
      ),
    ).toMatchObject({ action: 'merge', expectedHeadSha: prHead });
  });

  it('has no Portal payload for desktop-only actions', () => {
    expect(
      portalPullRequestActionPayload(
        { kind: 'fix-ci' },
        repo(),
        undefined,
        TARGET,
      ),
    ).toBeNull();
  });
});
