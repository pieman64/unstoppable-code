import type { WorktreePrStatus } from '@canopy/desktop-shared/types/github';
import {
  deriveSplitPrEligibilityInputs,
  deriveSplitPrReadiness,
  gatherSplitPrEligibilityInputs,
  gatherSplitPrReadinessInputs,
  SPLIT_PR_BLOCKER_COPY,
  splitPrLineCount,
  type SplitPrBlocker,
} from '../splitPrEligibilityInputs';
import {
  isSplitPrEligible,
  useGitHubStore,
  worktreeKey,
} from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { createDiffStatsKey } from '@/stores/projectsStore.diffStats';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);
const DIFF_KEY = createDiffStatsKey(PROJECT_ID, WORKTREE_ID);

function makePrStatus(
  overrides: Partial<
    NonNullable<WorktreePrStatus['repos'][number]['status']>
  > = {},
): WorktreePrStatus {
  return {
    repos: [
      {
        repoId: PROJECT_ID,
        repoName: 'Project One',
        status: {
          prNumber: 9,
          prUrl: 'https://github.com/org/repo/pull/9',
          state: 'open',
          title: 'A big PR',
          checkStatus: 'passing',
          checkDetails: [],
          reviewStatus: 'approved',
          reviewers: [],
          hasConflicts: false,
          commentCount: 0,
          updatedAt: new Date(0).toISOString(),
          additions: 900,
          deletions: 300,
          ...overrides,
        },
      },
    ],
    lastCheckedAt: new Date(0).toISOString(),
  };
}

/**
 * Reproduces the OLD inline gathering logic each of `PullRequestSection` and
 * the `github.split_pr` dispatcher duplicated before extraction, so the
 * shared helper's output can be asserted equal to it for a fixture state.
 */
function legacyInlineGathering(
  isSingleRepo: boolean,
): ReturnType<typeof gatherSplitPrEligibilityInputs> {
  const prStatus = useGitHubStore.getState().prStatuses[KEY];
  const singleRepoPrData =
    prStatus && prStatus.repos.length === 1
      ? (prStatus.repos[0].status ?? undefined)
      : undefined;
  const diffStats = useProjectsStore.getState().diffStats[DIFF_KEY];
  const { splitPrEnabled, splitPrThresholdLines } =
    useSplitPrPreferencesStore.getState();
  return {
    prState: singleRepoPrData?.state,
    prAdditions: singleRepoPrData?.additions,
    prDeletions: singleRepoPrData?.deletions,
    diffStats:
      diffStats !== undefined
        ? { insertions: diffStats.insertions, deletions: diffStats.deletions }
        : undefined,
    splitPrEnabled,
    thresholdLines: splitPrThresholdLines,
    isSingleRepo,
  };
}

const testStores = {
  getPrStatus: (
    projectId: string,
    worktreeId: string,
  ): WorktreePrStatus | null | undefined =>
    useGitHubStore.getState().prStatuses[worktreeKey(projectId, worktreeId)],
  getDiffStats: (
    projectId: string,
    worktreeId: string,
  ): { insertions: number; deletions: number } | undefined =>
    useProjectsStore.getState().diffStats[
      createDiffStatsKey(projectId, worktreeId)
    ],
  getGatingPreferences: (): {
    splitPrEnabled: boolean;
    splitPrThresholdLines: number;
  } => useSplitPrPreferencesStore.getState(),
};

