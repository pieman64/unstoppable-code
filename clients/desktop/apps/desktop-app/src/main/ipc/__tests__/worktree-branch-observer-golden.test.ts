/**
 * CAN-4899 golden: Git HEAD/branch observation pinned at the project IPC and
 * main composition boundary. Captured on the pre-migration branch watcher and
 * kept unmodified across the move into core-runtime, so module-level tests can
 * move with the code without losing the legacy contract.
 *
 * Pinned: one native HEAD watch per checkout across load, save and git-ready;
 * the exact `internal.worktree.git.observe` inputs, `worktree:branch-changed`
 * payloads and stats invalidations; removed checkouts retired (never closed);
 * preserved workspaces kept; multi-repo checkouts the root catalog does not
 * mark Git-aware still observed, whatever their `repos/` directory is named;
 * and no recording after quit.
 */
import type { BrowserWindow } from 'electron';
import type * as NodeFs from 'node:fs';
import type * as GitModule from '../../lib/git';
import type * as PathsModule from '../../lib/paths';
import type { CanopyCallerDescriptor } from '@canopy/protocol/canopy-core';
import {
  IPC_CHANNELS,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
  type SidebarItemsFile,
} from '@canopy/desktop-shared/types';
import type { FileBrowserRoot } from '../../lib/file-browser-roots';

interface FakeWatcher {
  path: string;
  listener: (eventType: string, filename: string | null) => void;
  close: jest.Mock;
  closed: boolean;
}

const watchers: FakeWatcher[] = [];

jest.mock('node:fs', () => {
  const actual = jest.requireActual<typeof NodeFs>('node:fs');
  return {
    ...actual,
    watch: jest.fn(
      (
        path: string,
        _options: unknown,
        listener: (eventType: string, filename: string | null) => void,
      ) => {
        const watcher: FakeWatcher = {
          path,
          listener,
          closed: false,
          close: jest.fn(() => {
            watcher.closed = true;
          }),
        };
        watchers.push(watcher);
        const handle = {
          close: watcher.close,
          on: (): unknown => handle,
        };
        return handle;
      },
    ),
  };
});

const WORKTREES_ROOT = '/golden/workspaces';
function worktreeDir(projectId: string, worktreeId: string): string {
  return `${WORKTREES_ROOT}/${projectId}/worktrees/${worktreeId}`;
}

jest.mock('../../lib/paths', () => ({
  ...jest.requireActual<typeof PathsModule>('../../lib/paths'),
  getWorkspaceWorktreeDir: (projectId: string, worktreeId: string): string =>
    `/golden/workspaces/${projectId}/worktrees/${worktreeId}`,
  getWorkspaceWorktreeRepoDir: (
    projectId: string,
    worktreeId: string,
    repoDirName: string,
  ): string =>
    `/golden/workspaces/${projectId}/worktrees/${worktreeId}/repos/${repoDirName}`,
}));

/** Live HEAD per checkout path; a missing entry is a failed read. */
const liveBranches = new Map<string, string | null>();
/** The `repos/` directories of ws-c's worktree, as `readdir` lists them. */
const legacyRepoDirs: string[] = [];
/** ws-c's file browser also shows an attachments root. */
let legacyAttachmentsVisible = false;

jest.mock('../../lib/git', () => ({
  ...jest.requireActual<typeof GitModule>('../../lib/git'),
  getGitHeadWatchState: jest.fn((repoPath: string) =>
    Promise.resolve({
      headPath: `${repoPath}/.git/HEAD`,
      branchName: liveBranches.get(repoPath) ?? null,
    }),
  ),
  getCurrentBranchDisplayName: jest.fn((repoPath: string) =>
    Promise.resolve(liveBranches.get(repoPath) ?? null),
  ),
  isGitRepo: jest.fn((dir: string) => Promise.resolve(liveBranches.has(dir))),
}));

