/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PrDiffSnapshot,
  PrStatusData,
  SplitPrDiscardResponse,
  SplitPrExecuteResponse,
  SplitPrMap,
  SplitPrPlanRequest,
  SplitPrPlanResponse,
  SplitPrPlanResult,
  SplitWorkflowApproveRequest,
  SplitWorkflowStartRequest,
  SplitWorkflowStartResult,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { PullRequestSection } from '../PullRequestSection';
import { ActivitySectionChromeContext } from '@/components/shared/panel-section';
import { SplitPreflightModalHost } from '../SplitPreflightModal';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';

// jsdom's test global scope does not expose Node's structuredClone; the
// split-plan review panel uses it to deep-clone the incoming plan on mount.
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
  loadPreferences: jest.Mock;
  github: {
    getSplitPrMap: jest.Mock;
    planSplitPr: jest.Mock<Promise<SplitPrPlanResult>, [SplitPrPlanRequest]>;
    startSplitWorkflow: jest.Mock<
      Promise<SplitWorkflowStartResult>,
      [SplitWorkflowStartRequest]
    >;
    approveSplitWorkflow: jest.Mock<
      Promise<SplitPrExecuteResponse>,
      [SplitWorkflowApproveRequest]
    >;
    exitSplitWorkflow: jest.Mock<Promise<void>, [unknown]>;
    discardSplitPr: jest.Mock<Promise<SplitPrDiscardResponse>, [unknown]>;
  };
}

function installWindowApiMock(): MockWindowApi {
  const api: MockWindowApi = {
    loadPreferences: jest.fn().mockResolvedValue({
      splitPrEnabled: true,
      splitPrThresholdLines: 500,
    }),
    github: {
      getSplitPrMap: jest
        .fn<Promise<SplitPrMap | null>, [unknown]>()
        .mockResolvedValue(null),
      planSplitPr: jest
        .fn<Promise<SplitPrPlanResult>, [SplitPrPlanRequest]>()
        .mockImplementation(
          () =>
            new Promise(() => {
              // Left pending by default; the fourth-surface pre-flight test
              // only asserts the call happened.
            }),
        ),
      startSplitWorkflow: jest
        .fn<Promise<SplitWorkflowStartResult>, [SplitWorkflowStartRequest]>()
        .mockImplementation(
          () =>
            new Promise(() => {
              // Left pending by default; launch tests only assert the call.
            }),
        ),
      approveSplitWorkflow: jest
        .fn<Promise<SplitPrExecuteResponse>, [SplitWorkflowApproveRequest]>()
        .mockImplementation(
          () =>
            new Promise(() => {
              // Left pending by default; approve tests override per-call.
            }),
        ),
      exitSplitWorkflow: jest
        .fn<Promise<void>, [unknown]>()
        .mockResolvedValue(undefined),
      discardSplitPr: jest
        .fn<Promise<SplitPrDiscardResponse>, [unknown]>()
        .mockResolvedValue({ branches: [], prNumbers: [] }),
    },
  };
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: api,
  });
  return api;
}

function makePrStatus(overrides: Partial<PrStatusData> = {}): PrStatusData {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    state: 'open',
    title: 'A very large PR',
    checkStatus: 'passing',
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
    additions: 600,
    deletions: 100,
    ...overrides,
  };
}

function makeWorktreePrStatus(status: PrStatusData): WorktreePrStatus {
  return {
    repos: [{ repoId: 'repo-1', repoName: 'repo', status }],
    lastCheckedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeSingleRepoProject(): SidebarItem {
  return {
    type: 'single-repo',
    id: PROJECT_ID,
    name: 'Workspace One',
    repoPath: '/repo',
    color: 'blue',
    collapsed: false,
    order: 0,
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/big-change',
        createdAt: '2026-07-01T00:00:00.000Z',
      },
    ],
  };
}

function setGatingPrefs(enabled: boolean, thresholdLines: number): void {
  useSplitPrPreferencesStore.setState({
    splitPrEnabled: enabled,
    splitPrThresholdLines: thresholdLines,
    hasLoaded: true,
  });
  // Keep the async preferences load consistent so it cannot overwrite the
  // seeded gating state when it resolves during render.
  api.loadPreferences.mockResolvedValue({
    splitPrEnabled: enabled,
    splitPrThresholdLines: thresholdLines,
  });
}

