/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PrDiffSnapshot,
  SplitPlan,
  SplitPrExecuteResponse,
  SplitPrMap,
  SplitPrPlanRequest,
  SplitPrPlanResponse,
  SplitPrPlanResult,
  SplitWorkflowApproveRequest,
} from '@canopy/desktop-shared/types/github';
import { SplitWorkflowView } from '../SplitWorkflowView';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';

// jsdom's test global scope does not expose Node's structuredClone; the
// review panel uses it to deep-clone the incoming plan on mount.
if (typeof globalThis.structuredClone === 'undefined') {
  Object.defineProperty(globalThis, 'structuredClone', {
    configurable: true,
    value: (value: unknown): unknown => JSON.parse(JSON.stringify(value)),
  });
}

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);

interface MockWindowApi {
  github: {
    getSplitPrMap: jest.Mock<Promise<SplitPrMap | null>, [unknown]>;
    planSplitPr: jest.Mock<Promise<SplitPrPlanResult>, [SplitPrPlanRequest]>;
    approveSplitWorkflow: jest.Mock<
      Promise<SplitPrExecuteResponse>,
      [SplitWorkflowApproveRequest]
    >;
    exitSplitWorkflow: jest.Mock<Promise<void>, [unknown]>;
    cancelSplitPr: jest.Mock<Promise<void>, [unknown]>;
  };
}

function installWindowApiMock(): MockWindowApi {
  const api: MockWindowApi = {
    github: {
      getSplitPrMap: jest
        .fn<Promise<SplitPrMap | null>, [unknown]>()
        .mockResolvedValue(null),
      planSplitPr: jest
        .fn<Promise<SplitPrPlanResult>, [SplitPrPlanRequest]>()
        .mockImplementation(() => new Promise(() => undefined)),
      approveSplitWorkflow: jest
        .fn<Promise<SplitPrExecuteResponse>, [SplitWorkflowApproveRequest]>()
        .mockImplementation(() => new Promise(() => undefined)),
      exitSplitWorkflow: jest
        .fn<Promise<void>, [unknown]>()
        .mockResolvedValue(undefined),
      cancelSplitPr: jest
        .fn<Promise<void>, [unknown]>()
        .mockResolvedValue(undefined),
    },
  };
  Object.defineProperty(window, 'api', { configurable: true, value: api });
  return api;
}

function makeSnapshot(): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files: [
      {
        path: 'client.ts',
        kind: 'modified',
        isBinary: false,
        additions: 1,
        deletions: 0,
        hunks: [
          {
            file: 'client.ts',
            hunkIndex: 0,
            header: '@@ -1,3 +1,4 @@',
            contentHash: 'hash-0',
            coreLines: ['+added line'],
            occurrenceIndex: 0,
            additions: 1,
            deletions: 0,
            preview: '+added line',
          },
        ],
      },
    ],
    totalAdditions: 1,
    totalDeletions: 0,
  };
}

function makeValidPlan(buildTestCommand = 'npm test'): SplitPlan {
  return {
    finalGoal: 'Split the PR into two reviewable pieces',
    concerns: [],
    children: [
      {
        index: 1,
        title: 'refactor: extract helper',
        type: 'refactor',
        dependsOn: [],
        changes: [{ file: 'client.ts', hunks: [0] }],
        renames: [],
        testProof: 'npm test -- helper',
        risk: 'low',
        rationale: 'Pure extraction',
      },
    ],
    parallelizable: 'No',
    landOrder: '1',
    buildTestCommand,
    unassignedHunks: [],
  };
}

function makeReviewResponse(
  buildTestCommand = 'npm test',
): SplitPrPlanResponse {
  return {
    plan: makeValidPlan(buildTestCommand),
    snapshot: makeSnapshot(),
    originalPr: {
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      baseBranch: 'main',
      headBranch: 'feature-branch',
      headSha: 'head-sha',
    },
  };
}

