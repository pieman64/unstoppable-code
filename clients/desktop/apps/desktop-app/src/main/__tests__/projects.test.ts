import '../../__tests__/worktree-replica-compatibility';
import type * as DesktopRuntimeModule from '../canopy-runtime/desktop-runtime';
import type {
  DeleteProjectRequest,
  ProjectApplySourceChangesRequest,
  ProjectApplySourceChangesResponse,
  ProjectData,
  SidebarItem,
  SidebarItemsFile,
  SidebarItemsSaveOptions,
  SaveDefaultPluginsRequest,
  SingleRepoSidebarItem,
  WorktreeData,
} from '@canopy/desktop-shared/types';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  WORKSPACE_ROOT_REPO_ID,
} from '@canopy/desktop-shared/types';
import type * as FsPromises from 'node:fs/promises';
import type * as WorkspacePersistence from '../lib/workspace-persistence';

const mockReconcileGitPendingWorktrees = jest.fn();
const mockCountArchivedContainers = jest.fn();
const mockResolveProjectScripts = jest.fn();
const mockResolveProjectHooks = jest.fn();

jest.mock('node:fs/promises');
// The worktree registry is written atomically; route it through the mocked
// writeFile so registry assertions observe the published payload.
jest.mock('../lib/atomic-file', () => ({
  writeFileAtomically: jest.fn(
    (target: string, data: string, options?: { encoding?: BufferEncoding }) =>
      jest
        .requireMock<typeof FsPromises>('node:fs/promises')
        .writeFile(target, data, options?.encoding ?? 'utf8'),
  ),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceIndexFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getProjectsFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getProjectWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getProjectDir: jest.fn((id: string) => `/mock/workspaces/${id}`),
  getDefaultReposDir: jest.fn(() => '/mock/repos'),
  getWorkspacesFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getWorkspaceWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getWorkspaceConfigPath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/workspace.json`,
  ),
}));
jest.mock('../lib/path-safety', () => ({
  isPathInside: jest.fn(
    (parentDir: string, childPath: string) =>
      childPath.startsWith(parentDir + '/') || childPath === parentDir,
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  getWorkspaceExternalPath: jest.fn(() => null),
  registerWorkspaceTypes: jest.fn(),
  registerWorkspaceExternalPaths: jest.fn(),
}));
jest.mock('../lib/workspace-source-control', () => ({
  repairExistingWorkspaceRootWorktrees: jest.fn(),
}));
jest.mock('../lib/script-resolver', () => ({
  get resolveProjectScripts(): typeof mockResolveProjectScripts {
    return mockResolveProjectScripts;
  },
  resolveWorkspaceRepoScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(() => undefined),
}));
jest.mock('../lib/hook-resolver', () => ({
  get resolveProjectHooks(): typeof mockResolveProjectHooks {
    return mockResolveProjectHooks;
  },
  resolveWorkspaceRepoDataHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(() => undefined),
}));
jest.mock('../lib/workspace-reference-repo-poller', () => ({
  startPolling: jest.fn(),
  syncTrackedWorkspaces: jest.fn(),
}));
jest.mock('../lib/code-graph-base-manager', () => ({
  startCodeGraphBaseManager: jest.fn(),
  syncCodeGraphBaseRepositories: jest.fn(),
}));
jest.mock('../lib/repo-shadow', () => ({
  cleanupUnreferencedRepoShadows: jest.fn().mockResolvedValue(undefined),
  getBaselineReadPath: jest.fn((repoPath: string) => Promise.resolve(repoPath)),
}));
jest.mock('../lib/github-poller', () => ({
  syncTrackedWorktrees: jest.fn(),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn((sourceRepoPath: string) =>
    Promise.resolve(sourceRepoPath),
  ),
}));
jest.mock('../lib/project-source-change-apply', () => ({
  applyProjectSourceChangesToWorktree: jest.fn(),
}));
jest.mock('../lib/worktree-boot-recovery', () => ({
  get reconcileGitPendingWorktrees(): typeof mockReconcileGitPendingWorktrees {
    return mockReconcileGitPendingWorktrees;
  },
}));
jest.mock('../lib/workspace-deletion', () => ({
  deleteWorkspace: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => {
  const actual = jest.requireActual<typeof WorkspacePersistence>(
    '../lib/workspace-persistence',
  );
  return Object.defineProperties(
    {},
    {
      ...Object.getOwnPropertyDescriptors(actual),
      updateWorkspaceWorktrees: {
        value: jest.fn(),
        enumerable: true,
      },
    },
  );
});
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../lib/archived-containers', () => ({
  get countArchivedContainers(): typeof mockCountArchivedContainers {
    return mockCountArchivedContainers;
  },
}));
jest.mock('../lib/cowork-work-entries-file', () => ({
  readWorkEntryCount: jest.fn().mockResolvedValue(0),
  readWorkEntrySidebarSummary: jest.fn().mockResolvedValue({ count: 0 }),
}));
jest.mock('../lib/worktree-lifecycle-signals', () => ({
  publishWorktreeLifecycleChange: jest.fn(),
}));
let capturedExternalSnapshotCallback:
  | ((workspaceId: string, worktrees: readonly WorktreeData[]) => void)
  | undefined;
const mockSyncWorktreesFileWatchers = jest.fn(
  (
    _items: SidebarItem[],
    _getWindow: () => unknown,
    _preserveWorkspaceIds?: ReadonlySet<string>,
    callback?: (
      workspaceId: string,
      worktrees: readonly WorktreeData[],
    ) => void,
  ): void => {
    capturedExternalSnapshotCallback = callback;
  },
);
jest.mock('../lib/worktrees-file-watcher', () => ({
  get syncWorktreesFileWatchers(): typeof mockSyncWorktreesFileWatchers {
    return mockSyncWorktreesFileWatchers;
  },
}));
const mockReconcileExternalWorktreeSnapshot = jest.fn(() => Promise.resolve());
jest.mock('../lib/worktree-registry-reconciliation', () => ({
  get reconcileExternalWorktreeSnapshot(): typeof mockReconcileExternalWorktreeSnapshot {
    return mockReconcileExternalWorktreeSnapshot;
  },
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { registerIpcHandler } from '../ipc/register';
import { registerProjectHandlers } from '../ipc/projects';
import * as sidebarItems from '../lib/sidebar-items';
import * as sidebarSaveAdapter from '../lib/sidebar-save-adapter';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import { applyProjectSourceChangesToWorktree } from '../lib/project-source-change-apply';
import {
  startPolling,
  syncTrackedWorkspaces,
} from '../lib/workspace-reference-repo-poller';
import { syncTrackedWorktrees } from '../lib/github-poller';
import { syncCodeGraphBaseRepositories } from '../lib/code-graph-base-manager';
import { repairExistingWorkspaceRootWorktrees } from '../lib/workspace-source-control';
import { updateWorkspaceWorktrees } from '../lib/workspace-persistence';
import { deleteWorkspace } from '../lib/workspace-deletion';
import { readPreferencesFile } from '../lib/preferences-store';
import { publishWorktreeLifecycleChange } from '../lib/worktree-lifecycle-signals';
import { syncWorktreesFileWatchers } from '../lib/worktrees-file-watcher';
import { allowsW5ProjectionOnlyRead } from '../lib/w5-fallback-read';

const mockedReadFile = jest.mocked(readFile);
const mockedDeleteWorkspace = jest.mocked(deleteWorkspace);
const mockedWriteFile = jest.mocked(writeFile);
const mockedMkdir = jest.mocked(mkdir);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedStartPolling = jest.mocked(startPolling);
const mockedSyncTrackedWorkspaces = jest.mocked(syncTrackedWorkspaces);
const mockedSyncTrackedWorktrees = jest.mocked(syncTrackedWorktrees);
const mockedSyncCodeGraphBaseRepositories = jest.mocked(
  syncCodeGraphBaseRepositories,
);
const mockedPublishWorktreeLifecycleChange = jest.mocked(
  publishWorktreeLifecycleChange,
);
const mockedSyncWorktreesFileWatchers = jest.mocked(syncWorktreesFileWatchers);
const mockedApplyProjectSourceChangesToWorktree = jest.mocked(
  applyProjectSourceChangesToWorktree,
);
const mockedRepairExistingWorkspaceRootWorktrees = jest.mocked(
  repairExistingWorkspaceRootWorktrees,
);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);

type LoadHandler = (event?: unknown) => Promise<SidebarItemsFile>;
type SaveHandler = (
  _event: unknown,
  items: SidebarItem[],
  options?: SidebarItemsSaveOptions,
) => Promise<SidebarItemsFile>;
type ApplySourceChangesHandler = (
  _event: unknown,
  request: ProjectApplySourceChangesRequest,
) => Promise<ProjectApplySourceChangesResponse>;
type SaveDefaultPluginsHandler = (
  _event: unknown,
  request: SaveDefaultPluginsRequest,
) => Promise<void>;
type DeleteHandler = (
  _event: unknown,
  request: DeleteProjectRequest,
) => Promise<void>;
type ReorderWorkspacesHandler = (
  _event: unknown,
  request: {
    activeWorkspaceId: string;
    overWorkspaceId: string;
  },
) => Promise<void>;

let loadHandler: LoadHandler;
let callerGrants: Array<
  `core.${string}.${string}` | `worker.${string}.${string}`
> = ['core.workspace.read', 'core.worktree.read'];
let saveHandler: SaveHandler;
let applySourceChangesHandler: ApplySourceChangesHandler;
let saveDefaultPluginsHandler: SaveDefaultPluginsHandler;
let deleteHandler: DeleteHandler;
let reorderWorkspacesHandler: ReorderWorkspacesHandler;
const mockGetWindow = jest.fn(() => null);

function createMissingFileError(pathStr: string): Error & { code: string } {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${pathStr}'`),
    { code: 'ENOENT' },
  );
}