function setDesktopPrSplitFlag(enabled: boolean): void {
  useFeatureFlagsStore.getState().setSnapshot({
    ...getDefaultFeatureFlagSnapshot(),
    values: {
      ...getDefaultFeatureFlagSnapshot().values,
      [CLIENT_FEATURE_FLAGS.canopyDesktopPrSplit.key]: enabled,
    },
  });
}

let api: MockWindowApi;
let container: HTMLElement;
let root: Root;

beforeEach(() => {
  api = installWindowApiMock();
  __resetSplitPrPreferencesForTests();
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useGitHubStore.setState({
    prStatuses: {},
    creatingPr: new Set<string>(),
    creationProgress: {},
    planningSplitPr: new Set<string>(),
    splittingPr: new Set<string>(),
    splitPrPlans: {},
    splitPrProgress: {},
    splitPrResults: {},
    splitPrRefusals: {},
    splitPrExecuteFailures: {},
    splitLockedWorktrees: new Set<string>(),
    splitWorkflowSessions: new Set<string>(),
  });
  useProjectsStore.setState({
    projects: [makeSingleRepoProject()],
    diffStats: {},
    uncommittedChanges: {},
    hasUnpushedCommits: {},
  });
  usePipelineRunsStore.setState({
    runningExecutionsByWorktree: {},
    pausedExecutionsByWorktree: {},
  });
  useChatStore.setState({ worktreeChats: {} });
  useActivityStore.setState({ splitPreflight: null });
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
      <PullRequestSection projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
    );
    // Flush the mount effects (preferences load + split map hydration).
    await Promise.resolve();
  });
}

// Mounts the section alongside the real (app-root-mounted-in-production)
// SplitPreflightModalHost, so a fourth-surface test can assert the full
// click -> modal-appears -> Start -> launch-invoked path, not just that the
// activityStore target was set.
async function renderWithPreflightHost(): Promise<void> {
  await act(async () => {
    root.render(
      <>
        <PullRequestSection projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />
        <SplitPreflightModalHost />
      </>,
    );
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

// SplitPreflightModalHost renders via createPortal(..., document.body), so
// the modal is NOT a descendant of `container` — query the full document.
function queryDocument(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

describe('PullRequestSection session-replay privacy', () => {
  it('records the pull request detail in session replay', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            title: 'Private pull request title',
            checkDetails: [
              { name: 'private-check', status: 'passing', detailsUrl: null },
            ],
          }),
        ),
      },
    });

    await render();

    const title = Array.from(container.querySelectorAll('p')).find(
      (element) => element.textContent === 'Private pull request title',
    );
    const detail = title?.parentElement;
    expect(detail?.textContent).toContain('PR #42');
    expect(detail?.textContent).toContain('private-check');
    expect(detail?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  });

  it('records the host section root where the chrome renders one', async () => {
    useGitHubStore.setState({
      prStatuses: { [KEY]: makeWorktreePrStatus(makePrStatus()) },
    });

    await act(async () => {
      root.render(
        <ActivitySectionChromeContext.Provider value="frameless">
          <PullRequestSection projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />
        </ActivitySectionChromeContext.Provider>,
      );
      await Promise.resolve();
    });

    const section = container.querySelector(
      'section[data-activity-chrome="frameless"]',
    );
    expect(section?.parentElement).toBe(container);
    expect(section?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });
});