let api: MockWindowApi;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  api = installWindowApiMock();
  useGitHubStore.setState({
    planningSplitPr: new Set<string>(),
    splittingPr: new Set<string>(),
    splitPrPlans: {},
    splitPrProgress: {},
    splitPrResults: {},
    splitPrRefusals: {},
    splitPrExecuteFailures: {},
    splitLockedWorktrees: new Set<string>([KEY]),
    splitWorkflowSessions: new Set<string>([KEY]),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  jest.clearAllMocks();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(
      <Suspense fallback={null}>
        <SplitWorkflowView projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />
      </Suspense>,
    );
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

function activeStep(): string | null {
  const active = container.querySelector<HTMLElement>(
    '[data-testid^="split-workflow-step-"][data-active="true"]',
  );
  return active?.getAttribute('data-testid') ?? null;
}

describe('SplitWorkflowView', () => {
  it('shows the plan step spinner while planning is in flight', async () => {
    useGitHubStore.setState((state) => ({
      planningSplitPr: new Set([...Array.from(state.planningSplitPr), KEY]),
    }));
    await render();

    expect(query('split-workflow-view')).not.toBeNull();
    expect(activeStep()).toBe('split-workflow-step-plan');
    expect(container.textContent).toContain('Analyzing PR diff');
  });

  it('offers a Cancel on the plan step that exits the workflow (releasing the lock)', async () => {
    useGitHubStore.setState((state) => ({
      planningSplitPr: new Set([...Array.from(state.planningSplitPr), KEY]),
    }));
    await render();

    expect(activeStep()).toBe('split-workflow-step-plan');
    const cancel = query('split-workflow-plan-cancel');
    expect(cancel).not.toBeNull();
    await act(async () => {
      cancel?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(api.github.exitSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
  });

  it('advances plan -> review when a plan lands, and shows the embedded review panel', async () => {
    await render();
    // Plan step active first (no plan, not planning => idle plan step).
    expect(activeStep()).toBe('split-workflow-step-plan');

    await act(async () => {
      useGitHubStore.setState((state) => ({
        splitPrPlans: { ...state.splitPrPlans, [KEY]: makeReviewResponse() },
      }));
      await Promise.resolve();
    });

    expect(activeStep()).toBe('split-workflow-step-review');
    expect(query('split-plan-panel')).not.toBeNull();
    expect(query('split-plan-approve')).not.toBeNull();
  });

  it('regenerate: planning takes precedence over a stale existing plan, showing the Plan step (not an approvable Review)', async () => {
    useGitHubStore.setState((state) => ({
      splitPrPlans: {
        ...state.splitPrPlans,
        [KEY]: makeReviewResponse('stale-command'),
      },
    }));
    await render();
    expect(activeStep()).toBe('split-workflow-step-review');
    expect(query('split-plan-approve')).not.toBeNull();

    // Regenerate starts: planningSplitPr gains the key while the stale plan
    // is still present in splitPrPlans (planSplitPr does not clear it).
    await act(async () => {
      useGitHubStore.setState((state) => ({
        planningSplitPr: new Set([...Array.from(state.planningSplitPr), KEY]),
      }));
      await Promise.resolve();
    });

    expect(activeStep()).toBe('split-workflow-step-plan');
    expect(query('split-plan-panel')).toBeNull();
    expect(query('split-plan-approve')).toBeNull();
    expect(container.textContent).toContain('Analyzing PR diff');

    // The new plan lands: planning clears and the fresh plan replaces the
    // stale one, moving back to Review with the NEW plan.
    await act(async () => {
      useGitHubStore.setState((state) => {
        const nextPlanning = new Set(state.planningSplitPr);
        nextPlanning.delete(KEY);
        return {
          planningSplitPr: nextPlanning,
          splitPrPlans: {
            ...state.splitPrPlans,
            [KEY]: makeReviewResponse('fresh-command'),
          },
        };
      });
      await Promise.resolve();
    });

    expect(activeStep()).toBe('split-workflow-step-review');
    expect(query('split-plan-panel')).not.toBeNull();
    expect(
      useGitHubStore.getState().splitPrPlans[KEY]?.plan.buildTestCommand,
    ).toBe('fresh-command');
  });

  it('review -> execute: approve commits the edited plan and calls approveSplitWorkflow under lock', async () => {
    useGitHubStore.setState((state) => ({
      splitPrPlans: {
        ...state.splitPrPlans,
        [KEY]: makeReviewResponse('original-command'),
      },
    }));
    await render();
    expect(activeStep()).toBe('split-workflow-step-review');

    // Edit the build/test command, then approve.
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="split-plan-build-command"]',
    );
    expect(input).not.toBeNull();
    await act(async () => {
      // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked via .call
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'edited-command');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      query('split-plan-approve')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    // Store now holds the edited plan (committed via commitApprovedSplitPlan).
    expect(
      useGitHubStore.getState().splitPrPlans[KEY]?.plan.buildTestCommand,
    ).toBe('edited-command');
    expect(api.github.approveSplitWorkflow).toHaveBeenCalledTimes(1);
    expect(
      api.github.approveSplitWorkflow.mock.calls[0][0].plan.buildTestCommand,
    ).toBe('edited-command');
  });

  it('execute step renders per-child progress rows and a Cancel that calls cancelSplitPr', async () => {
    useGitHubStore.setState((state) => ({
      splittingPr: new Set([...Array.from(state.splittingPr), KEY]),
      splitPrPlans: {
        ...state.splitPrPlans,
        [KEY]: makeReviewResponse(),
      },
      splitPrProgress: {
        ...state.splitPrProgress,
        [KEY]: [
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            phase: 'carving_child',
            childIndex: 1,
            childTotal: 2,
          },
        ],
      },
    }));
    await render();

    expect(activeStep()).toBe('split-workflow-step-execute');
    expect(container.textContent).toContain('Carving child branch (1/2)');

    await act(async () => {
      query('split-workflow-cancel')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(api.github.cancelSplitPr).toHaveBeenCalledTimes(1);
  });

  it('derives the Execute step from splittingPr alone after a reload-during-execute (no plan/progress seeded)', async () => {
    // Reload-during-execute hydration seeds only the lock + `splittingPr` for
    // the key (the executing entry from `getSplitLockState`); the in-memory
    // plan and progress are gone. The view must still land on Execute, not
    // fall back to the Plan step on the otherwise-empty state.
    useGitHubStore.setState((state) => ({
      splittingPr: new Set([...Array.from(state.splittingPr), KEY]),
    }));
    await render();

    expect(activeStep()).toBe('split-workflow-step-execute');
  });

  it('a plan-time refusal while locked surfaces the refusal and auto-exits, preserving the refusal', async () => {
    useGitHubStore.setState((state) => ({
      splitPrRefusals: {
        ...state.splitPrRefusals,
        [KEY]: { code: 'no_open_pr', message: 'There is no open PR to split.' },
      },
    }));
    await render();

    expect(activeStep()).toBe('split-workflow-step-plan');
    expect(query('split-workflow-refusal')).not.toBeNull();
    expect(container.textContent).toContain('There is no open PR to split.');

    // Auto-exit releases the lock (exitSplitWorkflow), but must NOT clear the
    // stored refusal — the normal-UX PullRequestSection notice keys off it.
    expect(api.github.exitSplitWorkflow).toHaveBeenCalledTimes(1);
    expect(useGitHubStore.getState().splitPrRefusals[KEY]).toBeDefined();
  });

  it('shows a completed success state on the finalize step', async () => {
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature-branch',
      originalHeadSha: 'head-sha',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [],
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState((state) => ({
      splitPrResults: { ...state.splitPrResults, [KEY]: map },
    }));
    await render();

    expect(activeStep()).toBe('split-workflow-step-finalize');
    expect(query('split-workflow-done')).not.toBeNull();
    expect(container.textContent).toContain('Split complete');
  });

  it('finalize renders the finished page from the completed map (integration + children links) and stays mounted after the lock releases', async () => {
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature-branch',
      originalHeadSha: 'head-sha',
      integrationBranch: 'split/integration',
      integrationPrNumber: 100,
      integrationPrUrl: 'https://github.com/example/repo/pull/100',
      originalWorktreeId: WORKTREE_ID,
      children: [
        {
          index: 1,
          title: 'refactor: extract helper',
          type: 'refactor',
          branchName: 'split/01-extract-helper',
          baseBranch: 'main',
          dependsOn: [],
          changes: [],
          prNumber: 101,
          prUrl: 'https://github.com/example/repo/pull/101',
        },
      ],
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    // Completed settle: the session persists but the lock has released.
    useGitHubStore.setState((state) => ({
      splitPrResults: { ...state.splitPrResults, [KEY]: map },
      splitLockedWorktrees: new Set(
        [...Array.from(state.splitLockedWorktrees)].filter((k) => k !== KEY),
      ),
    }));
    await render();

    // The view is still mounted (session, not lock) on the finalize finished page.
    expect(query('split-workflow-view')).not.toBeNull();
    expect(activeStep()).toBe('split-workflow-step-finalize');
    expect(query('split-result-summary')).not.toBeNull();
    // Integration PR link + supersedes note.
    expect(container.textContent).toContain('Integration PR #100');
    expect(container.textContent).toContain('supersedes #42');
    // Child row: [i/N] title, branch name, and PR link.
    expect(container.textContent).toContain('[1/1] refactor: extract helper');
    expect(container.textContent).toContain('branch: split/01-extract-helper');
    expect(container.textContent).toContain('#101');
    // Tracks-integration-branch note + child-worktrees note.
    expect(container.textContent).toContain('integration branch');
    expect(container.textContent).toContain('sidebar');
  });

  it('finalize Done button closes the session, restoring normal worktree UX', async () => {
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature-branch',
      originalHeadSha: 'head-sha',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [],
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState((state) => ({
      splitPrResults: { ...state.splitPrResults, [KEY]: map },
      splitLockedWorktrees: new Set(
        [...Array.from(state.splitLockedWorktrees)].filter((k) => k !== KEY),
      ),
    }));
    await render();

    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(true);
    const done = query('split-workflow-done');
    expect(done).not.toBeNull();

    await act(async () => {
      done?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // The session is closed → WorktreeManager keys on session OR lock, both now
    // false, so normal worktree UX takes over.
    expect(useGitHubStore.getState().splitWorkflowSessions.has(KEY)).toBe(
      false,
    );
  });
});
