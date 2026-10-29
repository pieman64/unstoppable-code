import type {
  PrDiffSnapshot,
  SplitPlan,
  SplitPrMap,
  SplitPrPlanResponse,
  SplitWorkflowStartResult,
} from '@canopy/desktop-shared/types/github';
import { isSplitPrEligible, useGitHubStore, worktreeKey } from '../githubStore';
import { setVisibleContext } from '@/lib/osNotifications';

// The real `addToast` is a safe no-op in this test env (no
// `window.api.showOsNotification`, no cached notification prefs), but the
// idle-state toast tests replace it with a spy and restore this afterward.
const REAL_ADD_TOAST = useGitHubStore.getState().addToast;

const BASE_ARGS = {
  prState: 'open' as const,
  prAdditions: undefined,
  prDeletions: undefined,
  diffStats: undefined,
  splitPrEnabled: true,
  thresholdLines: 500,
  isSingleRepo: true,
};

describe('isSplitPrEligible', () => {
  it('is eligible when PR line count is exactly at the threshold', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 300,
        prDeletions: 200,
      }),
    ).toBe(true);
  });

  it('is platform-independent: eligibility no longer depends on the OS', () => {
    // The Windows gate was removed once the verify runner gained a PowerShell
    // path; eligibility is now decided solely by the toggle, single-repo, open
    // PR, and line-count checks. The args carry no platform field at all.
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 300,
        prDeletions: 200,
      }),
    ).toBe(true);
  });

  it('is not eligible when PR line count is one below the threshold', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 300,
        prDeletions: 199,
      }),
    ).toBe(false);
  });

  it('is eligible when PR line count is one above the threshold', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 300,
        prDeletions: 201,
      }),
    ).toBe(true);
  });

  it('prefers PR additions/deletions over diffStats when both are present', () => {
    // PR counts say under threshold; diffStats says over threshold.
    // PR counts must win, so this stays ineligible.
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 10,
        prDeletions: 10,
        diffStats: { insertions: 1000, deletions: 1000 },
      }),
    ).toBe(false);

    // And the inverse: PR counts say over threshold, diffStats says under.
    // PR counts must win, so this is eligible.
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 1000,
        prDeletions: 1000,
        diffStats: { insertions: 1, deletions: 1 },
      }),
    ).toBe(true);
  });

  it('falls back to diffStats when only prAdditions is undefined', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: undefined,
        prDeletions: 1000,
        diffStats: { insertions: 300, deletions: 300 },
      }),
    ).toBe(true);
  });

  it('falls back to diffStats when only prDeletions is undefined', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: 1000,
        prDeletions: undefined,
        diffStats: { insertions: 300, deletions: 300 },
      }),
    ).toBe(true);
  });

  it('is ineligible when both PR counts and diffStats are undefined', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prAdditions: undefined,
        prDeletions: undefined,
        diffStats: undefined,
      }),
    ).toBe(false);
  });

  it('is ineligible when the split PR feature flag/toggle is off', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        splitPrEnabled: false,
        prAdditions: 1000,
        prDeletions: 1000,
      }),
    ).toBe(false);
  });

  it('is ineligible for multi-repo worktrees', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        isSingleRepo: false,
        prAdditions: 1000,
        prDeletions: 1000,
      }),
    ).toBe(false);
  });

  it('is ineligible when prState is undefined (no open PR)', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prState: undefined,
        prAdditions: 1000,
        prDeletions: 1000,
      }),
    ).toBe(false);
  });

  it('is ineligible when prState is closed', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prState: 'closed',
        prAdditions: 1000,
        prDeletions: 1000,
      }),
    ).toBe(false);
  });

  it('is ineligible when prState is merged', () => {
    expect(
      isSplitPrEligible({
        ...BASE_ARGS,
        prState: 'merged',
        prAdditions: 1000,
        prDeletions: 1000,
      }),
    ).toBe(false);
  });
});

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);

function makeSnapshot(): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function makePlan(finalGoal: string): SplitPlan {
  return {
    finalGoal,
    concerns: [],
    children: [],
    parallelizable: '',
    landOrder: '',
    buildTestCommand: '',
    unassignedHunks: [],
  };
}

