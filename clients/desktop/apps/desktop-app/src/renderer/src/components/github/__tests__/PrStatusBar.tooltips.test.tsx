/**
 * @jest-environment jsdom
 */
import { setTestEarlyAccessFeatures } from '@/test-utils/labsExperiments';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  CheckDetail,
  MergePrResponse,
  PrMergeQueueStatus,
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type {
  SidebarItem,
  SingleRepoSidebarItem,
} from '@canopy/desktop-shared/types';
import { getDefaultFeatureFlagSnapshot } from '@canopy/protocol/feature-flags';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { makeDefaultWorktreeBranchName } from '@canopy/desktop-shared/lib/default-worktree-branch';
import { PrStatusBar } from '../PrStatusBar';
import type { WorktreeBranchTargetPickerProps } from '@/components/home/HomeBranchPicker';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useChatStore } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';

import { useNavigationStore } from '@/stores/navigationStore';
import { useCurrentUiStateStore } from '@/stores/currentUiStateStore';
import { useBaseBranchAlignmentStore } from '@/stores/baseBranchAlignmentStore';
import { __resetSplitPrPreferencesForTests } from '@/hooks/useSplitPrPreferences';
import {
  __resetMergeQueueAgentHandlingForTests,
  useMergeQueueAgentHandlingStore,
} from '@/hooks/useMergeQueueAgentHandling';

// The picker's own behavior is covered by HomeBranchPicker's tests; here it
// is a stub that exposes the props the header hands it.
let mockWorktreeBranchPicker: WorktreeBranchTargetPickerProps | null = null;
jest.mock('@/components/home/HomeBranchPicker', () => ({
  WorktreeBranchTargetPicker: (
    props: WorktreeBranchTargetPickerProps,
  ): JSX.Element | null => {
    mockWorktreeBranchPicker = props;
    return props.open ? <div data-testid={props['data-testid']} /> : null;
  },
}));

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const SECOND_WORKTREE_ID = 'wt-2';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);
const SECOND_KEY = worktreeKey(PROJECT_ID, SECOND_WORKTREE_ID);
const originalMergePr = useGitHubStore.getState().mergePr;
const originalAddToast = useGitHubStore.getState().addToast;
const originalCancelGitAction = useGitHubStore.getState().cancelGitAction;
const originalSelectWorktree = useChatStore.getState().selectWorktree;
const originalSetTrackedBaseBranch =
  useProjectsStore.getState().setTrackedBaseBranch;

function makePrStatus(overrides: Partial<PrStatusData> = {}): PrStatusData {
  return {
    prNumber: 42,
    prUrl: 'https://github.com/example/repo/pull/42',
    state: 'open',
    title: 'Add rich top-bar tooltips',
    body: 'A concise description of the change.',
    checkStatus: 'failing',
    checkDetails: [],
    reviewStatus: 'none',
    reviewers: [],
    hasConflicts: false,
    commentCount: 0,
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWorktreePrStatus(status: PrStatusData): WorktreePrStatus {
  return {
    repos: [{ repoId: 'repo-1', repoName: 'repo', status }],
    lastCheckedAt: '2026-07-01T00:00:00.000Z',
  };
}

function makeSingleRepoProject(
  trackedBaseBranchByWorktreeId: Record<string, string> = {},
): SingleRepoSidebarItem {
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
        branchName: 'feature/tooltips',
        createdAt: '2026-07-01T00:00:00.000Z',
        ...(trackedBaseBranchByWorktreeId[WORKTREE_ID]
          ? { trackedBaseBranch: trackedBaseBranchByWorktreeId[WORKTREE_ID] }
          : {}),
      },
      {
        id: SECOND_WORKTREE_ID,
        branchName: 'feature/other-worktree',
        createdAt: '2026-07-02T00:00:00.000Z',
        ...(trackedBaseBranchByWorktreeId[SECOND_WORKTREE_ID]
          ? {
              trackedBaseBranch:
                trackedBaseBranchByWorktreeId[SECOND_WORKTREE_ID],
            }
          : {}),
      },
    ],
  };
}

function makeMultiRepoProject(
  trackedRepoBaseBranches?: Record<string, string>,
): SidebarItem {
  return {
    type: 'multi-repo',
    id: PROJECT_ID,
    name: 'Workspace One',
    color: 'blue',
    collapsed: false,
    order: 0,
    repos: [
      {
        id: 'repo-1',
        name: 'app',
        repoPath: '/workspace/app',
        source: 'manifest',
      },
      {
        id: 'repo-2',
        name: 'docs',
        repoPath: '/workspace/docs',
        source: 'local',
      },
    ],
    worktrees: [
      {
        id: WORKTREE_ID,
        branchName: 'feature/tooltips',
        createdAt: '2026-07-01T00:00:00.000Z',
        ...(trackedRepoBaseBranches ? { trackedRepoBaseBranches } : {}),
      },
    ],
  };
}

function makeOneRepoMultiRepoProject(
  trackedRepoBaseBranches?: Record<string, string>,
): SidebarItem {
  const project = makeMultiRepoProject(trackedRepoBaseBranches);
  if (project.type !== 'multi-repo') {
    throw new Error('Expected a multi-repo project fixture.');
  }
  return { ...project, repos: project.repos.slice(0, 1) };
}

function installWindowApiMock(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      detectApps: jest.fn().mockResolvedValue([]),
      // The store persists an explicit tracked base through this targeted
      // channel rather than the wholesale `saveProjects()` snapshot.
      setTrackedBaseBranch: jest.fn().mockResolvedValue(undefined),
      loadPreferences: jest.fn().mockResolvedValue({ lastOpenApp: '' }),
      savePreferences: jest.fn().mockResolvedValue(undefined),
      openInApp: jest.fn().mockResolvedValue(undefined),
    },
  });
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  installWindowApiMock();
  __resetSplitPrPreferencesForTests();
  __resetMergeQueueAgentHandlingForTests();
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useGitHubStore.setState({
    mergePr: originalMergePr,
    addToast: originalAddToast,
    cancelGitAction: originalCancelGitAction,
    prStatuses: {},
    creatingPr: new Set<string>(),
    creationProgress: {},
    committingAndPushing: new Set<string>(),
    mergingLocalBranches: new Set<string>(),
    mergingPr: new Set<string>(),
    gitStatsRefreshing: new Set<string>(),
    gitActionOperationIds: {},
    gitActionCancellationRequested: new Set<string>(),
    activeBranchSyncAction: {},
    commitPushProgress: {},
    commitReviewPending: {},
    prMergeWarnings: {},
    toasts: [],
    notifications: [],
  });
  useProjectsStore.setState({
    setTrackedBaseBranch: originalSetTrackedBaseBranch,
    projects: [makeSingleRepoProject()],
    diffStats: {},
    uncommittedChanges: {},
    hasUnpushedCommits: {},
    hasUnpulledCommits: {},
    hasRemoteTracking: {},
    hasOriginRemote: {},
    hasBranchBeenPushed: {},
    baseBranchExistsLocally: {},
    baseBranchExistsInRemote: {},
    commitsAhead: {},
    baseBranches: {},
    repoBranches: {},
  });
  usePipelineRunsStore.setState({
    runningExecutionsByWorktree: {},
    pausedExecutionsByWorktree: {},
  });
  useChatStore.setState({
    worktreeChats: {},
    selectedWorktree: null,
    selectWorktree: originalSelectWorktree,
  });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  useActivityStore.setState({ splitPreflight: null });
  useCurrentUiStateStore.setState({ revision: 0, slices: {} });
  setTestEarlyAccessFeatures({ enabled: false });
  useBaseBranchAlignmentStore.getState().resolveConfirmation(false);
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

async function render(worktreeId = WORKTREE_ID): Promise<void> {
  await act(async () => {
    root.render(
      <PrStatusBar
        projectId={PROJECT_ID}
        worktreeId={worktreeId}
        viewMode="list"
        viewModeReady
      />,
    );
    await Promise.resolve();
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise resolver was not initialized');
  };
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

// React derives onMouseEnter from native mouseover; dispatch the native event so
// the synthetic handler fires in this createRoot harness.
async function hover(element: Element): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    await Promise.resolve();
  });
}

const CHECKS: CheckDetail[] = [
  {
    name: 'build',
    status: 'failing',
    detailsUrl: 'https://ci.example/build',
  },
  { name: 'unit-tests', status: 'passing', detailsUrl: null },
  {
    name: 'lint',
    status: 'pending',
    detailsUrl: 'https://ci.example/lint',
  },
];

