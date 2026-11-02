import type { BrowserWindow } from 'electron';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
  type SidebarItemsFile,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';

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

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/worktree-service', () => ({
  invalidateWorktreeStats: jest.fn(),
}));

jest.mock('../lib/worktree-git-observations', () => ({
  observeWorktreeGit: jest.fn(() => Promise.resolve({ status: 'recorded' })),
}));

jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

import { CanopyOperationError } from '@canopy/core-runtime';
import { getCurrentBranchDisplayName, getGitHeadWatchState } from '../lib/git';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { invalidateWorktreeStats } from '../lib/worktree-service';
import { observeWorktreeGit } from '../lib/worktree-git-observations';
import { sendToWindow } from '../lib/window-send';
import { WorktreeRecordRefusedError } from '../lib/worktree-repair';
import { publishWorktreeGitReady } from '../lib/worktree-git-ready-hooks';
import { publishWorktreeLifecycleChange } from '../lib/worktree-lifecycle-signals';
import {
  recordWorktreeBranchChange,
  startWorktreeBranchEnrollment,
  startWorktreeBranchObserver,
  stopWorktreeBranchWatchers,
} from '../lib/worktree-branch-watcher';

interface FakeStream {
  params: { scope: unknown; fileRootId: string };
  caller: CanopyCallerDescriptor;
  emit(): void;
  end(): void;
  close: jest.Mock;
}

const mockedGetGitHeadWatchState = jest.mocked(getGitHeadWatchState);
const mockedGetCurrentBranchDisplayName = jest.mocked(
  getCurrentBranchDisplayName,
);
const mockedRepoEntries = jest.mocked(listWorkspaceWorktreeRepoEntries);
const mockedObserve = jest.mocked(observeWorktreeGit);
const mockedSend = jest.mocked(sendToWindow);

const windowRef = {} as BrowserWindow;
const getWindow = (): BrowserWindow => windowRef;

let listing: SidebarItemsFile;
let streams: FakeStream[];
let listCallers: CanopyCallerDescriptor[];
let attachFailure: CanopyOperationError | null;
const live = new Map<string, string | null>();

function createDispatcher(): DesktopCanopyDispatcher {
  const dispatcher = {
    queryWorktreeListForLegacyIpc: jest.fn(
      (_params: unknown, options: { caller: CanopyCallerDescriptor }) => {
        listCallers.push(options.caller);
        return Promise.resolve({
          canonicalResult: null,
          legacyResult: listing,
        });
      },
    ),
    openGitHeadWatchForBranchObserver: jest.fn(
      (
        params: FakeStream['params'],
        options: {
          caller: CanopyCallerDescriptor;
          onFrame: (frame: unknown) => void;
        },
      ) => {
        if (attachFailure) {
          const error = attachFailure;
          attachFailure = null;
          const attached = Promise.reject(error);
          return Promise.resolve({ handle: { close: jest.fn() }, attached });
        }
        const close = jest.fn();
        streams.push({
          params,
          caller: options.caller,
          close,
          emit: () =>
            options.onFrame({
              kind: 'item',
              cursor: { daemonEpoch: 'e', sequence: 1 },
              item: { kind: 'modified', relativePath: 'HEAD' },
            }),
          end: () =>
            options.onFrame({
              kind: 'end',
              cursor: { daemonEpoch: 'e', sequence: 1 },
              outcome: 'error',
              error: {
                kind: 'resource_exhausted',
                message: 'buffer',
                retry: { kind: 'never' },
              },
            }),
        });
        return Promise.resolve({
          handle: { close },
          attached: Promise.resolve(),
        });
      },
    ),
  };
  return dispatcher as unknown as DesktopCanopyDispatcher;
}

function singleRepo(
  id: string,
  worktrees: WorktreeData[] = [
    { id: 'wt-1', branchName: 'main', createdAt: '2026-10-01T00:00:00Z' },
  ],
): SidebarItem {
  return {
    type: 'single-repo',
    id,
    name: id,
    repoPath: `/repos/${id}`,
    color: '#123456',
    collapsed: false,
    order: 0,
    worktrees,
  };
}

function multiRepo(id: string): SidebarItem {
  return {
    type: 'multi-repo',
    id,
    name: id,
    color: '#123456',
    repos: [],
    collapsed: false,
    order: 1,
    worktrees: [
      { id: 'wt-2', branchName: 'feature', createdAt: '2026-10-01T00:00:00Z' },
    ],
  };
}