describe('PullRequestSection Split PR gating', () => {
  it('shows the Split PR button for an eligible open PR at/above the threshold', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    const button = query('split-pr-button');
    expect(button).not.toBeNull();
    // Displayed line count prefers the PR's own additions/deletions.
    expect(button?.textContent).toContain('700');
  });

  it('hides the Split PR button when the PR is below the threshold', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 300, deletions: 100 }),
        ),
      },
    });

    await render();

    expect(query('split-pr-button')).toBeNull();
  });

  it('hides the Split PR button when the feature toggle is off', async () => {
    setGatingPrefs(false, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    expect(query('split-pr-button')).toBeNull();
  });

  it('hides the Split PR button when the desktop PR Split flag is off', async () => {
    setGatingPrefs(true, 500);
    setDesktopPrSplitFlag(false);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    expect(query('split-pr-button')).toBeNull();
  });

  it('hides the Split PR button for multi-repo projects', async () => {
    setGatingPrefs(true, 500);
    const multiRepoProject: SidebarItem = {
      type: 'multi-repo',
      id: PROJECT_ID,
      name: 'Workspace One',
      color: 'blue',
      repos: [],
      worktrees: [
        {
          id: WORKTREE_ID,
          branchName: 'feature/big-change',
          createdAt: '2026-07-01T00:00:00.000Z',
        },
      ],
      collapsed: false,
      order: 0,
    };
    useProjectsStore.setState({ projects: [multiRepoProject] });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    expect(query('split-pr-button')).toBeNull();
  });

  it('renders mapped refusal copy with a dismiss affordance', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrRefusals: {
        [KEY]: {
          code: 'head_out_of_sync',
          message: 'raw backend detail that should not render',
        },
      },
    });

    await render();

    const refusal = query('split-pr-refusal');
    expect(refusal).not.toBeNull();
    expect(refusal?.textContent).toContain(
      'Local branch is out of sync with the PR — push or pull first.',
    );
    expect(refusal?.textContent).not.toContain('raw backend detail');
    expect(query('split-pr-refusal-dismiss')).not.toBeNull();
  });

  it('renders the backend message for invalid_plan refusals', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrRefusals: {
        [KEY]: {
          code: 'invalid_plan',
          message: 'The planner left hunk 3 of client.ts unassigned.',
        },
      },
    });

    await render();

    expect(query('split-pr-refusal')?.textContent).toContain(
      'The planner left hunk 3 of client.ts unassigned.',
    );
  });

  it('renders a compact issues list for invalid_plan refusals that carry issues', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrRefusals: {
        [KEY]: {
          code: 'invalid_plan',
          message: 'Split plan fixture failed validation: two issues found.',
          issues: [
            {
              code: 'unassigned-hunk',
              severity: 'error',
              message: 'hunk 3 of client.ts is not assigned to any child',
            },
            {
              code: 'duplicate-hunk',
              severity: 'error',
              message: 'hunk 0 of server.ts is assigned to multiple children',
              childIndex: 2,
            },
          ],
        },
      },
    });

    await render();

    const issuesList = query('split-pr-refusal-issues');
    expect(issuesList).not.toBeNull();
    expect(issuesList?.textContent).toContain(
      'hunk 3 of client.ts is not assigned to any child',
    );
    expect(issuesList?.textContent).toContain('Child 2:');
    expect(issuesList?.textContent).toContain(
      'hunk 0 of server.ts is assigned to multiple children',
    );
    expect(issuesList?.querySelectorAll('li')).toHaveLength(2);
    expect(query('split-pr-refusal-issues-more')).toBeNull();
  });

  it('caps the issues list at 8 entries and shows a "+N more" line beyond the cap', async () => {
    setGatingPrefs(true, 500);
    const issues = Array.from({ length: 11 }, (_, i) => ({
      code: 'unassigned-hunk' as const,
      severity: 'error' as const,
      message: `hunk ${i} of file${i}.ts is not assigned to any child`,
    }));
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrRefusals: {
        [KEY]: {
          code: 'invalid_plan',
          message: 'Split plan fixture failed validation: eleven issues found.',
          issues,
        },
      },
    });

    await render();

    const issuesList = query('split-pr-refusal-issues');
    expect(issuesList).not.toBeNull();
    const items = issuesList?.querySelectorAll('li') ?? [];
    // 8 capped issue rows + 1 "+N more" row.
    expect(items).toHaveLength(9);
    const moreLine = query('split-pr-refusal-issues-more');
    expect(moreLine).not.toBeNull();
    expect(moreLine?.textContent).toContain('+3 more');
    expect(issuesList?.textContent).not.toContain('hunk 8 of file8.ts');
  });

  it('does not render an issues list for refusals without issues', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrRefusals: {
        [KEY]: {
          code: 'head_out_of_sync',
          message: 'raw backend detail',
        },
      },
    });

    await render();

    expect(query('split-pr-refusal-issues')).toBeNull();
  });

  it('renders the completed split result view from a persisted map', async () => {
    setGatingPrefs(true, 500);
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature/big-change',
      originalHeadSha: 'abc123',
      integrationBranch: 'split/integration',
      integrationPrNumber: 50,
      integrationPrUrl: 'https://github.com/example/repo/pull/50',
      originalWorktreeId: WORKTREE_ID,
      children: [
        {
          index: 1,
          title: 'refactor: extract helper',
          type: 'refactor',
          branchName: 'split/child-1',
          baseBranch: 'main',
          dependsOn: [],
          changes: [{ file: 'client.ts', hunks: 'all' }],
          prNumber: 51,
          prUrl: 'https://github.com/example/repo/pull/51',
        },
      ],
      status: 'completed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    // The section hydrates the persisted map on mount via getSplitPrMap.
    api.github.getSplitPrMap.mockResolvedValue(map);

    await render();

    const result = query('split-result');
    expect(result).not.toBeNull();
    expect(result?.textContent).toContain('supersedes #42');
    expect(result?.textContent).toContain('[1/1] refactor: extract helper');
    expect(result?.textContent).toContain('base: main');
    // Result view replaces the Split PR button.
    expect(query('split-pr-button')).toBeNull();
  });

  it('routes "Plan new split" through the pre-flight modal: click opens the modal, Start invokes the launch', async () => {
    setGatingPrefs(true, 500);
    // A failed map with no resumable plan (splitPrPlans[KEY] is unset) is
    // the only state that renders "Plan new split" instead of "Resume split".
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature/big-change',
      originalHeadSha: 'abc123',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [],
      status: 'failed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });
    api.github.getSplitPrMap.mockResolvedValue(map);

    await renderWithPreflightHost();

    const replanButton = query('split-result-replan');
    expect(replanButton).not.toBeNull();
    // Clicking must not plan directly — it only opens the pre-flight modal.
    await act(async () => {
      replanButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useGitHubStore.getState().planningSplitPr.has(KEY)).toBe(false);
    expect(api.github.planSplitPr).not.toHaveBeenCalled();

    const modal = queryDocument('split-preflight-modal');
    expect(modal).not.toBeNull();

    const startButton = queryDocument('split-preflight-start');
    expect(startButton).not.toBeNull();
    await act(async () => {
      startButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // A5: the pre-flight Start funnels into the lockdown-aware
    // startSplitWorkflow, not planSplitPr directly.
    expect(api.github.startSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'plan',
    });
    expect(api.github.planSplitPr).not.toHaveBeenCalled();
    expect(useActivityStore.getState().splitPreflight).toBeNull();
  });

  it('shows the post-discard artifacts panel after a successful discard deletes the result', async () => {
    setGatingPrefs(true, 500);
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature/big-change',
      originalHeadSha: 'abc123',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [
        {
          index: 1,
          title: 'refactor: extract helper',
          type: 'refactor',
          branchName: 'split/child-1',
          baseBranch: 'main',
          dependsOn: [],
          changes: [{ file: 'client.ts', hunks: 'all' }],
          prNumber: 51,
          prUrl: 'https://github.com/example/repo/pull/51',
        },
      ],
      // A failed/cancelled map is the only state that surfaces the discard
      // affordance.
      status: 'failed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });
    api.github.getSplitPrMap.mockResolvedValue(map);
    // The discard leaves a child branch + PR behind; the panel must list them.
    api.github.discardSplitPr.mockResolvedValue({
      branches: ['split/child-1', 'split/integration'],
      prNumbers: [51],
    });

    await render();

    expect(query('split-result')).not.toBeNull();
    expect(query('split-pr-discard-artifacts')).toBeNull();

    const discardButton = query('split-pr-discard');
    expect(discardButton).not.toBeNull();
    await act(async () => {
      discardButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    // The store deleted the result, so the result view is gone...
    expect(query('split-result')).toBeNull();
    // ...but the sibling artifacts panel is now visible listing the leftovers.
    const artifacts = query('split-pr-discard-artifacts');
    expect(artifacts).not.toBeNull();
    expect(artifacts?.textContent).toContain('split/child-1');
    expect(artifacts?.textContent).toContain('split/integration');
    expect(artifacts?.textContent).toContain('#51');
  });

  it('does not restore post-discard artifacts when a pending discard resolves after switching worktrees', async () => {
    setGatingPrefs(true, 500);
    const map: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature/big-change',
      originalHeadSha: 'abc123',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [
        {
          index: 1,
          title: 'refactor: extract helper',
          type: 'refactor',
          branchName: 'split/child-1',
          baseBranch: 'main',
          dependsOn: [],
          changes: [{ file: 'client.ts', hunks: 'all' }],
        },
      ],
      status: 'failed',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });
    api.github.getSplitPrMap.mockResolvedValue(map);
    let resolveDiscard!: (response: SplitPrDiscardResponse) => void;
    api.github.discardSplitPr.mockReturnValue(
      new Promise((resolve) => {
        resolveDiscard = resolve;
      }),
    );

    await render();
    await act(async () => {
      query('split-pr-discard')?.click();
      await Promise.resolve();
    });

    // Switch worktrees before the IPC response arrives. The old cleanup runs
    // before there is an artifact to delete, so the completion continuation
    // must also guard against repopulating the abandoned key.
    await act(async () => {
      root.render(
        <PullRequestSection projectId={PROJECT_ID} worktreeId="wt-2" />,
      );
      await Promise.resolve();
    });
    await act(async () => {
      resolveDiscard({ branches: ['split/child-1'], prNumbers: [] });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(query('split-pr-discard-artifacts')).toBeNull();
    expect(
      useGitHubStore.getState().splitPrDiscardedArtifacts[KEY],
    ).toBeUndefined();

    // Returning to the original worktree must not resurrect the old notice.
    await act(async () => {
      root.render(
        <PullRequestSection projectId={PROJECT_ID} worktreeId={WORKTREE_ID} />,
      );
      await Promise.resolve();
    });
    expect(query('split-pr-discard-artifacts')).toBeNull();
  });

  it('surfaces a plan_mismatch execute failure directly with a Discard affordance, even though the stale persisted map is still status: executing', async () => {
    setGatingPrefs(true, 500);
    // The persisted map on disk was never transitioned to 'failed': a
    // plan_mismatch throws BEFORE the backend's mapRef is initialized for
    // this run, so the map stays at whatever status the prior run left it
    // in. SplitResultView's own Discard button only renders for
    // status: 'failed' | 'cancelled', so without the dedicated failure
    // notice this stale 'executing' map would show no actions at all.
    const staleMap: SplitPrMap = {
      version: 1,
      originalPrNumber: 42,
      originalPrUrl: 'https://github.com/example/repo/pull/42',
      originalBaseBranch: 'main',
      originalHeadBranch: 'feature/big-change',
      originalHeadSha: 'abc123',
      integrationBranch: 'split/integration',
      originalWorktreeId: WORKTREE_ID,
      children: [],
      status: 'executing',
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    };
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: staleMap },
      splitPrExecuteFailures: {
        [KEY]: {
          code: 'plan_mismatch',
          message:
            'The approved plan differs from the split already in progress — discard the previous split state or resume the original plan',
        },
      },
    });
    api.github.getSplitPrMap.mockResolvedValue(staleMap);
    api.github.discardSplitPr.mockResolvedValue({
      branches: ['split/integration'],
      prNumbers: [],
    });

    await render();

    const failureNotice = query('split-pr-execute-failure');
    expect(failureNotice).not.toBeNull();
    expect(failureNotice?.textContent).toContain(
      'The approved plan differs from the split already in progress',
    );
    // The stale executing-status result view must NOT render alongside it.
    expect(query('split-result')).toBeNull();

    const discardButton = query('split-pr-execute-failure-discard');
    expect(discardButton).not.toBeNull();
    await act(async () => {
      discardButton?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(api.github.discardSplitPr).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    // A successful discard clears the structured failure along with the map.
    expect(query('split-pr-execute-failure')).toBeNull();
    expect(
      useGitHubStore.getState().splitPrExecuteFailures[KEY],
    ).toBeUndefined();
  });

  it('dismisses a non-plan_mismatch execute failure notice without a Discard button', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();

    expect(query('split-pr-execute-failure')).not.toBeNull();
    expect(query('split-pr-execute-failure-discard')).toBeNull();

    const dismissButton = query('split-pr-execute-failure-dismiss');
    expect(dismissButton).not.toBeNull();
    await act(async () => {
      dismissButton?.click();
      await Promise.resolve();
    });

    expect(query('split-pr-execute-failure')).toBeNull();
  });
});