function makeMap(): SplitPrMap {
  return {
    version: 1,
    originalPrNumber: 42,
    originalPrUrl: 'https://github.com/example/repo/pull/42',
    originalBaseBranch: 'main',
    originalHeadBranch: 'feature/big-change',
    originalHeadSha: 'head-sha',
    integrationBranch: 'feature-split/integration',
    originalWorktreeId: WORKTREE_ID,
    children: [],
    status: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePlanResponse(finalGoal: string): SplitPrPlanResponse {
  return {
    plan: makePlan(finalGoal),
    snapshot: makeSnapshot(),
    originalPr: {
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      baseBranch: 'main',
      headBranch: 'feature/big-change',
      headSha: 'head-sha',
    },
  };
}

describe('commitApprovedSplitPlan', () => {
  beforeEach(() => {
    useGitHubStore.setState({ splitPrPlans: {} });
  });

  it('replaces the plan in place while preserving snapshot and originalPr', () => {
    const original = makePlanResponse('pre-edit goal');
    useGitHubStore.setState({ splitPrPlans: { [KEY]: original } });

    const edited = makePlan('post-edit goal');
    useGitHubStore
      .getState()
      .commitApprovedSplitPlan(PROJECT_ID, WORKTREE_ID, edited);

    const stored = useGitHubStore.getState().splitPrPlans[KEY];
    expect(stored.plan).toBe(edited);
    expect(stored.plan.finalGoal).toBe('post-edit goal');
    expect(stored.snapshot).toBe(original.snapshot);
    expect(stored.originalPr).toBe(original.originalPr);
  });

  it('is a no-op when there is no existing plan entry for the key', () => {
    const edited = makePlan('post-edit goal');
    useGitHubStore
      .getState()
      .commitApprovedSplitPlan(PROJECT_ID, WORKTREE_ID, edited);

    expect(useGitHubStore.getState().splitPrPlans[KEY]).toBeUndefined();
  });

  it('does not mutate plans for other worktree keys', () => {
    const other = makePlanResponse('other goal');
    const original = makePlanResponse('pre-edit goal');
    useGitHubStore.setState({
      splitPrPlans: {
        [KEY]: original,
        'proj-2/wt-2': other,
      },
    });

    const edited = makePlan('post-edit goal');
    useGitHubStore
      .getState()
      .commitApprovedSplitPlan(PROJECT_ID, WORKTREE_ID, edited);

    expect(useGitHubStore.getState().splitPrPlans['proj-2/wt-2']).toBe(other);
  });
});

describe('discardSplitPr', () => {
  const discardSplitPrMock = jest.fn();

  beforeEach(() => {
    discardSplitPrMock.mockReset();
    discardSplitPrMock.mockResolvedValue({
      branches: ['feature-split/integration', 'feature-split/01-a'],
      prNumbers: [101, 102],
    });
    // Minimal window.api surface for the store action under test.
    Object.defineProperty(globalThis, 'window', {
      value: { api: { github: { discardSplitPr: discardSplitPrMock } } },
      configurable: true,
      writable: true,
    });
    useGitHubStore.setState({
      splitPrResults: {},
      splitPrProgress: {},
      splitPrPlans: {},
      splitPrRefusals: {},
      splitPrDiscardedArtifacts: {},
    });
  });

  it('clears all per-worktree split state and returns leftover artifacts', async () => {
    useGitHubStore.setState({
      splitPrResults: { [KEY]: makeMap() },
      splitPrProgress: { [KEY]: [] },
      splitPrPlans: { [KEY]: makePlanResponse('x') },
      splitPrRefusals: {
        [KEY]: { code: 'invalid_plan', message: 'bad' },
      },
      splitPrExecuteFailures: {
        [KEY]: { code: 'plan_mismatch', message: 'mismatch' },
      },
    });

    const result = await useGitHubStore
      .getState()
      .discardSplitPr(PROJECT_ID, WORKTREE_ID);

    expect(discardSplitPrMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(result).toEqual({
      branches: ['feature-split/integration', 'feature-split/01-a'],
      prNumbers: [101, 102],
    });
    const state = useGitHubStore.getState();
    expect(state.splitPrResults[KEY]).toBeUndefined();
    expect(state.splitPrProgress[KEY]).toBeUndefined();
    expect(state.splitPrPlans[KEY]).toBeUndefined();
    expect(state.splitPrRefusals[KEY]).toBeUndefined();
    expect(state.splitPrExecuteFailures[KEY]).toBeUndefined();
    expect(state.splitPrDiscardedArtifacts[KEY]).toEqual(result);
    state.clearSplitPrDiscardedArtifacts(PROJECT_ID, WORKTREE_ID);
    expect(
      useGitHubStore.getState().splitPrDiscardedArtifacts[KEY],
    ).toBeUndefined();
  });

  it('does not clear state and returns null when the IPC call fails', async () => {
    discardSplitPrMock.mockRejectedValue(new Error('boom'));
    useGitHubStore.setState({ splitPrPlans: { [KEY]: makePlanResponse('x') } });

    const result = await useGitHubStore
      .getState()
      .discardSplitPr(PROJECT_ID, WORKTREE_ID);

    expect(result).toBeNull();
    expect(useGitHubStore.getState().splitPrPlans[KEY]).toBeDefined();
  });
});

describe('startSplitWorkflow', () => {
  const startSplitWorkflowMock = jest.fn();
  const getSplitPrMapMock = jest.fn();

  beforeEach(() => {
    startSplitWorkflowMock.mockReset();
    getSplitPrMapMock.mockReset();
    getSplitPrMapMock.mockResolvedValue(null);
    Object.defineProperty(globalThis, 'window', {
      value: {
        api: {
          github: {
            startSplitWorkflow: startSplitWorkflowMock,
            getSplitPrMap: getSplitPrMapMock,
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useGitHubStore.setState({
      splitPrResults: {},
      splitPrProgress: {},
      splitPrPlans: {},
      splitPrRefusals: {},
      splitPrExecuteFailures: {},
      planningSplitPr: new Set<string>(),
      splittingPr: new Set<string>(),
      // The 'plan' mode ok-result handler only stores the plan while the
      // lock is still held (see the cancel-drops-late-plan test below), so
      // these tests must seed the lock as held to exercise the normal path.
      splitLockedWorktrees: new Set<string>([KEY]),
      splitWorkflowSessions: new Set<string>(),
    });
  });

  it('stores the plan result exactly like planSplitPr on an ok plan envelope', async () => {
    const response = makePlanResponse('x');
    startSplitWorkflowMock.mockResolvedValue({
      mode: 'plan',
      result: { status: 'ok', response },
    });

    const result = await useGitHubStore
      .getState()
      .startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    expect(startSplitWorkflowMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'plan',
    });
    expect(result).toBe(true);
    const state = useGitHubStore.getState();
    expect(state.splitPrPlans[KEY]).toEqual(response);
    expect(state.planningSplitPr.has(KEY)).toBe(false);
  });

  it('clears stale per-key state (incl. execute failures) before a plan launch', async () => {
    useGitHubStore.setState({
      splitPrResults: { [KEY]: makeMap() },
      splitPrProgress: { [KEY]: [] },
      splitPrRefusals: { [KEY]: { code: 'invalid_plan', message: 'bad' } },
      splitPrExecuteFailures: {
        [KEY]: { code: 'plan_mismatch', message: 'mismatch' },
      },
    });
    const response = makePlanResponse('x');
    startSplitWorkflowMock.mockResolvedValue({
      mode: 'plan',
      result: { status: 'ok', response },
    });

    await useGitHubStore.getState().startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    const state = useGitHubStore.getState();
    expect(state.splitPrResults[KEY]).toBeUndefined();
    expect(state.splitPrProgress[KEY]).toBeUndefined();
    expect(state.splitPrRefusals[KEY]).toBeUndefined();
    expect(state.splitPrExecuteFailures[KEY]).toBeUndefined();
    expect(state.splitPrPlans[KEY]).toEqual(response);
  });

  it('stores a refusal (and returns false) on a refused plan envelope', async () => {
    startSplitWorkflowMock.mockResolvedValue({
      mode: 'plan',
      result: { status: 'refused', code: 'no_open_pr', message: 'No open PR' },
    });

    const result = await useGitHubStore
      .getState()
      .startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    expect(result).toBe(false);
    expect(useGitHubStore.getState().splitPrRefusals[KEY]).toEqual({
      code: 'no_open_pr',
      message: 'No open PR',
    });
  });

  it('drops a late-arriving ok plan if the lock was released before it settled (cancel)', async () => {
    // Simulates: user starts plan mode -> exits (lock released via the
    // onSplitLockChange event) -> the in-flight planPrSplit call then
    // resolves ok. The plan must NOT be stored on the now-unlocked
    // worktree, or the PR panel's Split PR button would stay hidden.
    let resolveStart: (value: {
      mode: 'plan';
      result: { status: 'ok'; response: SplitPrPlanResponse };
    }) => void = () => {};
    startSplitWorkflowMock.mockReturnValue(
      new Promise((resolve) => {
        resolveStart = resolve;
      }),
    );

    const pending = useGitHubStore
      .getState()
      .startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    // Cancel: exitSplitWorkflow releases the lock immediately (mirrored via
    // the onSplitLockChange subscription in real usage).
    useGitHubStore.setState({ splitLockedWorktrees: new Set<string>() });

    // The plan resolves ok only after the lock is already released.
    resolveStart({
      mode: 'plan',
      result: { status: 'ok', response: makePlanResponse('x') },
    });
    const result = await pending;

    expect(result).toBe(true);
    expect(useGitHubStore.getState().splitPrPlans[KEY]).toBeUndefined();
  });

  describe('idle-state toast (review)', () => {
    afterEach(() => {
      useGitHubStore.setState({ addToast: REAL_ADD_TOAST });
      setVisibleContext(null, null);
    });

    it('fires a Split PR review toast when the worktree is NOT in the foreground', async () => {
      const addToast = jest.fn();
      useGitHubStore.setState({ addToast });
      setVisibleContext(null, null); // not viewing this worktree
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'plan',
        result: { status: 'ok', response: makePlanResponse('x') },
      });

      await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

      expect(addToast).toHaveBeenCalledWith(
        'Split PR plan is ready for your review.',
        'info',
        undefined,
        expect.objectContaining({
          category: 'Split PR',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
        }),
      );
    });

    it('does NOT fire a review toast when the worktree IS in the foreground', async () => {
      const addToast = jest.fn();
      useGitHubStore.setState({ addToast });
      setVisibleContext(KEY, null); // actively viewing this worktree's workflow
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'plan',
        result: { status: 'ok', response: makePlanResponse('x') },
      });

      await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

      expect(addToast).not.toHaveBeenCalled();
    });
  });

  describe("mode: 'review'", () => {
    it('KEEPS the stored plan (no clearing) and forwards mode review', async () => {
      const existing = makePlanResponse('stored');
      useGitHubStore.setState({ splitPrPlans: { [KEY]: existing } });
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'review',
        result: { status: 'locked' },
      });

      const result = await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, { mode: 'review' });

      expect(startSplitWorkflowMock).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'review',
      });
      expect(result).toBe(true);
      // Review must NOT clear the stored plan — it IS the plan Review renders.
      expect(useGitHubStore.getState().splitPrPlans[KEY]).toBe(existing);
      expect(useGitHubStore.getState().planningSplitPr.has(KEY)).toBe(false);
    });

    it('KEEPS the persisted result map so a Cancel back out restores the result view', async () => {
      // A failed split left a persisted map; the user opens Edit plan (review)
      // then Cancels. The result map must survive the review entry so the
      // Resume/Discard result UI is still there after Cancel — a failed map
      // cannot satisfy the completed-finalize gate, so keeping it is safe.
      const failedMap: SplitPrMap = { ...makeMap(), status: 'failed' };
      useGitHubStore.setState({
        splitPrPlans: { [KEY]: makePlanResponse('stored') },
        splitPrResults: { [KEY]: failedMap },
      });
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'review',
        result: { status: 'locked' },
      });

      await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, { mode: 'review' });

      expect(useGitHubStore.getState().splitPrResults[KEY]).toEqual(failedMap);
    });
  });

  describe("mode: 'resume'", () => {
    it('forwards the stored plan+snapshot and stores the completed map on ok', async () => {
      const plan = makePlan('x');
      const snapshot = makeSnapshot();
      const map: SplitPrMap = { ...makeMap(), status: 'completed' };
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'resume',
        result: { status: 'ok', map },
      });

      const result = await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
          mode: 'resume',
          plan,
          snapshot,
        });

      expect(startSplitWorkflowMock).toHaveBeenCalledWith({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        mode: 'resume',
        plan,
        snapshot,
      });
      expect(result).toBe(true);
      const state = useGitHubStore.getState();
      expect(state.splitPrResults[KEY]).toEqual(map);
      expect(state.splittingPr.has(KEY)).toBe(false);
    });

    it('marks splittingPr synchronously so the locked workflow view derives the Execute step (retry swap)', async () => {
      // The retry surfaces (progress-overlay Retry / result-view Resume) route
      // through mode:'resume'. While the resumed execute is in flight, the
      // store must have the key in `splittingPr` — that is the exact signal
      // SplitWorkflowView reads to render the Execute step, i.e. what "swaps
      // in the locked workflow view" for the A7 locked-set assertion.
      let resolveStart: ((value: SplitWorkflowStartResult) => void) | undefined;
      startSplitWorkflowMock.mockImplementation(
        () =>
          new Promise<SplitWorkflowStartResult>((resolve) => {
            resolveStart = resolve;
          }),
      );

      const pending = useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
          mode: 'resume',
          plan: makePlan('x'),
          snapshot: makeSnapshot(),
        });

      // In flight: the Execute-step signal is set.
      expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(true);

      resolveStart?.({
        mode: 'resume',
        result: { status: 'ok', map: { ...makeMap(), status: 'completed' } },
      });
      await pending;

      // Settled: the in-flight flag clears.
      expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(false);
    });

    it('bails early (no-op) on a double-dispatch when a run is already in flight for the key', async () => {
      // First resume left in flight (splittingPr has the key). A second
      // dispatch — e.g. a rapid double-click of Retry/Resume — must NOT reach
      // the IPC again; only the first proceeds.
      startSplitWorkflowMock.mockImplementation(
        () => new Promise<SplitWorkflowStartResult>(() => {}),
      );

      const first = useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
          mode: 'resume',
          plan: makePlan('x'),
          snapshot: makeSnapshot(),
        });
      expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(true);
      expect(startSplitWorkflowMock).toHaveBeenCalledTimes(1);

      const secondResult = await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
          mode: 'resume',
          plan: makePlan('x'),
          snapshot: makeSnapshot(),
        });

      // The second call short-circuited: still one IPC call, returned false.
      expect(secondResult).toBe(false);
      expect(startSplitWorkflowMock).toHaveBeenCalledTimes(1);
      void first;
    });

    it('repopulates the structured failure on a failed resume envelope', async () => {
      startSplitWorkflowMock.mockResolvedValue({
        mode: 'resume',
        result: {
          status: 'failed',
          message: 'Verify failed for child 2',
          childIndex: 2,
          verifyTail: 'FAIL',
        },
      });
      getSplitPrMapMock.mockResolvedValue({ ...makeMap(), status: 'failed' });

      await useGitHubStore
        .getState()
        .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
          mode: 'resume',
          plan: makePlan('x'),
          snapshot: makeSnapshot(),
        });
      await Promise.resolve();
      await Promise.resolve();

      expect(useGitHubStore.getState().splitPrExecuteFailures[KEY]).toEqual({
        message: 'Verify failed for child 2',
        childIndex: 2,
        verifyTail: 'FAIL',
      });
      expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(false);
    });
  });
});