describe('PrStatusBar rich top-bar tooltips', () => {
  it('shows commit-only progress for an active remote-backed commit', async () => {
    useGitHubStore.setState({
      committingAndPushing: new Set([KEY]),
      activeBranchSyncAction: { [KEY]: 'commit' },
      commitPushProgress: {
        [KEY]: { steps: [], currentPhase: 'committing' },
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
      hasOriginRemote: { [KEY]: true },
    });
    await render();

    const commitButton = query('pr-status-bar-local-commit');
    // The running action keeps its own label and swaps only the leading icon
    // for the spinner, so the control the user clicked never renames itself
    // mid-flight. Progress detail belongs in the tooltip, asserted below.
    expect(commitButton?.textContent?.trim()).toBe('Commit');
    expect(
      commitButton?.querySelector('[aria-label="Thinking"]'),
    ).not.toBeNull();
    if (!commitButton) {
      throw new Error('Expected the local commit progress button.');
    }

    await hover(commitButton);
    const tooltip =
      document.body.querySelector<HTMLElement>('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('Generating message');
    expect(tooltip?.textContent).toContain('Staging');
    expect(tooltip?.textContent).toContain('Committing');
  });

  it('offers a real ✕ button over a running action, but never while refreshing', async () => {
    // The ✕ takes over the running action's spinner slot and is its OWN
    // button — own hover state, own tooltip, own accessible name — rendered as
    // a SIBLING of the action button rather than a child, since interactive
    // descendants inside a <button> are invalid and the click would bubble.
    // The action button underneath also cancels, so it must stay ENABLED.
    const cancelGitAction = jest.fn().mockResolvedValue(undefined);
    useGitHubStore.setState({
      cancelGitAction,
      committingAndPushing: new Set([KEY]),
      activeBranchSyncAction: { [KEY]: 'commit-and-push' },
      gitActionOperationIds: { [KEY]: 'operation-1' },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
      hasOriginRemote: { [KEY]: true },
    });
    await render();

    const cancelButton = query('pr-status-bar-cancel-git-action');
    expect(cancelButton).not.toBeNull();
    // A sibling of the action button, never a child: interactive descendants
    // inside a <button> are invalid markup, and the click would bubble into
    // the action. `closest('button')` is the structural check — a nested ✕
    // would find its enclosing action button here.
    // From the PARENT up — `closest` would otherwise match the ✕ itself.
    expect(cancelButton?.parentElement?.closest('button')).toBeNull();
    const runningAction = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label^="Cancel "]',
    );
    expect(runningAction?.disabled).toBe(false);
    await act(async () => {
      cancelButton?.click();
      await Promise.resolve();
    });
    expect(cancelGitAction).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(cancelGitAction).toHaveBeenCalledTimes(1);

    // A stats refresh is already finishing the action off, so cancellation
    // stops being offered — same rule the old ✕ pill's visibility had.
    act(() => {
      useGitHubStore.setState({ gitStatsRefreshing: new Set([KEY]) });
    });
    expect(query('pr-status-bar-cancel-git-action')).toBeNull();
  });

  it('stops offering cancellation once one has been requested', async () => {
    // Second click would be a no-op, so the ✕ never appears and the slot keeps
    // spinning.
    useGitHubStore.setState({
      committingAndPushing: new Set([KEY]),
      activeBranchSyncAction: { [KEY]: 'commit-and-push' },
      gitActionOperationIds: { [KEY]: 'operation-1' },
      gitActionCancellationRequested: new Set([KEY]),
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
      hasOriginRemote: { [KEY]: true },
    });
    await render();

    expect(query('pr-status-bar-cancel-git-action')).toBeNull();
  });

  it('carries merged state in the PR badge glyph colour', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ state: 'merged' })),
      },
    });
    await render();

    // The badge lost its tinted pill: state now reads from the leading glyph,
    // and `#42` stays fg-primary so the number itself is legible.
    const badge = document.body.querySelector('a[href$="/pull/42"]');
    expect(badge?.classList.contains('fg-primary')).toBe(true);
    expect(badge?.querySelector('.fg-special-strong')).not.toBeNull();
  });

  it('uses the accent action color for the Merge PR action', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 0,
          }),
        ),
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton).not.toBeNull();
    // Merge is an action, so it takes the accent ink of the other primary git
    // actions; the merged purple read as "already merged".
    expect(mergeButton?.classList.contains('fg-accent')).toBe(true);
    expect(mergeButton?.classList.contains('fg-special-strong')).toBe(false);
    expect(mergeButton?.classList.contains('bg-special')).toBe(false);
  });

  it('replaces Merge with a merge queue status while the PR is queued', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 0,
            mergeQueue: { required: true, inQueue: true, position: 2 },
          }),
        ),
      },
    });
    await render();

    expect(query('pr-status-bar-merge-pr')).toBeNull();
    const queued = query('pr-status-bar-merge-queue');
    expect(queued?.textContent).toBe('Queued·#2');
    expect(queued?.tagName).toBe('BUTTON');
    expect(queued?.getAttribute('aria-haspopup')).toBe('dialog');
    expect(queued?.getAttribute('aria-expanded')).toBe('false');
    expect(queued?.classList.contains('fg-warning')).toBe(true);
    // The position goes with the PR badges when the header narrows.
    expect(query('pr-status-bar-merge-queue-position')?.className).toContain(
      'hidden @[420px]/topbar:inline-flex',
    );
    // The PR badge keeps the GitHub link.
    expect(document.body.querySelector('a[href$="/pull/42"]')).not.toBeNull();
  });

  it('shows the estimate and counts it down between polls', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    try {
      const observedAt = Date.now();
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({
              checkStatus: 'passing',
              mergeQueue: {
                required: true,
                inQueue: true,
                position: 3,
                phase: 'queued',
                estimatedSecondsToMerge: 19 * 60,
                observedAt: new Date(observedAt).toISOString(),
              },
            }),
          ),
        },
      });
      await render();
      expect(query('pr-status-bar-merge-queue')?.textContent).toBe(
        'Queued·#3·~19 min',
      );
      await act(async () => {
        jest.advanceTimersByTime(5 * 60_000);
        await Promise.resolve();
      });
      expect(query('pr-status-bar-merge-queue-eta')?.textContent).toBe(
        '~14 min',
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('labels a pull request in the merge group as testing and a locked one as merging', async () => {
    const queuedStatus = (phase: 'awaiting_checks' | 'locked'): PrStatusData =>
      makePrStatus({
        checkStatus: 'passing',
        mergeQueue: {
          required: true,
          inQueue: true,
          position: 1,
          phase,
          estimatedSecondsToMerge: 11 * 60,
          observedAt: new Date().toISOString(),
        },
      });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(queuedStatus('awaiting_checks')),
      },
    });
    await render();
    expect(query('pr-status-bar-merge-queue')?.textContent).toBe(
      'Testing·~11 min',
    );

    await act(async () => {
      useGitHubStore.setState({
        prStatuses: { [KEY]: makeWorktreePrStatus(queuedStatus('locked')) },
      });
      await Promise.resolve();
    });
    const merging = query('pr-status-bar-merge-queue');
    expect(merging?.textContent).toBe('Merging now');
    expect(merging?.classList.contains('fg-special-strong')).toBe(true);
  });

  it('omits the queue position when GitHub reports none', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'pending',
            mergeQueue: { required: true, inQueue: true, position: null },
          }),
        ),
      },
    });
    await render();

    expect(query('pr-status-bar-merge-queue')?.textContent).toBe('Queued');
  });

  it('opens the queue list from the label and reads it only while open', async () => {
    const getMergeQueue = jest.fn().mockResolvedValue({
      queue: {
        url: 'https://github.com/example/repo/queue/main',
        baseBranch: 'main',
        totalCount: 2,
        maximumEntriesToBuild: 2,
        fetchedAt: new Date().toISOString(),
        entries: [
          {
            position: 1,
            phase: 'awaiting_checks',
            estimatedSecondsToMerge: 240,
            enqueuedAt: null,
            pullRequest: {
              number: 7,
              title: 'Earlier change',
              url: 'https://github.com/example/repo/pull/7',
              author: 'mara-k',
            },
          },
          {
            position: 2,
            phase: 'queued',
            estimatedSecondsToMerge: 480,
            enqueuedAt: null,
            pullRequest: {
              number: 42,
              title: 'Add rich top-bar tooltips',
              url: 'https://github.com/example/repo/pull/42',
              author: 'sam-lee',
            },
          },
        ],
      },
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, github: { getMergeQueue } },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            baseRefName: 'main',
            mergeQueue: { required: true, inQueue: true, position: 2 },
          }),
        ),
      },
    });
    await render();
    expect(getMergeQueue).not.toHaveBeenCalled();

    const trigger = query('pr-status-bar-merge-queue');
    await act(async () => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(getMergeQueue).toHaveBeenCalledWith({
      repository: 'example/repo',
      baseBranch: 'main',
    });
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
    const popover = query('pr-status-bar-merge-queue-popover');
    expect(popover?.getAttribute('role')).toBe('dialog');
    expect(popover?.getAttribute('aria-label')).toBe('Merge queue');
    const rows = Array.from(
      popover?.querySelectorAll('[data-testid="merge-queue-popover-row"]') ??
        [],
    );
    expect(rows.map((row) => row.getAttribute('data-pr-number'))).toEqual([
      '7',
      '42',
    ]);
    expect(rows[1]?.getAttribute('aria-current')).toBe('true');
    expect(rows[1]?.textContent).toContain('This pull request');
    // The open list is newer than the poll, so the label follows it.
    expect(query('pr-status-bar-merge-queue-eta')?.textContent).toBe('~8 min');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.mergeQueuePopover,
    ).toEqual({
      open: true,
      repoCount: 1,
      phase: 'queued',
      position: 2,
      etaMinutes: 8,
      queueLength: 2,
    });

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
      await Promise.resolve();
    });
    expect(query('pr-status-bar-merge-queue-popover')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  describe('after the queue list closes', () => {
    /** The base branch's queue with this PR third, ~8 min out, read now. */
    function mockQueueWithPrThird(): void {
      const getMergeQueue = jest.fn().mockResolvedValue({
        queue: {
          url: 'https://github.com/example/repo/queue/main',
          baseBranch: 'main',
          totalCount: 3,
          maximumEntriesToBuild: 2,
          fetchedAt: new Date().toISOString(),
          entries: [
            {
              position: 3,
              phase: 'queued',
              estimatedSecondsToMerge: 480,
              enqueuedAt: null,
              pullRequest: {
                number: 42,
                title: 'Add rich top-bar tooltips',
                url: 'https://github.com/example/repo/pull/42',
                author: 'sam-lee',
              },
            },
          ],
        },
      });
      Object.defineProperty(window, 'api', {
        configurable: true,
        value: { ...window.api, github: { getMergeQueue } },
      });
    }

    function queuedPoll(mergeQueue: PrMergeQueueStatus): WorktreePrStatus {
      return makeWorktreePrStatus(
        makePrStatus({
          checkStatus: 'passing',
          baseRefName: 'main',
          mergeQueue,
        }),
      );
    }

    async function openAndCloseQueueList(): Promise<void> {
      const trigger = query('pr-status-bar-merge-queue');
      await act(async () => {
        trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        await Promise.resolve();
      });
      expect(query('pr-status-bar-merge-queue-eta')?.textContent).toBe(
        '~8 min',
      );
      await act(async () => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
        );
        await Promise.resolve();
      });
      expect(query('pr-status-bar-merge-queue-popover')).toBeNull();
    }

    it('follows a newer poll without an estimate over the last queue list', async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        mockQueueWithPrThird();
        useGitHubStore.setState({
          prStatuses: {
            [KEY]: queuedPoll({
              required: true,
              inQueue: true,
              position: 5,
              phase: 'queued',
              observedAt: new Date(Date.now() - 60_000).toISOString(),
            }),
          },
        });
        await render();
        await openAndCloseQueueList();

        await act(async () => {
          jest.advanceTimersByTime(30_000);
          useGitHubStore.setState({
            prStatuses: {
              [KEY]: queuedPoll({
                required: true,
                inQueue: true,
                position: 1,
                phase: 'awaiting_checks',
                observedAt: new Date().toISOString(),
              }),
            },
          });
          await Promise.resolve();
        });
        expect(query('pr-status-bar-merge-queue')?.textContent).toBe('Testing');
      } finally {
        jest.useRealTimers();
      }
    });

    it("keeps counting down the queue list's estimate on the label", async () => {
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
      try {
        mockQueueWithPrThird();
        // The poll has no estimate, so the one on screen is the list's.
        useGitHubStore.setState({
          prStatuses: {
            [KEY]: queuedPoll({
              required: true,
              inQueue: true,
              position: 3,
              phase: 'queued',
              observedAt: new Date(Date.now() - 60_000).toISOString(),
            }),
          },
        });
        await render();
        await openAndCloseQueueList();

        await act(async () => {
          jest.advanceTimersByTime(3 * 60_000);
          await Promise.resolve();
        });
        expect(query('pr-status-bar-merge-queue-eta')?.textContent).toBe(
          '~5 min',
        );
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('shows no merge queue status when only some open PRs are queued', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'repo',
              status: makePrStatus({
                mergeQueue: { required: true, inQueue: true, position: 1 },
              }),
            },
            {
              repoId: 'repo-2',
              repoName: 'other',
              status: makePrStatus({ prNumber: 43, checkStatus: 'pending' }),
            },
          ],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    await render();

    expect(query('pr-status-bar-merge-queue')).toBeNull();
  });

  it('lets merge conflicts take precedence over the merge queue status', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            hasConflicts: true,
            mergeQueue: { required: true, inQueue: true, position: 1 },
          }),
        ),
      },
    });
    await render();

    expect(query('pr-status-bar-merge-queue')).toBeNull();
  });

  it('keeps Merge for a queue-required PR that is not queued yet', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 0,
            mergeQueue: { required: true, inQueue: false },
          }),
        ),
      },
    });
    await render();

    expect(query('pr-status-bar-merge-pr')).not.toBeNull();
    expect(query('pr-status-bar-merge-queue')).toBeNull();
  });

  it('marks Merge as chat-driven when the base branch uses a merge queue', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 0,
            mergeQueue: { required: true, inQueue: false },
          }),
        ),
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton?.getAttribute('data-merge-via')).toBe('chat');
    expect(mergeButton?.textContent).toBe('Merge');
    // Same tint as a direct merge; only the glyph and the help change.
    expect(mergeButton?.classList.contains('fg-accent')).toBe(true);
    if (mergeButton) await hover(mergeButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Start a chat that adds this pull request to the merge queue and watches it until it merges',
    );
  });

  it.each([
    ['is not required', { required: false, inQueue: false }],
    ['is unknown', undefined],
  ])(
    'keeps the direct Merge treatment when a merge queue %s',
    async (_label, mergeQueue) => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({
              checkStatus: 'passing',
              reviewStatus: 'approved',
              unresolvedReviewThreadCount: 0,
              ...(mergeQueue ? { mergeQueue } : {}),
            }),
          ),
        },
      });
      await render();

      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton?.getAttribute('data-merge-via')).toBe('direct');
      if (mergeButton) await hover(mergeButton);
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Merge the pull request',
      );
    },
  );

  describe('merge queue agent handling setting', () => {
    const readyQueuePr = makePrStatus({
      checkStatus: 'passing',
      reviewStatus: 'approved',
      unresolvedReviewThreadCount: 0,
      mergeQueue: { required: true, inQueue: false },
    });
    const QUEUE_REMOVED_HOOK = {
      'pr:queue:removed': [{ type: 'command', command: 'echo requeue' }],
    };

    function setQueueRemovedHook(paused = false): void {
      const project = makeSingleRepoProject();
      if (project.type !== 'single-repo') {
        throw new Error('Expected a single-repo project fixture.');
      }
      useProjectsStore.setState({
        projects: [
          {
            ...project,
            effectiveHooks: QUEUE_REMOVED_HOOK,
            worktrees: project.worktrees.map((worktree) =>
              worktree.id === WORKTREE_ID && paused
                ? { ...worktree, pausedHookKeys: ['project:pr:queue:removed'] }
                : worktree,
            ),
          } as SidebarItem,
        ],
        appliedProjectWorktreeHooks: {},
      });
    }

    async function expectMergeButton(via: string, help: string): Promise<void> {
      await render();
      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton?.getAttribute('data-merge-via')).toBe(via);
      expect(mergeButton?.textContent).toBe('Merge');
      if (mergeButton) await hover(mergeButton);
      expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
        help,
      );
    }

    function seedHandling(handling: string): void {
      // The status bar loads the saved setting once on mount.
      jest.mocked(window.api.loadPreferences).mockResolvedValue({
        lastOpenApp: '',
        mergeQueueAgentHandling: handling,
      } as never);
    }

    beforeEach(() => {
      useGitHubStore.setState({
        prStatuses: { [KEY]: makeWorktreePrStatus(readyQueuePr) },
      });
    });

    it('enters the merge queue directly when set to Never', async () => {
      seedHandling('never');
      await expectMergeButton(
        'queue',
        'Add this pull request to the merge queue',
      );
    });

    it('enters the merge queue directly when the project hook would run', async () => {
      setQueueRemovedHook();
      await expectMergeButton(
        'queue',
        'Add this pull request to the merge queue',
      );
    });

    it('starts a chat when the project hook is paused in the worktree', async () => {
      setQueueRemovedHook(true);
      await expectMergeButton(
        'chat',
        'Start a chat that adds this pull request to the merge queue and watches it until it merges',
      );
    });

    it('starts a chat despite the project hook when set to Always', async () => {
      setQueueRemovedHook();
      seedHandling('always');
      await expectMergeButton(
        'chat',
        'Start a chat that adds this pull request to the merge queue and watches it until it merges',
      );
    });

    it('updates the button when the setting changes', async () => {
      await render();
      expect(
        query('pr-status-bar-merge-pr')?.getAttribute('data-merge-via'),
      ).toBe('chat');
      await act(async () => {
        useMergeQueueAgentHandlingStore.setState({ handling: 'never' });
        await Promise.resolve();
      });
      expect(
        query('pr-status-bar-merge-pr')?.getAttribute('data-merge-via'),
      ).toBe('queue');
    });
  });

  it('keeps the unresolved-comments warning on a chat-driven Merge', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 2,
            mergeQueue: { required: true, inQueue: false },
          }),
        ),
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton?.getAttribute('data-merge-via')).toBe('chat');
    expect(mergeButton?.classList.contains('fg-warning')).toBe(true);
    if (mergeButton) await hover(mergeButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'This PR has unresolved comments or an unknown review thread state',
    );
  });

  it('marks Merge as chat-driven when any mergeable PR uses a merge queue', async () => {
    const ready = {
      checkStatus: 'passing',
      reviewStatus: 'approved',
      unresolvedReviewThreadCount: 0,
    } as const;
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'repo',
              status: makePrStatus({ ...ready }),
            },
            {
              repoId: 'repo-2',
              repoName: 'other',
              status: makePrStatus({
                ...ready,
                prNumber: 43,
                mergeQueue: { required: true, inQueue: false },
              }),
            },
          ],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton?.getAttribute('data-merge-via')).toBe('chat');
    if (mergeButton) await hover(mergeButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Merge the pull requests. A chat handles any that use a merge queue',
    );
  });

  describe('Merge progress checklist', () => {
    const ready = {
      checkStatus: 'passing',
      reviewStatus: 'approved',
      unresolvedReviewThreadCount: 0,
    } as const;
    const queued = { required: true, inQueue: false } as const;
    const mergingState = {
      mergingPr: new Set([KEY]),
      mergePrProgress: {
        [KEY]: {
          steps: [{ phase: 'queued' as const, timestamp: 1 }],
          currentPhase: 'queued' as const,
        },
      },
    };

    async function hoverMerge(): Promise<string> {
      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton).not.toBeNull();
      if (mergeButton) await hover(mergeButton);
      return document.body.textContent ?? '';
    }

    it('lists the direct merge steps while a direct merge runs', async () => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: makeWorktreePrStatus(makePrStatus({ ...ready })),
        },
      });
      await render();

      expect(await hoverMerge()).toContain('Merging pull request');
    });

    // The steps describe a GitHub API merge. A merge queue hands the whole
    // merge to a chat, so that chat is the only progress surface.
    it('stays hidden while Merge hands off to a merge queue chat', async () => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ ...ready, mergeQueue: queued }),
          ),
        },
      });
      await render();

      const text = await hoverMerge();
      expect(text).not.toContain('Checking mergeability');
      expect(text).not.toContain('Merging pull request');
      expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    });

    // Starting the chat takes a few seconds and cannot be cancelled, so the
    // spinner holds the glyph's slot (it must not yield to a hover ✕) and
    // the button waits disabled.
    it('holds a spinner on a disabled Merge while the chat starts', async () => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ ...ready, mergeQueue: queued }),
          ),
        },
      });
      await render();

      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton?.hasAttribute('disabled')).toBe(true);
      expect(mergeButton?.getAttribute('aria-label')).toBeNull();
      expect(mergeButton?.getAttribute('aria-busy')).toBe('true');
      // The chat glyph gives way to the spinner, which stays put on hover.
      expect(mergeButton?.querySelector('span.h-3.w-3 > *')).not.toBeNull();
      expect(mergeButton?.innerHTML).not.toContain(
        'group-hover/gitaction:hidden',
      );
      expect(query('pr-status-bar-cancel-git-action')).toBeNull();
    });

    // `fg-emphasis` is white, the ink for a filled button. Merge is a tinted
    // ghost button, so its spinner takes the label's ink to stay visible.
    it.each([
      ['a chat-driven', queued],
      ['a direct', undefined],
    ])('draws the spinner in the label ink for %s merge', async (_l, mq) => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ ...ready, ...(mq ? { mergeQueue: mq } : {}) }),
          ),
        },
      });
      await render();

      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton?.querySelector('span.h-3.w-3 > *')).not.toBeNull();
      expect(mergeButton?.innerHTML).not.toContain('fg-emphasis');
    });

    it('keeps a direct merge cancellable while it runs', async () => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: makeWorktreePrStatus(makePrStatus({ ...ready })),
        },
      });
      await render();

      const mergeButton = query('pr-status-bar-merge-pr');
      expect(mergeButton?.hasAttribute('disabled')).toBe(false);
      expect(mergeButton?.getAttribute('aria-label')).toBe('Cancel merge');
      expect(mergeButton?.innerHTML).toContain('group-hover/gitaction:hidden');
      expect(query('pr-status-bar-cancel-git-action')).not.toBeNull();
    });

    it('still lists the steps when another repo merges directly', async () => {
      useGitHubStore.setState({
        ...mergingState,
        prStatuses: {
          [KEY]: {
            repos: [
              {
                repoId: 'repo-1',
                repoName: 'repo',
                status: makePrStatus({ ...ready }),
              },
              {
                repoId: 'repo-2',
                repoName: 'other',
                status: makePrStatus({
                  ...ready,
                  prNumber: 43,
                  mergeQueue: queued,
                }),
              },
            ],
            lastCheckedAt: '2026-07-01T00:00:00.000Z',
          },
        },
      });
      await render();

      expect(await hoverMerge()).toContain('Merging pull request');
    });
  });

  it('inks Commit & Push with the accent color on a ghost shell', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkStatus: 'passing' })),
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
    });
    await render();

    const branchSync = query('pr-status-bar-branch-sync');
    expect(branchSync).not.toBeNull();
    expect(branchSync?.textContent).toContain('Commit & push');
    expect(branchSync?.classList.contains('fg-accent')).toBe(true);
    // Ghost shell: the accent lives in the ink, never in a filled body.
    expect(branchSync?.classList.contains('bg-accent')).toBe(false);
    expect(branchSync?.classList.contains('fg-primary')).toBe(false);
  });

  it('inks Create PR with the same accent color on a ghost shell', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [{ repoId: 'repo-1', repoName: 'repo', status: null }],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
      hasOriginRemote: { [KEY]: true },
    });
    await render();

    const createPr = query('pr-status-bar-primary-action');
    expect(createPr?.textContent).toContain('Create PR');
    expect(createPr?.classList.contains('fg-accent')).toBe(true);
    expect(createPr?.classList.contains('bg-accent')).toBe(false);
  });

  it('disables conflicting Git actions while a PR merge is active', async () => {
    useGitHubStore.setState({
      mergingPr: new Set([KEY]),
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            unresolvedReviewThreadCount: 0,
          }),
        ),
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
    });
    await render();

    const commitButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Commit & push'));
    expect(commitButton?.disabled).toBe(true);
  });

  it('does not show an idle local Commit button for a remote-backed repo', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [{ repoId: 'repo-1', repoName: 'repo', status: null }],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    useProjectsStore.setState({
      uncommittedChanges: { [KEY]: true },
      hasRemoteTracking: { [KEY]: true },
      hasOriginRemote: { [KEY]: true },
    });
    await render();

    expect(query('pr-status-bar-local-commit')).toBeNull();
    // The single primary action covers commit + push here. Its VISIBLE copy
    // stays short for the header cluster, so the full action is asserted on
    // the accessible name instead.
    const primaryAction = query('pr-status-bar-primary-action');
    expect(primaryAction?.textContent).toContain('Create PR');
    expect(primaryAction?.getAttribute('aria-label')).toBe(
      'Commit, push & create PR',
    );
  });

  it('hands delayed unresolved-comment confirmation back to its originating worktree', async () => {
    const pendingMerge = deferred<MergePrResponse | null>();
    const mergePr = jest
      .fn()
      .mockReturnValueOnce(pendingMerge.promise)
      .mockResolvedValueOnce({
        dryRun: true,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 43,
            prUrl: 'https://github.com/example/repo/pull/43',
            unresolvedReviewThreadCount: 1,
          },
        ],
        failedRepos: [],
      })
      .mockResolvedValue(null);
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    const selectWorktree = jest.fn(
      (projectId: string, worktreeId: string): void => {
        useChatStore.setState({
          selectedWorktree: { projectId, worktreeId },
        });
      },
    );
    useGitHubStore.setState({
      mergePr,
      addToast,
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
      selectWorktree,
    });
    await render();

    await act(async () => {
      query('pr-status-bar-merge-pr')?.click();
      await Promise.resolve();
    });

    act(() => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: PROJECT_ID,
          worktreeId: SECOND_WORKTREE_ID,
        },
      });
    });
    await render(SECOND_WORKTREE_ID);

    await act(async () => {
      pendingMerge.resolve({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
      await pendingMerge.promise;
    });

    expect(query('pr-merge-warning-modal')).toBeNull();
    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('merge needs confirmation'),
      'warning',
      expect.any(Function),
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );
    const openFromToast = addToast.mock.calls[0]?.[2];

    await act(async () => {
      openFromToast?.();
      await Promise.resolve();
    });
    expect(selectWorktree).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(mergePr).toHaveBeenNthCalledWith(2, PROJECT_ID, WORKTREE_ID, {
      repoIds: undefined,
      confirmUnresolvedComments: false,
      dryRun: true,
    });
    expect(useGitHubStore.getState().prMergeWarnings[KEY]?.prUrl).toBe(
      'https://github.com/example/repo/pull/43',
    );
    await render();

    expect(query('pr-merge-warning-modal')).not.toBeNull();
    await act(async () => {
      query('pr-merge-warning-confirm')?.click();
      await Promise.resolve();
    });
    expect(mergePr).toHaveBeenLastCalledWith(PROJECT_ID, WORKTREE_ID, {
      repoIds: undefined,
      confirmUnresolvedComments: true,
    });

    act(() => {
      useGitHubStore.getState().openPrMergeWarning({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoIds: undefined,
        prUrl: 'https://github.com/example/repo/pull/42',
        unresolvedReviewThreadCount: 2,
      });
      useChatStore.setState({
        selectedWorktree: {
          projectId: PROJECT_ID,
          worktreeId: SECOND_WORKTREE_ID,
        },
      });
    });
    await render(SECOND_WORKTREE_ID);
    expect(query('pr-merge-warning-modal')).toBeNull();
    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();

    await render();
    expect(query('pr-merge-warning-modal')).toBeNull();
  });

  it('toasts a delayed confirmation when the originating top bar is unmounted', async () => {
    const pendingMerge = deferred<MergePrResponse | null>();
    const mergePr = jest
      .fn()
      .mockReturnValueOnce(pendingMerge.promise)
      .mockResolvedValueOnce({
        dryRun: true,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 43,
            prUrl: 'https://github.com/example/repo/pull/43',
            unresolvedReviewThreadCount: 1,
          },
        ],
        failedRepos: [],
      });
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    const selectWorktree = jest.fn(
      (projectId: string, worktreeId: string): void => {
        useChatStore.setState({
          selectedWorktree: { projectId, worktreeId },
        });
      },
    );
    useGitHubStore.setState({
      mergePr,
      addToast,
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
      selectWorktree,
    });
    await render();

    await act(async () => {
      query('pr-status-bar-merge-pr')?.click();
      await Promise.resolve();
    });
    act(() => {
      root.render(<></>);
    });

    await act(async () => {
      pendingMerge.resolve({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
      await pendingMerge.promise;
    });

    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('merge needs confirmation'),
      'warning',
      expect.any(Function),
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );

    const openFromToast = addToast.mock.calls[0]?.[2];
    await act(async () => {
      openFromToast?.();
      await Promise.resolve();
    });

    expect(selectWorktree).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);
    expect(mergePr).toHaveBeenNthCalledWith(2, PROJECT_ID, WORKTREE_ID, {
      repoIds: undefined,
      confirmUnresolvedComments: false,
      dryRun: true,
    });
    expect(useGitHubStore.getState().prMergeWarnings[KEY]?.prUrl).toBe(
      'https://github.com/example/repo/pull/43',
    );
    expect(addToast).toHaveBeenCalledTimes(1);

    await render();
    expect(query('pr-merge-warning-modal')).not.toBeNull();
  });

  it('discards toast re-verification when the selected worktree changes', async () => {
    const pendingRefresh = deferred<MergePrResponse | null>();
    const mergePr = jest
      .fn()
      .mockResolvedValueOnce({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      })
      .mockReturnValueOnce(pendingRefresh.promise);
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    const selectWorktree = jest.fn(
      (projectId: string, worktreeId: string): void => {
        useChatStore.setState({
          selectedWorktree: { projectId, worktreeId },
        });
      },
    );
    useGitHubStore.setState({
      mergePr,
      addToast,
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: SECOND_WORKTREE_ID,
      },
      selectWorktree,
    });
    await render();

    await act(async () => {
      query('pr-status-bar-merge-pr')?.click();
      await Promise.resolve();
    });

    const openFromToast = addToast.mock.calls[0]?.[2];
    await act(async () => {
      openFromToast?.();
      await Promise.resolve();
    });
    expect(selectWorktree).toHaveBeenCalledWith(PROJECT_ID, WORKTREE_ID);

    act(() => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: PROJECT_ID,
          worktreeId: SECOND_WORKTREE_ID,
        },
      });
    });

    await act(async () => {
      pendingRefresh.resolve({
        dryRun: true,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 43,
            prUrl: 'https://github.com/example/repo/pull/43',
            unresolvedReviewThreadCount: 1,
          },
        ],
        failedRepos: [],
      });
      await pendingRefresh.promise;
    });

    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();
  });

  it('shows a delayed confirmation while the top bar is visible on kanban', async () => {
    const pendingMerge = deferred<MergePrResponse | null>();
    const mergePr = jest.fn().mockReturnValueOnce(pendingMerge.promise);
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    useGitHubStore.setState({
      mergePr,
      addToast,
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });
    useNavigationStore.setState({ activePage: 'kanban' });
    await render();

    await act(async () => {
      query('pr-status-bar-merge-pr')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      pendingMerge.resolve({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
      await pendingMerge.promise;
    });

    expect(query('pr-merge-warning-modal')).not.toBeNull();
    expect(addToast).not.toHaveBeenCalled();
  });

  it('routes a delayed confirmation through a toast while Settings is open', async () => {
    const pendingMerge = deferred<MergePrResponse | null>();
    const mergePr = jest
      .fn()
      .mockReturnValueOnce(pendingMerge.promise)
      .mockResolvedValueOnce({
        dryRun: true,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    const selectWorktree = jest.fn(
      (projectId: string, worktreeId: string): void => {
        useChatStore.setState({
          selectedWorktree: { projectId, worktreeId },
        });
      },
    );
    useGitHubStore.setState({
      mergePr,
      addToast,
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
      selectWorktree,
    });
    await render();

    await act(async () => {
      query('pr-status-bar-merge-pr')?.click();
      await Promise.resolve();
    });
    act(() => {
      useNavigationStore.setState({ settingsOpen: true });
    });

    await act(async () => {
      pendingMerge.resolve({
        dryRun: false,
        verifiedRepos: [],
        mergedRepos: [],
        requiresUnresolvedConfirmation: [
          {
            repoId: 'repo-1',
            repoName: 'repo',
            prNumber: 42,
            prUrl: 'https://github.com/example/repo/pull/42',
            unresolvedReviewThreadCount: 2,
          },
        ],
        failedRepos: [],
      });
      await pendingMerge.promise;
    });

    expect(query('pr-merge-warning-modal')).toBeNull();
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('merge needs confirmation'),
      'warning',
      expect.any(Function),
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      }),
    );

    const openFromToast = addToast.mock.calls[0]?.[2];
    await act(async () => {
      openFromToast?.();
      await Promise.resolve();
    });

    expect(useNavigationStore.getState().settingsOpen).toBe(false);
    expect(mergePr).toHaveBeenNthCalledWith(2, PROJECT_ID, WORKTREE_ID, {
      repoIds: undefined,
      confirmUnresolvedComments: false,
      dryRun: true,
    });
    expect(query('pr-merge-warning-modal')).not.toBeNull();
  });

  it('clears an open merge warning when its page becomes hidden', async () => {
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });
    await render();

    act(() => {
      useGitHubStore.getState().openPrMergeWarning({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoIds: undefined,
        prUrl: 'https://github.com/example/repo/pull/42',
        unresolvedReviewThreadCount: 2,
      });
    });
    expect(query('pr-merge-warning-modal')).not.toBeNull();

    act(() => {
      useNavigationStore.setState({ activePage: 'overview' });
    });

    expect(query('pr-merge-warning-modal')).toBeNull();
    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();

    act(() => {
      useNavigationStore.setState({ activePage: 'main' });
    });
    expect(query('pr-merge-warning-modal')).toBeNull();
  });

  it('clears an open merge warning when Settings opens', async () => {
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });
    await render();

    act(() => {
      useGitHubStore.getState().openPrMergeWarning({
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        repoIds: undefined,
        prUrl: 'https://github.com/example/repo/pull/42',
        unresolvedReviewThreadCount: 2,
      });
    });
    expect(query('pr-merge-warning-modal')).not.toBeNull();

    act(() => {
      useNavigationStore.setState({ settingsOpen: true });
    });

    expect(query('pr-merge-warning-modal')).toBeNull();
    expect(useGitHubStore.getState().prMergeWarnings[KEY]).toBeUndefined();
  });

  it('shows the PR-pill rich tooltip (title + description) on hover', async () => {
    useGitHubStore.setState({
      prStatuses: { [KEY]: makeWorktreePrStatus(makePrStatus()) },
    });
    await render();

    // Tooltip is not mounted until hovered.
    expect(query('pr-status-bar-pr-tooltip')).toBeNull();

    const pill = document.body.querySelector('a[href$="/pull/42"]');
    expect(pill).not.toBeNull();
    if (pill) await hover(pill);

    const tooltip = query('pr-status-bar-pr-tooltip');
    expect(tooltip).not.toBeNull();
    expect(tooltip?.textContent).toContain('Add rich top-bar tooltips');
    expect(tooltip?.textContent).toContain(
      'A concise description of the change.',
    );
  });

  it('opens a scrollable per-check CI popover listing every check on hover', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkDetails: CHECKS })),
      },
    });
    await render();

    const ciBadge = query('pr-status-bar-ci-badge');
    expect(ciBadge).not.toBeNull();
    expect(query('pr-status-bar-ci-popover')).toBeNull();

    if (ciBadge) await hover(ciBadge);

    const popover = query('pr-status-bar-ci-popover');
    expect(popover).not.toBeNull();
    // Same "Checks (X/Y passing)" header + list as the activity card.
    expect(popover?.textContent).toContain('Checks (1/3 passing)');
    expect(popover?.textContent).toContain('build');
    expect(popover?.textContent).toContain('unit-tests');
    expect(popover?.textContent).toContain('lint');
    // Long lists stay reachable via an internal scroll container.
    expect(popover?.querySelector('.overflow-y-auto')).not.toBeNull();
  });

  it('does not open a CI popover when the PR has no checks', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkDetails: [] })),
      },
    });
    await render();

    const ciBadge = query('pr-status-bar-ci-badge');
    expect(ciBadge).not.toBeNull();
    if (ciBadge) await hover(ciBadge);

    expect(query('pr-status-bar-ci-popover')).toBeNull();
    // ...but the badge still explains itself: the plain tooltip is the
    // fallback for exactly the states where there is no check list to show.
    const tooltip = document.body.querySelector('[role="tooltip"]');
    expect(tooltip?.textContent).toContain('CI failing');
  });

  it('suppresses the plain CI tooltip once the rich check list can show', async () => {
    // Both on the same hover would stack a tooltip over the popover.
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkDetails: CHECKS })),
      },
    });
    await render();

    const ciBadge = query('pr-status-bar-ci-badge');
    expect(ciBadge).not.toBeNull();
    if (ciBadge) await hover(ciBadge);

    expect(query('pr-status-bar-ci-popover')).not.toBeNull();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it("shows each multi-repo PR badge tooltip with that repo's actual PR details", async () => {
    useProjectsStore.setState({ projects: [makeMultiRepoProject()] });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'app',
              status: makePrStatus({
                title: 'Ship the app tooltip',
                body: 'App-specific pull request details.',
                checkStatus: 'passing',
                reviewStatus: 'approved',
                mergeableState: 'clean',
                unresolvedReviewThreadCount: 0,
              }),
            },
            {
              repoId: 'repo-2',
              repoName: 'docs',
              status: makePrStatus({
                prNumber: 84,
                prUrl: 'https://github.com/example/docs/pull/84',
                title: 'Document the tooltip',
                body: 'Docs-specific pull request details.',
                checkStatus: 'failing',
                reviewStatus: 'changes_requested',
              }),
            },
          ],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    await render();

    const aggregatePill = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === '2 PRs');
    expect(aggregatePill).not.toBeUndefined();
    if (aggregatePill) await hover(aggregatePill);

    const repoPopover = query('pr-status-bar-repo-popover');
    expect(repoPopover).not.toBeNull();
    const appPrBadge = repoPopover?.querySelector(
      'a[href="https://github.com/example/repo/pull/42"]',
    );
    expect(appPrBadge).not.toBeNull();
    if (appPrBadge) await hover(appPrBadge);

    const tooltip = query('pr-status-bar-repo-pr-tooltip-repo-1');
    expect(tooltip?.textContent).toContain('Ship the app tooltip');
    expect(tooltip?.textContent).toContain(
      'App-specific pull request details.',
    );
    expect(tooltip?.textContent).toContain('CI checks: Passing');
    expect(tooltip?.textContent).toContain('Review: Approved');
    expect(tooltip?.textContent).not.toContain('Document the tooltip');
  });

  it("shows each multi-repo CI badge tooltip with that repo's check details", async () => {
    useProjectsStore.setState({ projects: [makeMultiRepoProject()] });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'app',
              status: makePrStatus({
                checkStatus: 'failing',
                checkDetails: [
                  {
                    name: 'app-build',
                    status: 'failing',
                    detailsUrl: 'https://ci.example/app-build',
                  },
                ],
              }),
            },
            {
              repoId: 'repo-2',
              repoName: 'docs',
              status: makePrStatus({
                prNumber: 84,
                prUrl: 'https://github.com/example/docs/pull/84',
                checkStatus: 'passing',
                checkDetails: [
                  {
                    name: 'docs-build',
                    status: 'passing',
                    detailsUrl: 'https://ci.example/docs-build',
                  },
                ],
              }),
            },
          ],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    await render();

    const aggregatePill = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === '2 PRs');
    expect(aggregatePill).not.toBeUndefined();
    if (aggregatePill) await hover(aggregatePill);

    const appCiBadge = query('pr-status-bar-repo-ci-badge-repo-1');
    expect(appCiBadge).not.toBeNull();
    if (appCiBadge) await hover(appCiBadge);

    const popover = query('pr-status-bar-repo-ci-popover-repo-1');
    expect(popover?.textContent).toContain('Checks (0/1 passing)');
    expect(popover?.textContent).toContain('app-build');
    expect(popover?.textContent).not.toContain('docs-build');
    expect(popover?.querySelector('.overflow-y-auto')).not.toBeNull();
    expect(query('pr-status-bar-repo-popover')).not.toBeNull();
  });

  it('keeps the PR list open when returning from a nested CI popover', async () => {
    useProjectsStore.setState({ projects: [makeMultiRepoProject()] });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: {
          repos: [
            {
              repoId: 'repo-1',
              repoName: 'app',
              status: makePrStatus({
                checkStatus: 'failing',
                checkDetails: [
                  { name: 'app-build', status: 'failing', detailsUrl: null },
                ],
              }),
            },
            {
              repoId: 'repo-2',
              repoName: 'docs',
              status: makePrStatus({ prNumber: 84 }),
            },
          ],
          lastCheckedAt: '2026-07-01T00:00:00.000Z',
        },
      },
    });
    await render();

    const aggregatePill = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.trim() === '2 PRs');
    expect(aggregatePill).not.toBeUndefined();
    if (aggregatePill) await hover(aggregatePill);

    const repoPopover = query('pr-status-bar-repo-popover');
    const appCiBadge = query('pr-status-bar-repo-ci-badge-repo-1');
    expect(repoPopover).not.toBeNull();
    expect(appCiBadge).not.toBeNull();
    if (appCiBadge) await hover(appCiBadge);

    const ciPopover = query('pr-status-bar-repo-ci-popover-repo-1');
    expect(ciPopover).not.toBeNull();
    if (ciPopover && repoPopover) {
      await act(async () => {
        repoPopover.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: ciPopover,
          }),
        );
        ciPopover.dispatchEvent(
          new MouseEvent('mouseover', {
            bubbles: true,
            relatedTarget: repoPopover,
          }),
        );
        ciPopover.dispatchEvent(
          new MouseEvent('mouseout', {
            bubbles: true,
            relatedTarget: repoPopover,
          }),
        );
        repoPopover.dispatchEvent(
          new MouseEvent('mousemove', {
            bubbles: true,
            relatedTarget: ciPopover,
          }),
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
      });
    }

    expect(query('pr-status-bar-repo-popover')).not.toBeNull();
  });
});

