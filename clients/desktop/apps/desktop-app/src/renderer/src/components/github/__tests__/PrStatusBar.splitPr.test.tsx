/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PrStatusData,
  WorktreePrStatus,
} from '@canopy/desktop-shared/types/github';
import type { SidebarItem } from '@canopy/desktop-shared/types';
import {
  CLIENT_FEATURE_FLAGS,
  getDefaultFeatureFlagSnapshot,
} from '@canopy/protocol/feature-flags';
import { PrStatusBar } from '../PrStatusBar';
import { useGitHubStore, worktreeKey } from '@/stores/githubStore';
import { useProjectsStore } from '@/stores/projectsStore';
import { usePipelineRunsStore } from '@/stores/pipelineRunsStore';
import { useChatStore, type ChatTab } from '@/stores/chatStore';
import { useActivityStore } from '@/stores/activityStore';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  __resetSplitPrPreferencesForTests,
  useSplitPrPreferencesStore,
} from '@/hooks/useSplitPrPreferences';

const PROJECT_ID = 'proj-1';
const WORKTREE_ID = 'wt-1';
const KEY = worktreeKey(PROJECT_ID, WORKTREE_ID);

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

function setGatingPrefs(enabled: boolean, thresholdLines: number): void {
  useSplitPrPreferencesStore.setState({
    splitPrEnabled: enabled,
    splitPrThresholdLines: thresholdLines,
    hasLoaded: true,
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

function installWindowApiMock(): void {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      detectApps: jest.fn().mockResolvedValue([]),
      loadPreferences: jest.fn().mockResolvedValue({
        splitPrEnabled: true,
        splitPrThresholdLines: 500,
        lastOpenApp: '',
      }),
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
  useFeatureFlagsStore.setState({ snapshot: getDefaultFeatureFlagSnapshot() });
  useGitHubStore.setState({
    prStatuses: {},
    creatingPr: new Set<string>(),
    creationProgress: {},
    committingAndPushing: new Set<string>(),
    mergingLocalBranches: new Set<string>(),
    mergingPr: new Set<string>(),
    gitStatsRefreshing: new Set<string>(),
    activeBranchSyncAction: {},
    commitPushProgress: {},
    commitReviewPending: {},
  });
  useProjectsStore.setState({
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
      <PrStatusBar
        projectId={PROJECT_ID}
        worktreeId={WORKTREE_ID}
        viewMode="list"
        viewModeReady
      />,
    );
    await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
}

/**
 * An eligible worktree that is waiting keeps Split PR in the header, shown
 * unavailable with its blockers (DESIGN.md: disabled with its reason, not
 * hidden), and a click does nothing.
 */
function expectBlockedSplit(): void {
  const button = query('split-pr-status-bar-button');
  expect(button).not.toBeNull();
  expect(button?.getAttribute('aria-disabled')).toBe('true');
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  expect(useActivityStore.getState().splitPreflight).toBeNull();
}

describe('PrStatusBar Split PR status-bar button', () => {
  it('is present when the worktree is eligible and fully ready (zero blockers)', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });

    await render();

    const button = query('split-pr-status-bar-button');
    expect(button).not.toBeNull();
    expect(button?.querySelector('svg')).not.toBeNull();
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

    const button = query('split-pr-status-bar-button');
    expect(button).not.toBeNull();
    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(useActivityStore.getState().splitPreflight).toEqual({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    expect(useGitHubStore.getState().planningSplitPr?.has(KEY)).not.toBe(true);
  });

  it('is absent when the desktop PR Split flag is off', async () => {
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

    expect(query('split-pr-status-bar-button')).toBeNull();
  });

  it('is absent when the worktree is below the eligibility threshold', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 100, deletions: 50 }),
        ),
      },
    });

    await render();

    expect(query('split-pr-status-bar-button')).toBeNull();
  });

  it('is disabled with its blocker when there are uncommitted changes', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100 }),
        ),
      },
    });
    useProjectsStore.setState({ uncommittedChanges: { [KEY]: true } });

    await render();

    expectBlockedSplit();
  });

  it('is disabled with its blocker while a pipeline is active for the worktree', async () => {
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

    expectBlockedSplit();
  });

  it('is disabled with its blocker while a chat tab is actively streaming', async () => {
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

    expectBlockedSplit();
  });

  it('is disabled with its blocker when GitHub reports merge conflicts', async () => {
    setGatingPrefs(true, 500);
    useGitHubStore.setState({
      prStatuses: {
        [KEY]: makeWorktreePrStatus(
          makePrStatus({ additions: 600, deletions: 100, hasConflicts: true }),
        ),
      },
    });

    await render();

    expectBlockedSplit();
  });
});
