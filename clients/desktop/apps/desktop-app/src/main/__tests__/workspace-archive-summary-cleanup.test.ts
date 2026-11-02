import type * as DestructiveRecovery from '../lib/w5-destructive-recovery';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../lib/w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../lib/w5-destructive-recovery',
  ),
  readDestructiveRecovery: jest.fn(() => Promise.resolve(null)),
  assertNoDestructiveRecovery: jest.fn(() => Promise.resolve()),
  assertNoLegacyArchiveRecovery: jest.fn(() => Promise.resolve()),
  refuseInterruptedArchiveJournal: jest.fn(() => Promise.resolve()),
  findCompletedDestructiveArchive: jest.fn(() => Promise.resolve(null)),
  reportDestructiveRecovery: jest.fn(() => Promise.resolve([])),
  withDestructiveLifecycle: (
    _input: unknown,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveStep: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
  destructiveCall: (
    _phase: string,
    work: (...args: unknown[]) => Promise<unknown>,
    ...args: unknown[]
  ): Promise<unknown> => work(...args),
  hasDestructiveLifecycle: (): boolean => false,
  assertDestructiveRowIdentity: (): void => {},
  acknowledgeArchiveCaptureRefusal: (): void => {},
  protectDestructivePath: (): Promise<void> => Promise.resolve(),
  markDestructiveCleanupRequired: (): void => {},
  destructiveCleanup: (
    _phase: string,
    work: () => Promise<unknown>,
  ): Promise<unknown> => work(),
}));
// Native profile transactions are exercised with real registries in browser-profile-service.test.ts.
jest.mock('../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() =>
    Promise.resolve('profile-retirement'),
  ),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
}));
import type * as InstructionFiles from '../lib/instruction-files';
jest.mock('node:fs/promises');
jest.mock('../lib/unmanaged-worktree-repository', () => ({
  listUnmanagedWorktreeRepositories: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'test-animal'),
}));
jest.mock('../lib/git', () => {
  const removeWorktree = jest.fn<Promise<void>, [string, string]>();
  return {
    addRemoteAndSync: jest.fn(),
    bestEffortPruneWorktrees: jest.fn(),
    cleanupPersistedTurnDiffTreeRefs: jest.fn(() => Promise.resolve()),
    cloneRepo: jest.fn(),
    commitWithLocalIdentity: jest.fn(),
    createWorktree: jest.fn(),
    createWorktreeFromHead: jest.fn(),
    deleteBranch: jest.fn(),
    getCurrentBranch: jest.fn(),
    getDiffStats: jest.fn(() =>
      Promise.resolve({ insertions: 0, deletions: 0 }),
    ),
    getRemoteUrl: jest.fn(),
    getRepoRootFromWorktree: jest.fn(),
    initLocalRepo: jest.fn(),
    hasCommitsAhead: jest.fn(() => Promise.resolve(false)),
    hasUncommittedChanges: jest.fn(() => Promise.resolve(false)),
    isGitRepo: jest.fn(),
    isRegisteredWorktreePath: jest.fn(() => Promise.resolve(true)),
    pruneWorktrees: jest.fn(),
    removeWorktree,
    withWorktreeRemovalLock: jest.fn(
      (
        repoPath: string,
        operation: (
          removeLockedWorktree: (worktreePath: string) => Promise<void>,
        ) => Promise<unknown>,
      ) => operation((worktreePath) => removeWorktree(repoPath, worktreePath)),
    ),
    stageAllChanges: jest.fn(),
  };
});
jest.mock('../lib/paths', () => ({
  getAppAdvisorWatchersFilePath: jest.fn(
    () => '/mock/app-advisor-watchers.json',
  ),
  getDefaultReposDir: jest.fn(() => '/mock/repos'),
  getWorktreeDataDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktree-data/${worktreeId}`,
  ),
  getWorkspaceChatTabsFilePath: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/chats/${worktreeId}.json`,
  ),
  getWorkspaceClaudeMdPath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/CLAUDE.md`,
  ),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}`,
  ),
  getWorkspaceWorktreeSummaryFilePath: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/summaries/${worktreeId}.json`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeReposDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/worktrees/${worktreeId}/repos`,
  ),
  getWorkspaceWorktreesFilePath: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees.json`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (workspaceId: string) => `/mock/workspaces/${workspaceId}/worktrees`,
  ),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/mock/workspaces/${workspaceId}/attachments/${worktreeId}`,
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  isWorkEntryWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(() => Promise.resolve(null)),
  markWorkspaceWorktreeRecentlyRemoved: jest.fn(),
  markWorktreeRecentlyRemoved: jest.fn(),
  removeWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  readWorkspaceWorktreesDetailed: jest.fn(async (workspaceId: string) => ({
    worktrees: await jest
      .requireMock<{
        readWorkspaceWorktrees: (id: string) => Promise<unknown[]>;
      }>('../lib/workspace-persistence')
      .readWorkspaceWorktrees(workspaceId),
    authority: 'ok',
  })),
  readWorkspaceConfigDetailed: jest.fn(async (workspaceId: string) => ({
    config: await jest
      .requireMock<{
        readWorkspaceConfig: (id: string) => Promise<unknown>;
      }>('../lib/workspace-persistence')
      .readWorkspaceConfig(workspaceId),
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  })),
  isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
  updateWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
  writeWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
  writeAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
}));
jest.mock('../lib/script-runner', () => ({
  drainWorktreeShellScripts: jest.fn(() => Promise.resolve()),
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-events', () => ({
  createScriptCompleteEvent: jest.fn(),
  createScriptOutputEvent: jest.fn(),
  createScriptStartedEvent: jest.fn(),
  createWorkspaceRootScriptDescriptor: jest.fn(),
  createWorkspaceRepoScriptDescriptor: jest.fn(),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(() => undefined),
  listLiveBackgroundTaskOwners: jest.fn(() => []),
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
  subscribeChatSessionActivity: jest.fn(() => jest.fn()),
  subscribeLiveBackgroundTasks: jest.fn(() => jest.fn()),
  hasPendingCodexContinuation: jest.fn(() => false),
  getChatSessionLiveness: jest.fn(() => ({
    foreground: false,
    background: false,
  })),
  getGlobalPluginDefaultsRevision: jest.fn(() => 0),
  getSessionGlobalPluginDefaultsRevision: jest.fn(() => undefined),
  destroyWorktreeSessions: jest.fn(() => Promise.resolve()),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ deleteBranchOnArchive: false }),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({ deleteBranchOnArchive: false }),
  ),
}));
jest.mock('../pipelines/worktree-cleanup', () => ({
  cleanupWorktreePipelines: jest.fn(() => Promise.resolve({ warnings: [] })),
  drainWorktreePipelines: jest.fn(() => Promise.resolve()),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(() => ({
    executionsDir: '/mock/executions',
    tempRootDir: '/mock/executions',
    bundledActionsDir: '/mock/actions',
    getProjectActionsDir: (repoPath: string): string => repoPath,
  })),
}));
jest.mock('../lib/github-poller', () => ({
  stopTracking: jest.fn(),
  syncTrackedWorktrees: jest.fn(),
}));
jest.mock('../lib/instruction-files', () => ({
  ...jest.requireActual<typeof InstructionFiles>('../lib/instruction-files'),
  ensureAgentsMdSymlink: jest.fn(),
}));
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  hasManifestRepos: jest.fn(() => false),
  writeCanopyJson: jest.fn(),
}));
jest.mock('../lib/repo-url-matcher', () => ({
  remoteUrlsMatch: jest.fn(() => false),
}));
jest.mock('../lib/workspace-source', () => ({
  readWorkspaceSettingsData: jest.fn(),
  readEffectiveWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/workspace-drift', () => ({
  readWorkspaceDriftSummary: jest.fn(),
}));
jest.mock('../lib/workspace-readiness', () => ({
  computeWorkspaceReadinessIssues: jest.fn(),
}));
jest.mock('../lib/workspace-source-control', () => ({
  initializeWorkspaceSourceRepo: jest.fn(),
  repairWorkspaceRootWorktree: jest.fn(),
  validateWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
}));
jest.mock('../lib/worktree-summary-scheduler', () => ({
  cancelScheduledGeneration: jest.fn(),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));

import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { cleanupPersistedTurnDiffTreeRefs } from '../lib/git';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { registerIpcHandler } from '../ipc/register';
import { registerWorkspaceHandlers } from '../ipc/workspaces';
import { validateId } from '../lib/validation';
import { readWorkspaceConfig } from '../lib/workspace-persistence';
import { computeWorkspaceReadinessIssues } from '../lib/workspace-readiness';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedReadFile = jest.mocked(readFile);
const mockedCleanupPersistedTurnDiffTreeRefs = jest.mocked(
  cleanupPersistedTurnDiffTreeRefs,
);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedRm = jest.mocked(rm);
const mockedReaddir = jest.mocked(readdir);
const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);
const mockedComputeWorkspaceReadinessIssues = jest.mocked(
  computeWorkspaceReadinessIssues,
);
const mockedValidateId = jest.mocked(validateId);

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