function makeFailurePlanResponse(): SplitPrPlanResponse {
  return {
    plan: {
      finalGoal: 'goal',
      concerns: [],
      children: [],
      parallelizable: '',
      landOrder: '',
      buildTestCommand: '',
      unassignedHunks: [],
    },
    snapshot: {
      baseRef: 'base',
      headRef: 'head',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    },
    originalPr: {
      prNumber: 42,
      prUrl: 'https://github.com/example/repo/pull/42',
      baseBranch: 'main',
      headBranch: 'feature/big-change',
      headSha: 'head',
    },
  };
}

function makeExecutingMap(): SplitPrMap {
  return {
    version: 1,
    originalPrNumber: 42,
    originalPrUrl: 'https://github.com/example/repo/pull/42',
    originalBaseBranch: 'main',
    originalHeadBranch: 'feature/big-change',
    originalHeadSha: 'head',
    integrationBranch: 'split/integration',
    originalWorktreeId: WORKTREE_ID,
    children: [],
    status: 'executing',
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

describe('PullRequestSection Split PR failure modal', () => {
  it('renders the failure modal with message, child index, and verify tail', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: { [KEY]: makeFailurePlanResponse() },
      splitPrExecuteFailures: {
        [KEY]: {
          message: 'Verify failed for child 2',
          childIndex: 2,
          verifyTail: 'FAIL: 1 test failed',
        },
      },
    });

    await render();

    const modal = queryDocument('split-failure-modal');
    expect(modal).not.toBeNull();
    expect(queryDocument('split-failure-message')?.textContent).toContain(
      'Verify failed for child 2',
    );
    expect(queryDocument('split-failure-child-index')?.textContent).toContain(
      '#2',
    );
    expect(queryDocument('split-failure-verify-tail')?.textContent).toContain(
      'FAIL: 1 test failed',
    );
  });

  it('Leave dismisses the modal but keeps the inline failure notice', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: { [KEY]: makeFailurePlanResponse() },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();
    expect(queryDocument('split-failure-modal')).not.toBeNull();

    await act(async () => {
      queryDocument('split-failure-leave')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    // Modal gone, inline notice remains (persistent surface).
    expect(queryDocument('split-failure-modal')).toBeNull();
    expect(query('split-pr-execute-failure')).not.toBeNull();
  });

  it('Retry re-enters the locked workflow via mode resume with the stored plan', async () => {
    setGatingPrefs(true, 500);
    const planResponse = makeFailurePlanResponse();
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: { [KEY]: planResponse },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();

    await act(async () => {
      queryDocument('split-failure-retry')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(api.github.startSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'resume',
      plan: planResponse.plan,
      snapshot: planResponse.snapshot,
    });
  });

  it('Edit plan re-enters the locked workflow via mode review', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: { [KEY]: makeFailurePlanResponse() },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();

    await act(async () => {
      queryDocument('split-failure-edit-plan')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(api.github.startSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'review',
    });
  });

  it('hides Retry/Edit and offers Plan new split when no stored plan exists', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      // No splitPrPlans entry — post-reload the in-memory plan is gone.
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();

    expect(queryDocument('split-failure-modal')).not.toBeNull();
    expect(queryDocument('split-failure-retry')).toBeNull();
    expect(queryDocument('split-failure-edit-plan')).toBeNull();
    expect(queryDocument('split-failure-plan-new')).not.toBeNull();
    expect(queryDocument('split-failure-replan-note')).not.toBeNull();
  });

  it('"Plan new split" dismisses the failure modal before opening the pre-flight (no stacking)', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
    });

    await render();
    expect(queryDocument('split-failure-modal')).not.toBeNull();

    await act(async () => {
      queryDocument('split-failure-plan-new')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    // The pre-flight opened AND the failure modal is dismissed — the two do
    // not stack.
    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(queryDocument('split-failure-modal')).toBeNull();
  });

  it('does not render the failure modal while the worktree is split-locked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: { [KEY]: makeFailurePlanResponse() },
      splitPrExecuteFailures: {
        [KEY]: { message: 'Verify failed for child 2', childIndex: 2 },
      },
      splitLockedWorktrees: new Set<string>([KEY]),
    });

    await render();

    expect(queryDocument('split-failure-modal')).toBeNull();
  });
});