describe('PrStatusBar session-replay privacy', () => {
  it('records the status bar in session replay', async () => {
    useGitHubStore.setState({
      prStatuses: { [KEY]: makeWorktreePrStatus(makePrStatus()) },
    });
    await render();

    const bar = query('pr-status-bar');
    expect(bar).not.toBeNull();
    expect(bar?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? null).toBeNull();
    expect(
      bar?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? null,
    ).toBeNull();
  });

  it('records the portaled CI check list', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ checkDetails: CHECKS })),
      },
    });
    await render();

    const ciBadge = query('pr-status-bar-ci-badge');
    expect(ciBadge).not.toBeNull();
    if (ciBadge) await hover(ciBadge);

    const popover = query('pr-status-bar-ci-popover');
    expect(popover?.parentElement).toBe(document.body);
    expect(popover?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
  });
});

describe('PrStatusBar native title migration (CAN-2799)', () => {
  it('explains the Fix CI button with a rich tooltip instead of a native title', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'failing',
            // Settled: a failing check with nothing still pending.
            checkDetails: [CHECKS[0]],
          }),
        ),
      },
    });
    await render();

    const fixButton = query('pr-status-bar-fix-ci');
    expect(fixButton).not.toBeNull();
    expect(fixButton?.hasAttribute('title')).toBe(false);
    expect(fixButton?.getAttribute('aria-label')).toBe('Fix failing CI checks');
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
    if (fixButton) await hover(fixButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Fix failing CI checks',
    );
  });

  it('shows the full base branch in a rich tooltip that lets the trigger shrink', async () => {
    useProjectsStore.setState({ baseBranches: { [KEY]: 'main' } });
    await render();

    const baseBranchButton = query('pr-status-bar-base-branch');
    expect(baseBranchButton).not.toBeNull();
    expect(baseBranchButton?.hasAttribute('title')).toBe(false);
    // The tooltip wrapper carries the shrink floor so the branch label can
    // still truncate under pressure (a `shrink-0` wrapper would defeat it).
    const wrapper = baseBranchButton?.parentElement;
    expect(wrapper?.classList.contains('min-w-14')).toBe(true);
    expect(wrapper?.classList.contains('shrink-0')).toBe(false);
    if (baseBranchButton) await hover(baseBranchButton);
    expect(
      document.body.querySelector('[role="tooltip"]')?.textContent,
    ).toContain('main');
  });

  it('warns about unresolved comments on the Merge PR button via a rich tooltip', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 2,
          }),
        ),
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton).not.toBeNull();
    expect(mergeButton?.hasAttribute('title')).toBe(false);
    if (mergeButton) await hover(mergeButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'This PR has unresolved comments or an unknown review thread state',
    );
  });

  it('keeps the plain Merge PR help when every review thread is resolved', async () => {
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({
            checkStatus: 'passing',
            reviewStatus: 'approved',
            mergeableState: 'clean',
            unresolvedReviewThreadCount: 0,
          }),
        ),
      },
    });
    await render();

    const mergeButton = query('pr-status-bar-merge-pr');
    expect(mergeButton).not.toBeNull();
    expect(mergeButton?.hasAttribute('title')).toBe(false);
    if (mergeButton) await hover(mergeButton);
    expect(document.body.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Merge the pull request',
    );
  });
});