function openStreams(): FakeStream[] {
  return streams.filter((stream) => stream.close.mock.calls.length === 0);
}

async function flush(): Promise<void> {
  for (let index = 0; index < 100; index += 1) await Promise.resolve();
}

/** Starts the observer and enrolls through main's first-paint fallback. */
function startEnrolledObserver(): void {
  startWorktreeBranchObserver({ dispatcher: createDispatcher(), getWindow });
  startWorktreeBranchEnrollment();
}

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  streams = [];
  listCallers = [];
  attachFailure = null;
  live.clear();
  listing = { version: 1, items: [singleRepo('ws-1')] };
  mockedGetGitHeadWatchState.mockImplementation((repoPath) =>
    Promise.resolve({
      headPath: `${repoPath}/.git/HEAD`,
      branchName: live.get(repoPath) ?? 'main',
    }),
  );
  mockedGetCurrentBranchDisplayName.mockImplementation((repoPath) =>
    Promise.resolve(live.get(repoPath) ?? 'main'),
  );
  mockedRepoEntries.mockImplementation((_projectId, worktreePath) =>
    Promise.resolve([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace',
        repoPath: worktreePath,
      },
      {
        repoId: 'api',
        repoName: 'api',
        repoPath: `${worktreePath}/repos/api`,
      },
    ]),
  );
});

afterEach(() => {
  stopWorktreeBranchWatchers();
  jest.useRealTimers();
});