describe('gatherSplitPrEligibilityInputs', () => {
  beforeEach(() => {
    __resetSplitPrPreferencesForTests();
    useGitHubStore.setState({ prStatuses: {} });
    useProjectsStore.setState({ diffStats: {} });
  });

  it('matches the old inline gathering logic for a fixture state with an open PR', () => {
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    useProjectsStore.setState({
      diffStats: { [DIFF_KEY]: { insertions: 50, deletions: 10 } },
    });
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });

    const result = gatherSplitPrEligibilityInputs(
      PROJECT_ID,
      WORKTREE_ID,
      true,
      testStores,
    );

    expect(result).toEqual(legacyInlineGathering(true));
    expect(result).toEqual({
      prState: 'open',
      prAdditions: 900,
      prDeletions: 300,
      diffStats: { insertions: 50, deletions: 10 },
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });
  });

  it('matches the old inline gathering logic when there is no PR status (diffStats-only fixture)', () => {
    useProjectsStore.setState({
      diffStats: { [DIFF_KEY]: { insertions: 20, deletions: 5 } },
    });
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: false,
      splitPrThresholdLines: 250,
      hasLoaded: true,
    });

    const result = gatherSplitPrEligibilityInputs(
      PROJECT_ID,
      WORKTREE_ID,
      false,
      testStores,
    );

    expect(result).toEqual(legacyInlineGathering(false));
    expect(result).toEqual({
      prState: undefined,
      prAdditions: undefined,
      prDeletions: undefined,
      diffStats: { insertions: 20, deletions: 5 },
      splitPrEnabled: false,
      thresholdLines: 250,
      isSingleRepo: false,
    });
  });

  it('treats a multi-repo PR status (more than one repo) the same as no single-repo PR data', () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            { repoId: 'a', repoName: 'A', status: null },
            { repoId: 'b', repoName: 'B', status: null },
          ],
          lastCheckedAt: new Date(0).toISOString(),
        },
      },
    });

    const result = gatherSplitPrEligibilityInputs(
      PROJECT_ID,
      WORKTREE_ID,
      false,
      testStores,
    );

    expect(result).toEqual(legacyInlineGathering(false));
    expect(result.prState).toBeUndefined();
    expect(result.prAdditions).toBeUndefined();
    expect(result.prDeletions).toBeUndefined();
  });
});

describe('deriveSplitPrEligibilityInputs', () => {
  it('shapes a single-repo open PR status plus diffStats into isSplitPrEligible inputs', () => {
    const result = deriveSplitPrEligibilityInputs({
      prStatus: makePrStatus({ additions: 400, deletions: 100 }),
      diffStats: { insertions: 10, deletions: 2 },
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });

    expect(result).toEqual({
      prState: 'open',
      prAdditions: 400,
      prDeletions: 100,
      diffStats: { insertions: 10, deletions: 2 },
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });
  });

  it('leaves prState/prAdditions/prDeletions undefined for a null prStatus', () => {
    const result = deriveSplitPrEligibilityInputs({
      prStatus: null,
      diffStats: undefined,
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });

    expect(result.prState).toBeUndefined();
    expect(result.prAdditions).toBeUndefined();
    expect(result.prDeletions).toBeUndefined();
  });

  it('leaves prState/prAdditions/prDeletions undefined for a multi-repo prStatus', () => {
    const result = deriveSplitPrEligibilityInputs({
      prStatus: {
        repos: [
          { repoId: 'a', repoName: 'A', status: null },
          { repoId: 'b', repoName: 'B', status: null },
        ],
        lastCheckedAt: new Date(0).toISOString(),
      },
      diffStats: undefined,
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: false,
    });

    expect(result.prState).toBeUndefined();
    expect(result.prAdditions).toBeUndefined();
    expect(result.prDeletions).toBeUndefined();
  });
});

describe('deriveSplitPrEligibilityInputs — WorktreeItem lastKnownPrStatus fallback wiring', () => {
  /**
   * `WorktreeItem` does not read `prStatus` from the store directly into the
   * helper: it first computes `effectivePrStatus = prStatus ?? lastKnownPrStatus`
   * (falling back to the worktree's persisted `lastKnownPrStatus` only when the
   * live store entry is absent — `undefined`, not `null`) and feeds THAT into
   * `deriveSplitPrEligibilityInputs`. This reproduces that call-site shaping so
   * the fallback path is covered through the same wiring WorktreeItem uses.
   */
  function effectivePrStatusFor(
    prStatus: WorktreePrStatus | null | undefined,
    lastKnownPrStatus: WorktreePrStatus | null | undefined,
  ): WorktreePrStatus | null | undefined {
    return prStatus === undefined ? lastKnownPrStatus : prStatus;
  }

  it('falls back to lastKnownPrStatus when the live store has no entry for the worktree', () => {
    const lastKnownPrStatus = makePrStatus({
      state: 'open',
      additions: 600,
      deletions: 50,
    });
    const effectivePrStatus = effectivePrStatusFor(
      undefined,
      lastKnownPrStatus,
    );

    const result = deriveSplitPrEligibilityInputs({
      prStatus: effectivePrStatus,
      diffStats: undefined,
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });

    expect(result).toEqual({
      prState: 'open',
      prAdditions: 600,
      prDeletions: 50,
      diffStats: undefined,
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });
    expect(isSplitPrEligible(result)).toBe(true);
  });

  it('prefers the live store entry over lastKnownPrStatus once the store has loaded (even a null live entry)', () => {
    const lastKnownPrStatus = makePrStatus({
      state: 'open',
      additions: 600,
      deletions: 50,
    });
    // A live `null` entry (PR status fetched and found to be none) is NOT
    // the same as "not yet loaded" (`undefined`) — it must win over the
    // stale `lastKnownPrStatus`, not be treated as absent.
    const effectivePrStatus = effectivePrStatusFor(null, lastKnownPrStatus);

    const result = deriveSplitPrEligibilityInputs({
      prStatus: effectivePrStatus,
      diffStats: undefined,
      splitPrEnabled: true,
      thresholdLines: 500,
      isSingleRepo: true,
    });

    expect(result.prState).toBeUndefined();
    expect(result.prAdditions).toBeUndefined();
    expect(result.prDeletions).toBeUndefined();
    expect(isSplitPrEligible(result)).toBe(false);
  });
});