function makeWorktree(overrides: Partial<WorktreeData> = {}): WorktreeData {
  return {
    id: 'wt-1',
    branchName: 'feature/test',
    createdAt: '2025-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeProject(
  overrides: Partial<ProjectData> = {},
): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Test Project',
    repoPath: '/home/user/repo',
    color: '#ff0000',
    collapsed: false,
    order: 0,
    worktrees: [],
    ...overrides,
  };
}

function expectSingleRepoItem(
  item: SidebarItem | undefined,
): SingleRepoSidebarItem {
  if (!item || item.type !== 'single-repo') {
    throw new Error('Expected a single-repo sidebar item');
  }
  return item;
}

function makeWorkspaceIndexJson(
  workspaces: Array<Record<string, unknown>>,
  version: number = 1,
): string {
  return JSON.stringify({ version, workspaces });
}

function makeWorkspaceConfigJson(
  config: Record<string, unknown>,
  version: number = 1,
): string {
  return JSON.stringify({ version, ...config });
}

function makeSingleRepoIndexEntry(
  project: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...project,
    type: 'single-repo',
  };
}

function makeProjectIndexEntry(
  project: SingleRepoSidebarItem,
): Record<string, unknown> {
  return makeSingleRepoIndexEntry({
    id: project.id,
    name: project.name,
    color: project.color,
    collapsed: project.collapsed,
    order: project.order,
  });
}

function makeWorktreesFileJson(
  worktrees: WorktreeData[],
  version: number = 1,
): string {
  return JSON.stringify({ version, worktrees });
}

function getWriteCallRaw(filePath: string): string {
  const call = mockedWriteFile.mock.calls.find(([path]) => path === filePath);
  expect(call).toBeDefined();
  const content = call?.[1];
  expect(typeof content).toBe('string');
  if (typeof content !== 'string') {
    throw new Error(`Expected string write content for ${filePath}`);
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getWriteCallRecord(filePath: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(getWriteCallRaw(filePath));
  if (!isRecord(parsed)) {
    throw new Error(`Expected JSON object for ${filePath}`);
  }
  return parsed;
}

function getWrittenWorkspaceIndex(filePath: string): {
  version: number;
  workspaces: Array<
    Record<string, unknown> & { activitySectionOrder?: unknown }
  >;
} {
  const parsed = getWriteCallRecord(filePath);
  const { version, workspaces } = parsed;
  if (typeof version !== 'number' || !Array.isArray(workspaces)) {
    throw new Error(`Expected project index payload for ${filePath}`);
  }

  return {
    version,
    workspaces: workspaces.map(
      (
        workspace,
      ): Record<string, unknown> & { activitySectionOrder?: unknown } => {
        if (!isRecord(workspace)) {
          throw new Error(`Expected project entry object for ${filePath}`);
        }
        return workspace;
      },
    ),
  };
}

function mockReadFileText(contents: string): void {
  mockedReadFile.mockImplementation(
    (): Promise<string> => Promise.resolve(contents),
  );
}

function mockReadFileByPath(
  implementation: (filePath: string) => Promise<string>,
): void {
  mockedReadFile.mockImplementation(async (...args): Promise<string> => {
    const [filePath] = args;
    if (typeof filePath !== 'string') {
      throw new Error('Expected string file path');
    }

    return implementation(filePath);
  });
}

function assertIsLoadHandler(value: unknown): asserts value is LoadHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected load handler to be registered');
  }
}

function assertIsSaveHandler(value: unknown): asserts value is SaveHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected save handler to be registered');
  }
}

function assertIsApplySourceChangesHandler(
  value: unknown,
): asserts value is ApplySourceChangesHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected apply-source-changes handler to be registered');
  }
}

function assertIsSaveDefaultPluginsHandler(
  value: unknown,
): asserts value is SaveDefaultPluginsHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected save-default-plugins handler to be registered');
  }
}

function assertIsDeleteHandler(value: unknown): asserts value is DeleteHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected delete handler to be registered');
  }
}

function assertIsReorderWorkspacesHandler(
  value: unknown,
): asserts value is ReorderWorkspacesHandler {
  if (typeof value !== 'function') {
    throw new Error('Expected reorder-workspaces handler to be registered');
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  callerGrants = ['core.workspace.read', 'core.worktree.read'];
  // A first launch has no index yet; an automocked read would otherwise
  // look unreadable, which the index writer refuses to overwrite.
  mockedReadFile.mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
  capturedExternalSnapshotCallback = undefined;
  mockReconcileGitPendingWorktrees.mockResolvedValue(undefined);
  mockCountArchivedContainers.mockResolvedValue(0);
  mockResolveProjectScripts.mockResolvedValue({});
  mockResolveProjectHooks.mockResolvedValue({});
  mockedApplyProjectSourceChangesToWorktree.mockResolvedValue({
    worktreeId: 'wt-1',
    branchName: 'feature/test',
    createdWorktree: false,
    referenceRepoPath: '/repos/source',
  });
  mockedRepairExistingWorkspaceRootWorktrees.mockResolvedValue(undefined);
  const preferences: Partial<Awaited<ReturnType<typeof readPreferencesFile>>> =
    {
      worktreeFilterHiddenWorkspaceIds: [],
    };
  // A partial fixture: these tests rely on unset preferences staying undefined.
  mockedReadPreferencesFile.mockResolvedValue(
    preferences as Awaited<ReturnType<typeof readPreferencesFile>>,
  );

  registerProjectHandlers(
    mockGetWindow,
    jest
      .requireActual<
        typeof DesktopRuntimeModule
      >('../canopy-runtime/desktop-runtime')
      .createDesktopRuntime(),
    // An IPC caller, as the lifecycle projections admit it (W7b-2a, Q8).
    () => ({
      principalId: 'local-desktop-user',
      clientInstanceId: 'test',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: callerGrants,
    }),
  );

  const calls = mockedRegisterIpcHandler.mock.calls;
  const loadCall = calls.find(([ch]) => ch === 'projects:load');
  const saveCall = calls.find(([ch]) => ch === 'projects:save');
  const saveDefaultPluginsCall = calls.find(
    ([ch]) => ch === 'project:save-default-plugins',
  );
  const applySourceChangesCall = calls.find(
    ([ch]) => ch === 'project:apply-source-changes',
  );
  const deleteCall = calls.find(([ch]) => ch === 'project:delete');
  const reorderWorkspacesCall = calls.find(
    ([ch]) => ch === 'workspace:reorder',
  );

  const nextLoadHandler = loadCall?.[1];
  const nextSaveHandler = saveCall?.[1];
  const nextSaveDefaultPluginsHandler = saveDefaultPluginsCall?.[1];
  const nextApplySourceChangesHandler = applySourceChangesCall?.[1];
  const nextDeleteHandler = deleteCall?.[1];
  const nextReorderWorkspacesHandler = reorderWorkspacesCall?.[1];

  assertIsLoadHandler(nextLoadHandler);
  assertIsSaveHandler(nextSaveHandler);
  assertIsSaveDefaultPluginsHandler(nextSaveDefaultPluginsHandler);
  assertIsApplySourceChangesHandler(nextApplySourceChangesHandler);
  assertIsDeleteHandler(nextDeleteHandler);
  assertIsReorderWorkspacesHandler(nextReorderWorkspacesHandler);

  loadHandler = nextLoadHandler;
  saveHandler = nextSaveHandler;
  saveDefaultPluginsHandler = nextSaveDefaultPluginsHandler;
  applySourceChangesHandler = nextApplySourceChangesHandler;
  deleteHandler = nextDeleteHandler;
  reorderWorkspacesHandler = nextReorderWorkspacesHandler;
});