let archiveHandler: HandlerFn;
let readinessHandler: HandlerFn;

beforeEach(() => {
  jest.clearAllMocks();
  mockedReadFile.mockRejectedValue(
    Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
  );
  // The watcher store stats its file before reading it.
  jest
    .mocked(stat)
    .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockedRm.mockResolvedValue(undefined);
  // Archive scans `worktrees/<id>/repos` for stale child checkouts; the
  // automocked readdir would otherwise return undefined.
  mockedReaddir.mockResolvedValue([]);
  mockedReadWorkspaceConfig.mockResolvedValue({
    version: 1,
    type: 'multi-repo',
    repos: [],
    sourceRepoPath: '/repos/workspace-source',
  });
  mockedComputeWorkspaceReadinessIssues.mockResolvedValue([]);

  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      query: (
        ...args: Parameters<DesktopCanopyDispatcher['query']>
      ): Promise<never> => {
        void args;
        return Promise.reject(new Error('Unexpected dispatcher query'));
      },
      instruction: (
        ...args: Parameters<DesktopCanopyDispatcher['instruction']>
      ): Promise<never> => {
        void args;
        return Promise.reject(new Error('Unexpected dispatcher instruction'));
      },
      queryWorktreeListForLegacyIpc: () =>
        Promise.resolve({
          canonicalResult: null,
          legacyResult: [],
        }),
    },
    resolveCaller: () => ({
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test',
      grants: ['core.worktree.read'],
    }),
  });

  const archiveCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'workspace:archive-worktree',
  );
  if (!archiveCall) {
    throw new Error('workspace:archive-worktree handler was not registered');
  }

  const handler = archiveCall[1];
  if (typeof handler !== 'function') {
    throw new Error('workspace:archive-worktree handler is not callable');
  }

  archiveHandler = (event: unknown, request: unknown): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [event, request]));

  const readinessCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'workspace:read-readiness',
  );
  if (!readinessCall || typeof readinessCall[1] !== 'function') {
    throw new Error('workspace:read-readiness handler was not registered');
  }
  readinessHandler = (event: unknown, request: unknown): Promise<unknown> =>
    Promise.resolve(
      Reflect.apply(readinessCall[1], undefined, [event, request]),
    );
});

