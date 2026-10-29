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
jest.mock('node:fs/promises');
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'test-animal'),
}));
jest.mock('../lib/git', () => {
  const removeWorktree = jest.fn<Promise<void>, [string, string]>();
  return {
    bestEffortPruneWorktrees: jest.fn(),
    cleanupPersistedTurnDiffTreeRefs: jest.fn(() => Promise.resolve()),
    createWorktree: jest.fn(),
    deleteBranch: jest.fn(),
    getCurrentBranch: jest.fn(),
    getDiffStats: jest.fn(),
    getRemoteDefaultBranch: jest.fn(),
    hasCommitsAhead: jest.fn(),
    hasRemoteTrackingBranch: jest.fn(),
    hasUncommittedChanges: jest.fn(),
    hasUnpushedCommits: jest.fn(),
    isRegisteredWorktreePath: jest.fn(() => Promise.resolve(true)),
    pruneWorktrees: jest.fn(),
    removeWindowsWorktreeReparsePoints: jest.fn(() => Promise.resolve()),
    removeWorktree,
    withWorktreeRemovalLock: jest.fn(
      (
        repoPath: string,
        operation: (
          removeLockedWorktree: (worktreePath: string) => Promise<void>,
        ) => Promise<unknown>,
      ) => operation((worktreePath) => removeWorktree(repoPath, worktreePath)),
    ),
  };
});
jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorkspaceWorktreesFilePath: jest.fn(
    (id: string) => `/mock/workspaces/${id}/worktrees.json`,
  ),
  getAppAdvisorWatchersFilePath: jest.fn(
    () => '/mock/app-advisor-watchers.json',
  ),
  getChatTabsFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/chats/${worktreeId}.json`,
  ),
  getWorktreeDataDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktree-data/${worktreeId}`,
  ),
  getWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
  getWorktreeSummaryFilePath: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/summaries/${worktreeId}.json`,
  ),
  getWorktreeAttachmentsDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/attachments/${worktreeId}`,
  ),
}));
jest.mock('../lib/workspace-registry', () => ({
  isMultiRepoWorkspace: jest.fn(() => false),
  isWorkEntryWorkspace: jest.fn(() => false),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/mock/workspaces/${projectId}/worktrees/${worktreeId}`,
  ),
}));
jest.mock('../lib/validation', () => ({
  validateAbsolutePath: jest.fn((value: string, label: string) => {
    if (!value.startsWith('/')) {
      throw new Error(`Invalid ${label}: must be an absolute path`);
    }
  }),
  validateId: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  getWorkspaceWorktreeCreatedAt: jest.fn(() => Promise.resolve(null)),
  markWorkspaceWorktreeRecentlyRemoved: jest.fn(),
  markWorktreeRecentlyRemoved: jest.fn(),
  removeWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
  readWorkspaceConfig: jest.fn(() =>
    Promise.resolve({
      version: 1,
      type: 'single-repo',
      repos: [],
      temporary: false,
      repoPath: '/repos/project-1',
    }),
  ),
  readWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
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
}));
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
}));
jest.mock('../lib/script-runner', () => ({
  drainWorktreeShellScripts: jest.fn(() => Promise.resolve()),
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-events', () => ({
  createProjectScriptDescriptor: jest.fn(),
  createScriptCompleteEvent: jest.fn(),
  createScriptOutputEvent: jest.fn(),
  createScriptStartedEvent: jest.fn(),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
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
jest.mock('../lib/github-poller', () => ({
  stopTracking: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
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
jest.mock('../lib/worktree-summary-scheduler', () => ({
  cancelScheduledGeneration: jest.fn(),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));

import { readFile, rm, stat } from 'node:fs/promises';
import { BrowserProfileError } from '@canopy/desktop-shared/browser-profile-error';
import {
  commitTaskBrowserRetirement,
  prepareTaskBrowserRetirement,
  retireRemovedBrowserTask,
  settleFailedTaskBrowserRetirement,
} from '../browser/browser-profile-lifecycle';
import { isRegisteredWorktreePath, removeWorktree } from '../lib/git';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { registerIpcHandler } from '../ipc/register';
import { registerWorktreeHandlers } from '../ipc/worktrees';

const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedReadFile = jest.mocked(readFile);
const mockedRm = jest.mocked(rm);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedIsRegisteredWorktreePath = jest.mocked(isRegisteredWorktreePath);
const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);

type HandlerFn = (event: unknown, request: unknown) => Promise<unknown>;

let archiveHandler: HandlerFn;

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

  registerWorktreeHandlers(() => null);

  const archiveCall = mockedRegisterIpcHandler.mock.calls.find(
    ([channel]) => channel === 'worktree:archive',
  );
  if (!archiveCall) {
    throw new Error('worktree:archive handler was not registered');
  }

  const handler = archiveCall[1];
  if (typeof handler !== 'function') {
    throw new Error('worktree:archive handler is not callable');
  }

  archiveHandler = (event: unknown, request: unknown): Promise<unknown> =>
    Promise.resolve(Reflect.apply(handler, undefined, [event, request]));
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

describe('worktree:archive chat cleanup', () => {
  it('removes archived worktree chat tabs from the unified project chats directory', async () => {
    await archiveHandler(
      {},
      {
        projectId: 'project-1',
        worktreeId: 'test-animal',
        repoPath: '/repos/project-1',
      },
    );

    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'project-1',
      'test-animal',
      expect.objectContaining({ observabilityMode: 'live-service' }),
    );
  });

  it('rethrows worktree teardown failures instead of swallowing them', async () => {
    mockedRemoveWorktree.mockRejectedValueOnce(
      new Error('git teardown failed'),
    );
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockedRm.mockImplementation((targetPath) => {
      if (targetPath === '/mock/workspaces/project-1/worktrees/test-animal') {
        return Promise.reject(new Error('fallback rm failed'));
      }
      return Promise.resolve(undefined);
    });

    await expect(
      archiveHandler(
        {},
        {
          projectId: 'project-1',
          worktreeId: 'test-animal',
          repoPath: '/repos/project-1',
        },
      ),
    ).rejects.toThrow('fallback rm failed');
  });
});

describe('worktree:archive browser profile independence', () => {
  const request = {
    projectId: 'project-1',
    worktreeId: 'test-animal',
    repoPath: '/repos/project-1',
  };

  it('archives when browser profile retirement cannot be prepared and retires the profile after the owner is removed', async () => {
    jest
      .mocked(prepareTaskBrowserRetirement)
      .mockRejectedValueOnce(
        new BrowserProfileError(
          'recovery_required',
          'The browser task archive outcome is uncertain. Its profile remains fenced.',
        ),
      );

    await expect(archiveHandler({}, request)).resolves.toMatchObject({
      success: true,
    });

    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalled();
    expect(commitTaskBrowserRetirement).not.toHaveBeenCalled();
    expect(retireRemovedBrowserTask).toHaveBeenCalledWith(
      'project-1',
      'test-animal',
    );
  });

  it('archives when the browser profile commit fails after the owner is removed', async () => {
    jest
      .mocked(commitTaskBrowserRetirement)
      .mockRejectedValueOnce(
        new BrowserProfileError(
          'storage_unavailable',
          'Browser profile metadata is in use by another process.',
        ),
      );
    jest
      .mocked(retireRemovedBrowserTask)
      .mockRejectedValueOnce(new Error('metadata still busy'));

    const response = await archiveHandler({}, request);

    expect(response).toMatchObject({ success: true });
    expect(JSON.stringify(response)).toContain(
      'Browser data for this worktree will be cleared the next time the app starts.',
    );
  });

  it('keeps the original archive error when settling the browser retirement fails', async () => {
    mockedRemoveWorktree.mockRejectedValueOnce(
      new Error('git teardown failed'),
    );
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockedRm.mockImplementation((targetPath) =>
      targetPath === '/mock/workspaces/project-1/worktrees/test-animal'
        ? Promise.reject(new Error('fallback rm failed'))
        : Promise.resolve(undefined),
    );
    jest
      .mocked(settleFailedTaskBrowserRetirement)
      .mockRejectedValueOnce(new Error('browser metadata unavailable'));

    await expect(archiveHandler({}, request)).rejects.toThrow(
      'fallback rm failed',
    );
  });
});
