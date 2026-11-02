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
  portalPullRequestMergeRepo,
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

describe('portal PR actions: every repository of a multi-repo worktree', () => {
  const ROOT_ID = '__workspace_root__';
  const CHILD_HEAD = 'b'.repeat(40);
  const root = (overrides: Partial<Repo> = {}): Repo =>
    repo({ repoId: ROOT_ID, repoName: 'Project root', ...overrides });
  const child = (overrides: Partial<Repo> = {}): Repo =>
    repo({
      repoId: 'api',
      repoName: 'API',
      baseBranch: 'develop',
      headSha: CHILD_HEAD,
      ...overrides,
    });
  type StatusRepo = NonNullable<PortalPrStatus['repos']>[number];
  const childPr = (overrides: Record<string, unknown> = {}): StatusRepo => ({
    repoId: 'api',
    repoName: 'API',
    status: {
      number: 7,
      url: 'https://github.com/acme/api/pull/7',
      state: 'open',
      baseRefName: 'develop',
      checkStatus: 'passing' as const,
      mergeReady: true,
      unresolvedReviewThreadCount: 0,
      ...overrides,
    },
  });
  function statusOf(...repos: StatusRepo[]): PortalPrStatus {
    return { worktreeLocalId: TARGET.worktreeLocalId, repos };
  }
  const NO_ROOT_PR = {
    repoId: ROOT_ID,
    repoName: 'Project root',
    status: null,
  };
  function multiPlan(
    repos: readonly [Repo, ...Repo[]],
    status?: PortalPrStatus,
  ): PullRequestActionsPlan {
    return planPullRequestActions(
      portalPullRequestActionsFacts(repos[0], status, { repos }),
      portalPullRequestActivity(IDLE_ROW),
    );
  }

  it('keeps one repository exactly as it was without the opt-in', () => {
    const r = repo({ dirty: true });
    const status = prStatus();
    expect(portalPullRequestActionsFacts(r, status, { repos: [r] })).toEqual(
      portalPullRequestActionsFacts(r, status),
    );
    for (const request of [
      { kind: 'branch-sync', action: 'commit-and-push' },
      { kind: 'create-pr', repoIds: undefined },
      { kind: 'merge' },
    ] as const) {
      expect(
        portalPullRequestActionPayload(request, r, status, TARGET, {
          repos: [r],
        }),
      ).toEqual(portalPullRequestActionPayload(request, r, status, TARGET));
    }
  });

  it('plans from every repository and creates a PR in each changed one', () => {
    const changed = child({ dirty: true, published: false, ahead: null });
    const repos = [root({ commitsAhead: false }), changed] as const;
    const facts = portalPullRequestActionsFacts(repos[0], undefined, {
      repos,
    });
    expect(facts.isMultiRepo).toBe(true);
    expect(facts.repoBranches?.map((branch) => branch.repoId)).toEqual([
      ROOT_ID,
      'api',
    ]);
    expect(facts.worktree.hasUncommittedChanges).toBe(true);
    // Only the child has changes, so only the child gets a PR.
    expect(multiPlan(repos).createPr?.repoIds).toEqual(['api']);

    const both = [root(), changed] as const;
    const create = multiPlan(both).createPr;
    expect(create?.repoIds).toEqual([ROOT_ID, 'api']);
    expect(create?.label.repoCount).toBe(2);
    expect(
      portalPullRequestActionPayload(
        { kind: 'create-pr', repoIds: create?.repoIds },
        both[0],
        undefined,
        TARGET,
        { repos: both },
      ),
    ).toEqual({
      ...TARGET,
      expectedHeadSha: HEAD,
      repoIds: [ROOT_ID, 'api'],
      action: 'create_auto',
      expectedBaseBranch: 'main',
      expectedHeadBranch: 'feature/login',
    });
  });

  it("never reads another repository's PR", () => {
    const repos = [root(), child()] as const;
    const facts = portalPullRequestActionsFacts(
      repos[0],
      statusOf(NO_ROOT_PR, childPr()),
      { repos },
    );
    expect(facts.repos?.map((entry) => entry.pr?.number ?? null)).toEqual([
      null,
      7,
    ]);
  });

  it('syncs each repository whose own state calls for the action', () => {
    const repos = [root({ dirty: true }), child({ ahead: 1 })] as const;
    const status = statusOf(
      { ...childPr(), repoId: ROOT_ID, repoName: 'Project root' },
      childPr(),
    );
    expect(multiPlan(repos, status).branchSync).toEqual([
      'commit-and-push',
      'push',
    ]);
    const sync = (
      action: 'commit-and-push' | 'push' | 'pull',
    ): ReturnType<typeof portalPullRequestActionPayload> =>
      portalPullRequestActionPayload(
        { kind: 'branch-sync', action },
        repos[0],
        status,
        TARGET,
        { repos },
      );
    expect(sync('commit-and-push')).toEqual({
      ...TARGET,
      expectedHeadSha: HEAD,
      repoIds: [ROOT_ID],
      action: 'commit',
      push: true,
    });
    expect(sync('push')).toMatchObject({ action: 'push', repoIds: ['api'] });
    // Nothing is behind: no repository to pull.
    expect(sync('pull')).toBeNull();
  });

  it("merges the one ready PR on that PR's own base and head", () => {
    const prHead = 'f'.repeat(40);
    const repos = [root(), child({ prHeadSha: prHead })] as const;
    const status = statusOf(NO_ROOT_PR, childPr());
    expect(multiPlan(repos, status).merge?.blockedReason).toBeUndefined();
    expect(
      portalPullRequestActionPayload(
        { kind: 'merge' },
        repos[0],
        status,
        TARGET,
        {
          repos,
        },
      ),
    ).toEqual({
      ...TARGET,
      repoIds: ['api'],
      expectedHeadSha: prHead,
      action: 'merge',
      expectedPrNumber: 7,
      expectedBaseBranch: 'develop',
      expectedHeadBranch: 'feature/login',
    });
    // Aligning the base stays the root's, as the header's drift is.
    expect(
      portalPullRequestActionPayload(
        { kind: 'align-base' },
        repos[0],
        status,
        TARGET,
        { repos },
      ),
    ).toBeNull();
  });

  it('merges one PR per click: the first ready one that warns, else the first ready one', () => {
    const repos = [
      root({ prHeadSha: HEAD }),
      child({ prHeadSha: HEAD }),
    ] as const;
    const merge = (
      status: PortalPrStatus,
    ): ReturnType<typeof portalPullRequestActionPayload> =>
      portalPullRequestActionPayload(
        { kind: 'merge' },
        repos[0],
        status,
        TARGET,
        {
          repos,
        },
      );
    const child7 = childPr();
    const rootPr: StatusRepo = {
      repoId: ROOT_ID,
      repoName: 'Project root',
      status: { ...child7.status, number: 3, baseRefName: 'main' },
    };
    // Both ready; only the child's review threads warn: Merge names it alone.
    const warned = statusOf(
      rootPr,
      childPr({ unresolvedReviewThreadCount: 2 }),
    );
    expect(merge(warned)).toMatchObject({
      repoIds: ['api'],
      expectedPrNumber: 7,
    });
    expect(
      portalPullRequestMergeRepo(repos[0], warned, { repos })?.repoId,
    ).toBe('api');
    // Neither warns: the first ready PR, the root's.
    expect(merge(statusOf(rootPr, child7))).toMatchObject({
      repoIds: [ROOT_ID],
      expectedPrNumber: 3,
    });
    // Without the opt-in, Merge is the row's own.
    expect(portalPullRequestMergeRepo(repos[0], warned)).toBe(repos[0]);
  });
});
