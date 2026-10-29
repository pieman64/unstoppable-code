import type {
  CanopyApi,
  SidebarItem,
  WorktreeData,
  WorktreeHealthIssue,
} from '@canopy/desktop-shared/types';
import { useProjectsStore } from '@/stores/projectsStore';
import {
  canShowStandaloneDeleteButton,
  getDeleteAction,
  isWorktreeFresh,
  shouldBypassDeleteConfirmation,
} from '@/components/worktree/worktree-delete-action';

declare global {
  interface Window {
    api: CanopyApi;
  }
}

const PROJECT_ID = 'project-1';
const WORKTREE_ID = 'worktree-1';

function makeWorktree(overrides?: Partial<WorktreeData>): WorktreeData {
  return {
    id: WORKTREE_ID,
    branchName: 'feature-x',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

/**
 * Test-only helper: cowork sidebar items have no `worktrees`, so tests that
 * read a worktree back off the store's `SidebarItem[]` need to narrow past
 * that variant first.
 */
function getProjectWorktrees(project: SidebarItem | undefined): WorktreeData[] {
  if (!project || project.type === 'cowork') {
    return [];
  }
  return project.worktrees;
}

const mockSaveProjects = jest.fn().mockResolvedValue(undefined);
const mockSetTrackedBaseBranch = jest.fn().mockResolvedValue(undefined);
const mockGetDiffStatsBatch = jest.fn().mockResolvedValue([]);
const mockRetryWorktreeHealthCheck = jest.fn();

beforeAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      api: {
        saveProjects: mockSaveProjects,
        setTrackedBaseBranch: mockSetTrackedBaseBranch,
        getDiffStatsBatch: mockGetDiffStatsBatch,
        retryWorktreeHealthCheck: mockRetryWorktreeHealthCheck,
      },
    },
  });
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('WorktreeItem delete confirmation behavior', () => {
  const cleanStats = { insertions: 0, deletions: 0 };
  const dirtyStats = { insertions: 1, deletions: 0 };

  it('bypasses confirmation for done worktrees', () => {
    expect(
      getDeleteAction({
        isDone: true,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
      }),
    ).toBe('delete');
  });

  it('bypasses confirmation for clean settled worktrees with loaded stats', () => {
    expect(
      shouldBypassDeleteConfirmation({
        isDone: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe(true);
  });

  it('opens confirmation for worktrees with uncommitted changes', () => {
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: true,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe('confirm');
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: dirtyStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe('confirm');
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: true,
        hasUnpushedCommits: false,
      }),
    ).toBe('confirm');
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: true,
      }),
    ).toBe('confirm');
  });

  it('opens confirmation while diff stats or clean state are unknown', () => {
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
      }),
    ).toBe('confirm');
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe('delete');
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
      }),
    ).toBe('confirm');
  });

  it('disables deletion while a session is active', () => {
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: true,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe('disabled');
  });

  it('disables deletion while archive is in progress', () => {
    expect(
      getDeleteAction({
        isDone: false,
        hasActiveSession: false,
        isArchiveInProgress: true,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
      }),
    ).toBe('disabled');
  });
});

describe('WorktreeItem standalone delete button visibility', () => {
  const cleanStats = { insertions: 0, deletions: 0 };
  const dirtyStats = { insertions: 1, deletions: 0 };
  const settled = {
    isDone: false,
    isPendingGitSetup: false,
    isRunningSetup: false,
    isTearingDown: false,
  };

  it('shows the button for a fresh worktree before stats have loaded', () => {
    expect(
      canShowStandaloneDeleteButton({ ...settled, isFreshWorktree: true }),
    ).toBe(true);
  });

  it('hides the button when stats have not loaded for a non-fresh worktree', () => {
    expect(
      canShowStandaloneDeleteButton({ ...settled, isFreshWorktree: false }),
    ).toBe(false);
    // Also when the flag is omitted entirely (defaults to non-fresh).
    expect(canShowStandaloneDeleteButton(settled)).toBe(false);
  });

  it('shows the button once stats confirm a clean worktree', () => {
    expect(
      canShowStandaloneDeleteButton({
        ...settled,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe(true);
  });

  it('hides the button when uncommitted work is known', () => {
    expect(
      canShowStandaloneDeleteButton({
        ...settled,
        stats: cleanStats,
        hasUncommittedChanges: true,
        hasCommitsAhead: false,
        hasUnpushedCommits: false,
      }),
    ).toBe(false);
    expect(
      canShowStandaloneDeleteButton({ ...settled, stats: dirtyStats }),
    ).toBe(false);
    expect(
      canShowStandaloneDeleteButton({
        ...settled,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: true,
        hasUnpushedCommits: false,
      }),
    ).toBe(false);
    expect(
      canShowStandaloneDeleteButton({
        ...settled,
        stats: cleanStats,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
        hasUnpushedCommits: true,
      }),
    ).toBe(false);
  });

  it('hides the button during setup, teardown, or pending git phases', () => {
    const baseParams = {
      isDone: false,
      stats: cleanStats,
      hasUncommittedChanges: false,
      isFreshWorktree: true,
    };
    expect(
      canShowStandaloneDeleteButton({
        ...baseParams,
        isPendingGitSetup: true,
        isRunningSetup: false,
        isTearingDown: false,
      }),
    ).toBe(false);
    expect(
      canShowStandaloneDeleteButton({
        ...baseParams,
        isPendingGitSetup: false,
        isRunningSetup: true,
        isTearingDown: false,
      }),
    ).toBe(false);
    expect(
      canShowStandaloneDeleteButton({
        ...baseParams,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: true,
      }),
    ).toBe(false);
  });

  it('hides the button for done worktrees (they use the always-visible button)', () => {
    expect(
      canShowStandaloneDeleteButton({
        isDone: true,
        isPendingGitSetup: false,
        isRunningSetup: false,
        isTearingDown: false,
        isFreshWorktree: true,
      }),
    ).toBe(false);
  });
});

describe('isWorktreeFresh', () => {
  const now = Date.UTC(2026, 4, 12, 12, 0, 0);

  it('returns true when createdAt is within the freshness window', () => {
    const createdAt = new Date(now - 5_000).toISOString();
    expect(isWorktreeFresh(createdAt, now)).toBe(true);
  });

  it('returns false when createdAt is outside the freshness window', () => {
    const createdAt = new Date(now - 60_000).toISOString();
    expect(isWorktreeFresh(createdAt, now)).toBe(false);
  });

  it('returns false for unparseable timestamps', () => {
    expect(isWorktreeFresh('not-a-date', now)).toBe(false);
  });
});

describe('WorktreeItem behavior (store-level)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useProjectsStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          type: 'single-repo',
          name: 'test-project',
          repoPath: '/tmp/repo',
          color: '#000000',
          order: 0,
          collapsed: false,
          worktrees: [makeWorktree({ trackedBaseBranch: 'develop' })],
          scripts: {},
          effectiveScripts: {},
          hooks: {},
          effectiveHooks: {},
        },
      ],
    });
  });

  it('ordinary branch switch does not clear tracked base', () => {
    // Simulate what handleBranchSwitched now does (just updateBranchName, no setTrackedBaseBranch)
    useProjectsStore
      .getState()
      .updateBranchName(PROJECT_ID, WORKTREE_ID, 'feature-y');

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    // trackedBaseBranch should be preserved
    expect(wt.trackedBaseBranch).toBe('develop');
    expect(wt.branchName).toBe('feature-y');
  });

  it('branch creation still persists tracked base', async () => {
    // Simulate what handleBranchCreated does
    useProjectsStore
      .getState()
      .updateBranchName(PROJECT_ID, WORKTREE_ID, 'feature-new');
    await useProjectsStore
      .getState()
      .setTrackedBaseBranch(PROJECT_ID, WORKTREE_ID, 'main');

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt.trackedBaseBranch).toBe('main');
    expect(wt.branchName).toBe('feature-new');
    // Persisted through the targeted tracked-base channel, which is what
    // survives a later wholesale renderer save.
    expect(mockSetTrackedBaseBranch).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
      repoId: undefined,
      baseBranch: 'main',
    });
  });
});