describe('PrStatusBar archived-chats control', () => {
  it('hosts the archive control in the header action cluster, scoped to this worktree', async () => {
    useChatStore.setState({
      archivedChats: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: [
          {
            chatId: 'archived-1',
            title: 'Archived chat',
            turnCount: 2,
            archivedAt: '2026-07-01T00:00:00.000Z',
            createdAt: '2026-06-30T00:00:00.000Z',
            restorable: true,
            unread: false,
            providerType: 'claude',
          },
        ],
      },
    });

    await render();

    // The control moved out of the panel tab strip into the header's
    // right-aligned action cluster, ahead of the `Open in` split control.
    const archive = query('chat-tab-archive');
    expect(archive).not.toBeNull();
    expect(archive?.closest('[data-testid="pr-status-bar"]')).not.toBeNull();
    expect(query('chat-tab-archive-count')?.textContent).toBe('1');

    // `worktree-open-app` only renders once an app is detected; the split
    // control's chevron trigger is always present.
    const openDropdown = query('worktree-open-trigger');
    expect(
      archive !== null &&
        openDropdown !== null &&
        Boolean(
          archive.compareDocumentPosition(openDropdown) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
    ).toBe(true);
  });

  it('renders nothing for a worktree with no archived chats', async () => {
    useChatStore.setState({
      archivedChats: { [`${PROJECT_ID}/${WORKTREE_ID}`]: [] },
    });

    await render();

    expect(query('chat-tab-archive')).toBeNull();
  });

  it('keeps the archive control in the header for a legacy Early access opt-in', async () => {
    useChatStore.setState({
      archivedChats: {
        [`${PROJECT_ID}/${WORKTREE_ID}`]: [
          {
            chatId: 'archived-1',
            title: 'Archived chat',
            turnCount: 2,
            archivedAt: '2026-07-01T00:00:00.000Z',
            createdAt: '2026-06-30T00:00:00.000Z',
            restorable: true,
            unread: false,
            providerType: 'claude',
          },
        ],
      },
    });
    setTestEarlyAccessFeatures({ enabled: true, hydrated: true });

    await render();

    expect(query('pr-status-bar')).not.toBeNull();
    expect(query('chat-tab-archive')).not.toBeNull();
    expect(
      query('chat-tab-archive')?.closest('[data-testid="pr-status-bar"]'),
    ).not.toBeNull();
    expect(query('chat-tab-archive-count')?.textContent).toBe('1');
  });
});

