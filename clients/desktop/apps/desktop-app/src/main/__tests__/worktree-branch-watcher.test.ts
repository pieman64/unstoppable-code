import type { BrowserWindow } from 'electron';
import type { FSWatcher } from 'node:fs';
import type { SidebarItem, WorktreeData } from '@canopy/desktop-shared/types';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';

interface MockWatcher {
  close: jest.Mock<void, []>;
  emitChange: (filename?: string | Buffer) => void;
  emitError: (error?: Error) => void;
  on: jest.Mock<MockWatcher, [string, (...args: unknown[]) => void]>;
}

const watchers: MockWatcher[] = [];

jest.mock('node:fs', () => ({
  watch: jest.fn(
    (
      _path: string,
      _options: unknown,
      listener: (_event: string, filename: string | Buffer | null) => void,
    ) => {
      const handlers = new Map<string, (...args: unknown[]) => void>();
      const watcher: MockWatcher = {
        close: jest.fn<void, []>(),
        emitChange(filename?: string | Buffer): void {
          listener('change', filename ?? 'HEAD');
        },
        emitError(error = new Error('watch failed')): void {
          handlers.get('error')?.(error);
        },
        on: jest.fn((event, handler) => {
          handlers.set(event, handler);
          return watcher;
        }),
      };
      watchers.push(watcher);
      return watcher as unknown as FSWatcher;
    },
  ),
}));

jest.mock('../lib/git', () => ({
  getCurrentBranchDisplayName: jest.fn(),
  getGitHeadWatchState: jest.fn(),
}));

jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
}));