describe('PullRequestSection Split PR interrupted modal', () => {
  it('shows the interrupted modal for a stale executing map with no live lock', async () => {
    setGatingPrefs(true, 500);
    const map = makeExecutingMap();
    api.github.getSplitPrMap.mockResolvedValue(map);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });

    await render();

    expect(queryDocument('split-interrupted-modal')).not.toBeNull();
  });

  it('does not show the interrupted modal while a live run is in flight (locked + splitting)', async () => {
    setGatingPrefs(true, 500);
    const map = makeExecutingMap();
    api.github.getSplitPrMap.mockResolvedValue(map);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
      splittingPr: new Set<string>([KEY]),
      splitLockedWorktrees: new Set<string>([KEY]),
    });

    await render();

    expect(queryDocument('split-interrupted-modal')).toBeNull();
  });

  it('Resume opens the pre-flight modal', async () => {
    setGatingPrefs(true, 500);
    const map = makeExecutingMap();
    api.github.getSplitPrMap.mockResolvedValue(map);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });

    await render();

    await act(async () => {
      queryDocument('split-interrupted-resume')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(queryDocument('split-interrupted-modal')).toBeNull();
  });

  it('Dismiss closes the interrupted modal', async () => {
    setGatingPrefs(true, 500);
    const map = makeExecutingMap();
    api.github.getSplitPrMap.mockResolvedValue(map);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });

    await render();
    expect(queryDocument('split-interrupted-modal')).not.toBeNull();

    await act(async () => {
      queryDocument('split-interrupted-dismiss')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true }),
      );
      await Promise.resolve();
    });

    expect(queryDocument('split-interrupted-modal')).toBeNull();
  });

  it('does not show the interrupted modal for a completed map', async () => {
    setGatingPrefs(true, 500);
    const map: SplitPrMap = { ...makeExecutingMap(), status: 'completed' };
    api.github.getSplitPrMap.mockResolvedValue(map);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrResults: { [KEY]: map },
    });

    await render();

    expect(queryDocument('split-interrupted-modal')).toBeNull();
  });
});

