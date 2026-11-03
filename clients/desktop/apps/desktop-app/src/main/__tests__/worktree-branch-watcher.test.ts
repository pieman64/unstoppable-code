import type { BrowserWindow } from 'electron';
import type * as PathsModule from '../lib/paths';
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
  ...jest.requireActual<typeof PathsModule>('../lib/paths'),
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

async function useStoredListing(
  dispatcher: DesktopCanopyDispatcher,
  existingRuntime?: DesktopCanopyDispatcher,
): Promise<DesktopCanopyDispatcher> {
  const { createDesktopRuntime } =
    await import('../canopy-runtime/desktop-runtime');
  const runtime = existingRuntime ?? createDesktopRuntime();
  // Finish real filesystem reads before advancing fake observer timers.
  const result = await runtime.queryWorktreeListForLegacyIpc(
    {},
    {
      caller: {
        principalId: 'local-desktop-user',
        clientInstanceId: 'electron-main-branch-observer',
        authorityId: 'local-desktop',
        interfaceKind: 'desktop',
        grants: ['core.worktree.read'],
      },
    },
  );
  expect(result.canonicalResult).not.toBeNull();
  jest
    .spyOn(dispatcher, 'queryWorktreeListForLegacyIpc')
    .mockResolvedValue(result);
  return runtime;
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
  it('keeps all 35 watches when the store cannot read the index, then retires them on proven absence', async () => {
    const { __setDesktopW5FileStoreForTests } =
      await import('../lib/w5-commit-log-file-store');
    listing = {
      version: 1,
      items: Array.from({ length: 35 }, (_, index) =>
        singleRepo(`ws-${index}`),
      ),
    };
    const dispatcher = createDispatcher();
    startWorktreeBranchObserver({ dispatcher, getWindow });
    startWorktreeBranchEnrollment();
    await flush();
    await jest.advanceTimersByTimeAsync(0);
    expect(openStreams()).toHaveLength(35);
    let state: 'unreadable' | 'absent' = 'unreadable';
    __setDesktopW5FileStoreForTests({
      read: () => Promise.resolve({ state }),
      replace: () => Promise.reject(new Error('Read must not write')),
      remove: () => Promise.reject(new Error('Read must not write')),
    });
    const runtime = await useStoredListing(dispatcher);
    try {
      publishWorktreeLifecycleChange('projects-saved');
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(openStreams()).toHaveLength(35);
      state = 'absent';
      await useStoredListing(dispatcher, runtime);
      publishWorktreeLifecycleChange('projects-saved');
      await jest.advanceTimersByTimeAsync(1_000);
      await flush();
      expect(openStreams()).toHaveLength(0);
    } finally {
      await runtime.shutdown();
      __setDesktopW5FileStoreForTests(undefined);
    }
  });

  it('keeps a watch when its worktree list is unreadable even though the index is readable', async () => {
    const { readAllSidebarItemsSnapshot } =
      await import('../lib/sidebar-items');
    const { __setDesktopW5FileStoreForTests } =
      await import('../lib/w5-commit-log-file-store');
    const dispatcher = createDispatcher();
    startWorktreeBranchObserver({ dispatcher, getWindow });
    startWorktreeBranchEnrollment();
    await jest.advanceTimersByTimeAsync(0);
    expect(openStreams()).toHaveLength(1);
    __setDesktopW5FileStoreForTests({
      read: (filePath) =>
        Promise.resolve(
          filePath.endsWith('index.json')
            ? {
                state: 'present',
                raw: JSON.stringify({
                  version: 1,
                  workspaces: [singleRepo('ws-1')],
                }),
              }
            : filePath.endsWith('workspace.json')
              ? {
                  state: 'present',
                  raw: JSON.stringify({
                    version: 1,
                    type: 'single-repo',
                    repoPath: '/repos/ws-1',
                    repos: [],
                  }),
                }
              : { state: 'unreadable' },
        ),
      replace: () => Promise.reject(new Error('Read must not write')),
      remove: () => Promise.reject(new Error('Read must not write')),
    });
    const runtime = await useStoredListing(dispatcher);
    try {
      const snapshot = await readAllSidebarItemsSnapshot({
        persistRemovalCleanup: false,
      });
      expect(snapshot.indexAuthority).toBe('ok');
      expect(snapshot.workspaceReads?.get('ws-1')?.worktrees).toBe(
        'unreadable',
      );
      publishWorktreeLifecycleChange('projects-saved');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(openStreams()).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      __setDesktopW5FileStoreForTests(undefined);
    }
  });

  it.each([
    { fault: 'malformed manifest', phase: 'startup' },
    { fault: 'partial index', phase: 'startup' },
    { fault: 'malformed manifest', phase: 'lifecycle sync' },
    { fault: 'unreadable worktree list', phase: 'lifecycle sync' },
    { fault: 'partial worktree list', phase: 'lifecycle sync' },
    { fault: 'unprojected workspace', phase: 'lifecycle sync' },
  ])(
    'enrolls readable workspaces with a $fault during $phase',
    async ({ fault, phase }) => {
      const { readAllSidebarItemsSnapshot } =
        await import('../lib/sidebar-items');
      const { __setDesktopW5FileStoreForTests } =
        await import('../lib/w5-commit-log-file-store');
      const { getWorkspaceConfigPath, getWorkspaceWorktreesFilePath } =
        await import('../lib/paths');
      const dispatcher = createDispatcher();
      if (phase === 'lifecycle sync') {
        listing = {
          version: 1,
          items: [singleRepo('ws-broken'), singleRepo('ws-removed')],
        };
        startWorktreeBranchObserver({ dispatcher, getWindow });
        startWorktreeBranchEnrollment();
        await flush();
        expect(openStreams()).toHaveLength(2);
      }
      const existingStreams = [...streams];
      let recovered = false;
      __setDesktopW5FileStoreForTests({
        read: (filePath) => {
          if (filePath.endsWith('index.json')) {
            return Promise.resolve({
              state: 'present',
              raw: JSON.stringify({
                version: 1,
                workspaces: [
                  singleRepo('ws-broken'),
                  singleRepo('ws-healthy'),
                  ...(!recovered && fault === 'partial index'
                    ? [{ id: 'ws-invalid', type: 'invalid' }]
                    : []),
                ],
              }),
            });
          }
          if (filePath.endsWith('workspace.json')) {
            return Promise.resolve({
              state: 'present',
              raw:
                !recovered &&
                fault === 'malformed manifest' &&
                filePath === getWorkspaceConfigPath('ws-broken')
                  ? '{"version":'
                  : JSON.stringify({
                      version: 1,
                      type: 'single-repo',
                      repoPath:
                        !recovered &&
                        fault === 'unprojected workspace' &&
                        filePath === getWorkspaceConfigPath('ws-broken')
                          ? 'relative/path'
                          : '/repos/readable',
                      repos: [],
                    }),
            });
          }
          if (filePath.endsWith('worktrees.json')) {
            if (
              recovered &&
              filePath === getWorkspaceWorktreesFilePath('ws-broken')
            ) {
              return Promise.resolve(
                fault === 'unreadable worktree list'
                  ? { state: 'absent' }
                  : {
                      state: 'present',
                      raw: JSON.stringify({ version: 1, worktrees: [] }),
                    },
              );
            }
            if (
              fault === 'unreadable worktree list' &&
              filePath === getWorkspaceWorktreesFilePath('ws-broken')
            ) {
              return Promise.resolve({ state: 'unreadable' });
            }
            return Promise.resolve({
              state: 'present',
              raw: JSON.stringify({
                version: 1,
                worktrees: [
                  {
                    id:
                      fault === 'partial worktree list' &&
                      filePath === getWorkspaceWorktreesFilePath('ws-broken')
                        ? 'wt-new'
                        : 'wt-1',
                    branchName: 'main',
                    createdAt: '2026-10-01T00:00:00Z',
                  },
                  ...(fault === 'partial worktree list' &&
                  filePath === getWorkspaceWorktreesFilePath('ws-broken')
                    ? [null]
                    : []),
                ],
              }),
            });
          }
          return Promise.resolve({ state: 'absent' });
        },
        replace: () => Promise.reject(new Error('Read must not write')),
        remove: () => Promise.reject(new Error('Read must not write')),
      });
      const runtime = await useStoredListing(dispatcher);
      try {
        const snapshot = await readAllSidebarItemsSnapshot({
          persistRemovalCleanup: false,
        });
        expect(snapshot.indexAuthority).toBe(
          fault === 'partial index' ? 'partial' : 'ok',
        );
        expect(snapshot.authority).toBe(
          fault === 'partial index' ||
            fault === 'partial worktree list' ||
            fault === 'unprojected workspace'
            ? 'partial'
            : 'unreadable',
        );
        if (fault === 'malformed manifest') {
          expect(snapshot.workspaceReads.get('ws-broken')?.manifest).toBe(
            'unreadable',
          );
          expect(snapshot.file.warnings).toEqual([
            expect.objectContaining({ workspaceId: 'ws-broken' }),
          ]);
        }
        if (phase === 'startup') {
          startWorktreeBranchObserver({ dispatcher, getWindow });
          startWorktreeBranchEnrollment();
        } else {
          publishWorktreeLifecycleChange('projects-saved');
        }
        await jest.advanceTimersByTimeAsync(1_000);
        await flush();
        const expectedWorkspaceIds =
          fault === 'partial worktree list'
            ? ['ws-broken', 'ws-broken', 'ws-healthy']
            : phase === 'lifecycle sync' || fault === 'partial index'
              ? ['ws-broken', 'ws-healthy']
              : ['ws-healthy'];
        expect(
          openStreams()
            .map((stream) => stream.params.fileRootId)
            .sort(),
        ).toEqual(expectedWorkspaceIds);
        for (const stream of existingStreams) {
          if (stream.params.fileRootId === 'ws-broken') {
            expect(stream.close).not.toHaveBeenCalled();
            expect(openStreams()).toContain(stream);
          } else {
            expect(stream.close).toHaveBeenCalledTimes(1);
          }
        }
        const retainedStreams = openStreams().filter(
          (stream) => stream.params.fileRootId === 'ws-broken',
        );
        recovered = true;
        await useStoredListing(dispatcher, runtime);
        publishWorktreeLifecycleChange('projects-saved');
        await jest.advanceTimersByTimeAsync(1_000);
        expect(openStreams().map((stream) => stream.params.fileRootId)).toEqual(
          ['ws-healthy'],
        );
        for (const stream of retainedStreams) {
          expect(stream.close).toHaveBeenCalledTimes(1);
        }
      } finally {
        await runtime.shutdown();
        __setDesktopW5FileStoreForTests(undefined);
      }
    },
  );

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