describe('splitPrLineCount', () => {
  it('prefers PR additions/deletions over diffStats when both are present', () => {
    expect(
      splitPrLineCount({
        prAdditions: 100,
        prDeletions: 20,
        diffStats: { insertions: 5, deletions: 5 },
      }),
    ).toBe(120);
  });

  it('falls back to diffStats when PR additions/deletions are not both present', () => {
    expect(
      splitPrLineCount({
        prAdditions: undefined,
        prDeletions: undefined,
        diffStats: { insertions: 30, deletions: 8 },
      }),
    ).toBe(38);
  });

  it('returns undefined when neither PR counts nor diffStats are available', () => {
    expect(
      splitPrLineCount({
        prAdditions: undefined,
        prDeletions: undefined,
        diffStats: undefined,
      }),
    ).toBeUndefined();
  });
});

const ELIGIBLE_INPUTS = {
  prState: 'open',
  prAdditions: 900,
  prDeletions: 300,
  diffStats: undefined,
  splitPrEnabled: true,
  thresholdLines: 500,
  isSingleRepo: true,
};

const INELIGIBLE_INPUTS = {
  ...ELIGIBLE_INPUTS,
  splitPrEnabled: false,
};

describe('deriveSplitPrReadiness', () => {
  const noBlockers = {
    uncommittedChanges: false,
    hasUnpushedCommits: false,
    hasConflicts: false,
    hasActivePipelines: false,
    hasActiveChats: false,
  };

  it('returns eligible: true and no blockers when eligible and every signal is clear', () => {
    const result = deriveSplitPrReadiness({
      eligibilityInputs: ELIGIBLE_INPUTS,
      ...noBlockers,
    });

    expect(result).toEqual({ eligible: true, blockers: [] });
  });

  it('returns eligible: false and an empty blocker list when ineligible, even if every blocking signal is set', () => {
    const result = deriveSplitPrReadiness({
      eligibilityInputs: INELIGIBLE_INPUTS,
      uncommittedChanges: true,
      hasUnpushedCommits: true,
      hasConflicts: true,
      hasActivePipelines: true,
      hasActiveChats: true,
    });

    expect(result).toEqual({ eligible: false, blockers: [] });
  });

  const singleBlockerCases: Array<{
    field: keyof typeof noBlockers;
    blocker: SplitPrBlocker;
  }> = [
    { field: 'uncommittedChanges', blocker: 'uncommitted_changes' },
    { field: 'hasUnpushedCommits', blocker: 'unpushed_commits' },
    { field: 'hasConflicts', blocker: 'merge_conflicts' },
    { field: 'hasActivePipelines', blocker: 'active_pipelines' },
    { field: 'hasActiveChats', blocker: 'active_chats' },
  ];

  it.each(singleBlockerCases)(
    'reports only "$blocker" when just $field is set',
    ({ field, blocker }) => {
      const result = deriveSplitPrReadiness({
        eligibilityInputs: ELIGIBLE_INPUTS,
        ...noBlockers,
        [field]: true,
      });

      expect(result).toEqual({ eligible: true, blockers: [blocker] });
    },
  );

  it('orders multiple blockers in the declared SplitPrBlocker order regardless of which flags are set first', () => {
    const result = deriveSplitPrReadiness({
      eligibilityInputs: ELIGIBLE_INPUTS,
      uncommittedChanges: false,
      hasUnpushedCommits: true,
      hasConflicts: false,
      hasActivePipelines: true,
      hasActiveChats: true,
    });

    expect(result).toEqual({
      eligible: true,
      blockers: ['unpushed_commits', 'active_pipelines', 'active_chats'],
    });
  });

  it('reports all five blockers in declared order when every signal is set and eligible', () => {
    const result = deriveSplitPrReadiness({
      eligibilityInputs: ELIGIBLE_INPUTS,
      uncommittedChanges: true,
      hasUnpushedCommits: true,
      hasConflicts: true,
      hasActivePipelines: true,
      hasActiveChats: true,
    });

    expect(result).toEqual({
      eligible: true,
      blockers: [
        'uncommitted_changes',
        'unpushed_commits',
        'merge_conflicts',
        'active_pipelines',
        'active_chats',
      ],
    });
  });
});