describe('PrStatusBar PR base-branch drift warning', () => {
  beforeEach(() => {
    // The drift *warning* is reserved for a base the user (or a main-process
    // retarget) explicitly persisted. Seed those tracked values so these
    // cases exercise the conflict path rather than the auto-adopt path.
    useProjectsStore.setState({
      projects: [
        makeSingleRepoProject({
          [WORKTREE_ID]: 'main',
          [SECOND_WORKTREE_ID]: 'release/next',
        }),
      ],
    });
    useChatStore.setState({
      selectedWorktree: { projectId: PROJECT_ID, worktreeId: WORKTREE_ID },
    });
  });

  it('settles a hidden PR base question before another worktree asks', async () => {
    const updatePrBaseBranch = jest.fn();
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listBranches: jest.fn().mockResolvedValue({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }),
        getDiffStatsBatch: jest.fn().mockResolvedValue([]),
        github: { updatePrBaseBranch },
      },
    });
    useProjectsStore.setState({
      baseBranches: { [KEY]: 'main', [SECOND_KEY]: 'release/next' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus()),
        [SECOND_KEY]: makeWorktreePrStatus(makePrStatus({ prNumber: 43 })),
      },
    });
    const findQuestion = (): HTMLButtonElement | undefined =>
      Array.from(
        document.body.querySelectorAll<HTMLButtonElement>('button'),
      ).find((button) => button.textContent?.includes('Yes, update PR'));

    await render();
    await act(async () => {
      query('pr-status-bar-base-branch')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-branch-name="release/next"]')
        ?.click();
      await Promise.resolve();
    });
    expect(findQuestion()).toBeDefined();

    // The same bar instance moves to another worktree.
    await act(async () => {
      useChatStore.setState({
        selectedWorktree: {
          projectId: PROJECT_ID,
          worktreeId: SECOND_WORKTREE_ID,
        },
      });
      await Promise.resolve();
    });
    await render(SECOND_WORKTREE_ID);
    expect(findQuestion()).toBeUndefined();

    expect(window.api.setTrackedBaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        baseBranch: 'release/next',
      }),
    );

    await act(async () => {
      query('pr-status-bar-base-branch')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-branch-name="main"]')
        ?.click();
      await Promise.resolve();
    });
    expect(findQuestion()).toBeDefined();
    await act(async () => {
      Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('No, just locally'))
        ?.click();
      await Promise.resolve();
    });
    expect(findQuestion()).toBeUndefined();
    expect(window.api.setTrackedBaseBranch).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: PROJECT_ID,
        worktreeId: SECOND_WORKTREE_ID,
        baseBranch: 'main',
      }),
    );
    expect(updatePrBaseBranch).not.toHaveBeenCalled();
  });

  it('updates the PR base even when the previous GitHub base is unavailable', async () => {
    const updatePrBaseBranch = jest.fn().mockResolvedValue({
      success: true,
      prUrl: 'https://github.com/example/repo/pull/42',
    });
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listBranches: jest.fn().mockResolvedValue({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }),
        github: { updatePrBaseBranch },
      },
    });
    useProjectsStore.setState({ baseBranches: { [KEY]: 'main' } });
    useGitHubStore.setState({
      prStatuses: { [KEY]: makeWorktreePrStatus(makePrStatus()) },
    });

    await render();
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>(
          '[data-testid="pr-status-bar-base-branch"]',
        )
        ?.click();
      await Promise.resolve();
    });
    await act(async () => {
      document.body
        .querySelector<HTMLElement>('[data-branch-name="release/next"]')
        ?.click();
      await Promise.resolve();
    });
    const updatePrButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Yes, update PR'));
    await act(async () => {
      updatePrButton?.click();
      await Promise.resolve();
    });

    expect(updatePrBaseBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      prNumber: 42,
      newBaseBranch: 'release/next',
    });
  });

  it('stays hidden while a user-approved PR base update is refreshing', async () => {
    const updatePrBaseBranch = deferred<{ success: boolean; prUrl: string }>();
    const setTrackedBaseBranch = jest.fn(
      (
        projectId: string,
        worktreeId: string,
        nextBaseBranch: string | null,
      ): Promise<void> => {
        const state = useProjectsStore.getState();
        useProjectsStore.setState({
          baseBranches: {
            ...state.baseBranches,
            [worktreeKey(projectId, worktreeId)]: nextBaseBranch,
          },
        });
        return Promise.resolve();
      },
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listBranches: jest.fn().mockResolvedValue({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }),
        github: {
          updatePrBaseBranch: jest.fn(() => updatePrBaseBranch.promise),
        },
      },
    });
    useProjectsStore.setState({
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'main' })),
      },
    });

    await render();

    const baseBranchButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="pr-status-bar-base-branch"]',
    );
    expect(baseBranchButton).not.toBeNull();
    await act(async () => {
      baseBranchButton?.click();
      await Promise.resolve();
    });

    const nextBaseOption = document.body.querySelector<HTMLElement>(
      '[data-branch-name="release/next"]',
    );
    expect(nextBaseOption).not.toBeNull();
    await act(async () => {
      nextBaseOption?.click();
      await Promise.resolve();
    });

    const updatePrButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Yes, update PR'));
    expect(updatePrButton).toBeDefined();
    await act(async () => {
      updatePrButton?.click();
      await Promise.resolve();
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'release/next',
      undefined,
      { existsLocally: true, existsInRemote: true },
    );
    expect(query('pr-status-base-branch-drift-warning')).toBeNull();

    await act(async () => {
      updatePrBaseBranch.resolve({
        success: true,
        prUrl: 'https://github.com/example/repo/pull/42',
      });
      await updatePrBaseBranch.promise;
    });
    expect(query('pr-status-base-branch-drift-warning')).toBeNull();

    await act(async () => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ baseRefName: 'release/hotfix' }),
          ),
        },
      });
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-warning')).not.toBeNull();
  });

  it('does not carry pending PR-base suppression into another worktree', async () => {
    const updatePrBaseBranch = deferred<{ success: boolean; prUrl: string }>();
    const setTrackedBaseBranch = jest.fn(
      (
        projectId: string,
        worktreeId: string,
        nextBaseBranch: string | null,
      ): Promise<void> => {
        const state = useProjectsStore.getState();
        useProjectsStore.setState({
          baseBranches: {
            ...state.baseBranches,
            [worktreeKey(projectId, worktreeId)]: nextBaseBranch,
          },
        });
        return Promise.resolve();
      },
    );
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ...window.api,
        listBranches: jest.fn().mockResolvedValue({
          branches: [
            {
              name: 'main',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
            {
              name: 'release/next',
              isRemote: false,
              isCurrent: false,
              isUsedByWorktree: false,
              hasLocalRef: true,
              hasRemoteRef: true,
            },
          ],
          defaultBranch: 'main',
        }),
        github: {
          updatePrBaseBranch: jest.fn(() => updatePrBaseBranch.promise),
        },
      },
    });
    useProjectsStore.setState({
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main', [SECOND_KEY]: 'release/next' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'main' })),
        [SECOND_KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'main' }),
        ),
      },
    });

    await render();
    const baseBranchButton = document.body.querySelector<HTMLButtonElement>(
      '[data-testid="pr-status-bar-base-branch"]',
    );
    await act(async () => {
      baseBranchButton?.click();
      await Promise.resolve();
    });
    const nextBaseOption = document.body.querySelector<HTMLElement>(
      '[data-branch-name="release/next"]',
    );
    await act(async () => {
      nextBaseOption?.click();
      await Promise.resolve();
    });
    const updatePrButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent?.includes('Yes, update PR'));
    await act(async () => {
      updatePrButton?.click();
      await Promise.resolve();
    });

    await render(SECOND_WORKTREE_ID);

    expect(query('pr-status-base-branch-drift-warning')).not.toBeNull();
  });

  it('explains the drift and immediately clears after confirming alignment', async () => {
    const setTrackedBaseBranch = jest.fn(
      (
        projectId: string,
        worktreeId: string,
        nextBaseBranch: string | null,
      ): Promise<void> => {
        const state = useProjectsStore.getState();
        useProjectsStore.setState({
          baseBranches: {
            ...state.baseBranches,
            [worktreeKey(projectId, worktreeId)]: nextBaseBranch,
          },
        });
        return Promise.resolve();
      },
    );
    useProjectsStore.setState({
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'release/next' }),
        ),
      },
    });

    await render();

    const warning = query('pr-status-base-branch-drift-warning');
    expect(warning).not.toBeNull();
    if (!warning) throw new Error('Expected the base-branch drift warning.');

    await hover(warning);
    const tooltip = query('pr-status-base-branch-drift-tooltip');
    expect(tooltip?.textContent).toContain('Base branch drift');
    expect(tooltip?.textContent).toContain('main');
    expect(tooltip?.textContent).toContain('PR #42');
    expect(tooltip?.textContent).toContain('release/next');

    await act(async () => {
      warning.click();
      await Promise.resolve();
    });
    const modal = query('pr-status-base-branch-drift-modal');
    expect(modal?.textContent).toContain('Align base branch with PR?');
    expect(modal?.textContent).toContain('release/next');
    expect(
      useCurrentUiStateStore.getState().envelope.snapshot.appAdvisor
        ?.baseBranchAlignmentModal,
    ).toMatchObject({
      open: true,
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      driftCount: 1,
    });

    await act(async () => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'main' })),
        },
      });
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-modal')).toBeNull();

    await act(async () => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ baseRefName: 'release/next' }),
          ),
        },
      });
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-warning')).not.toBeNull();
    expect(query('pr-status-base-branch-drift-modal')).toBeNull();

    await act(async () => {
      query('pr-status-base-branch-drift-warning')?.click();
      await Promise.resolve();
    });

    const confirm = query('pr-status-base-branch-drift-confirm');
    await act(async () => {
      confirm?.click();
      await Promise.resolve();
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'release/next',
      undefined,
    );
    expect(query('pr-status-base-branch-drift-warning')).toBeNull();
    expect(query('pr-status-base-branch-drift-modal')).toBeNull();
  });

  it('dismisses base-branch alignment when its worktree surface is hidden', async () => {
    useProjectsStore.setState({ baseBranches: { [KEY]: 'main' } });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'release/next' }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });

    await render();
    await act(async () => {
      query('pr-status-base-branch-drift-warning')?.click();
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-modal')).not.toBeNull();

    act(() => {
      useNavigationStore.setState({ activePage: 'overview' });
    });

    expect(query('pr-status-base-branch-drift-modal')).toBeNull();
    expect(useBaseBranchAlignmentStore.getState().pending).toBeNull();
  });

  it('dismisses base-branch alignment when Settings opens', async () => {
    useProjectsStore.setState({ baseBranches: { [KEY]: 'main' } });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'release/next' }),
        ),
      },
    });
    useChatStore.setState({
      selectedWorktree: {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
      },
    });

    await render();
    await act(async () => {
      query('pr-status-base-branch-drift-warning')?.click();
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-modal')).not.toBeNull();

    act(() => {
      useNavigationStore.setState({ settingsOpen: true });
    });

    expect(query('pr-status-base-branch-drift-modal')).toBeNull();
    expect(useBaseBranchAlignmentStore.getState().pending).toBeNull();
  });

  it('invalidates base-branch alignment when the drift changes in place', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'release/next' }),
        ),
      },
    });

    await render();
    await act(async () => {
      query('pr-status-base-branch-drift-warning')?.click();
      await Promise.resolve();
    });
    expect(query('pr-status-base-branch-drift-modal')?.textContent).toContain(
      'release/next',
    );

    await act(async () => {
      useGitHubStore.setState({
        prStatuses: {
          [KEY]: makeWorktreePrStatus(
            makePrStatus({ baseRefName: 'release/hotfix' }),
          ),
        },
      });
      await Promise.resolve();
    });

    expect(query('pr-status-base-branch-drift-modal')).toBeNull();
    expect(useBaseBranchAlignmentStore.getState().pending).toBeNull();
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('aligns a one-repository multi-repo project through its repo entry', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeOneRepoMultiRepoProject({ 'repo-1': 'main' })],
      setTrackedBaseBranch,
      repoBranches: {
        [KEY]: [
          {
            repoId: 'repo-1',
            repoName: 'app',
            branch: 'feature/tooltips',
            baseBranch: 'main',
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
          },
        ],
      },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ baseRefName: 'release/next' }),
        ),
      },
    });

    await render();
    await act(async () => {
      query('pr-status-base-branch-drift-warning')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      query('pr-status-base-branch-drift-confirm')?.click();
      await Promise.resolve();
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'release/next',
      'repo-1',
    );
  });

  it('does not warn when the tracked base already matches the PR', async () => {
    useProjectsStore.setState({ baseBranches: { [KEY]: 'main' } });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'main' })),
      },
    });

    await render();

    expect(query('pr-status-base-branch-drift-warning')).toBeNull();
  });

  it('adopts the PR base without warning when nothing was ever tracked', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      // No `trackedBaseBranch` anywhere: the displayed `main` is the derived
      // fallback, not a choice the user made.
      projects: [makeSingleRepoProject()],
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'develop' })),
      },
    });

    await render();

    expect(query('pr-status-base-branch-drift-warning')).toBeNull();
    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'develop',
      undefined,
    );
  });

  it('adopts once, not on every render, while the write settles', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeSingleRepoProject()],
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'develop' })),
      },
    });

    await render();
    // A second unrelated store update re-renders the bar while the tracked
    // value has not been written back yet; it must not re-issue the write.
    await act(async () => {
      useProjectsStore.setState({ commitsAhead: { [KEY]: true } });
      await Promise.resolve();
    });

    expect(setTrackedBaseBranch).toHaveBeenCalledTimes(1);
  });

  it('still warns when an explicitly tracked base conflicts with the PR', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeSingleRepoProject({ [WORKTREE_ID]: 'main' })],
      setTrackedBaseBranch,
      baseBranches: { [KEY]: 'main' },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'develop' })),
      },
    });

    await render();

    expect(query('pr-status-base-branch-drift-warning')).not.toBeNull();
    expect(setTrackedBaseBranch).not.toHaveBeenCalled();
  });

  it('adopts the PR base per repo in a multi-repo project', async () => {
    const setTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
    useProjectsStore.setState({
      projects: [makeOneRepoMultiRepoProject()],
      setTrackedBaseBranch,
      repoBranches: {
        [KEY]: [
          {
            repoId: 'repo-1',
            repoName: 'app',
            branch: 'feature/tooltips',
            baseBranch: 'main',
            baseBranchExistsLocally: true,
            baseBranchExistsInRemote: true,
          },
        ],
      },
    });
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(makePrStatus({ baseRefName: 'develop' })),
      },
    });

    await render();

    expect(query('pr-status-base-branch-drift-warning')).toBeNull();
    expect(setTrackedBaseBranch).toHaveBeenCalledWith(
      PROJECT_ID,
      WORKTREE_ID,
      'develop',
      'repo-1',
    );
  });
});