jest.mock('../../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(
    (projectId: string, worktreePath: string) => {
      const rootEntry = {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace',
        repoPath: worktreePath,
      };
      if (projectId === 'ws-b')
        return Promise.resolve([
          rootEntry,
          {
            repoId: 'api',
            repoName: 'api',
            repoPath: `${worktreePath}/repos/api`,
          },
        ]);
      // A pre-source-backing root that is a Git checkout, and a checkout
      // `workspace:remove-repo` left behind: both listed by the repo entries.
      if (projectId === 'ws-c')
        return Promise.resolve([
          rootEntry,
          ...legacyRepoDirs.map((name) => ({
            repoId: name,
            repoName: name,
            repoPath: `${worktreePath}/repos/${name}`,
          })),
        ]);
      return Promise.resolve([]);
    },
  ),
}));

jest.mock('../../lib/file-browser-roots', () => ({
  getFileBrowserRoots: jest.fn(),
  getFileBrowserSupplementalWatchPaths: jest.fn(() => []),
}));

jest.mock('../../lib/worktree-service', () => ({
  invalidateWorktreeStats: jest.fn(),
}));

jest.mock('../../lib/worktree-git-observations', () => ({
  observeWorktreeGit: jest.fn(() => Promise.resolve({ status: 'recorded' })),
}));