function makeChatTab(id: string, overrides: Partial<ChatTab> = {}): ChatTab {
  return {
    id,
    title: `Chat ${id}`,
    messages: [],
    status: 'idle',
    error: null,
    createdAt: '2026-07-01T00:00:00.000Z',
    queuedMessages: [],
    planMode: false,
    proposalMode: 'optional',
    thinkingLevel: 'high',
    modelConfig: { thinkingLevel: 'high', fastMode: false },
    fastModeExplicit: false,
    ...overrides,
  };
}

describe('PullRequestSection Split PR readiness gating', () => {
  it('renders the button enabled with the Split PR icon when fully ready', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    const button = query('split-pr-button');
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('disabled')).toBe(false);
    expect(button?.querySelector('svg')).not.toBeNull();
  });

  it('renders the button disabled with a tooltip listing every blocker when eligible but blocked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100, hasConflicts: true }),
        ),
      },
    });
    useProjectsStore.setState({ uncommittedChanges: { [KEY]: true } });

    await render();

    const button = query('split-pr-button');
    expect(button).not.toBeNull();
    expect(button?.hasAttribute('disabled')).toBe(true);
    expect(button?.querySelector('svg')).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain(
      'Commit or discard local changes first',
    );
    expect(tooltip?.textContent).toContain(
      'Resolve the merge conflicts reported by GitHub first',
    );
  });

  it('disables the button while a pipeline is active for the worktree', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    usePipelineRunsStore.setState({
      runningExecutionsByWorktree: { [KEY]: new Set(['exec-1']) },
    });

    await render();

    expect(query('split-pr-button')?.hasAttribute('disabled')).toBe(true);
  });

  it('disables the button while a chat tab is actively streaming for the worktree', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [makeChatTab('chat-1', { status: 'streaming' })],
          activeTabId: 'chat-1',
        },
      },
    });

    await render();

    expect(query('split-pr-button')?.hasAttribute('disabled')).toBe(true);
  });

  it('opens the split pre-flight modal target instead of planning directly when clicked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    const button = query('split-pr-button');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    // Clicking the launch surface must gate through the modal, not plan
    // immediately.
    expect(useGitHubStore.getState().planningSplitPr.has(KEY)).toBe(false);
  });

  it('does not disable the button for a chat tab mid pending-plan-exit', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    useChatStore.setState({
      worktreeChats: {
        [KEY]: {
          tabs: [
            makeChatTab('chat-1', {
              status: 'streaming',
              pendingPlanExit: { toolInput: {} },
            }),
          ],
          activeTabId: 'chat-1',
        },
      },
    });

    await render();

    expect(query('split-pr-button')?.hasAttribute('disabled')).toBe(false);
  });
});