jest.mock('../lib/workspace-persistence', () => ({
  updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  invalidateWorktreeStats: jest.fn(),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { watch } from 'node:fs';
import { getCurrentBranchDisplayName, getGitHeadWatchState } from '../lib/git';
import { updateWorkspaceWorktree } from '../lib/workspace-persistence';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { invalidateWorktreeStats } from '../lib/worktree-service';
import { sendToWindow } from '../lib/window-send';
import {
  ensureWorktreeBranchWatchers,
  stopWorktreeBranchWatchers,
  syncWorktreeBranchWatchers,
} from '../lib/worktree-branch-watcher';

const mockedWatch = jest.mocked(watch);
const mockedGetCurrentBranchDisplayName = jest.mocked(
  getCurrentBranchDisplayName,
);
const mockedGetGitHeadWatchState = jest.mocked(getGitHeadWatchState);
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedInvalidateWorktreeStats = jest.mocked(invalidateWorktreeStats);
const mockedSendToWindow = jest.mocked(sendToWindow);

const windowRef = {} as BrowserWindow;

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function singleRepoItem(
  id = 'ws-1',
  worktreeId = 'wt-1',
  worktree: Partial<WorktreeData> = {},
): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#123456',
    worktrees: [
      {
        id: worktreeId,
        branchName: 'main',
        createdAt: '2026-05-22T00:00:00.000Z',
        ...worktree,
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function multiRepoItem(worktree: Partial<WorktreeData> = {}): SidebarItem {
  return {
    type: 'multi-repo',
    id: 'ws-1',
    name: 'ws-1',
    color: '#123456',
    repos: [],
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'main',
        createdAt: '2026-05-22T00:00:00.000Z',
        ...worktree,
      },
    ],
    collapsed: false,
    order: 0,
  };
}

const DEFAULT_BRANCH = 'mink-2-1792088684150';
const RENAMED_BRANCH = 'qrtp/fix-left-nav-title-update';

/** HEAD (both the watch state and a later read) is on `branchName`. */
function mockLiveBranch(branchName: string | null): void {
  mockedGetGitHeadWatchState.mockImplementation((repoPath) =>
    Promise.resolve({ headPath: `${repoPath}/.git/HEAD`, branchName }),
  );
  mockedGetCurrentBranchDisplayName.mockResolvedValue(branchName);
}

function persistedRow(): WorktreeData {
  return {
    id: 'wt-1',
    branchName: DEFAULT_BRANCH,
    createdAt: '2026-05-22T00:00:00.000Z',
    lastKnownPrStatus: null,
  };
}

function branchChangedEvents(): unknown[] {
  return mockedSendToWindow.mock.calls
    .filter(([, channel]) => channel === IPC_CHANNELS.worktreeBranchChanged)
    .map(([, , event]) => event);
}

async function sync(items: SidebarItem[]): Promise<void> {
  await syncWorktreeBranchWatchers(items, () => windowRef);
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  watchers.length = 0;
  stopWorktreeBranchWatchers();
  mockedGetGitHeadWatchState.mockImplementation((repoPath) =>
    Promise.resolve({
      headPath: `${repoPath}/.git/HEAD`,
      branchName: 'main',
    }),
  );
  mockedGetCurrentBranchDisplayName.mockResolvedValue('main');
  mockedUpdateWorkspaceWorktree.mockResolvedValue(true);
  mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
});

afterEach(() => {
  stopWorktreeBranchWatchers();
  jest.useRealTimers();
});

describe('worktree branch watchers', () => {
  it('starts and retires watchers as synced worktrees change', async () => {
    await sync([singleRepoItem('ws-1', 'wt-1')]);

    expect(mockedWatch).toHaveBeenCalledWith(
      '/mock/workspaces/ws-1/worktrees/wt-1/.git',
      { persistent: false },
      expect.any(Function),
    );
    expect(watchers).toHaveLength(1);

    await sync([singleRepoItem('ws-2', 'wt-2')]);

    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(watchers).toHaveLength(2);
    expect(mockedWatch).toHaveBeenLastCalledWith(
      '/mock/workspaces/ws-2/worktrees/wt-2/.git',
      { persistent: false },
      expect.any(Function),
    );
  });

  it('ignores a retired watcher after the same target is re-added', async () => {
    await sync([singleRepoItem()]);
    await sync([]);
    await sync([singleRepoItem()]);

    watchers[0]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);
    expect(mockedGetCurrentBranchDisplayName).not.toHaveBeenCalled();

    watchers[1]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);
    expect(mockedGetCurrentBranchDisplayName).toHaveBeenCalledTimes(1);
  });

  it('retains watchers for projects preserved after a partial load', async () => {
    await sync([singleRepoItem('ws-1', 'wt-1')]);

    await syncWorktreeBranchWatchers([], () => windowRef, new Set(['ws-1']));

    expect(watchers[0]?.close).not.toHaveBeenCalled();
    expect(mockedWatch).toHaveBeenCalledTimes(1);
  });

  it('does not install a stale watcher after a newer sync completes', async () => {
    const staleHead = createDeferred<{
      headPath: string;
      branchName: string;
    }>();
    mockedGetGitHeadWatchState
      .mockImplementationOnce(() => staleHead.promise)
      .mockResolvedValueOnce({
        headPath: '/mock/workspaces/ws-2/worktrees/wt-2/.git/HEAD',
        branchName: 'main',
      });

    const staleSync = sync([singleRepoItem('ws-1', 'wt-1')]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedGetGitHeadWatchState).toHaveBeenCalledTimes(1);
    await sync([singleRepoItem('ws-2', 'wt-2')]);

    staleHead.resolve({
      headPath: '/mock/workspaces/ws-1/worktrees/wt-1/.git/HEAD',
      branchName: 'main',
    });
    await staleSync;

    expect(mockedWatch).toHaveBeenCalledTimes(1);
    expect(mockedWatch).toHaveBeenCalledWith(
      '/mock/workspaces/ws-2/worktrees/wt-2/.git',
      { persistent: false },
      expect.any(Function),
    );
  });

  it('debounces HEAD changes and emits only actual branch changes', async () => {
    mockedGetCurrentBranchDisplayName.mockResolvedValueOnce('feature/new-name');

    await sync([singleRepoItem()]);

    watchers[0]?.emitChange('index');
    watchers[0]?.emitChange('HEAD');
    watchers[0]?.emitChange('HEAD');

    await jest.advanceTimersByTimeAsync(99);
    expect(mockedGetCurrentBranchDisplayName).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(1);

    expect(mockedGetCurrentBranchDisplayName).toHaveBeenCalledTimes(1);
    expect(mockedInvalidateWorktreeStats).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      expect.any(Function),
    );
    const persistBranchChange =
      mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    expect(
      persistBranchChange?.({
        id: 'wt-1',
        branchName: 'main',
        createdAt: '2026-05-22T00:00:00.000Z',
        status: 'done',
        lastKnownPrStatus: {
          repos: [],
          lastCheckedAt: '2026-05-22T00:00:00.000Z',
        },
      }),
    ).toEqual({
      id: 'wt-1',
      branchName: 'feature/new-name',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastKnownPrStatus: null,
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      windowRef,
      IPC_CHANNELS.worktreeBranchChanged,
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        branchName: 'feature/new-name',
      },
    );
  });

  it('records nothing when a watched checkout detaches', async () => {
    await sync([singleRepoItem()]);

    // Git reports a detached HEAD as the literal `HEAD`.
    mockedGetCurrentBranchDisplayName.mockResolvedValue('HEAD');
    watchers[0]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);

    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('records the change through the Git observation and keeps a row already in that state', async () => {
    mockedGetCurrentBranchDisplayName.mockResolvedValueOnce('feature/new-name');

    await sync([singleRepoItem()]);
    watchers[0]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);

    const persistBranchChange =
      mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    const alreadyRecorded = {
      id: 'wt-1',
      branchName: 'feature/new-name',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastKnownPrStatus: null,
    };
    // The same row back is the persistence layer's "no write".
    expect(persistBranchChange?.(alreadyRecorded)).toBe(alreadyRecorded);
  });

  it('still tells the renderer about the branch when its persistence fails', async () => {
    mockedGetCurrentBranchDisplayName.mockResolvedValueOnce('feature/new-name');
    mockedUpdateWorkspaceWorktree.mockRejectedValueOnce(new Error('disk full'));

    await sync([singleRepoItem()]);
    watchers[0]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);

    expect(mockedSendToWindow).toHaveBeenCalledWith(
      windowRef,
      IPC_CHANNELS.worktreeBranchChanged,
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        branchName: 'feature/new-name',
      },
    );
  });

  it('does not persist or emit when the branch name is unchanged', async () => {
    mockedGetCurrentBranchDisplayName.mockResolvedValue('main');

    await sync([singleRepoItem()]);
    watchers[0]?.emitChange('HEAD');

    await jest.advanceTimersByTimeAsync(100);

    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
    expect(mockedInvalidateWorktreeStats).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });

  it('clears stale PR metadata without changing the sidebar branch for child repo branch changes', async () => {
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoPath: '/mock/workspaces/ws-1/worktrees/wt-1',
      },
      {
        repoId: 'repo-a',
        repoPath: '/mock/workspaces/ws-1/worktrees/wt-1/repos/repo-a',
      },
    ]);
    mockedGetCurrentBranchDisplayName.mockResolvedValueOnce('feature/repo-a');

    await sync([multiRepoItem()]);

    watchers[1]?.emitChange('HEAD');
    await jest.advanceTimersByTimeAsync(100);

    expect(mockedInvalidateWorktreeStats).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
      'ws-1',
      'wt-1',
      expect.any(Function),
    );
    const persistBranchChange =
      mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
    expect(
      persistBranchChange?.({
        id: 'wt-1',
        branchName: 'main',
        createdAt: '2026-05-22T00:00:00.000Z',
        status: 'done',
        lastKnownPrStatus: {
          repos: [],
          lastCheckedAt: '2026-05-22T00:00:00.000Z',
        },
      }),
    ).toEqual({
      id: 'wt-1',
      branchName: 'main',
      createdAt: '2026-05-22T00:00:00.000Z',
      lastKnownPrStatus: null,
    });
    expect(mockedSendToWindow).toHaveBeenCalledWith(
      windowRef,
      IPC_CHANNELS.worktreeBranchChanged,
      {
        projectId: 'ws-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
        branchName: 'feature/repo-a',
      },
    );
  });

  it('forgets stopped watchers after fs.watch errors', async () => {
    await sync([singleRepoItem()]);

    watchers[0]?.emitError();

    expect(watchers[0]?.close).not.toHaveBeenCalled();

    await sync([singleRepoItem()]);

    expect(watchers).toHaveLength(2);
    expect(watchers[1]?.close).not.toHaveBeenCalled();
  });

  describe('catch-up on start', () => {
    it('records a branch renamed while nothing watched the checkout', async () => {
      mockLiveBranch(RENAMED_BRANCH);

      await sync([
        singleRepoItem('ws-1', 'wt-1', { branchName: DEFAULT_BRANCH }),
      ]);

      expect(watchers).toHaveLength(1);
      expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledTimes(1);
      expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledWith(
        'ws-1',
        'wt-1',
        expect.any(Function),
      );
      const updater = mockedUpdateWorkspaceWorktree.mock.calls[0]?.[2];
      expect(updater?.(persistedRow())).toMatchObject({
        branchName: RENAMED_BRANCH,
      });
      expect(mockedInvalidateWorktreeStats).toHaveBeenCalledWith(
        'ws-1',
        'wt-1',
      );
      expect(branchChangedEvents()).toEqual([
        { projectId: 'ws-1', worktreeId: 'wt-1', branchName: RENAMED_BRANCH },
      ]);
    });

    it('writes and sends nothing when the recorded branch is current', async () => {
      mockLiveBranch(DEFAULT_BRANCH);

      await sync([
        singleRepoItem('ws-1', 'wt-1', { branchName: DEFAULT_BRANCH }),
      ]);

      expect(watchers).toHaveLength(1);
      expect(mockedGetCurrentBranchDisplayName).not.toHaveBeenCalled();
      expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
      expect(mockedSendToWindow).not.toHaveBeenCalled();
    });

    it.each([
      // Git reports a detached HEAD as the literal `HEAD`.
      ['a detached HEAD', 'HEAD'],
      ['a failed branch read', null],
    ])(
      'skips %s but still watches it',
      async (_label, liveBranch: string | null) => {
        mockLiveBranch(liveBranch);

        await sync([
          singleRepoItem('ws-1', 'wt-1', { branchName: DEFAULT_BRANCH }),
        ]);

        expect(watchers).toHaveLength(1);
        expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
        expect(mockedSendToWindow).not.toHaveBeenCalled();

        // A HEAD event while still detached records nothing either.
        watchers[0]?.emitChange('HEAD');
        await jest.advanceTimersByTimeAsync(100);
        expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
        expect(mockedSendToWindow).not.toHaveBeenCalled();
      },
    );

    it.each([
      [
        'not found',
        (): void => void mockedUpdateWorkspaceWorktree.mockResolvedValue(false),
      ],
      [
        'failed',
        (): void =>
          void mockedUpdateWorkspaceWorktree.mockRejectedValue(
            new Error('disk full'),
          ),
      ],
    ])(
      'keeps watching when the catch-up write is %s',
      async (_label, arrangeWrite) => {
        mockLiveBranch(RENAMED_BRANCH);
        arrangeWrite();

        await sync([
          singleRepoItem('ws-1', 'wt-1', { branchName: DEFAULT_BRANCH }),
        ]);

        expect(watchers).toHaveLength(1);
        expect(branchChangedEvents()).toHaveLength(1);

        // The entry now holds the live name, so the same HEAD is a no-op.
        mockedUpdateWorkspaceWorktree.mockClear();
        mockedSendToWindow.mockClear();
        watchers[0]?.emitChange('HEAD');
        await jest.advanceTimersByTimeAsync(100);
        expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
        expect(mockedSendToWindow).not.toHaveBeenCalled();
      },
    );

    it('treats later HEAD events against the caught-up branch', async () => {
      mockLiveBranch(RENAMED_BRANCH);
      await sync([
        singleRepoItem('ws-1', 'wt-1', { branchName: DEFAULT_BRANCH }),
      ]);
      mockedSendToWindow.mockClear();

      watchers[0]?.emitChange('HEAD');
      await jest.advanceTimersByTimeAsync(100);
      expect(mockedSendToWindow).not.toHaveBeenCalled();

      mockedGetCurrentBranchDisplayName.mockResolvedValue('feature/next');
      watchers[0]?.emitChange('HEAD');
      await jest.advanceTimersByTimeAsync(100);
      expect(branchChangedEvents()).toEqual([
        { projectId: 'ws-1', worktreeId: 'wt-1', branchName: 'feature/next' },
      ]);
    });

    it('catches up the root repo of a multi-repo worktree but never a child', async () => {
      const rootPath = '/mock/workspaces/ws-1/worktrees/wt-1';
      const childPath = `${rootPath}/repos/repo-a`;
      mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
        { repoId: WORKSPACE_ROOT_REPO_ID, repoPath: rootPath },
        { repoId: 'repo-a', repoPath: childPath },
      ]);
      const liveBranch = (repoPath: string): string =>
        repoPath === childPath ? 'feature/repo-a' : RENAMED_BRANCH;
      mockedGetGitHeadWatchState.mockImplementation((repoPath) =>
        Promise.resolve({
          headPath: `${repoPath}/.git/HEAD`,
          branchName: liveBranch(repoPath),
        }),
      );
      mockedGetCurrentBranchDisplayName.mockImplementation((repoPath) =>
        Promise.resolve(liveBranch(repoPath)),
      );

      await sync([multiRepoItem({ branchName: DEFAULT_BRANCH })]);

      expect(watchers).toHaveLength(2);
      expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledTimes(1);
      expect(branchChangedEvents()).toEqual([
        {
          projectId: 'ws-1',
          worktreeId: 'wt-1',
          repoId: WORKSPACE_ROOT_REPO_ID,
          branchName: RENAMED_BRANCH,
        },
      ]);
    });

    it('does not watch or read a checkout that is still being created', async () => {
      await sync([
        singleRepoItem('ws-1', 'wt-1', { setupPhase: 'git-pending' }),
      ]);

      expect(mockedGetGitHeadWatchState).not.toHaveBeenCalled();
      expect(watchers).toHaveLength(0);
    });
  });

  describe('ensureWorktreeBranchWatchers', () => {
    const target = {
      projectId: 'ws-1',
      worktreeId: 'wt-1',
      workspaceKind: 'single-repo' as const,
      branchName: 'main',
    };

    async function ensure(
      overrides: Partial<typeof target> = {},
    ): Promise<void> {
      await ensureWorktreeBranchWatchers(
        { ...target, ...overrides },
        () => windowRef,
      );
    }

    it('starts one watcher for a single-repo worktree, once', async () => {
      await ensure();
      await ensure();

      expect(mockedWatch).toHaveBeenCalledTimes(1);
      expect(mockedWatch).toHaveBeenCalledWith(
        '/mock/workspaces/ws-1/worktrees/wt-1/.git',
        { persistent: false },
        expect.any(Function),
      );
    });

    it('records a branch renamed before the checkout became ready', async () => {
      mockLiveBranch(RENAMED_BRANCH);

      await ensure({ branchName: DEFAULT_BRANCH });

      expect(branchChangedEvents()).toEqual([
        { projectId: 'ws-1', worktreeId: 'wt-1', branchName: RENAMED_BRANCH },
      ]);
    });

    it('opens one handle when a sync starts the same key concurrently', async () => {
      const head = createDeferred<{ headPath: string; branchName: string }>();
      mockedGetGitHeadWatchState.mockImplementationOnce(() => head.promise);

      const ensured = ensure();
      await Promise.resolve();
      await Promise.resolve();
      const synced = sync([
        singleRepoItem('ws-1', 'wt-1'),
        singleRepoItem('ws-2', 'wt-2'),
      ]);
      await Promise.resolve();
      head.resolve({
        headPath: '/mock/workspaces/ws-1/worktrees/wt-1/.git/HEAD',
        branchName: 'main',
      });
      await Promise.all([ensured, synced]);

      const ws1Watches = mockedWatch.mock.calls.filter(
        ([path]) => path === '/mock/workspaces/ws-1/worktrees/wt-1/.git',
      );
      expect(ws1Watches).toHaveLength(1);
      expect(watchers).toHaveLength(2);
      expect(watchers[0]?.close).not.toHaveBeenCalled();
    });

    it('is kept by a sync whose snapshot predates git-ready', async () => {
      await ensure();

      await sync([
        singleRepoItem('ws-1', 'wt-1', { setupPhase: 'git-pending' }),
      ]);
      watchers[0]?.emitChange('HEAD');
      await jest.advanceTimersByTimeAsync(100);

      expect(mockedGetCurrentBranchDisplayName).toHaveBeenCalledTimes(1);
    });

    it('starts one watcher per repo of a multi-repo worktree', async () => {
      mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
        {
          repoId: WORKSPACE_ROOT_REPO_ID,
          repoPath: '/mock/workspaces/ws-1/worktrees/wt-1',
        },
        {
          repoId: 'repo-a',
          repoPath: '/mock/workspaces/ws-1/worktrees/wt-1/repos/repo-a',
        },
      ]);

      await ensure({ workspaceKind: 'multi-repo' });

      expect(watchers).toHaveLength(2);
    });

    it('installs nothing after the watchers stop', async () => {
      const head = createDeferred<{ headPath: string; branchName: string }>();
      mockedGetGitHeadWatchState.mockImplementationOnce(() => head.promise);

      const ensured = ensure();
      await Promise.resolve();
      await Promise.resolve();
      stopWorktreeBranchWatchers();
      head.resolve({
        headPath: '/mock/workspaces/ws-1/worktrees/wt-1/.git/HEAD',
        branchName: 'main',
      });
      await ensured;

      expect(mockedWatch).not.toHaveBeenCalled();
    });
  });
});