describe('registerProjectHandlers', () => {
  it('registers a targeted tracked-base-branch writer', async () => {
    const call = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === 'worktree:set-tracked-base-branch',
    );
    expect(call).toBeDefined();
    const handler = call?.[1] as
      | ((
          event: unknown,
          request: {
            workspaceId: string;
            worktreeId: string;
            repoId?: string;
            baseBranch: string;
          },
        ) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error('Expected tracked-base-branch handler to be registered');
    }
    let persisted = [
      makeWorktree({
        branchGroupingParentWorktreeId: 'merged-parent',
        trackedRepoBaseBranches: { 'repo-a': 'main' },
      }),
    ];
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persisted = await updater(persisted);
        return persisted;
      },
    );

    await handler(
      {},
      {
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
        baseBranch: 'develop',
      },
    );

    expect(persisted[0]?.trackedRepoBaseBranches).toEqual({
      'repo-a': 'develop',
    });
    expect(persisted[0]?.branchGroupingParentWorktreeId).toBeUndefined();

    await handler(
      {},
      {
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        baseBranch: 'release',
      },
    );

    expect(persisted[0]?.trackedBaseBranch).toBe('release');
  });

  it('accepts the synthetic workspace-root repo id', async () => {
    const call = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === 'worktree:set-tracked-base-branch',
    );
    const handler = call?.[1] as
      | ((
          event: unknown,
          request: {
            workspaceId: string;
            worktreeId: string;
            repoId?: string;
            baseBranch: string;
          },
        ) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error('Expected tracked-base-branch handler to be registered');
    }
    let persisted = [makeWorktree()];
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persisted = await updater(persisted);
        return persisted;
      },
    );

    // Source-backed workspaces address the workspace root through the
    // synthetic `__workspace_root__` id, which is not a plain `validateId`
    // slug. `PrStatusBar` and `WorktreeBranchInfoDialog` both send it.
    await handler(
      {},
      {
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoId: WORKSPACE_ROOT_REPO_ID,
        baseBranch: 'develop',
      },
    );

    expect(persisted[0]?.trackedRepoBaseBranches).toEqual({
      [WORKSPACE_ROOT_REPO_ID]: 'develop',
    });
  });

  it('clears a tracked base branch when the request carries null', async () => {
    const call = mockedRegisterIpcHandler.mock.calls.find(
      ([channel]) => channel === 'worktree:set-tracked-base-branch',
    );
    const handler = call?.[1] as
      | ((
          event: unknown,
          request: {
            workspaceId: string;
            worktreeId: string;
            repoId?: string;
            baseBranch: string | null;
          },
        ) => Promise<void>)
      | undefined;
    if (!handler) {
      throw new Error('Expected tracked-base-branch handler to be registered');
    }
    let persisted = [
      makeWorktree({
        trackedBaseBranch: 'develop',
        trackedRepoBaseBranches: { 'repo-a': 'develop', 'repo-b': 'main' },
      }),
    ];
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persisted = await updater(persisted);
        return persisted;
      },
    );

    await handler(
      {},
      {
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoId: 'repo-a',
        baseBranch: null,
      },
    );

    expect(persisted[0]?.trackedRepoBaseBranches).toEqual({ 'repo-b': 'main' });

    await handler(
      {},
      { workspaceId: 'project-1', worktreeId: 'wt-1', baseBranch: null },
    );

    expect(persisted[0]?.trackedBaseBranch).toBeNull();
  });

  describe('tracked base through the worktree update boundary (CAN-3820)', () => {
    type TrackedBaseHandler = (
      event: unknown,
      request: {
        workspaceId: string;
        worktreeId: string;
        repoId?: string;
        baseBranch: string | null;
      },
    ) => Promise<void>;

    function trackedBaseHandler(): TrackedBaseHandler {
      const call = mockedRegisterIpcHandler.mock.calls.find(
        ([channel]) => channel === 'worktree:set-tracked-base-branch',
      );
      const handler = call?.[1] as TrackedBaseHandler | undefined;
      if (!handler) {
        throw new Error('Expected tracked-base-branch handler');
      }
      return handler;
    }

    it('writes nothing when the base is unchanged', async () => {
      const stored = [
        makeWorktree({
          trackedBaseBranch: 'develop',
          trackedRepoBaseBranches: { 'repo-a': 'main' },
        }),
      ];
      const results: WorktreeData[][] = [];
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          const next = await updater(stored);
          results.push(next);
          return next;
        },
      );

      await trackedBaseHandler()(
        {},
        { workspaceId: 'project-1', worktreeId: 'wt-1', baseBranch: 'develop' },
      );
      await trackedBaseHandler()(
        {},
        {
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoId: 'repo-a',
          baseBranch: ' main ',
        },
      );

      // The same list back is the persistence layer's "no write".
      expect(results).toEqual([stored, stored]);
      expect(results.every((result) => result === stored)).toBe(true);
    });

    it('refuses the read-only shared-container scope before reading', async () => {
      await expect(
        trackedBaseHandler()(
          {},
          {
            workspaceId: SHARED_CONTAINER_VIEWER_PROJECT_ID,
            worktreeId: 'wt-1',
            baseBranch: 'develop',
          },
        ),
      ).rejects.toThrow('Shared-container recipient workspaces are read-only');
      expect(mockedUpdateWorkspaceWorktrees).not.toHaveBeenCalled();
    });

    it('keeps its blank-base and missing-worktree messages', async () => {
      let persisted = [makeWorktree({ id: 'wt-2' })];
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          persisted = await updater(persisted);
          return persisted;
        },
      );

      await expect(
        trackedBaseHandler()(
          {},
          { workspaceId: 'project-1', worktreeId: 'wt-1', baseBranch: ' ' },
        ),
      ).rejects.toThrow('baseBranch is required.');
      await expect(
        trackedBaseHandler()(
          {},
          { workspaceId: 'project-1', worktreeId: 'wt-1', baseBranch: 'main' },
        ),
      ).rejects.toThrow(
        'Worktree "wt-1" was not found in project "project-1".',
      );
    });
  });

  it('registers load, save, desktop metadata/reorder, default-plugins, apply-source-changes, and delete handlers', () => {
    expect(mockedRegisterIpcHandler).toHaveBeenCalledTimes(8);
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'projects:load',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'projects:save',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'worktree:set-tracked-base-branch',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'workspace:update-metadata',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'workspace:reorder',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'project:save-default-plugins',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'project:apply-source-changes',
      expect.any(Function),
    );
    expect(mockedRegisterIpcHandler).toHaveBeenCalledWith(
      'project:delete',
      expect.any(Function),
    );
  });

  it('reorders visible projects without moving a hidden project slot', async () => {
    mockedReadPreferencesFile.mockResolvedValue({
      worktreeFilterHiddenWorkspaceIds: ['hidden'],
    } as Awaited<ReturnType<typeof readPreferencesFile>>);
    mockReadFileByPath((filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            makeSingleRepoIndexEntry({
              id: 'visible-a',
              name: 'Visible A',
              color: '#111111',
              order: 0,
            }),
            makeSingleRepoIndexEntry({
              id: 'hidden',
              name: 'Hidden',
              color: '#222222',
              order: 1,
            }),
            makeSingleRepoIndexEntry({
              id: 'visible-b',
              name: 'Visible B',
              color: '#333333',
              order: 2,
            }),
          ]),
        );
      }
      const configMatch = filePath.match(
        /^\/mock\/workspaces\/([^/]+)\/workspace\.json$/,
      );
      if (configMatch?.[1]) {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: `/repos/${configMatch[1]}`,
          }),
        );
      }
      if (filePath.endsWith('/worktrees.json')) {
        return Promise.resolve(makeWorktreesFileJson([]));
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    await reorderWorkspacesHandler(
      {},
      {
        activeWorkspaceId: 'visible-b',
        overWorkspaceId: 'visible-a',
      },
    );

    expect(
      getWrittenWorkspaceIndex('/mock/workspaces/index.json').workspaces.map(
        ({ id, order }) => ({ id, order }),
      ),
    ).toEqual([
      { id: 'visible-b', order: 0 },
      { id: 'hidden', order: 1 },
      { id: 'visible-a', order: 2 },
    ]);
  });

  it('starts the project reference repo poller over the desktop dispatcher', () => {
    expect(mockedStartPolling).toHaveBeenCalledWith(
      expect.any(Function),
      expect.anything(),
    );
    expect(typeof mockedStartPolling.mock.calls[0]?.[1].query).toBe('function');
  });
});