describe('main branch observer composition', () => {
  it('enrolls nothing until the first projects load, then reads membership itself', async () => {
    startWorktreeBranchObserver({ dispatcher: createDispatcher(), getWindow });
    publishWorktreeLifecycleChange('projects-saved');
    await jest.advanceTimersByTimeAsync(1_000);
    expect(listCallers).toEqual([]);

    publishWorktreeLifecycleChange('projects-loaded');
    await flush();
    publishWorktreeLifecycleChange('projects-loaded');
    await flush();

    expect(listCallers).toEqual([
      expect.objectContaining({ grants: ['core.worktree.read'] }),
    ]);
    expect(streams.map((stream) => stream.params)).toEqual([
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-1' },
        fileRootId: 'ws-1',
      },
    ]);
    expect(streams[0]?.caller.grants).toEqual(['worker.filesystem.read']);
  });

  it('enrolls once from the first-paint fallback, and a later load only rereads', async () => {
    startWorktreeBranchObserver({ dispatcher: createDispatcher(), getWindow });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(listCallers).toEqual([]);

    startWorktreeBranchEnrollment();
    startWorktreeBranchEnrollment();
    await flush();
    expect(listCallers).toHaveLength(1);

    // The load after the fallback is a debounced reread, not a second start.
    publishWorktreeLifecycleChange('projects-loaded');
    await flush();
    expect(listCallers).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(listCallers).toHaveLength(2);
    expect(openStreams()).toHaveLength(1);
  });

  it('maps single-repo, multi-repo and pending worktrees to checkouts', async () => {
    listing = {
      version: 1,
      items: [
        singleRepo('ws-1', [
          { id: 'wt-1', branchName: 'main', createdAt: '2026-10-01T00:00:00Z' },
          {
            id: 'wt-3',
            branchName: 'pending',
            createdAt: '2026-10-01T00:00:00Z',
            setupPhase: 'git-pending',
          },
        ]),
        multiRepo('ws-2'),
      ],
    };
    startEnrolledObserver();
    await flush();

    expect(streams.map((stream) => stream.params.fileRootId)).toEqual([
      'ws-1',
      WORKSPACE_ROOT_REPO_ID,
      'api',
    ]);
  });

  it('rereads membership on later lifecycle signals, debounced', async () => {
    startEnrolledObserver();
    await flush();

    listing = { version: 1, items: [] };
    publishWorktreeLifecycleChange('worktree-removal-settled');
    publishWorktreeLifecycleChange('external-snapshot');
    publishWorktreeLifecycleChange('workspace-deleted');
    await jest.advanceTimersByTimeAsync(250);
    await flush();

    expect(listCallers).toHaveLength(2);
    expect(openStreams()).toEqual([]);
  });

  // A split promotes its destination row without git-ready; before CAN-4899
  // the renderer's reload re-synced, so later loads and list writes still do.
  it('watches a checkout that arrives without git-ready on a later load or list write', async () => {
    startEnrolledObserver();
    await flush();

    listing = {
      version: 1,
      items: [
        singleRepo('ws-1', [
          { id: 'wt-1', branchName: 'main', createdAt: '2026-10-01T00:00:00Z' },
          {
            id: 'wt-4',
            branchName: 'split',
            createdAt: '2026-10-02T00:00:00Z',
          },
        ]),
      ],
    };
    publishWorktreeLifecycleChange('projects-loaded');
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(openStreams().map((stream) => stream.params.scope)).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1' },
      { workspaceId: 'ws-1', worktreeId: 'wt-4' },
    ]);

    listing = { version: 1, items: [singleRepo('ws-1')] };
    publishWorktreeLifecycleChange('worktree-list-membership');
    await jest.advanceTimersByTimeAsync(250);
    await flush();
    expect(openStreams().map((stream) => stream.params.scope)).toEqual([
      { workspaceId: 'ws-1', worktreeId: 'wt-1' },
    ]);
  });

  it('starts a ready worktree from the git-ready hook, and stops listening on stop', async () => {
    const dispatcher = createDispatcher();
    startWorktreeBranchObserver({ dispatcher, getWindow });
    const ready = {
      projectId: 'ws-1',
      worktreeId: 'wt-9',
      branchName: 'main',
      worktreeEffective: {},
      workspaceKind: 'single-repo' as const,
    };

    await publishWorktreeGitReady(ready);
    expect(streams.map((stream) => stream.params)).toEqual([
      {
        scope: { workspaceId: 'ws-1', worktreeId: 'wt-9' },
        fileRootId: 'ws-1',
      },
    ]);

    stopWorktreeBranchWatchers();
    expect(openStreams()).toEqual([]);
    await publishWorktreeGitReady(ready);
    expect(streams).toHaveLength(1);
  });

  it('records a HEAD change through the writer, push and stats invalidation', async () => {
    startEnrolledObserver();
    await flush();

    live.set('/mock/workspaces/ws-1/worktrees/wt-1', 'renamed');
    streams[0]?.emit();
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(mockedObserve).toHaveBeenCalledWith({
      kind: 'branch',
      workspaceId: 'ws-1',
      worktreeId: 'wt-1',
      branchName: 'renamed',
    });
    expect(invalidateWorktreeStats).toHaveBeenCalledWith('ws-1', 'wt-1');
    expect(mockedSend).toHaveBeenCalledWith(
      windowRef,
      IPC_CHANNELS.worktreeBranchChanged,
      { projectId: 'ws-1', worktreeId: 'wt-1', branchName: 'renamed' },
    );
    // The observer's own recording never rereads membership.
    expect(listCallers).toHaveLength(1);
  });

  it('holds a branch the branch namer recorded', async () => {
    startEnrolledObserver();
    await flush();

    await recordWorktreeBranchChange(
      { projectId: 'ws-1', worktreeId: 'wt-1', branchName: 'named' },
      getWindow,
    );
    live.set('/mock/workspaces/ws-1/worktrees/wt-1', 'named');
    streams[0]?.emit();
    await jest.advanceTimersByTimeAsync(100);
    await flush();

    expect(mockedObserve).toHaveBeenCalledTimes(1);
  });

  it('drops a refused write but still tells the renderer', async () => {
    mockedObserve.mockRejectedValueOnce(
      new WorktreeRecordRefusedError('invalid-request', 'gone'),
    );

    await recordWorktreeBranchChange(
      { projectId: 'ws-1', worktreeId: 'wt-1', branchName: 'x' },
      getWindow,
    );

    expect(mockedSend).toHaveBeenCalledTimes(1);
  });

  it('reopens a stream that ends and polls a checkout whose watch cannot attach', async () => {
    attachFailure = new CanopyOperationError({
      kind: 'internal',
      message: 'ENOSPC',
      retry: { kind: 'never' },
    });
    listing = { version: 1, items: [singleRepo('ws-1'), singleRepo('ws-2')] };
    startEnrolledObserver();
    await flush();
    expect(streams).toHaveLength(1);

    live.set('/mock/workspaces/ws-1/worktrees/wt-1', 'polled');
    await jest.advanceTimersByTimeAsync(2_000);
    await flush();
    expect(mockedObserve).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', branchName: 'polled' }),
    );

    streams[0]?.end();
    await jest.advanceTimersByTimeAsync(100);
    await flush();
    expect(streams).toHaveLength(2);
  });
});