jest.mock('../../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));

let persisted: SidebarItemsFile = { version: 1, items: [] };

jest.mock('../../lib/sidebar-save-adapter', () => ({
  saveSidebarItems: jest.fn(({ items }: { items: SidebarItem[] }) => {
    persisted = { version: 1, items };
    return Promise.resolve({ version: 1, items });
  }),
}));

jest.mock('../../lib/workspace-source-control', () => ({
  repairExistingWorkspaceRootWorktrees: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/workspace-reference-repo-poller', () => ({
  startPolling: jest.fn(),
  syncTrackedWorkspaces: jest.fn(),
}));
jest.mock('../../lib/code-graph-base-manager', () => ({
  startCodeGraphBaseManager: jest.fn(),
  syncCodeGraphBaseRepositories: jest.fn(),
}));
jest.mock('../../lib/github-poller', () => ({
  syncTrackedWorktrees: jest.fn(),
  reconcileTrackedWorkspaceWorktrees: jest.fn(() => ({
    removedWorktreeIds: [],
  })),
}));
jest.mock('../../lib/worktree-boot-recovery', () => ({
  reconcileGitPendingWorktrees: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/workspace-deletion', () => ({
  deleteWorkspace: jest.fn(),
}));
jest.mock('../../lib/worktrees-file-watcher', () => ({
  syncWorktreesFileWatchers: jest.fn(),
}));
jest.mock('../../lib/worktree-registry-reconciliation', () => ({
  reconcileExternalWorktreeSnapshot: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../lib/chat-badge-sync', () => ({
  backfillMissingWorktreeChatBadges: jest.fn(() => Promise.resolve()),
}));

type Handler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, Handler>();
jest.mock('../register', () => ({
  registerIpcHandler: (channel: string, handler: Handler): void => {
    handlers.set(channel, handler);
  },
}));

import { watch } from 'node:fs';
import { getFileBrowserRoots } from '../../lib/file-browser-roots';
import { invalidateWorktreeStats } from '../../lib/worktree-service';
import { observeWorktreeGit } from '../../lib/worktree-git-observations';
import { sendToWindow } from '../../lib/window-send';
import { publishWorktreeGitReady } from '../../lib/worktree-git-ready-hooks';
import * as branchWatcher from '../../lib/worktree-branch-watcher';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../../canopy-runtime/desktop-runtime';
import { LOCAL_DESKTOP_AUTHORITY_ID } from '../../canopy-runtime/desktop-runtime-identity';
import { registerProjectHandlers } from '../projects';

const mockedWatch = jest.mocked(watch);
const mockedObserve = jest.mocked(observeWorktreeGit);
const mockedInvalidate = jest.mocked(invalidateWorktreeStats);
const mockedSend = jest.mocked(sendToWindow);

// sendToWindow is mocked; this identity-only stand-in has no BrowserWindow APIs.
const windowRef = { id: 'golden-window' } as unknown as BrowserWindow;
const getWindow = jest.fn<BrowserWindow | null, []>(() => windowRef);

function rendererCaller(): CanopyCallerDescriptor {
  return {
    principalId: 'local',
    clientInstanceId: 'golden-renderer',
    authorityId: LOCAL_DESKTOP_AUTHORITY_ID,
    interfaceKind: 'desktop',
    grants: ['core.workspace.read', 'core.worktree.read'],
  };
}

function singleRepo(): SidebarItem {
  return {
    type: 'single-repo',
    id: 'ws-a',
    name: 'ws-a',
    repoPath: '/golden/repos/ws-a',
    color: '#123456',
    collapsed: false,
    order: 0,
    worktrees: [
      { id: 'wt-1', branchName: 'main', createdAt: '2026-10-01T00:00:00Z' },
      {
        id: 'wt-3',
        branchName: 'pending-branch',
        createdAt: '2026-10-02T00:00:00Z',
        setupPhase: 'git-pending',
      },
    ],
  };
}

function multiRepo(): SidebarItem {
  return {
    type: 'multi-repo',
    id: 'ws-b',
    name: 'ws-b',
    color: '#654321',
    repos: [],
    collapsed: false,
    order: 1,
    worktrees: [
      {
        id: 'wt-2',
        branchName: 'feature/b',
        createdAt: '2026-10-03T00:00:00Z',
      },
    ],
  };
}

function legacyMultiRepo(): SidebarItem {
  return {
    type: 'multi-repo',
    id: 'ws-c',
    name: 'ws-c',
    color: '#abcdef',
    repos: [],
    collapsed: false,
    order: 2,
    worktrees: [
      {
        id: 'wt-4',
        branchName: 'legacy-main',
        createdAt: '2026-10-04T00:00:00Z',
      },
    ],
  };
}

/** wt-3 after git-ready: its checkout exists and setup moved on. */
function readySingleRepo(): SidebarItem {
  const item = singleRepo();
  if (item.type === 'cowork') throw new Error('unexpected cowork item');
  return {
    ...item,
    worktrees: item.worktrees.map((worktree) =>
      worktree.id === 'wt-3'
        ? {
            id: 'wt-3',
            branchName: 'pending-branch',
            createdAt: '2026-10-02T00:00:00Z',
          }
        : worktree,
    ),
  };
}

const WT1 = worktreeDir('ws-a', 'wt-1');
const WT2 = worktreeDir('ws-b', 'wt-2');
const WT2_API = `${WT2}/repos/api`;
const WT3 = worktreeDir('ws-a', 'wt-3');
const WT4 = worktreeDir('ws-c', 'wt-4');
const WT4_OLD = `${WT4}/repos/old`;
// A hand-made directory: its name is not a valid repo id.
const WT4_HAND_MADE = `${WT4}/repos/Old Checkout`;

function gitDir(repoPath: string): string {
  return `${repoPath}/.git`;
}

function gitAwareRoot(repoId: string, absolutePath: string): FileBrowserRoot {
  return {
    repoId,
    repoName: repoId,
    absolutePath,
    rootKind: 'git-repo',
    gitAware: true,
    excludedDescendantRoots: [],
  };
}

function rootsFor(projectId: string, worktreeId: string): FileBrowserRoot[] {
  const dir = worktreeDir(projectId, worktreeId);
  // No `sourceRepoPath`, and `old` is no longer in workspace.json.
  if (projectId === 'ws-c')
    return [
      {
        ...gitAwareRoot(WORKSPACE_ROOT_REPO_ID, dir),
        rootKind: 'workspace-root',
        gitAware: false,
      },
      ...(legacyAttachmentsVisible
        ? [
            {
              ...gitAwareRoot(
                'attachments',
                `/golden/attachments/${worktreeId}`,
              ),
              rootKind: 'attachments' as const,
              gitAware: false,
            },
          ]
        : []),
    ];
  return projectId === 'ws-b'
    ? [
        gitAwareRoot(WORKSPACE_ROOT_REPO_ID, dir),
        gitAwareRoot('api', `${dir}/repos/api`),
      ]
    : [gitAwareRoot(projectId, dir)];
}

function liveWatchPaths(): string[] {
  return watchers
    .filter((watcher) => !watcher.closed)
    .map((watcher) => watcher.path)
    .sort();
}

function headWatchCalls(): string[] {
  return mockedWatch.mock.calls.map(([path]) => String(path)).sort();
}

/** A HEAD rewrite as the native watcher reports it. */
function moveHead(repoPath: string, branchName: string | null): void {
  liveBranches.set(repoPath, branchName);
  const live = watchers.filter(
    (watcher) => watcher.path === gitDir(repoPath) && !watcher.closed,
  );
  if (live.length === 0) throw new Error(`No HEAD watch for ${repoPath}`);
  for (const watcher of live) watcher.listener('change', 'HEAD');
}

function branchChangedPayloads(): unknown[] {
  return mockedSend.mock.calls
    .filter(([, channel]) => channel === IPC_CHANNELS.worktreeBranchChanged)
    .map(([window, , payload]) => ({ window, payload }));
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let elapsed = 0; elapsed < 3_000; elapsed += 10) {
    if (condition()) return;
    await sleep(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

/** Long enough for any debounce or HEAD refresh to have run. */
async function settle(): Promise<void> {
  await sleep(700);
}

function handler(channel: string): Handler {
  const found = handlers.get(channel);
  if (!found) throw new Error(`No handler for ${channel}`);
  return found;
}

async function load(): Promise<void> {
  await handler(IPC_CHANNELS.projectsLoad)(undefined);
}

async function save(items: SidebarItem[]): Promise<void> {
  await handler(IPC_CHANNELS.projectsSave)(undefined, items);
}

function publishLegacyEffectiveGitReady(
  event: Omit<
    Parameters<typeof publishWorktreeGitReady>[0],
    'worktreeEffective'
  >,
): Promise<void> {
  const legacyEvent = { ...event, worktreeEffective: {} };
  Reflect.set(legacyEvent, 'worktreeEffective', true);
  return publishWorktreeGitReady(legacyEvent);
}

let runtime: DesktopCanopyDispatcher;

/**
 * Main's composition. Before CAN-4899 the project handlers owned branch
 * watching; after it, main also starts the observer once the runtime accepts.
 */
function bootMain(): void {
  registerProjectHandlers(getWindow, runtime, rendererCaller);
  const start: unknown = Reflect.get(
    branchWatcher,
    'startWorktreeBranchObserver',
  );
  if (typeof start === 'function')
    Reflect.apply(start, undefined, [{ dispatcher: runtime, getWindow }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  watchers.length = 0;
  handlers.clear();
  liveBranches.clear();
  liveBranches.set(WT1, 'main');
  liveBranches.set(WT2, 'feature/b');
  liveBranches.set(WT2_API, 'main');
  liveBranches.set(WT3, 'pending-branch');
  legacyRepoDirs.splice(0, legacyRepoDirs.length, 'old');
  legacyAttachmentsVisible = false;
  persisted = { version: 1, items: [singleRepo(), multiRepo()] };
  // Each test is a fresh launch: native handles never outlive a runtime.
  runtime = createDesktopRuntime({
    workspaceServices: {
      readAllSidebarItems: () => Promise.resolve(persisted),
      readWorkspaceIndexEntry: jest.fn(),
      readWorkspaceConfig: jest.fn(),
      readWorkspaceWorktrees: jest.fn(),
      readEffectiveWorkspaceConfig: jest.fn(),
    },
  });
  jest
    .mocked(getFileBrowserRoots)
    .mockImplementation((projectId: string, worktreeId: string) => {
      const roots = rootsFor(projectId, worktreeId);
      return Promise.resolve({
        roots,
        rootMap: new Map(roots.map((root) => [root.repoId, root])),
      });
    });
  bootMain();
});

afterEach(async () => {
  branchWatcher.stopWorktreeBranchWatchers();
  await runtime.shutdown();
});

describe('CAN-4899 golden: branch observation at the main boundary', () => {
  it('keeps one native HEAD watch per checkout across load, save and git-ready', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();
    // The git-pending checkout has no HEAD to watch yet.
    expect(headWatchCalls()).toEqual(
      [gitDir(WT1), gitDir(WT2), gitDir(WT2_API)].sort(),
    );

    await load();
    await save([singleRepo(), multiRepo()]);
    await settle();
    expect(headWatchCalls()).toHaveLength(3);

    await publishLegacyEffectiveGitReady({
      projectId: 'ws-a',
      worktreeId: 'wt-3',
      branchName: 'pending-branch',
      workspaceKind: 'single-repo',
    });
    await waitFor(() => headWatchCalls().length === 4, 'the git-ready watch');
    expect(headWatchCalls()).toContain(gitDir(WT3));

    // A second git-ready, and the checkout's later ready row, start nothing.
    await publishLegacyEffectiveGitReady({
      projectId: 'ws-a',
      worktreeId: 'wt-3',
      branchName: 'pending-branch',
      workspaceKind: 'single-repo',
    });
    await save([readySingleRepo(), multiRepo()]);
    await load();
    await settle();
    expect(headWatchCalls()).toHaveLength(4);
    expect(liveWatchPaths()).toEqual(
      [gitDir(WT1), gitDir(WT2), gitDir(WT2_API), gitDir(WT3)].sort(),
    );
    // Nothing moved, so nothing was recorded.
    expect(mockedObserve).not.toHaveBeenCalled();
    expect(branchChangedPayloads()).toEqual([]);
  });

  it('records a HEAD branch change with the exact observation, push and invalidation', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    moveHead(WT1, 'feature/renamed');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the record');
    moveHead(WT2_API, 'api-branch');
    await waitFor(
      () => mockedObserve.mock.calls.length === 2,
      'the repo record',
    );
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'feature/renamed',
        },
      ],
      [
        {
          kind: 'branch',
          workspaceId: 'ws-b',
          worktreeId: 'wt-2',
          branchName: 'api-branch',
          repoId: 'api',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'feature/renamed',
        },
      },
      {
        window: windowRef,
        payload: {
          projectId: 'ws-b',
          worktreeId: 'wt-2',
          branchName: 'api-branch',
          repoId: 'api',
        },
      },
    ]);
    expect(mockedInvalidate.mock.calls).toEqual([
      ['ws-a', 'wt-1'],
      ['ws-b', 'wt-2'],
    ]);
  });

  it('ignores a detached HEAD and an unchanged branch', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    moveHead(WT1, 'HEAD');
    await settle();
    moveHead(WT1, 'main');
    await settle();

    expect(mockedObserve).not.toHaveBeenCalled();
    expect(branchChangedPayloads()).toEqual([]);
    expect(mockedInvalidate).not.toHaveBeenCalled();
  });

  it('records a branch renamed while nothing watched the checkout', async () => {
    liveBranches.set(WT1, 'renamed-offline');
    await load();
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the catch-up');
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'renamed-offline',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'renamed-offline',
        },
      },
    ]);
    expect(mockedInvalidate.mock.calls).toEqual([['ws-a', 'wt-1']]);
  });

  it('retires removed checkouts without closing them and records once when re-added', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    await save([singleRepo()]);
    await settle();
    // Closing a native HEAD watcher can block main on macOS: never on removal.
    expect(watchers.filter((watcher) => watcher.closed)).toEqual([]);
    for (const watcher of watchers.filter(
      (entry) => entry.path === gitDir(WT2_API),
    ))
      watcher.listener('change', 'HEAD');
    liveBranches.set(WT2_API, 'moved-while-removed');
    await settle();
    expect(mockedObserve).not.toHaveBeenCalled();

    await save([singleRepo(), multiRepo()]);
    await settle();
    // A repository has no persisted branch of its own to catch up from.
    expect(mockedObserve).not.toHaveBeenCalled();
    moveHead(WT2_API, 'second-move');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'one record');
    await settle();
    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-b',
          worktreeId: 'wt-2',
          branchName: 'second-move',
          repoId: 'api',
        },
      ],
    ]);
    expect(watchers.filter((watcher) => watcher.closed)).toEqual([]);
  });

  it('keeps observing a workspace that failed to load', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    persisted = {
      version: 1,
      items: [singleRepo()],
      preservedWorkspaceIds: ['ws-b'],
    };
    await load();
    await settle();

    moveHead(WT2, 'still-watched');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the record');
    expect(mockedObserve).toHaveBeenCalledWith({
      kind: 'branch',
      workspaceId: 'ws-b',
      worktreeId: 'wt-2',
      branchName: 'still-watched',
      repoId: WORKSPACE_ROOT_REPO_ID,
    });
  });

  it('records branch switches in multi-repo checkouts outside workspace.json source backing', async () => {
    liveBranches.set(WT4, 'legacy-main');
    liveBranches.set(WT4_OLD, 'old-main');
    persisted = { version: 1, items: [legacyMultiRepo()] };
    await load();
    await waitFor(() => headWatchCalls().length === 2, 'two HEAD watches');
    await settle();
    expect(headWatchCalls()).toEqual([gitDir(WT4), gitDir(WT4_OLD)].sort());

    moveHead(WT4, 'manual-switch');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the record');
    moveHead(WT4_OLD, 'old-switch');
    await waitFor(
      () => mockedObserve.mock.calls.length === 2,
      'the repo record',
    );
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'manual-switch',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
      ],
      [
        {
          kind: 'branch',
          workspaceId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'old-switch',
          repoId: 'old',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'manual-switch',
          repoId: WORKSPACE_ROOT_REPO_ID,
        },
      },
      {
        window: windowRef,
        payload: {
          projectId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'old-switch',
          repoId: 'old',
        },
      },
    ]);
  });

  it('records a branch switch in a repos/ directory whose name is not a repo id', async () => {
    legacyRepoDirs.push('Old Checkout');
    liveBranches.set(WT4, 'legacy-main');
    liveBranches.set(WT4_OLD, 'old-main');
    liveBranches.set(WT4_HAND_MADE, 'hand-main');
    persisted = { version: 1, items: [legacyMultiRepo()] };
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();
    expect(headWatchCalls()).toEqual(
      [gitDir(WT4), gitDir(WT4_OLD), gitDir(WT4_HAND_MADE)].sort(),
    );

    moveHead(WT4_HAND_MADE, 'hand-switch');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the record');
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'hand-switch',
          repoId: 'Old Checkout',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'hand-switch',
          repoId: 'Old Checkout',
        },
      },
    ]);
  });

  it('records a branch switch in a repos/ checkout named like the attachments root', async () => {
    legacyRepoDirs.push('attachments');
    legacyAttachmentsVisible = true;
    const retained = `${WT4}/repos/attachments`;
    liveBranches.set(WT4, 'legacy-main');
    liveBranches.set(WT4_OLD, 'old-main');
    liveBranches.set(retained, 'kept-main');
    persisted = { version: 1, items: [legacyMultiRepo()] };
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();
    expect(headWatchCalls()).toEqual(
      [gitDir(WT4), gitDir(WT4_OLD), gitDir(retained)].sort(),
    );

    moveHead(retained, 'kept-switch');
    await waitFor(() => mockedObserve.mock.calls.length === 1, 'the record');
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'kept-switch',
          repoId: 'attachments',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-c',
          worktreeId: 'wt-4',
          branchName: 'kept-switch',
          repoId: 'attachments',
        },
      },
    ]);
  });

  it('holds a branch the branch namer recorded so its HEAD event is a no-op', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    await branchWatcher.recordWorktreeBranchChange(
      { projectId: 'ws-a', worktreeId: 'wt-1', branchName: 'named/branch' },
      getWindow,
    );
    moveHead(WT1, 'named/branch');
    await settle();

    expect(mockedObserve.mock.calls).toEqual([
      [
        {
          kind: 'branch',
          workspaceId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'named/branch',
        },
      ],
    ]);
    expect(branchChangedPayloads()).toEqual([
      {
        window: windowRef,
        payload: {
          projectId: 'ws-a',
          worktreeId: 'wt-1',
          branchName: 'named/branch',
        },
      },
    ]);
    expect(mockedInvalidate.mock.calls).toEqual([['ws-a', 'wt-1']]);
  });

  it('records nothing after quit stops observation', async () => {
    await load();
    await waitFor(() => headWatchCalls().length === 3, 'three HEAD watches');
    await settle();

    branchWatcher.stopWorktreeBranchWatchers();
    for (const watcher of watchers) watcher.listener('change', 'HEAD');
    liveBranches.set(WT1, 'after-quit');
    await settle();

    expect(mockedObserve).not.toHaveBeenCalled();
    expect(branchChangedPayloads()).toEqual([]);
  });
});