describe('PrStatusBar change branch', () => {
  const branch = (
    name: string,
    isRemote: boolean,
  ): {
    name: string;
    isRemote: boolean;
    isCurrent: boolean;
    isUsedByWorktree: boolean;
    hasLocalRef: boolean;
    hasRemoteRef: boolean;
  } => ({
    name,
    isRemote,
    isCurrent: false,
    isUsedByWorktree: false,
    hasLocalRef: !isRemote,
    hasRemoteRef: isRemote,
  });

  function mockApi(api: Record<string, jest.Mock>): void {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, ...api },
    });
  }

  async function openChangeBranch(): Promise<void> {
    await act(async () => {
      query('pr-status-bar-branch-menu-trigger')?.click();
      await Promise.resolve();
    });
    await act(async () => {
      query('branch-menu-change')?.click();
      await Promise.resolve();
    });
  }

  async function select(
    target: Parameters<WorktreeBranchTargetPickerProps['onSelect']>[0],
  ): Promise<void> {
    await act(async () => {
      mockWorktreeBranchPicker?.onSelect(target);
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    });
  }

  beforeEach(() => {
    mockWorktreeBranchPicker = null;
  });

  it('labels a worktree on its generated branch as New branch', async () => {
    useProjectsStore.setState({
      projects: [
        {
          ...makeSingleRepoProject(),
          worktrees: [
            {
              id: WORKTREE_ID,
              branchName: makeDefaultWorktreeBranchName(WORKTREE_ID),
              createdAt: '2026-07-01T00:00:00.000Z',
            },
          ],
        },
      ],
    });
    await render();

    expect(query('pr-status-bar-branch-menu-trigger')?.textContent).toBe(
      'New branch',
    );
  });

  it('offers Change branch after Rename branch and switches the worktree', async () => {
    const homeListBranchTargets = jest.fn().mockResolvedValue({
      supported: true,
      defaultBranch: 'main',
      branches: [branch('release', true)],
    });
    const switchBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'release' });
    mockApi({ homeListBranchTargets, switchBranch });
    useProjectsStore.setState({
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();

    await act(async () => {
      query('pr-status-bar-branch-menu-trigger')?.click();
      await Promise.resolve();
    });
    const items = Array.from(
      query('pr-status-bar-branch-menu')?.querySelectorAll('[data-testid]') ??
        [],
    ).map((item) => item.getAttribute('data-testid'));
    expect(items.indexOf('branch-menu-change')).toBe(
      items.indexOf('branch-menu-rename') + 1,
    );
    expect(query('branch-menu-change')?.textContent).toBe('Change branch');

    await act(async () => {
      query('branch-menu-change')?.click();
      await Promise.resolve();
    });
    expect(query('pr-status-bar-change-branch-menu')).not.toBeNull();
    expect(homeListBranchTargets).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
    });
    expect(mockWorktreeBranchPicker?.currentBranch).toBe('feature/tooltips');
    expect(mockWorktreeBranchPicker?.branchTargets?.supported).toBe(true);

    await select({ kind: 'branch', branchName: 'release', isRemote: true });
    expect(switchBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      branchName: 'release',
      isRemote: true,
    });
    const project = useProjectsStore.getState().projects[0];
    expect(
      project?.type === 'single-repo' ? project.worktrees[0]?.branchName : null,
    ).toBe('release');
  });

  it("switches to a pull request's head branch, fetching it when unlisted", async () => {
    const switchBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'pr-head' });
    mockApi({
      homeListBranchTargets: jest.fn().mockResolvedValue({
        supported: true,
        defaultBranch: 'main',
        branches: [],
      }),
      switchBranch,
    });
    useProjectsStore.setState({
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();
    await openChangeBranch();

    await select({
      kind: 'pr',
      number: 12,
      title: 'Fix',
      headRefName: 'pr-head',
      url: 'https://github.com/acme/app/pull/12',
    });
    expect(switchBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      branchName: 'pr-head',
      isRemote: true,
    });
  });

  it('creates a missing Linear issue branch from the tracked base', async () => {
    const createBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'can-12-fix' });
    mockApi({
      homeListBranchTargets: jest.fn().mockResolvedValue({
        supported: true,
        defaultBranch: 'main',
        branches: [branch('develop', true)],
      }),
      createBranch,
    });
    useProjectsStore.setState({
      baseBranches: { [KEY]: 'develop' },
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();
    await openChangeBranch();

    await select({
      kind: 'linear-issue',
      identifier: 'CAN-12',
      title: 'Fix',
      branchName: 'can-12-fix',
    });
    expect(createBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      newBranchName: 'can-12-fix',
      baseBranch: 'develop',
      baseBranchIsRemote: true,
    });
  });

  it('cuts a missing Linear issue branch from origin when the base is also local', async () => {
    const createBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'can-13-fix' });
    mockApi({
      homeListBranchTargets: jest.fn().mockResolvedValue({
        supported: true,
        defaultBranch: 'main',
        // Checked out and tracked: both refs exist, so the list does not
        // mark it remote, yet the local copy may be behind origin.
        branches: [
          {
            ...branch('develop', false),
            hasLocalRef: true,
            hasRemoteRef: true,
          },
        ],
      }),
      createBranch,
    });
    useProjectsStore.setState({
      baseBranches: { [KEY]: 'develop' },
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();
    await openChangeBranch();

    await select({
      kind: 'linear-issue',
      identifier: 'CAN-13',
      title: 'Fix',
      branchName: 'can-13-fix',
    });
    expect(createBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      newBranchName: 'can-13-fix',
      baseBranch: 'develop',
      baseBranchIsRemote: true,
    });
  });

  function deferredTargets(): {
    promise: Promise<unknown>;
    resolve: (value: unknown) => void;
  } {
    let resolve: (value: unknown) => void = () => undefined;
    const promise = new Promise<unknown>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it('waits for the branch list before choosing between switch and create', async () => {
    const pending = deferredTargets();
    const switchBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'can-12-fix' });
    const createBranch = jest.fn();
    mockApi({
      homeListBranchTargets: jest.fn().mockReturnValue(pending.promise),
      switchBranch,
      createBranch,
    });
    useProjectsStore.setState({
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();
    await openChangeBranch();

    // Linear issues load on their own, so one can be picked before the
    // branch list arrives.
    await select({
      kind: 'linear-issue',
      identifier: 'CAN-12',
      title: 'Fix',
      branchName: 'can-12-fix',
    });
    await act(async () => {
      pending.resolve({
        supported: true,
        defaultBranch: 'main',
        branches: [branch('can-12-fix', false)],
      });
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    });

    expect(createBranch).not.toHaveBeenCalled();
    expect(switchBranch).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      branchName: 'can-12-fix',
      isRemote: false,
    });
  });

  it('ignores a branch list that arrives after the picker reopened', async () => {
    const stale = deferredTargets();
    const homeListBranchTargets = jest
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce({
        supported: true,
        defaultBranch: 'main',
        branches: [branch('can-12-fix', false)],
      });
    const switchBranch = jest
      .fn()
      .mockResolvedValue({ success: true, branchName: 'can-12-fix' });
    const createBranch = jest.fn();
    mockApi({ homeListBranchTargets, switchBranch, createBranch });
    useProjectsStore.setState({
      refreshDiffStats: jest.fn().mockResolvedValue(undefined),
    });
    await render();
    await openChangeBranch();
    await openChangeBranch();
    expect(homeListBranchTargets).toHaveBeenCalledTimes(2);
    await act(async () => {
      stale.resolve({ supported: true, defaultBranch: 'main', branches: [] });
      for (let tick = 0; tick < 4; tick++) await Promise.resolve();
    });

    await select({
      kind: 'linear-issue',
      identifier: 'CAN-12',
      title: 'Fix',
      branchName: 'can-12-fix',
    });
    expect(createBranch).not.toHaveBeenCalled();
    expect(switchBranch).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'can-12-fix' }),
    );
  });

  it('reports a failed switch and keeps the current branch', async () => {
    mockApi({
      homeListBranchTargets: jest.fn().mockResolvedValue({
        supported: true,
        defaultBranch: 'main',
        branches: [branch('release', true)],
      }),
      switchBranch: jest
        .fn()
        .mockRejectedValue(new Error('Commit or stash your changes first')),
    });
    const addToast = jest.fn<void, Parameters<typeof originalAddToast>>();
    useGitHubStore.setState({ addToast });
    await render();
    await openChangeBranch();

    await select({ kind: 'branch', branchName: 'release', isRemote: true });
    expect(addToast).toHaveBeenCalledWith(
      expect.stringContaining('Commit or stash your changes first'),
      'error',
    );
    const project = useProjectsStore.getState().projects[0];
    expect(
      project?.type === 'single-repo' ? project.worktrees[0]?.branchName : null,
    ).toBe('feature/tooltips');
  });
});