/**
 * Behavioral coverage for the WorktreeItem health-issue retry UI. This
 * project's jest setup runs tests in a node environment without a DOM
 * rendering library, so these tests exercise the exact store code-path the
 * component uses (`retryWorktreeHealthCheck`) instead of rendering JSX.
 */
describe('WorktreeItem health retry behavior (store-level)', () => {
  const brokenIssue: WorktreeHealthIssue = {
    status: 'broken',
    code: 'invalid-git-worktree',
    message: 'Git metadata is bad.',
    checkedAt: '2026-04-22T00:00:00.000Z',
    worktreePath: '/worktrees/project-1/worktree-1',
  };

  beforeEach(() => {
    jest.clearAllMocks();
    useProjectsStore.setState({
      projects: [
        {
          id: PROJECT_ID,
          type: 'single-repo',
          name: 'test-project',
          repoPath: '/tmp/repo',
          color: '#000000',
          order: 0,
          collapsed: false,
          worktrees: [makeWorktree({ healthIssue: brokenIssue })],
        },
      ],
    });
    mockGetDiffStatsBatch.mockResolvedValue([]);
  });

  it('clears the broken marker when retry returns healthy', async () => {
    mockRetryWorktreeHealthCheck.mockResolvedValue({
      healthy: true,
      worktree: makeWorktree(),
    });

    const response = await useProjectsStore
      .getState()
      .retryWorktreeHealthCheck(PROJECT_ID, WORKTREE_ID);

    expect(response.healthy).toBe(true);
    expect(mockRetryWorktreeHealthCheck).toHaveBeenCalledWith({
      projectId: PROJECT_ID,
      worktreeId: WORKTREE_ID,
    });
    // A healthy retry must trigger a refresh so the UI unhides diff stats.
    expect(mockGetDiffStatsBatch).toHaveBeenCalled();

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toBeUndefined();
  });

  it('keeps the broken marker when retry still reports unhealthy and refreshes diff stats for partial-heal data', async () => {
    mockRetryWorktreeHealthCheck.mockResolvedValue({
      healthy: false,
      worktree: makeWorktree({ healthIssue: brokenIssue }),
      issue: brokenIssue,
    });
    mockGetDiffStatsBatch.mockResolvedValue([
      {
        projectId: PROJECT_ID,
        worktreeId: WORKTREE_ID,
        insertions: 0,
        deletions: 0,
        healthIssue: brokenIssue,
      },
    ]);

    const response = await useProjectsStore
      .getState()
      .retryWorktreeHealthCheck(PROJECT_ID, WORKTREE_ID);

    expect(response.healthy).toBe(false);
    expect(mockGetDiffStatsBatch).toHaveBeenCalledTimes(1);

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toEqual(brokenIssue);
  });

  it('propagates retry errors to the caller without mutating state', async () => {
    mockRetryWorktreeHealthCheck.mockRejectedValue(new Error('network down'));

    await expect(
      useProjectsStore
        .getState()
        .retryWorktreeHealthCheck(PROJECT_ID, WORKTREE_ID),
    ).rejects.toThrow('network down');

    const wt = getProjectWorktrees(useProjectsStore.getState().projects[0])[0];
    expect(wt?.healthIssue).toEqual(brokenIssue);
  });
});