describe('PullRequestSection current-UI-state reporter', () => {
  function pullRequestSlice(): Record<string, unknown> | undefined {
    const slice =
      useCurrentUiStateStore.getState().slices['worktree.pullRequest'];
    return typeof slice === 'object' && slice !== null && !Array.isArray(slice)
      ? slice
      : undefined;
  }

  it('reports Split PR eligibility for an eligible open PR', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    expect(pullRequestSlice()).toEqual({
      gitActionInProgress: false,
      gitActionCancellationRequested: false,
      splitPrEligible: true,
      splitPrInProgress: false,
      splitPrCompleted: false,
      splitWorkflowActive: false,
      splitPrFailureModalOpen: false,
      splitPrInterruptedModalOpen: false,
      splitPrBlockers: [],
    });
  });

  it('reports active and pending-cancellation Git action state', async () => {
    useGitHubStore.setState({
      gitActionOperationIds: { [KEY]: 'operation-1' },
      gitActionCancellationRequested: new Set([KEY]),
    });

    await render();

    expect(pullRequestSlice()).toMatchObject({
      gitActionInProgress: true,
      gitActionCancellationRequested: true,
    });
  });

  it('reports splitWorkflowActive true while the worktree is split-locked', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitLockedWorktrees: new Set<string>([KEY]),
    });

    await render();

    expect(pullRequestSlice()).toMatchObject({
      splitWorkflowActive: true,
    });
  });

  it('reports splitPrBlockers for an eligible-but-blocked worktree', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100, hasConflicts: true }),
        ),
      },
    });
    useProjectsStore.setState({ uncommittedChanges: { [KEY]: true } });

    await render();

    const slice = pullRequestSlice();
    expect(slice).toMatchObject({ splitPrEligible: true });
    // Declaration order on `SplitPrBlocker` is the stable display order
    // `deriveSplitPrReadiness` collects blockers in.
    expect(slice?.splitPrBlockers).toEqual([
      'uncommitted_changes',
      'merge_conflicts',
    ]);
  });

  it('reports in-progress state while a split plan request is in flight', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      planningSplitPr: new Set([KEY]),
    });

    await render();

    expect(pullRequestSlice()).toMatchObject({
      splitPrInProgress: true,
      splitPrCompleted: false,
    });
  });

  it('clears the slice when the section unmounts', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();
    expect(pullRequestSlice()).toBeDefined();

    act(() => {
      root.unmount();
    });
    // Re-create the root so the shared afterEach unmount stays valid.
    root = createRoot(container);

    expect(pullRequestSlice()).toBeUndefined();
  });
});