describe('approveSplitWorkflow', () => {
  const approveSplitWorkflowMock = jest.fn();
  const getSplitPrMapMock = jest.fn();

  beforeEach(() => {
    approveSplitWorkflowMock.mockReset();
    getSplitPrMapMock.mockReset();
    getSplitPrMapMock.mockResolvedValue(null);
    Object.defineProperty(globalThis, 'window', {
      value: {
        api: {
          github: {
            approveSplitWorkflow: approveSplitWorkflowMock,
            getSplitPrMap: getSplitPrMapMock,
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useGitHubStore.setState({
      splitPrResults: {},
      splitPrPlans: {},
      splitPrExecuteFailures: {},
      splittingPr: new Set<string>(),
    });
  });

  it('stores the map and clears the plan on an ok completed envelope', async () => {
    approveSplitWorkflowMock.mockResolvedValue({
      status: 'ok',
      map: makeMap(),
    });
    useGitHubStore.setState({ splitPrPlans: { [KEY]: makePlanResponse('x') } });

    await useGitHubStore
      .getState()
      .approveSplitWorkflow(
        PROJECT_ID,
        WORKTREE_ID,
        makePlan('x'),
        makeSnapshot(),
      );

    const state = useGitHubStore.getState();
    expect(state.splitPrResults[KEY]).toEqual(makeMap());
    expect(state.splittingPr.has(KEY)).toBe(false);
    expect(state.splitPrExecuteFailures[KEY]).toBeUndefined();
  });

  it('stores a structured failure on a failed envelope', async () => {
    approveSplitWorkflowMock.mockResolvedValue({
      status: 'failed',
      code: 'plan_mismatch',
      message: 'mismatch',
    });

    await useGitHubStore
      .getState()
      .approveSplitWorkflow(
        PROJECT_ID,
        WORKTREE_ID,
        makePlan('x'),
        makeSnapshot(),
      );

    expect(useGitHubStore.getState().splitPrExecuteFailures[KEY]).toEqual({
      code: 'plan_mismatch',
      message: 'mismatch',
    });
  });

  describe('idle-state toast (done)', () => {
    afterEach(() => {
      useGitHubStore.setState({ addToast: REAL_ADD_TOAST });
      setVisibleContext(null, null);
    });

    it('fires a Split PR done toast on a completed settle when NOT in the foreground', async () => {
      const addToast = jest.fn();
      useGitHubStore.setState({ addToast });
      setVisibleContext(null, null);
      approveSplitWorkflowMock.mockResolvedValue({
        status: 'ok',
        map: { ...makeMap(), status: 'completed' },
      });

      await useGitHubStore
        .getState()
        .approveSplitWorkflow(
          PROJECT_ID,
          WORKTREE_ID,
          makePlan('x'),
          makeSnapshot(),
        );

      expect(addToast).toHaveBeenCalledWith(
        'Split PR complete.',
        'info',
        undefined,
        expect.objectContaining({
          category: 'Split PR',
          projectId: PROJECT_ID,
          worktreeId: WORKTREE_ID,
        }),
      );
    });

    it('does NOT fire a done toast when the worktree IS in the foreground', async () => {
      const addToast = jest.fn();
      useGitHubStore.setState({ addToast });
      setVisibleContext(KEY, null);
      approveSplitWorkflowMock.mockResolvedValue({
        status: 'ok',
        map: { ...makeMap(), status: 'completed' },
      });

      await useGitHubStore
        .getState()
        .approveSplitWorkflow(
          PROJECT_ID,
          WORKTREE_ID,
          makePlan('x'),
          makeSnapshot(),
        );

      expect(addToast).not.toHaveBeenCalled();
    });
  });
});

describe('exitSplitWorkflow', () => {
  const exitSplitWorkflowMock = jest.fn();
  const getSplitPrMapMock = jest.fn();

  beforeEach(() => {
    exitSplitWorkflowMock.mockReset();
    exitSplitWorkflowMock.mockResolvedValue(undefined);
    getSplitPrMapMock.mockReset();
    getSplitPrMapMock.mockResolvedValue(null);
    Object.defineProperty(globalThis, 'window', {
      value: {
        api: {
          github: {
            exitSplitWorkflow: exitSplitWorkflowMock,
            getSplitPrMap: getSplitPrMapMock,
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useGitHubStore.setState({ splitPrResults: {} });
  });

  it('invokes the exit IPC with the worktree coordinates', async () => {
    await useGitHubStore.getState().exitSplitWorkflow(PROJECT_ID, WORKTREE_ID);
    expect(exitSplitWorkflowMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('refreshes the persisted map (belt-and-suspenders) so a review-mode Cancel restores the failed-map UI', async () => {
    const failedMap: SplitPrMap = { ...makeMap(), status: 'failed' };
    getSplitPrMapMock.mockResolvedValue(failedMap);

    await useGitHubStore.getState().exitSplitWorkflow(PROJECT_ID, WORKTREE_ID);
    await Promise.resolve();
    await Promise.resolve();

    expect(getSplitPrMapMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useGitHubStore.getState().splitPrResults[KEY]).toEqual(failedMap);
  });
});

describe('split workflow session (presentation)', () => {
  const startSplitWorkflowMock = jest.fn();
  const approveSplitWorkflowMock = jest.fn();
  const exitSplitWorkflowMock = jest.fn();
  const getSplitPrMapMock = jest.fn();

  beforeEach(() => {
    startSplitWorkflowMock.mockReset();
    approveSplitWorkflowMock.mockReset();
    exitSplitWorkflowMock.mockReset();
    exitSplitWorkflowMock.mockResolvedValue(undefined);
    getSplitPrMapMock.mockReset();
    getSplitPrMapMock.mockResolvedValue(null);
    Object.defineProperty(globalThis, 'window', {
      value: {
        api: {
          github: {
            startSplitWorkflow: startSplitWorkflowMock,
            approveSplitWorkflow: approveSplitWorkflowMock,
            exitSplitWorkflow: exitSplitWorkflowMock,
            getSplitPrMap: getSplitPrMapMock,
          },
        },
      },
      configurable: true,
      writable: true,
    });
    useGitHubStore.setState({
      splitPrResults: {},
      splitPrPlans: {},
      splitPrExecuteFailures: {},
      splittingPr: new Set<string>(),
      splitLockedWorktrees: new Set<string>([KEY]),
      splitWorkflowSessions: new Set<string>(),
    });
  });

  it('opens a session at the start of startSplitWorkflow', async () => {
    startSplitWorkflowMock.mockResolvedValue({
      mode: 'plan',
      result: { status: 'ok', response: makePlanResponse('x') },
    });

    await useGitHubStore.getState().startSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(true);
  });

  it('KEEPS the session on a completed approve settle (so the Finalize page holds through the lock release)', async () => {
    approveSplitWorkflowMock.mockResolvedValue({
      status: 'ok',
      map: { ...makeMap(), status: 'completed' },
    });
    useGitHubStore.getState().openSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);

    await useGitHubStore
      .getState()
      .approveSplitWorkflow(
        PROJECT_ID,
        WORKTREE_ID,
        makePlan('x'),
        makeSnapshot(),
      );

    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(true);
  });

  it('ENDS the session on a failed approve settle BEFORE recording the failure (no double-surface)', async () => {
    approveSplitWorkflowMock.mockResolvedValue({
      status: 'failed',
      code: 'plan_mismatch',
      message: 'mismatch',
    });
    useGitHubStore.getState().openSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);

    await useGitHubStore
      .getState()
      .approveSplitWorkflow(
        PROJECT_ID,
        WORKTREE_ID,
        makePlan('x'),
        makeSnapshot(),
      );

    const state = useGitHubStore.getState();
    // Session ended so the view swaps back; the failure is recorded so the
    // failure modal (gated on no session/lock) becomes the single surface.
    expect(state.splitWorkflowSessions.has(KEY)).toBe(false);
    expect(state.splitPrExecuteFailures[KEY]).toEqual({
      code: 'plan_mismatch',
      message: 'mismatch',
    });
  });

  it('ENDS the session on a failed resume settle', async () => {
    startSplitWorkflowMock.mockResolvedValue({
      mode: 'resume',
      result: { status: 'failed', message: 'boom' },
    });

    await useGitHubStore
      .getState()
      .startSplitWorkflow(PROJECT_ID, WORKTREE_ID, {
        mode: 'resume',
        plan: makePlan('x'),
        snapshot: makeSnapshot(),
      });
    await Promise.resolve();

    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(
      false,
    );
  });

  it('ENDS the session on exitSplitWorkflow (Cancel paths)', async () => {
    useGitHubStore.getState().openSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);

    await useGitHubStore.getState().exitSplitWorkflow(PROJECT_ID, WORKTREE_ID);

    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(
      false,
    );
  });

  it('openSplitWorkflowSession is idempotent and closeSplitWorkflowSession removes only the key', () => {
    const store = useGitHubStore.getState();
    store.openSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);
    store.openSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);
    useGitHubStore.getState().openSplitWorkflowSession('proj-2', 'wt-2');
    expect(useGitHubStore.getState().splitWorkflowSessions.size).toBe(2);

    useGitHubStore
      .getState()
      .closeSplitWorkflowSession(PROJECT_ID, WORKTREE_ID);
    const sessions = useGitHubStore.getState().splitWorkflowSessions;
    expect(sessions.has(KEY)).toBe(false);
    expect(sessions.has('proj-2/wt-2')).toBe(true);
  });
});

describe('splitLockedWorktrees subscription', () => {
  interface LockCb {
    (event: { workspaceId: string; worktreeId: string; locked: boolean }): void;
  }
  const noopUnsub = (): void => {};

  function installEventsMock(options: {
    onSplitLockChange: (cb: LockCb) => () => void;
    getSplitLockState: () => Promise<{
      locked: Array<{
        workspaceId: string;
        worktreeId: string;
        executing: boolean;
      }>;
    }>;
    getSplitPrMap?: jest.Mock;
  }): void {
    Object.defineProperty(globalThis, 'window', {
      value: {
        api: {
          github: {
            onPrStatusUpdate: () => noopUnsub,
            onDependentBaseBranchesUpdated: () => noopUnsub,
            onPrCreationProgress: () => noopUnsub,
            onCommitPushProgress: () => noopUnsub,
            onSplitPrProgress: () => noopUnsub,
            onSplitLockChange: options.onSplitLockChange,
            getSplitLockState: options.getSplitLockState,
            getSplitPrMap:
              options.getSplitPrMap ?? jest.fn().mockResolvedValue(null),
          },
        },
      },
      configurable: true,
      writable: true,
    });
  }

  it('adds/removes keys as lock events arrive', () => {
    let lockCb: LockCb | undefined;
    installEventsMock({
      onSplitLockChange: (cb) => {
        lockCb = cb;
        return noopUnsub;
      },
      getSplitLockState: () => Promise.resolve({ locked: [] }),
    });
    useGitHubStore.setState({ splitLockedWorktrees: new Set<string>() });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    expect(lockCb).toBeDefined();

    lockCb?.({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      locked: true,
    });
    expect(useGitHubStore.getState().splitLockedWorktrees.has(KEY)).toBe(true);

    lockCb?.({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      locked: false,
    });
    expect(useGitHubStore.getState().splitLockedWorktrees.has(KEY)).toBe(false);

    unsubscribe();
  });

  it('seeds splitLockedWorktrees from getSplitLockState on wire-up', async () => {
    installEventsMock({
      onSplitLockChange: () => noopUnsub,
      getSplitLockState: () =>
        Promise.resolve({
          locked: [
            {
              workspaceId: PROJECT_ID,
              worktreeId: WORKTREE_ID,
              executing: false,
            },
          ],
        }),
    });
    useGitHubStore.setState({ splitLockedWorktrees: new Set<string>() });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    // The seed is async (fire-and-forget) — flush the microtask queue.
    await Promise.resolve();
    await Promise.resolve();

    expect(useGitHubStore.getState().splitLockedWorktrees.has(KEY)).toBe(true);
    // A non-executing (plan/review-phase) lock must NOT seed `splittingPr`.
    expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(false);

    unsubscribe();
  });

  it('seeds splittingPr for an executing lock so a reload-during-execute lands on Execute', async () => {
    installEventsMock({
      onSplitLockChange: () => noopUnsub,
      getSplitLockState: () =>
        Promise.resolve({
          locked: [
            {
              workspaceId: PROJECT_ID,
              worktreeId: WORKTREE_ID,
              executing: true,
            },
          ],
        }),
    });
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>(),
      splittingPr: new Set<string>(),
    });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    await Promise.resolve();
    await Promise.resolve();

    // Both the lock mirror AND the in-flight flag are seeded; the workflow
    // view derives 'execute' from `splittingPr` rather than falling back to
    // the Plan step on empty state.
    expect(useGitHubStore.getState().splitLockedWorktrees.has(KEY)).toBe(true);
    expect(useGitHubStore.getState().splittingPr.has(KEY)).toBe(true);

    unsubscribe();
  });

  it('reloads the persisted map and clears splittingPr on a lock RELEASE event', async () => {
    let lockCb: LockCb | undefined;
    const settledMap: SplitPrMap = { ...makeMap(), status: 'completed' };
    const getSplitPrMapMock = jest.fn().mockResolvedValue(settledMap);
    installEventsMock({
      onSplitLockChange: (cb) => {
        lockCb = cb;
        return noopUnsub;
      },
      getSplitLockState: () => Promise.resolve({ locked: [] }),
      getSplitPrMap: getSplitPrMapMock,
    });
    // Simulate the reload-during-execute seed: lock held + splittingPr set +
    // a stale `executing` map that the settle will overwrite.
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>([KEY]),
      splittingPr: new Set<string>([KEY]),
      splitPrResults: { [KEY]: { ...makeMap(), status: 'executing' } },
    });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    expect(lockCb).toBeDefined();

    lockCb?.({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      locked: false,
    });
    // `loadSplitPrMap` is fired without being awaited by the handler; flush.
    await Promise.resolve();
    await Promise.resolve();

    expect(getSplitPrMapMock).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    const state = useGitHubStore.getState();
    expect(state.splitLockedWorktrees.has(KEY)).toBe(false);
    expect(state.splittingPr.has(KEY)).toBe(false);
    // The truthful terminal map replaced the stale `executing` entry.
    expect(state.splitPrResults[KEY]).toEqual(settledMap);

    unsubscribe();
  });

  it('KEEPS the presentation session on a lock RELEASE when the settled map is completed', async () => {
    let lockCb: LockCb | undefined;
    const completedMap: SplitPrMap = { ...makeMap(), status: 'completed' };
    installEventsMock({
      onSplitLockChange: (cb) => {
        lockCb = cb;
        return noopUnsub;
      },
      getSplitLockState: () => Promise.resolve({ locked: [] }),
      getSplitPrMap: jest.fn().mockResolvedValue(completedMap),
    });
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>([KEY]),
      splitWorkflowSessions: new Set<string>([KEY]),
      splitPrResults: {},
    });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    lockCb?.({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      locked: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    // Lock released, but the session persists so the Finalize finished page
    // stays mounted until the user clicks Done.
    const state = useGitHubStore.getState();
    expect(state.splitLockedWorktrees.has(KEY)).toBe(false);
    expect(state.splitWorkflowSessions.has(KEY)).toBe(true);

    unsubscribe();
  });

  it('ENDS the presentation session on a lock RELEASE when the settled map is NOT completed (cancelled)', async () => {
    let lockCb: LockCb | undefined;
    const cancelledMap: SplitPrMap = { ...makeMap(), status: 'cancelled' };
    installEventsMock({
      onSplitLockChange: (cb) => {
        lockCb = cb;
        return noopUnsub;
      },
      getSplitLockState: () => Promise.resolve({ locked: [] }),
      getSplitPrMap: jest.fn().mockResolvedValue(cancelledMap),
    });
    useGitHubStore.setState({
      splitLockedWorktrees: new Set<string>([KEY]),
      splitWorkflowSessions: new Set<string>([KEY]),
      splitPrResults: {},
    });

    const unsubscribe = useGitHubStore.getState().subscribeToEvents();
    lockCb?.({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      locked: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    // A cancelled settle ends the session so normal worktree UX returns.
    const state = useGitHubStore.getState();
    expect(state.splitWorkflowSessions.has(KEY)).toBe(false);

    unsubscribe();
  });
});