// The archive boundary (CAN-3811) only archives a worktree in the list; the
// archive itself then sees the list it saw before this change.
beforeEach(() => {
  jest
    .mocked(
      jest.requireMock<{
        readWorkspaceWorktrees: () => Promise<unknown[]>;
      }>('../lib/workspace-persistence').readWorkspaceWorktrees,
    )
    .mockReset()
    .mockResolvedValue([])
    .mockResolvedValueOnce(
      ['test-animal', 'worktree-1'].map((id) => ({
        id,
        branchName: `branch-${id}`,
        createdAt: '2026-01-01T00:00:00.000Z',
      })),
    );
});

describe('workspace:read-readiness', () => {
  it('returns the dedicated readiness response for a project and worktree', async () => {
    mockedComputeWorkspaceReadinessIssues.mockResolvedValueOnce([
      {
        code: 'configure-hooks',
        title: 'Add repository hooks',
        message: 'No effective hooks.',
        repoName: 'app',
        fixPrompt: 'Configure hooks.',
      },
    ]);

    await expect(
      readinessHandler(
        {},
        { workspaceId: 'workspace-1', worktreeId: 'worktree-1' },
      ),
    ).resolves.toEqual({
      issues: [
        expect.objectContaining({
          code: 'configure-hooks',
          repoName: 'app',
        }),
      ],
    });
    expect(mockedComputeWorkspaceReadinessIssues).toHaveBeenCalledWith(
      'workspace-1',
      'worktree-1',
    );
    expect(mockedValidateId).toHaveBeenCalledWith('workspace-1', 'workspaceId');
    expect(mockedValidateId).toHaveBeenCalledWith('worktree-1', 'worktreeId');
  });

  it('rejects instead of turning audit failures into a ready response', async () => {
    mockedComputeWorkspaceReadinessIssues.mockRejectedValueOnce(
      new Error('audit failed'),
    );

    await expect(
      readinessHandler({}, { workspaceId: 'workspace-1' }),
    ).rejects.toThrow('audit failed');
  });

  it('rejects malformed worktree ids before running the readiness audit', async () => {
    mockedValidateId
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error('Invalid worktreeId');
      });

    await expect(
      readinessHandler(
        {},
        { workspaceId: 'workspace-1', worktreeId: '../outside' },
      ),
    ).rejects.toThrow('Invalid worktreeId');
    expect(mockedComputeWorkspaceReadinessIssues).not.toHaveBeenCalled();
  });
});

describe('workspace:archive-worktree summary cleanup', () => {
  it('removes archived worktree summaries from the unified summaries directory', async () => {
    await archiveHandler(
      {},
      {
        workspaceId: 'workspace-1',
        worktreeId: 'test-animal',
      },
    );

    expect(mockedCleanupPersistedTurnDiffTreeRefs).toHaveBeenCalledWith(
      '/repos/workspace-source',
      'workspace-1',
      'test-animal',
    );
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'workspace-1',
      'test-animal',
      expect.objectContaining({ observabilityMode: 'live-service' }),
    );
  });
});