describe('SPLIT_PR_BLOCKER_COPY', () => {
  const blockers: SplitPrBlocker[] = [
    'uncommitted_changes',
    'unpushed_commits',
    'merge_conflicts',
    'active_pipelines',
    'active_chats',
  ];

  it.each(blockers)('has a non-empty copy string for "%s"', (blocker) => {
    expect(typeof SPLIT_PR_BLOCKER_COPY[blocker]).toBe('string');
    expect(SPLIT_PR_BLOCKER_COPY[blocker].length).toBeGreaterThan(0);
  });
});

describe('gatherSplitPrReadinessInputs', () => {
  beforeEach(() => {
    __resetSplitPrPreferencesForTests();
    useGitHubStore.setState({ prStatuses: {} });
    useProjectsStore.setState({ diffStats: {} });
  });

  function readinessTestStores(overrides: {
    uncommittedChanges?: boolean;
    hasUnpushedCommits?: boolean;
    hasActivePipelines?: boolean;
    hasActiveChats?: boolean;
  }): Parameters<typeof gatherSplitPrReadinessInputs>[3] {
    return {
      ...testStores,
      getUncommittedChanges: (): boolean =>
        overrides.uncommittedChanges ?? false,
      getHasUnpushedCommits: (): boolean =>
        overrides.hasUnpushedCommits ?? false,
      getHasActivePipelines: (): boolean =>
        overrides.hasActivePipelines ?? false,
      getHasActiveChats: (): boolean => overrides.hasActiveChats ?? false,
    };
  }

  it('derives ready (eligible, no blockers) for an eligible worktree with every signal clear', () => {
    useGitHubStore.setState({ prStatuses: { [KEY]: makePrStatus() } });
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });

    const result = gatherSplitPrReadinessInputs(
      PROJECT_ID,
      WORKTREE_ID,
      true,
      readinessTestStores({}),
    );

    expect(result).toEqual({ eligible: true, blockers: [] });
  });

  it('derives merge_conflicts from the same prStatus used for eligibility (hasConflicts === true)', () => {
    useGitHubStore.setState({
      prStatuses: { [KEY]: makePrStatus({ hasConflicts: true }) },
    });
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });

    const result = gatherSplitPrReadinessInputs(
      PROJECT_ID,
      WORKTREE_ID,
      true,
      readinessTestStores({}),
    );

    expect(result).toEqual({ eligible: true, blockers: ['merge_conflicts'] });
  });

  it('combines uncommitted/unpushed/pipeline/chat signals with PR-derived conflicts', () => {
    useGitHubStore.setState({
      prStatuses: { [KEY]: makePrStatus({ hasConflicts: true }) },
    });
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });

    const result = gatherSplitPrReadinessInputs(
      PROJECT_ID,
      WORKTREE_ID,
      true,
      readinessTestStores({
        uncommittedChanges: true,
        hasUnpushedCommits: true,
        hasActivePipelines: true,
        hasActiveChats: true,
      }),
    );

    expect(result).toEqual({
      eligible: true,
      blockers: [
        'uncommitted_changes',
        'unpushed_commits',
        'merge_conflicts',
        'active_pipelines',
        'active_chats',
      ],
    });
  });

  it('returns no blockers for an ineligible worktree even when blocking signals are set', () => {
    useSplitPrPreferencesStore.setState({
      splitPrEnabled: false,
      splitPrThresholdLines: 500,
      hasLoaded: true,
    });

    const result = gatherSplitPrReadinessInputs(
      PROJECT_ID,
      WORKTREE_ID,
      true,
      readinessTestStores({
        uncommittedChanges: true,
        hasUnpushedCommits: true,
        hasActivePipelines: true,
        hasActiveChats: true,
      }),
    );

    expect(result).toEqual({ eligible: false, blockers: [] });
  });
});