describe('project:apply-source-changes handler', () => {
  it('delegates valid requests to the apply helper', async () => {
    const request: ProjectApplySourceChangesRequest = {
      projectId: 'project-1',
      target: {
        mode: 'existing',
        worktreeId: 'wt-1',
      },
      scripts: {
        setup: 'npm install',
      },
    };

    const result = await applySourceChangesHandler({}, request);

    expect(mockedApplyProjectSourceChangesToWorktree).toHaveBeenCalledWith(
      request,
      mockGetWindow,
      expect.any(Function),
    );
    expect(result).toEqual({
      worktreeId: 'wt-1',
      branchName: 'feature/test',
      createdWorktree: false,
      referenceRepoPath: '/repos/source',
    });
  });

  it('rejects when the underlying apply helper rejects for a missing project', async () => {
    mockedApplyProjectSourceChangesToWorktree.mockRejectedValueOnce(
      new Error('Project project-1 is not a single-repo project'),
    );

    await expect(
      applySourceChangesHandler(
        {},
        {
          projectId: 'project-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          scripts: {},
        },
      ),
    ).rejects.toThrow('Project project-1 is not a single-repo project');
  });

  it('rejects when the underlying apply helper rejects for a non-single-repo project', async () => {
    mockedApplyProjectSourceChangesToWorktree.mockRejectedValueOnce(
      new Error('Project workspace-1 is not a single-repo project'),
    );

    await expect(
      applySourceChangesHandler(
        {},
        {
          projectId: 'workspace-1',
          target: {
            mode: 'new',
            existingWorktreeIds: [],
          },
          scripts: {},
        },
      ),
    ).rejects.toThrow('Project workspace-1 is not a single-repo project');
  });
});

describe('project:save-default-plugins handler', () => {
  beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  it('updates default plugin selections and alwaysShow for the matching project', async () => {
    const selections = {
      collectionIds: ['bundle-a'],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const project = makeProject();
    const otherProject = makeProject({
      id: 'project-2',
      name: 'Other Project',
      repoPath: '/home/user/other',
    });

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            makeProjectIndexEntry(project),
            makeProjectIndexEntry(otherProject),
          ]),
        );
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: project.repoPath,
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-2/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: otherProject.repoPath,
            repos: [],
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    await saveDefaultPluginsHandler(
      {},
      {
        projectId: 'project-1',
        defaultPluginSelections: selections,
        alwaysShow: true,
      },
    );

    // CAN-3817: the plugins and Always show commands each write only this
    // project's manifest; no other manifest, the index or a worktree list.
    const projectWrites = mockedWriteFile.mock.calls
      .filter(([path]) => path === '/mock/workspaces/project-1/workspace.json')
      .map(([, content]): unknown =>
        typeof content === 'string' ? JSON.parse(content) : undefined,
      );
    expect(projectWrites).toEqual([
      expect.objectContaining({ defaultPluginSelections: selections }),
      expect.objectContaining({ alwaysShow: true }),
    ]);
    expect(mockedWriteFile.mock.calls.map(([path]) => path).sort()).toEqual([
      '/mock/workspaces/project-1/workspace.json',
      '/mock/workspaces/project-1/workspace.json',
    ]);
  });

  it('leaves alwaysShow unchanged when it is omitted', async () => {
    const selections = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      mcpServerRefs: [],
    };
    const project = makeProject({ alwaysShow: true });

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([makeProjectIndexEntry(project)]),
        );
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: project.repoPath,
            repos: [],
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    await saveDefaultPluginsHandler(
      {},
      {
        projectId: 'project-1',
        defaultPluginSelections: selections,
      },
    );

    const written = getWriteCallRecord(
      '/mock/workspaces/project-1/workspace.json',
    );
    expect(written.defaultPluginSelections).toEqual(selections);
    expect(written.alwaysShow).toBe(true);
  });
});