describe('PrStatusBar branch rename entry and quick copy', () => {
  it('never opens the inline rename from a double-click', async () => {
    // Review contract (Tommy): renaming a git branch must go through a
    // deliberate, labelled action. The double-click shortcut looked like it
    // was "changing the branch" by gesture and was cut.
    await render();

    const trigger = query('pr-status-bar-branch-menu-trigger');
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger?.dispatchEvent(
        new MouseEvent('dblclick', { bubbles: true, cancelable: true }),
      );
      await Promise.resolve();
    });

    expect(query('pr-status-bar-branch-rename-input')).toBeNull();
  });

  it('opens the inline rename from the branch menu item', async () => {
    await render();

    const trigger = query('pr-status-bar-branch-menu-trigger');
    await act(async () => {
      trigger?.click();
      await Promise.resolve();
    });
    const renameItem = query('branch-menu-rename');
    expect(renameItem).not.toBeNull();
    await act(async () => {
      renameItem?.click();
      await Promise.resolve();
    });

    const input = query('pr-status-bar-branch-rename-input');
    expect(input).not.toBeNull();
    // Seeded with the raw branch label, so the deliberate path edits the
    // real name rather than starting blank.
    expect(input?.getAttribute('value') ?? '').not.toBe('');
  });

  it('keeps the quick copy in-flow inside the pill, outside the trigger button', async () => {
    // The hover-revealed copy renders IN-FLOW inside the pill wrapper (after
    // the trigger), so under space pressure the label's `truncate` yields a
    // REAL ellipsis for it — no fade mask. It must never be a DESCENDANT of
    // the trigger <button> (interactive content inside a button is invalid
    // markup), its insets are an equal 2px (24px control, 2px trailing pad),
    // and its radius follows the nested rule (wrapper 8px − 2px = 6px).
    await render();

    const trigger = query('pr-status-bar-branch-menu-trigger');
    const wrapper = trigger?.parentElement;
    expect(wrapper).not.toBeNull();
    // At rest the copy is UNMOUNTED (the reveal is state-driven so the
    // wrapper's rest width can be measured before the button exists).
    expect(query('pr-status-bar-branch-copy')).toBeNull();

    await act(async () => {
      wrapper?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await Promise.resolve();
    });

    const copyButton = query('pr-status-bar-branch-copy');
    expect(copyButton).not.toBeNull();
    expect(copyButton?.parentElement?.closest('button')).toBeNull();
    // The wrapper locks its rest width for the hover, so revealing the
    // in-flow button cannot grow the pill — the label shrinks instead.
    expect((wrapper as HTMLElement).style.width).toMatch(/px$/);
    // parentElement is Tooltip's own wrapper span; the reveal container is
    // one above it.
    const container = copyButton?.parentElement?.parentElement;
    expect(container?.className).not.toContain('absolute');
    expect(container?.className).toContain('pr-0.5');
    expect(copyButton?.className).toContain('h-6');
    expect(copyButton?.className).toContain(
      'rounded-[calc(var(--radius-md)-2px)]',
    );
    // No fade mask anywhere on the label — truncation is the ellipsis.
    const label = trigger?.querySelector('span[title]');
    expect(label?.className).toContain('truncate');
    expect(label?.className).not.toContain('mask-image');
  });
});