function makeSnapshot(): PrDiffSnapshot {
  return {
    baseRef: 'base-sha',
    headRef: 'head-sha',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
  };
}

function makeSplitPlanResponse(buildTestCommand: string): SplitPrPlanResponse {
  return {
    plan: {
      finalGoal: 'Split the big PR',
      concerns: [],
      children: [],
      parallelizable: '',
      landOrder: '',
      buildTestCommand,
      unassignedHunks: [],
    },
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

describe('PullRequestSection Split PR approved-plan persistence', () => {
  it('a Retry after remount executes the store-committed edited plan', async () => {
    setGatingPrefs(true, 500);
    // The approved (edited) plan has already been committed to the store by
    // SplitWorkflowView's approve step (via `commitApprovedSplitPlan`); the
    // editable review UI itself now lives only in the locked workflow view,
    // so this PullRequestSection test seeds that committed plan directly and
    // exercises the post-failure Retry overlay path this section still owns.
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
      splitPrPlans: {
        [KEY]: makeSplitPlanResponse('edited-build-command'),
      },
      // The first execution attempt already failed: the backend delivered a
      // terminal error progress event (mirrors `onSplitPrProgress`), so the
      // failed-progress overlay renders with a Retry affordance.
      splitPrProgress: {
        [KEY]: [
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            phase: 'carving_child',
            childIndex: 1,
            childTotal: 1,
          },
          {
            projectId: PROJECT_ID,
            worktreeId: WORKTREE_ID,
            phase: 'error',
            error: 'split failed',
          },
        ],
      },
    });

    await render();

    // The store's plan entry holds the edited plan (not a pre-edit planner
    // response) — this is what makes Retry correct after a worktree switch.
    expect(
      useGitHubStore.getState().splitPrPlans[KEY]?.plan.buildTestCommand,
    ).toBe('edited-build-command');

    // Simulate switching away from and back to this worktree: unmount and
    // remount the component. Component-local state (if any survived) is
    // discarded; only the store should retain the approved plan.
    act(() => {
      root.unmount();
    });
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await render();

    // After remount, the failed-progress overlay should still be visible
    // (progress events persist in the store) with a Retry affordance.
    const retryButton = query('split-progress-retry');
    expect(retryButton).not.toBeNull();
    await act(async () => {
      retryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    // Retry re-enters the LOCKED workflow via `startSplitWorkflow({mode:
    // 'resume'})` (terminates resources, acquires the lock, swaps in the
    // workflow view at Execute), not the old unlocked execute path. It must
    // resume with the store-committed EDITED plan, not the pre-edit planner
    // response, even after the unmount/remount (simulating a worktree switch).
    const committed = useGitHubStore.getState().splitPrPlans[KEY];
    expect(committed).toBeDefined();
    expect(api.github.startSplitWorkflow).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      mode: 'resume',
      plan: committed?.plan,
      snapshot: committed?.snapshot,
    });
    expect(committed?.plan.buildTestCommand).toBe('edited-build-command');
  });
});