describe('load handler', () => {
  const observerKey = '__CANOPY_E2E_FIRST_PROJECTS_LOAD_MAIN__';
  const initialE2eDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    '__CANOPY_E2E__',
  );

  beforeAll(() => {
    Object.defineProperty(globalThis, '__CANOPY_E2E__', {
      configurable: true,
      value: true,
    });
  });

  it('requires the worktree read grant for the refreshed inventory', async () => {
    callerGrants = ['core.workspace.read'];
    await expect(loadHandler()).rejects.toMatchObject({
      payload: { kind: 'permission_denied' },
    });
  });

  afterAll(() => {
    if (initialE2eDescriptor) {
      Object.defineProperty(globalThis, '__CANOPY_E2E__', initialE2eDescriptor);
    } else {
      Reflect.deleteProperty(globalThis, '__CANOPY_E2E__');
    }
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, observerKey);
  });

  it('observes the actual successful callback without changing its result or service order', async () => {
    mockedReadFile.mockRejectedValue(
      createMissingFileError('/mock/workspaces/index.json'),
    );
    const events: Array<{ stage: string; details: unknown }> = [];
    Object.defineProperty(globalThis, observerKey, {
      configurable: true,
      value: (_event: unknown, stage: string, details: unknown) => {
        events.push({ stage, details });
      },
    });
    const event = { sender: { id: 41 } };

    const result = await loadHandler(event);

    expect(result).toEqual({ version: 1, items: [] });
    expect(mockedReadFile).toHaveBeenCalledTimes(2);
    expect(mockReconcileGitPendingWorktrees).toHaveBeenCalledTimes(1);
    expect(events.map(({ stage }) => stage)).toEqual([
      'projects-load-main-entered',
      'projects-load-main-resolved',
    ]);
    const enteredDetails = events[0]?.details as Record<string, unknown>;
    const resolvedDetails = events[1]?.details as Record<string, unknown>;
    expect(typeof enteredDetails.requestOrdinal).toBe('number');
    expect(typeof resolvedDetails.requestOrdinal).toBe('number');
    expect(resolvedDetails.itemCount).toBe(0);
  });

  it('observes the actual rejected callback and preserves the original rejection', async () => {
    const failure = new TypeError('sentinel project load failure');
    const read = jest
      .spyOn(sidebarItems, 'readAllSidebarItemsSnapshot')
      .mockRejectedValueOnce(failure);
    const events: Array<{ stage: string; details: unknown }> = [];
    Object.defineProperty(globalThis, observerKey, {
      configurable: true,
      value: (_event: unknown, stage: string, details: unknown) => {
        events.push({ stage, details });
        return Promise.reject(new Error('observer rejection'));
      },
    });

    try {
      await expect(loadHandler({ sender: { id: 42 } })).rejects.toBe(failure);
    } finally {
      read.mockRestore();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(events.map(({ stage }) => stage)).toEqual([
      'projects-load-main-entered',
      'projects-load-main-rejected',
    ]);
    const rejectedDetails = events[1]?.details as Record<string, unknown>;
    expect(typeof rejectedDetails.requestOrdinal).toBe('number');
    expect(rejectedDetails.errorKind).toBe('type-error');
  });

  it('does not project a later result through an observer retired while the request is in flight', async () => {
    let rejectRead: ((error: unknown) => void) | undefined;
    const read = jest
      .spyOn(sidebarItems, 'readAllSidebarItemsSnapshot')
      .mockImplementationOnce(
        () =>
          new Promise<
            Awaited<ReturnType<typeof sidebarItems.readAllSidebarItemsSnapshot>>
          >((_resolve, reject) => {
            rejectRead = reject;
          }),
      );
    const events: string[] = [];
    Object.defineProperty(globalThis, observerKey, {
      configurable: true,
      value: (_event: unknown, stage: string) => events.push(stage),
    });
    let codeReads = 0;
    const failure = Object.defineProperty(
      new Error('retired observer'),
      'code',
      {
        get() {
          codeReads++;
          return 'EIO';
        },
      },
    );

    const pending = loadHandler({ sender: { id: 43 } });
    await Promise.resolve();
    expect(events).toEqual(['projects-load-main-entered']);
    Reflect.deleteProperty(globalThis, observerKey);
    rejectRead?.(failure);

    try {
      await expect(pending).rejects.toBe(failure);
    } finally {
      read.mockRestore();
    }
    expect(events).toEqual(['projects-load-main-entered']);
    expect(codeReads).toBe(0);
  });

  it('preserves every current activity section id from the project index', async () => {
    const activitySectionOrder = [
      'summary',
      'terminals',
      'notes',
      'prompts',
      'attachments',
      'scripts',
    ];
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            makeSingleRepoIndexEntry({
              id: 'project-1',
              name: 'Test Project',
              color: '#000',
              collapsed: false,
              order: 0,
              activitySectionOrder,
            }),
          ]),
        );
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repos/project-1',
            repos: [],
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(expectSingleRepoItem(result.items[0]).activitySectionOrder).toEqual(
      activitySectionOrder,
    );
  });

  it('preserves failed project runtime state during partial-load synchronization', async () => {
    mockResolveProjectScripts.mockImplementation(
      ({ repoPath }: { repoPath: string }) =>
        repoPath === '/repos/failed'
          ? Promise.reject(new Error('transient read failure'))
          : Promise.resolve({}),
    );
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            makeSingleRepoIndexEntry({
              id: 'project-failed',
              name: 'Failed',
              color: '#000',
              collapsed: false,
              order: 0,
            }),
            makeSingleRepoIndexEntry({
              id: 'project-loaded',
              name: 'Loaded',
              color: '#fff',
              collapsed: false,
              order: 1,
            }),
          ]),
        );
      }
      if (filePath === '/mock/workspaces/project-failed/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repos/failed',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-loaded/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repos/loaded',
            repos: [],
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();
    const preserveWorkspaceIds = new Set(['project-failed']);
    const loadedItems = [
      expect.objectContaining({
        id: 'project-loaded',
      }),
    ];

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: 'workspace-load-failed',
        workspaceId: 'project-failed',
      }),
    ]);
    expect(mockedSyncTrackedWorktrees).toHaveBeenLastCalledWith(
      loadedItems,
      preserveWorkspaceIds,
    );
    expect(mockedSyncTrackedWorkspaces).toHaveBeenLastCalledWith(
      loadedItems,
      preserveWorkspaceIds,
    );
    expect(mockedSyncCodeGraphBaseRepositories).toHaveBeenLastCalledWith(
      loadedItems,
      preserveWorkspaceIds,
    );
    expect(mockedPublishWorktreeLifecycleChange).toHaveBeenLastCalledWith(
      'projects-loaded',
    );
    expect(mockedSyncWorktreesFileWatchers).toHaveBeenLastCalledWith(
      loadedItems,
      mockGetWindow,
      preserveWorkspaceIds,
      expect.any(Function),
    );
  });

  it('returns empty projects when file does not exist', async () => {
    mockedReadFile.mockRejectedValue(
      createMissingFileError('/mock/workspaces/index.json'),
    );

    const result = await loadHandler();

    expect(result).toEqual({ version: 1, items: [] });
    expect(mockReconcileGitPendingWorktrees).toHaveBeenCalledWith(
      mockGetWindow,
    );
    expect(mockSyncWorktreesFileWatchers).toHaveBeenCalledWith(
      [],
      mockGetWindow,
      new Set(),
      expect.any(Function),
    );
    if (!capturedExternalSnapshotCallback) {
      throw new Error('Expected external snapshot reconciliation callback');
    }
    capturedExternalSnapshotCallback('workspace-1', []);
    expect(mockReconcileExternalWorktreeSnapshot).toHaveBeenCalledWith(
      'workspace-1',
      [],
    );
  });

  it.each([true, false, undefined])(
    'loads an empty temporary project only when explicitly kept (%s)',
    async (alwaysShow) => {
      mockCountArchivedContainers.mockResolvedValue(0);
      mockReadFileByPath(async (filePath) => {
        if (filePath === '/mock/workspaces/index.json') {
          return makeWorkspaceIndexJson([
            {
              id: 'kept',
              name: 'Kept',
              type: 'multi-repo',
              color: '#000',
              collapsed: false,
              order: 0,
            },
          ]);
        }
        if (filePath === '/mock/workspaces/kept/workspace.json') {
          return makeWorkspaceConfigJson({
            type: 'multi-repo',
            repos: [],
            temporary: true,
            alwaysShow,
          });
        }
        return Promise.reject(createMissingFileError(filePath));
      });
      const result = await loadHandler();
      expect(result.items).toEqual(
        alwaysShow === true
          ? [
              expect.objectContaining({
                id: 'kept',
                temporary: true,
                alwaysShow: true,
                worktrees: [],
                archivedContainerCount: 0,
              }),
            ]
          : [],
      );
    },
  );

  it('keeps an empty temporary project visible while it owns archives', async () => {
    mockCountArchivedContainers.mockResolvedValue(1);
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            {
              id: 'workspace-archived',
              name: 'Archived workspace',
              type: 'multi-repo',
              color: '#000',
              collapsed: false,
              order: 0,
            },
          ]),
        );
      }
      if (filePath === '/mock/workspaces/workspace-archived/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'multi-repo',
            repos: [],
            temporary: true,
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'workspace-archived',
        temporary: true,
        worktrees: [],
        archivedContainerCount: 1,
      }),
    ]);
  });

  it('reconciles pending git worktrees only on the first project load', async () => {
    mockedReadFile.mockRejectedValue(
      createMissingFileError('/mock/workspaces/index.json'),
    );

    await loadHandler();
    await loadHandler();

    expect(mockReconcileGitPendingWorktrees).toHaveBeenCalledTimes(1);
  });

  it.each(['initial', 'refreshed'] as const)(
    'delivers a stale %s projects:load without remembering it or consuming startup work',
    async (stage) => {
      const runtime = jest
        .requireActual<
          typeof DesktopRuntimeModule
        >('../canopy-runtime/desktop-runtime')
        .createDesktopRuntime();
      const stale: SidebarItemsFile = {
        version: 1,
        stale: true,
        items: [makeProject({ id: 'disk-only' })],
      };
      const workspace = jest
        .spyOn(runtime, 'queryWorkspaceListForLegacyIpc')
        .mockImplementation(() => {
          expect(allowsW5ProjectionOnlyRead()).toBe(true);
          return Promise.resolve({
            canonicalResult: null,
            legacyResult:
              stage === 'initial' ? stale : { version: 1, items: [] },
          });
        });
      const worktrees = jest
        .spyOn(runtime, 'queryWorktreeListForLegacyIpc')
        .mockImplementation(() => {
          expect(allowsW5ProjectionOnlyRead()).toBe(true);
          return Promise.resolve({
            canonicalResult: null,
            legacyResult: stale,
          });
        });
      registerProjectHandlers(mockGetWindow, runtime, () => ({
        principalId: 'test',
        clientInstanceId: 'test',
        authorityId: 'local-desktop',
        interfaceKind: 'test',
        grants: callerGrants,
      }));
      const load = mockedRegisterIpcHandler.mock.calls.findLast(
        ([channel]) => channel === 'projects:load',
      )?.[1];
      const save = mockedRegisterIpcHandler.mock.calls.findLast(
        ([channel]) => channel === 'projects:save',
      )?.[1];
      assertIsLoadHandler(load);
      assertIsSaveHandler(save);
      const route = jest
        .spyOn(sidebarSaveAdapter, 'saveSidebarItems')
        .mockResolvedValue({
          version: 1,
          items: [],
          preservedWorkspaceIds: [],
        });
      try {
        const event = { sender: {} };
        await expect(load(event)).resolves.toEqual(stale);
        expect(mockReconcileGitPendingWorktrees).not.toHaveBeenCalled();
        expect(
          mockedRepairExistingWorkspaceRootWorktrees,
        ).not.toHaveBeenCalled();
        const authoritativeSyncs = stage === 'initial' ? 0 : 1;
        expect(mockedSyncTrackedWorkspaces).toHaveBeenCalledTimes(
          authoritativeSyncs,
        );
        expect(mockedSyncTrackedWorktrees).toHaveBeenCalledTimes(
          authoritativeSyncs,
        );
        expect(mockedSyncCodeGraphBaseRepositories).toHaveBeenCalledTimes(
          authoritativeSyncs,
        );
        expect(mockedSyncWorktreesFileWatchers).not.toHaveBeenCalled();
        expect(mockedPublishWorktreeLifecycleChange).not.toHaveBeenCalled();
        await save(event, stale.items);
        expect(route).toHaveBeenCalledWith(
          expect.objectContaining({ previousItems: undefined }),
        );
        workspace.mockRestore();
        worktrees.mockRestore();
        await load(event);
        expect(mockReconcileGitPendingWorktrees).toHaveBeenCalledTimes(1);
      } finally {
        workspace.mockRestore();
        worktrees.mockRestore();
        route.mockRestore();
        await runtime.shutdown();
      }
    },
  );

  it('loads projects while startup archive recovery is still pending', async () => {
    let finishRecovery = (): void => {};
    const recovery = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    mockReconcileGitPendingWorktrees.mockReturnValueOnce(recovery);
    const loading = loadHandler();
    try {
      const result = await Promise.race([
        loading,
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('blocked'), 200),
        ),
      ]);
      expect(result).toEqual({ version: 1, items: [] });
      await loadHandler();
      expect(mockReconcileGitPendingWorktrees).toHaveBeenCalledTimes(1);
    } finally {
      finishRecovery();
      await loading;
    }
  });

  it('keeps projects available when background startup recovery fails', async () => {
    const stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    mockReconcileGitPendingWorktrees.mockRejectedValueOnce(
      new Error('Recovery unavailable'),
    );
    try {
      await expect(loadHandler()).resolves.toEqual({ version: 1, items: [] });
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('Recovery unavailable'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('returns empty projects when JSON is invalid', async () => {
    mockReadFileText('not valid json {{{');

    const result = await loadHandler();

    expect(result).toEqual({ version: 1, items: [] });
  });

  it('returns empty projects when version is not 1', async () => {
    mockReadFileText(
      makeWorkspaceIndexJson(
        [
          makeSingleRepoIndexEntry({
            id: 'abc',
            name: 'P',
            color: '#000',
            collapsed: false,
            order: 0,
          }),
        ],
        2,
      ),
    );

    const result = await loadHandler();

    expect(result).toEqual({ version: 1, items: [] });
  });

  it('returns empty projects when projects field is not an array', async () => {
    mockReadFileText(
      JSON.stringify({ version: 1, workspaces: 'not-an-array' }),
    );

    const result = await loadHandler();

    expect(result).toEqual({ version: 1, items: [] });
  });

  it('returns empty projects when projects field is null', async () => {
    mockReadFileText(JSON.stringify({ version: 1, workspaces: null }));

    const result = await loadHandler();

    expect(result).toEqual({ version: 1, items: [] });
  });

  it('loads projects with worktrees joined from separate files', async () => {
    const wt = makeWorktree({ createdAt: '2026-01-01' });
    const project = {
      id: 'project-1',
      name: 'Test Project',
      color: '#ff0000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/home/user/repo',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-1/worktrees.json') {
        return Promise.resolve(makeWorktreesFileJson([wt]));
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(result.version).toBe(1);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('project-1');
    expect(result.items[0].name).toBe('Test Project');
    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([wt]);
    expect(mockedSyncTrackedWorktrees).toHaveBeenCalledWith(
      result.items,
      new Set(),
    );
    expect(mockedSyncTrackedWorkspaces).toHaveBeenCalledWith(
      result.items,
      new Set(),
    );
  });

  it('loads multiple projects each with their own worktrees', async () => {
    const wt1 = makeWorktree({ id: 'wt-a', branchName: 'main' });
    const wt2 = makeWorktree({ id: 'wt-b', branchName: 'develop' });

    const projects = [
      makeSingleRepoIndexEntry({
        id: 'proj-a',
        name: 'A',
        color: '#aaa',
        collapsed: false,
        order: 0,
      }),
      makeSingleRepoIndexEntry({
        id: 'proj-b',
        name: 'B',
        color: '#bbb',
        collapsed: true,
        order: 1,
      }),
    ];

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson(projects));
      }
      if (filePath === '/mock/workspaces/proj-a/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/a',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/proj-b/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/b',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/proj-a/worktrees.json') {
        return Promise.resolve(makeWorktreesFileJson([wt1]));
      }
      if (filePath === '/mock/workspaces/proj-b/worktrees.json') {
        return Promise.resolve(makeWorktreesFileJson([wt2]));
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(result.items).toHaveLength(2);
    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([wt1]);
    expect(expectSingleRepoItem(result.items[1]).worktrees).toEqual([wt2]);
  });

  it('ignores multi-repo projects with invalid canopy.json files and returns a warning', async () => {
    const wt = makeWorktree();
    const workspaces: Array<Record<string, unknown>> = [
      makeSingleRepoIndexEntry({
        id: 'proj-a',
        name: 'Project A',
        color: '#aaa',
        collapsed: false,
        order: 0,
      }),
      {
        id: 'workspace-b',
        name: 'Workspace B',
        color: '#bbb',
        collapsed: false,
        order: 1,
        type: 'multi-repo',
      },
    ];

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson(workspaces));
      }
      if (filePath === '/mock/workspaces/proj-a/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo-a',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/proj-a/worktrees.json') {
        return Promise.resolve(makeWorktreesFileJson([wt]));
      }
      if (filePath === '/mock/workspaces/workspace-b/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'multi-repo',
            repos: [],
            sourceRepoPath: '/repos/workspace-b',
          }),
        );
      }
      if (filePath === '/repos/workspace-b/canopy.json') {
        return Promise.resolve('{\n  "version": 1,\n  ]\n}');
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(result.items).toHaveLength(1);
    expect(result.items[0].id).toBe('proj-a');
    expect(result.warnings).toHaveLength(1);
    const warning = result.warnings?.[0];
    expect(warning?.code).toBe('invalid-canopy-json');
    expect(warning?.workspaceId).toBe('workspace-b');
    expect(warning?.workspaceName).toBe('Workspace B');
    if (warning?.code !== 'invalid-canopy-json') {
      throw new Error('Expected invalid canopy.json warning');
    }
    expect(warning.filePath).toBe('/repos/workspace-b/canopy.json');
    expect(warning.reason).toMatch(
      /Unexpected token|Expected double-quoted property name|position|line 3 column 3/,
    );
    const failedWorkspaceIds = new Set(['workspace-b']);
    expect(mockedSyncTrackedWorkspaces).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'proj-a' })],
      failedWorkspaceIds,
    );
    expect(mockedSyncCodeGraphBaseRepositories).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: 'proj-a' })],
      failedWorkspaceIds,
    );
  });

  it('returns empty worktrees when worktrees file does not exist', async () => {
    const project = {
      id: 'project-1',
      name: 'Test',
      color: '#000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo',
            repos: [],
          }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(result.items).toHaveLength(1);
    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([]);
  });

  it('returns empty worktrees when worktrees file has wrong version', async () => {
    const project = {
      id: 'project-1',
      name: 'Test',
      color: '#000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-1/worktrees.json') {
        return Promise.resolve(makeWorktreesFileJson([makeWorktree()], 99));
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([]);
  });

  it('returns empty worktrees when worktrees field is not an array', async () => {
    const project = {
      id: 'project-1',
      name: 'Test',
      color: '#000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-1/worktrees.json') {
        return Promise.resolve(
          JSON.stringify({ version: 1, worktrees: 'not-array' }),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([]);
  });

  it('returns empty worktrees when worktrees field is null', async () => {
    const project = {
      id: 'project-1',
      name: 'Test',
      color: '#000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-1/worktrees.json') {
        return Promise.resolve(JSON.stringify({ version: 1, worktrees: null }));
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([]);
  });

  it('returns empty worktrees when worktrees JSON is invalid', async () => {
    const project = {
      id: 'project-1',
      name: 'Test',
      color: '#000',
      collapsed: false,
      order: 0,
      type: 'single-repo',
    };

    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([project]));
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return Promise.resolve(
          makeWorkspaceConfigJson({
            type: 'single-repo',
            repoPath: '/repo',
            repos: [],
          }),
        );
      }
      if (filePath === '/mock/workspaces/project-1/worktrees.json') {
        return Promise.resolve('broken json {{');
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await loadHandler();

    expect(expectSingleRepoItem(result.items[0]).worktrees).toEqual([]);
  });
});

describe('save handler', () => {
  beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  it('never creates a snapshot-only project through save', async () => {
    const project = makeProject({ worktrees: [makeWorktree()] });
    const result = await saveHandler({}, [project]);
    expect(result.items).toEqual([]);
    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedSyncTrackedWorkspaces).toHaveBeenCalledWith([], new Set());
  });

  it('keeps the previous baseline for workspaces a save preserved', async () => {
    const event = { sender: {} };
    const before = [
      makeProject({ id: 'kept', collapsed: false }),
      makeProject({ id: 'saved', collapsed: false }),
    ];
    const route = jest
      .spyOn(sidebarSaveAdapter, 'saveSidebarItems')
      .mockResolvedValueOnce({
        version: 1,
        items: before,
        preservedWorkspaceIds: [],
      })
      .mockResolvedValueOnce({
        version: 1,
        items: [before[1]],
        preservedWorkspaceIds: ['kept'],
      })
      .mockResolvedValue({ version: 1, items: [], preservedWorkspaceIds: [] });
    try {
      await saveHandler(event, before);
      const edited = before.map((item) => ({ ...item, collapsed: true }));
      await saveHandler(event, edited);
      await saveHandler(event, edited);
      // The unread edit to `kept` must still look like an edit next time.
      expect(route).toHaveBeenLastCalledWith(
        expect.objectContaining({ previousItems: [before[0], edited[1]] }),
      );
    } finally {
      route.mockRestore();
    }
  });

  it('synchronizes from the authoritative save result', async () => {
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(makeWorkspaceIndexJson([]));
      }
      return Promise.reject(createMissingFileError(filePath));
    });
    const staleProject = makeProject({ id: 'project-deleted' });
    const event = { sender: {} };
    const loaded = await loadHandler(event);
    const route = jest.spyOn(sidebarSaveAdapter, 'saveSidebarItems');
    /** The last save, which also carries each update's IPC projection. */
    const lastSave = (): Omit<
      sidebarSaveAdapter.SidebarSaveRequest,
      'updateWorkspaceMetadata'
    > => {
      const request = route.mock.lastCall?.[0];
      if (!request) throw new Error('Expected a save');
      const { updateWorkspaceMetadata, updateWorktree, ...rest } = request;
      expect(updateWorkspaceMetadata).toBeInstanceOf(Function);
      expect(updateWorktree).toBeInstanceOf(Function);
      return rest;
    };
    const submitted = [staleProject];
    const options = { preserveWorkspaceIds: ['project-deleted'] };
    const result = await saveHandler(event, submitted, options);
    expect(lastSave()).toEqual({
      source: 'projects_save',
      items: submitted,
      options,
      previousItems: loaded.items,
    });
    await saveHandler(event, submitted);
    expect(lastSave()).toEqual({
      source: 'projects_save',
      items: submitted,
      options: undefined,
      previousItems: submitted,
    });
    await saveHandler({ sender: {} }, submitted);
    expect(lastSave()).toEqual({
      source: 'projects_save',
      items: submitted,
      options: undefined,
      previousItems: undefined,
    });
    route.mockRestore();
    expect(result.items).toEqual([]);
    const preservedWorkspaceIds = new Set<string>();
    expect(mockedSyncTrackedWorkspaces).toHaveBeenCalledWith(
      [],
      preservedWorkspaceIds,
    );
    expect(mockedSyncCodeGraphBaseRepositories).toHaveBeenCalledWith(
      [],
      preservedWorkspaceIds,
    );
    expect(mockedPublishWorktreeLifecycleChange).toHaveBeenCalledWith(
      'projects-saved',
    );
    expect(mockedSyncWorktreesFileWatchers).toHaveBeenCalledWith(
      [],
      mockGetWindow,
      preservedWorkspaceIds,
      expect.any(Function),
    );
  });

  it('preserves failed project ids in post-save runtime synchronization', async () => {
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return Promise.resolve(
          makeWorkspaceIndexJson([
            makeSingleRepoIndexEntry({
              id: 'project-failed',
              name: 'Failed',
              color: '#000',
              collapsed: false,
              order: 0,
            }),
          ]),
        );
      }
      return Promise.reject(createMissingFileError(filePath));
    });

    const result = await saveHandler({}, [], {
      preserveWorkspaceIds: ['project-failed'],
    });
    const preservedWorkspaceIds = new Set(['project-failed']);

    expect(result).toEqual({
      version: 1,
      items: [],
      preservedWorkspaceIds: ['project-failed'],
    });
    expect(mockedSyncTrackedWorkspaces).toHaveBeenCalledWith(
      [],
      preservedWorkspaceIds,
    );
    expect(mockedSyncCodeGraphBaseRepositories).toHaveBeenCalledWith(
      [],
      preservedWorkspaceIds,
    );
    expect(mockedPublishWorktreeLifecycleChange).toHaveBeenCalledWith(
      'projects-saved',
    );
    expect(mockedSyncWorktreesFileWatchers).toHaveBeenCalledWith(
      [],
      mockGetWindow,
      preservedWorkspaceIds,
      expect.any(Function),
    );
  });

  it('waits for an in-flight template install and preserves its new project', async () => {
    const staleProject = makeProject({ name: 'Renderer edit' });
    const installedProject: SidebarItem = {
      type: 'cowork',
      id: 'course-workspace',
      name: 'Course workspace',
      color: '#7c3aed',
      collapsed: false,
      order: 1,
      installedFromTemplateExternalId: '2f0c9a1e-4b3d-4f6a-8c2e-1d5b7a9e0c4f',
      installedFromTemplateContentHash: 'a'.repeat(64),
      cowork: {
        createdAt: '2026-09-09T00:00:00.000Z',
        archiveRetentionDays: 7,
      },
    };
    let persistedIndex = makeWorkspaceIndexJson([
      makeProjectIndexEntry(staleProject),
      {
        id: installedProject.id,
        name: installedProject.name,
        type: installedProject.type,
        color: installedProject.color,
        collapsed: installedProject.collapsed,
        order: installedProject.order,
      },
    ]);
    mockReadFileByPath(async (filePath) => {
      if (filePath === '/mock/workspaces/index.json') {
        return persistedIndex;
      }
      if (filePath === '/mock/workspaces/project-1/workspace.json') {
        return makeWorkspaceConfigJson({
          type: 'single-repo',
          repoPath: staleProject.repoPath,
          repos: [],
        });
      }
      if (filePath === '/mock/workspaces/course-workspace/workspace.json') {
        return makeWorkspaceConfigJson({
          type: 'cowork',
          repos: [],
          cowork: installedProject.cowork,
          installedFromTemplateExternalId:
            installedProject.installedFromTemplateExternalId,
          installedFromTemplateContentHash:
            installedProject.installedFromTemplateContentHash,
        });
      }
      if (filePath.endsWith('/worktrees.json')) {
        return makeWorktreesFileJson([]);
      }
      return Promise.reject(createMissingFileError(filePath));
    });
    mockedWriteFile.mockImplementation((filePath, contents) => {
      if (
        filePath === '/mock/workspaces/index.json' &&
        typeof contents === 'string'
      ) {
        persistedIndex = contents;
      }
      return Promise.resolve();
    });

    let releaseInstall!: () => void;
    let markInstallStarted!: () => void;
    const installGate = new Promise<void>((resolve) => {
      releaseInstall = resolve;
    });
    const installStarted = new Promise<void>((resolve) => {
      markInstallStarted = resolve;
    });
    const install = serializeChatProjectOperation(async () => {
      markInstallStarted();
      await installGate;
    });
    await installStarted;

    const save = saveHandler({}, [staleProject]);
    await Promise.resolve();
    await Promise.resolve();
    expect(mockedWriteFile).not.toHaveBeenCalled();

    releaseInstall();
    const [, result] = await Promise.all([install, save]);

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(result.items.map(({ id }) => id)).toEqual(['project-1']);
    expect(result.preservedWorkspaceIds).toEqual(['course-workspace']);
    mockedReadFile.mockReset();
    mockedWriteFile.mockReset();
  });
});

describe('validation', () => {
  beforeEach(() => {
    mockedMkdir.mockResolvedValue(undefined);
    mockedWriteFile.mockResolvedValue(undefined);
  });

  it('accepts valid project id with lowercase letters and numbers', async () => {
    const project = makeProject({ id: 'abc-123', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).resolves.toBeDefined();
  });

  it('accepts valid project id starting with a number', async () => {
    const project = makeProject({ id: '1-project', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).resolves.toBeDefined();
  });

  it('accepts single character project id', async () => {
    const project = makeProject({ id: 'a', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).resolves.toBeDefined();
  });

  it('rejects empty project id', async () => {
    const project = makeProject({ id: '', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid item id: ',
    );
  });

  it('rejects project id with uppercase letters', async () => {
    const project = makeProject({ id: 'MyProject', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid item id: must be lowercase alphanumeric with hyphens',
    );
  });

  it('rejects project id with special characters', async () => {
    const project = makeProject({ id: 'project_1', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid item id: must be lowercase alphanumeric with hyphens',
    );
  });

  it('rejects project id with spaces', async () => {
    const project = makeProject({ id: 'my project', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid item id: must be lowercase alphanumeric with hyphens',
    );
  });

  it('rejects project id starting with a hyphen', async () => {
    const project = makeProject({ id: '-project', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid item id: must be lowercase alphanumeric with hyphens',
    );
  });

  it('rejects relative repoPath', async () => {
    const project = makeProject({
      id: 'project-1',
      repoPath: 'relative/path',
    });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid repoPath for project project-1: must be an absolute path',
    );
  });

  it('rejects empty repoPath', async () => {
    const project = makeProject({ id: 'project-1', repoPath: '' });

    await expect(saveHandler({}, [project])).rejects.toThrow(
      'Invalid repoPath for project project-1: must be an absolute path',
    );
  });

  it('accepts absolute repoPath', async () => {
    const project = makeProject({
      id: 'project-1',
      repoPath: '/absolute/path',
    });

    await expect(saveHandler({}, [project])).resolves.toBeDefined();
  });

  it('validates all projects and rejects on first invalid one', async () => {
    const valid = makeProject({ id: 'valid-1', repoPath: '/repo' });
    const invalid = makeProject({ id: 'INVALID', repoPath: '/repo' });

    await expect(saveHandler({}, [valid, invalid])).rejects.toThrow(
      'Invalid item id: must be lowercase alphanumeric with hyphens',
    );

    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('does not write files when validation fails', async () => {
    const project = makeProject({ id: 'bad!', repoPath: '/repo' });

    await expect(saveHandler({}, [project])).rejects.toThrow();

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedMkdir).not.toHaveBeenCalled();
  });

  it('rejects malformed preserved project ids before writing', async () => {
    const project = makeProject();

    await expect(
      saveHandler({}, [project], {
        preserveWorkspaceIds: ['Bad Id!'],
      }),
    ).rejects.toThrow(
      'Invalid preserved project id: must be lowercase alphanumeric with hyphens',
    );

    expect(mockedWriteFile).not.toHaveBeenCalled();
    expect(mockedMkdir).not.toHaveBeenCalled();
  });

  it('accepts saving an empty project array', async () => {
    const result = await saveHandler({}, []);

    expect(result).toEqual({ version: 1, items: [] });
  });
});

describe('delete handler', () => {
  beforeEach(() => {
    mockedDeleteWorkspace.mockReset().mockResolvedValue({
      workspaceId: 'project-1',
      removed: 'code',
      cleanup: {
        archivedGitRefs: { status: 'done' },
        chatSearchRows: { status: 'done' },
        managedRepository: { status: 'done' },
        skillSuggestions: { status: 'done' },
      },
    });
  });

  it('runs the full single-repo project deletion through the workspace deletion boundary', async () => {
    await deleteHandler({}, { projectId: 'project-1' });

    expect(mockedDeleteWorkspace).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      source: 'single_repo_project_delete',
      singleRepoProject: true,
    });
  });

  it('still fails when the managed repository could not be removed', async () => {
    mockedDeleteWorkspace.mockResolvedValue({
      workspaceId: 'project-1',
      removed: 'code',
      cleanup: {
        archivedGitRefs: { status: 'done' },
        chatSearchRows: { status: 'done' },
        managedRepository: { status: 'failed', error: new Error('EBUSY') },
        skillSuggestions: { status: 'done' },
      },
    });

    await expect(deleteHandler({}, { projectId: 'project-1' })).rejects.toThrow(
      'EBUSY',
    );
  });

  it('passes a refusal through unchanged', async () => {
    mockedDeleteWorkspace.mockRejectedValue(
      new Error(
        'Cannot delete this project while its configuration is unavailable. Reload and try again.',
      ),
    );

    await expect(deleteHandler({}, { projectId: 'project-1' })).rejects.toThrow(
      'Cannot delete this project while its configuration is unavailable',
    );
  });

  it('rejects invalid project id', async () => {
    await expect(deleteHandler({}, { projectId: 'INVALID' })).rejects.toThrow();
    expect(mockedDeleteWorkspace).not.toHaveBeenCalled();
  });

  it('passes a supersede operation id and rejects a malformed one at the boundary', async () => {
    const operationId = '00000000-0000-4000-8000-000000000000';
    await deleteHandler(
      {},
      { projectId: 'project-1', supersedeInterruptedDeletion: operationId },
    );
    expect(mockedDeleteWorkspace).toHaveBeenCalledWith({
      workspaceId: 'project-1',
      source: 'single_repo_project_delete',
      singleRepoProject: true,
      supersedeInterruptedDeletion: operationId,
    });

    mockedDeleteWorkspace.mockClear();
    await expect(
      deleteHandler(
        {},
        {
          projectId: 'project-1',
          supersedeInterruptedDeletion: 'NOT/an-operation-id',
        },
      ),
    ).rejects.toThrow('Invalid supersedeInterruptedDeletion');
    expect(mockedDeleteWorkspace).not.toHaveBeenCalled();
  });
});
