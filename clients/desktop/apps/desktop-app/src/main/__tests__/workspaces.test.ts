import { cloneRepoWithLiveProgress } from '../lib/git';
import { getCloneJobs } from '../services/clone-jobs-host';
import { addWorkspaceFromRemote } from '../lib/workspace-service';
import {
  beginWorktreeGitSetup,
  claimWorktreeGitSetup,
} from '../lib/worktree-git-setup';
jest.mock('../lib/adhoc-combination-binding', () => ({
  bindCombinationAfterJoin: jest.fn((response) => Promise.resolve(response)),
}));
const { bindCombinationAfterJoin } = jest.requireMock<{
  bindCombinationAfterJoin: jest.Mock<
    Promise<AdhocMultiRepoCombineResponse>,
    [AdhocMultiRepoCombineResponse, AdhocMultiRepoCombineRequest['mode']]
  >;
}>('../lib/adhoc-combination-binding');
import type * as DestructiveRecovery from '../lib/w5-destructive-recovery';
import type * as ValidationModule from '../lib/validation';
import type * as WorkspacePersistenceModule from '../lib/workspace-persistence';
// This suite controls the legacy filesystem. Durable lifecycle evidence is
// exercised with real files and workers in w5-destructive-recovery.test.ts.
jest.mock('../lib/w5-destructive-recovery', () => ({
  ...jest.requireActual<typeof DestructiveRecovery>(
    '../lib/w5-destructive-recovery',
  ),
  readDestructiveRecovery: jest.fn(() => Promise.resolve(null)),
  assertNoDestructiveRecovery: jest.fn(() => Promise.resolve()),
  readInFlightWorktreeDestructiveOperations: jest.fn(() => Promise.resolve([])),
  assertFailedChildArchivesResumed: jest.fn(() => Promise.resolve()),
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
import type * as CompositionRecords from '../lib/workspace-composition-records';
jest.mock('../lib/workspace-composition-records', () => {
  const actual = jest.requireActual<typeof CompositionRecords>(
    '../lib/workspace-composition-records',
  );
  return {
    ...actual,
    createTemporaryCompositionRecords: jest.fn(),
    indexTemporaryCompositionWorkspace: jest.fn(),
    cleanupCompositionDestination: jest.fn(),
  };
});
import {
  createTemporaryCompositionRecords,
  indexTemporaryCompositionWorkspace,
} from '../lib/workspace-composition-records';
jest.mock('../services/org-project-auto-conversion-host', () => ({
  requestOrgProjectAutoConversion: jest.fn(),
}));
import type * as ImportFolderModule from '@canopy/desktop-shared/node/lib/import-folder';
import { requestOrgProjectAutoConversion } from '../services/org-project-auto-conversion-host';
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
import type * as AtomicFileModule from '../lib/atomic-file';
import type * as SidebarItemsModule from '../lib/sidebar-items';
import { Dirent, statSync } from 'node:fs';
import {
  IPC_CHANNELS,
  STANDALONE_CHAT_PROJECT_ID,
  COWORK_HOME_WORKTREE_ID,
  WORKSPACE_ROOT_REPO_ID,
  type SidebarItem,
  type AdhocMultiRepoCombineResponse,
  type AdhocMultiRepoCombineRequest,
  type SplitTemporaryWorkspaceDestructiveApprovalResponse,
  type ArchivedContainerRecoveryManifest,
  type ArchivedGitRepositoryState,
  type WorktreeData,
  type WorkspaceConfigFile,
  type WorkspaceIndexEntry,
} from '@canopy/desktop-shared/types';

jest.mock('node:fs/promises');
// The fixtures name folders that only exist in the mocked filesystem.
jest.mock('@canopy/desktop-shared/node/lib/import-folder', () => ({
  ...jest.requireActual<typeof ImportFolderModule>(
    '@canopy/desktop-shared/node/lib/import-folder',
  ),
  assertImportFolderExists: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/atomic-file', () => ({
  ...jest.requireActual<typeof AtomicFileModule>('../lib/atomic-file'),
  writeFileAtomically: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/unmanaged-worktree-repository', () => ({
  listUnmanagedWorktreeRepositories: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(),
    commitLocalWorkspaceCancellation: jest.fn(),
  })),
}));
jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/worktree-data/${wtId}`,
  ),
  getWorktreeDataRootDir: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/worktree-data`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/worktrees/${wtId}`,
  ),
  getWorkspaceChatTabsFilePath: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/chats/${wtId}.json`,
  ),
  getWorkspaceWorktreeSummaryFilePath: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/summaries/${wtId}.json`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/worktrees/${wtId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (wsId: string, wtId: string, repoId: string) =>
      `/mock/workspaces/${wsId}/worktrees/${wtId}/repos/${repoId}`,
  ),
  getWorkspaceClaudeMdPath: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/CLAUDE.md`,
  ),
  getWorkspaceIndexFilePath: jest.fn(() => '/mock/workspaces/index.json'),
  getWorkspaceDir: jest.fn((wsId: string) => `/mock/workspaces/${wsId}`),
  getWorkspacesFilePath: jest.fn(() => '/mock/workspaces/workspaces.json'),
  getWorkspaceWorktreesFilePath: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/worktrees.json`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/worktrees`,
  ),
  getArchivedContainersRootDir: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/archived-containers`,
  ),
  getWorkspaceConfigPath: jest.fn(
    (wsId: string) => `/mock/workspaces/${wsId}/workspace.json`,
  ),
  getProjectsFilePath: jest.fn(() => '/mock/projects.json'),
  getDefaultReposDir: jest.fn(() => '/mock/repos'),
  getWorkspaceWorktreeAttachmentsDir: jest.fn(
    (wsId: string, wtId: string) =>
      `/mock/workspaces/${wsId}/attachments/${wtId}`,
  ),
}));
jest.mock('../lib/git', () => {
  const removeWorktree = jest.fn<Promise<void>, [string, string]>();
  return {
    cleanupPersistedTurnDiffTreeRefs: jest.fn(() => Promise.resolve()),
    bestEffortPruneWorktrees: jest.fn(),
    createWorktree: jest.fn(),
    createWorktreeAvoidingCheckedOutBranch: jest.fn(),
    createWorktreeForExistingBranch: jest.fn(),
    createWorktreeFromStartPoint: jest.fn(),
    removeWorktree,
    withWorktreeRemovalLock: jest.fn(
      (
        repoPath: string,
        operation: (
          removeLockedWorktree: (worktreePath: string) => Promise<void>,
        ) => Promise<unknown>,
      ) => operation((worktreePath) => removeWorktree(repoPath, worktreePath)),
    ),
    deleteBranch: jest.fn(),
    doesLocalBranchExist: jest.fn(),
    doesRemoteBranchExist: jest.fn(),
    fetchOrigin: jest.fn(),
    getCurrentBranch: jest.fn(),
    getRemoteUrl: jest.fn(),
    getRepoRootFromWorktree: jest.fn(),
    isBranchNameAvailable: jest.fn(),
    listCheckedOutBranches: jest.fn(() => Promise.resolve(new Map())),
    isGitRepo: jest.fn(),
    isRegisteredWorktreePath: jest.fn(() => Promise.resolve(true)),
    pruneWorktrees: jest.fn(),
    removeWindowsWorktreeReparsePoints: jest.fn(() => Promise.resolve()),
    resolveSharedAvailableBranchName: jest.fn(),
    stageAllChanges: jest.fn(),
    commitWithLocalIdentity: jest.fn(),
    addRemoteAndSync: jest.fn(),
    cloneRepo: jest.fn(),
    cloneRepoWithLiveProgress: jest.fn(() => Promise.resolve()),
  };
});
jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
  hasManifestRepos: jest.fn(),
  writeCanopyJson: jest.fn(),
}));
jest.mock('../lib/validation', () => ({
  validateId: jest.fn(),
}));
jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn(() => 'test-animal'),
}));
jest.mock('../lib/workspace-persistence', () => {
  const readWorkspaceConfig = jest.fn<Promise<WorkspaceConfigFile>, [string]>();
  const readWorkspaceWorktrees = jest.fn<
    ReturnType<typeof WorkspacePersistenceModule.readWorkspaceWorktrees>,
    Parameters<typeof WorkspacePersistenceModule.readWorkspaceWorktrees>
  >(() => Promise.resolve([]));
  const readWorkspaceConfigDetailed = jest.fn<
    ReturnType<typeof WorkspacePersistenceModule.readWorkspaceConfigDetailed>,
    [string]
  >(async (workspaceId) => ({
    config: await readWorkspaceConfig(workspaceId),
    authority: 'ok',
    ownerMalformed: false,
    memoryMalformed: false,
  }));
  const writeWorkspaceConfig = jest.fn();
  return {
    markWorkspaceWorktreeRecentlyRemoved: jest.fn(),
    markWorktreeRecentlyRemoved: jest.fn(),
    readWorkspaceWorktreesDetailed: jest.fn(async (workspaceId: string) => ({
      worktrees: await readWorkspaceWorktrees(workspaceId),
      authority: 'ok',
    })),
    removeWorkspaceWorktrees: jest.fn(() => Promise.resolve([])),
    readWorkspaceConfig,
    readWorkspaceConfigDetailed,
    readWorkspaceOwnership: jest.fn(
      async (
        workspaceId: string,
      ): ReturnType<
        typeof WorkspacePersistenceModule.readWorkspaceOwnership
      > => {
        const detail = await readWorkspaceConfigDetailed(workspaceId);
        if (detail.authority !== 'ok') return { authority: detail.authority };
        if (detail.ownerMalformed) return { authority: 'unreadable' };
        return {
          authority: 'ok',
          type: detail.config.type,
          owner: detail.config.owner,
          ownershipTransfer: detail.config.ownershipTransfer,
        };
      },
    ),
    readWorkspaceWorktrees,
    writeWorkspaceWorktrees: jest.fn(() => Promise.resolve()),
    isWorkspaceWorktreeRecentlyRemoved: jest.fn(() => false),
    updateWorkspaceWorktree: jest.fn(() => Promise.resolve(true)),
    updateWorkspaceWorktrees: jest.fn(
      async (
        _workspaceId: string,
        updater: (worktrees: unknown[]) => unknown[] | Promise<unknown[]>,
      ) => updater([]),
    ),
    writeWorkspaceConfig,
    WorkspaceConfigUnreadableError: class WorkspaceConfigUnreadableError extends Error {},
    updateWorkspaceConfig: jest.fn(
      async (
        workspaceId: string,
        update: (config: unknown, read: unknown) => unknown,
        options?: { shouldWrite?: (result: unknown) => boolean },
      ): Promise<unknown> => {
        const config: unknown = await readWorkspaceConfig(workspaceId);
        const result = await update(config, {
          authority: 'ok',
          ownerMalformed: false,
          memoryMalformed: false,
        });
        if (options?.shouldWrite && !options.shouldWrite(result)) return result;
        await writeWorkspaceConfig(workspaceId, config);
        return result;
      },
    ),
  };
});
// CAN-3546: an organization's multi-repo project checks and syncs each
// repository change; a Personal one passes straight through.
const mockOrgMultiRepoSync = {
  addRepo: jest.fn(
    (_workspaceId: string, _repoPath: string, add: () => Promise<unknown>) =>
      add(),
  ),
  removeRepo: jest.fn(
    (_workspaceId: string, _repoId: string, remove: () => Promise<void>) =>
      remove(),
  ),
  applySourceChanges: jest.fn(
    (_workspaceId: string, _request: unknown, apply: () => Promise<unknown>) =>
      apply(),
  ),
};
jest.mock('../lib/workspace-retention', () => ({
  updateWorkspaceRetention: jest.fn(() =>
    Promise.resolve({
      workspaceId: 'test-workspace',
      activityBaselineRecorded: false,
    }),
  ),
}));
jest.mock('../lib/workspace-default-plugins-save', () => ({
  saveDefaultPluginsAndVisibility: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/workspace-private-memory', () => ({
  updateWorkspacePrivateMemory: jest.fn(() =>
    Promise.resolve({ workspaceId: 'test-workspace', privateMemory: true }),
  ),
}));
jest.mock('../lib/org-member-multi-repo-sync-deps', () => ({
  getOrgMemberMultiRepoSync: (): typeof mockOrgMultiRepoSync =>
    mockOrgMultiRepoSync,
}));
jest.mock('../lib/archived-containers', () => ({
  listArchivedContainerManifests: jest.fn(() => Promise.resolve([])),
  listArchivedContainerManifestsStrict: jest.fn(() => Promise.resolve([])),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
jest.mock('../lib/archived-container-git', () => ({
  readArchivedGitStagedDescriptor: jest.fn(() => Promise.resolve(null)),
  releaseArchivedGitState: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/archived-container-recovery', () => ({
  finishArchivedContainerRecovery: jest.fn(() => Promise.resolve([])),
  readProjectWorktreeRegistrations: jest.fn((projectId: string) =>
    Promise.resolve({ projectId, repositories: [] }),
  ),
  removeProjectWorktreeRegistrations: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/workspace-activity', () => ({
  runWithWorkspaceTargetActivityDeletion: <T>(
    _projectId: string,
    _worktreeId: string,
    operation: () => Promise<T>,
  ): Promise<T> => operation(),
  touchAllWorkspaceTargets: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));
// The workspace index the conversion command (CAN-3819) updates in place.
const mockWorkspaceIndex: { entries: WorkspaceIndexEntry[] } = { entries: [] };
jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(),
  readWorkspaceIndexEntry: jest.fn(),
  writeAllSidebarItems: jest.fn(),
  removeWorkspaceIndexEntry: jest.fn(),
  toSidebarItemWorkspaceConfig: jest.fn((item: SidebarItem) =>
    jest
      .requireActual<typeof SidebarItemsModule>('../lib/sidebar-items')
      .toSidebarItemWorkspaceConfig(item),
  ),
  getWorkspaceIndexRepository: jest.fn(() => ({
    read: jest.fn(() =>
      Promise.resolve({ entries: mockWorkspaceIndex.entries, authority: 'ok' }),
    ),
    update: jest.fn(
      async (
        change: (current: {
          entries: WorkspaceIndexEntry[];
          authority: 'ok';
        }) =>
          | { result: unknown; entries?: WorkspaceIndexEntry[] }
          | Promise<{ result: unknown; entries?: WorkspaceIndexEntry[] }>,
      ): Promise<unknown> => {
        const decided = await change({
          entries: mockWorkspaceIndex.entries,
          authority: 'ok',
        });
        if (decided.entries) mockWorkspaceIndex.entries = decided.entries;
        return decided.result;
      },
    ),
  })),
}));
jest.mock('../lib/workspace-source-control', () => ({
  initializeWorkspaceSourceRepo: jest.fn(),
  prepareNewWorkspaceSourceRepo: jest.fn(),
  repairExistingWorkspaceRootWorktrees: jest.fn(),
  repairWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
  validateWorkspaceRootWorktree: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/script-runner', () => ({
  drainWorktreeShellScripts: jest.fn(() => Promise.resolve()),
  runShellScript: jest.fn(),
}));
jest.mock('../lib/script-log-store', () => ({
  startScriptRunLog: jest.fn(
    ({
      projectId,
      worktreeId,
      script,
    }: {
      projectId: string;
      worktreeId: string;
      script: { scriptKey: string };
    }) =>
      Promise.resolve({
        projectId,
        worktreeId,
        script,
        runId: 'run-1',
      }),
  ),
  appendScriptRunLogLines: jest.fn(() => Promise.resolve()),
  completeScriptRunLog: jest.fn(() => Promise.resolve()),
  deleteScriptRunLogsForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/cowork-work-entries', () => ({
  clearWorkEntrySummariesForWorkspace: jest.fn(() => Promise.resolve()),
  listWorkEntryIds: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/script-events', () => ({
  createWorkspaceRootScriptDescriptor: jest.fn(
    (scriptName: string, command: string) => ({
      scriptKey: `workspace-root:${scriptName}`,
      scriptName,
      label: scriptName,
      command,
      lifecycle: 'custom',
      target: 'workspace-root',
    }),
  ),
  createWorkspaceRepoScriptDescriptor: jest.fn(
    (
      repoId: string,
      repoName: string,
      scriptName: string,
      command: string,
    ) => ({
      scriptKey: `workspace-repo:${repoId}:${scriptName}`,
      scriptName,
      label: `${repoName}:${scriptName}`,
      command,
      lifecycle: 'custom',
      target: 'workspace-repo',
      repoId,
      repoName,
    }),
  ),
  createScriptStartedEvent: jest.fn(() => ({ type: 'started' })),
  createScriptOutputEvent: jest.fn(() => ({ type: 'output' })),
  createScriptCompleteEvent: jest.fn(() => ({ type: 'complete' })),
}));
jest.mock('../ipc/register', () => ({
  registerIpcHandler: jest.fn(),
}));
jest.mock('../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  resolveWorkspaceWorktreeBranchName: jest.fn(() =>
    Promise.resolve('config-branch'),
  ),
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
  startWorkspaceRepoSetupAndDiscovery: jest.fn(),
}));
jest.mock('../lib/adhoc-multi-repo-workspaces', () => ({
  combineWorktreeWithWorkspace: jest.fn(),
  createOrReuseTemporaryWorkspaceFromRepos: jest.fn(),
  createOrReuseTemporaryWorkspaceFromWorkspaces: jest.fn(),
  listCompatibilitySymlinkReservedWorktreeIds: jest.fn(() =>
    Promise.resolve(new Set()),
  ),
  promoteTemporaryWorkspace: jest.fn(),
}));
jest.mock('../lib/adhoc-existing-worktree-join', () => ({
  combineWorktreeWithExistingWorktree: jest.fn(),
  listExistingWorktreeJoinOptions: jest.fn(),
}));
jest.mock('../lib/desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
jest.mock('../agents/session-manager', () => ({
  getLiveBackgroundTasksForChat: jest.fn(),
  listLiveBackgroundTaskOwners: jest.fn(),
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
  destroyWorktreeSessions: jest.fn(),
}));
jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../ipc/preferences', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      scriptTimeoutMinutes: 5,
    }),
  ),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(() =>
    Promise.resolve({
      scriptTimeoutMinutes: 5,
    }),
  ),
}));
jest.mock('../lib/github-poller', () => ({
  stopTracking: jest.fn(),
  setForegroundWorktree: jest.fn(),
  syncTrackedWorktrees: jest.fn(() => Promise.resolve()),
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
jest.mock('../lib/path-safety', () => ({
  isPathInside: jest.fn(
    (parentDir: string, childPath: string) =>
      childPath.startsWith(parentDir + '/') || childPath === parentDir,
  ),
}));
jest.mock('../lib/script-resolver', () => ({
  resolveWorkspaceRootScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoScripts: jest.fn(() => Promise.resolve({})),
  getResolvedScriptCommand: jest.fn(),
  toScriptOverrides: jest.fn((scripts: Record<string, unknown>) => scripts),
}));
jest.mock('../lib/hook-resolver', () => ({
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn((hooks: Record<string, unknown>) => hooks),
}));
jest.mock('../lib/instruction-files', () => ({
  ...jest.requireActual<typeof InstructionFiles>('../lib/instruction-files'),
  ensureAgentsMdSymlink: jest.fn(),
}));
jest.mock('../lib/plan-persistence', () => ({
  deleteTrackedPlansForWorktree: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/window-send', () => ({
  sendToWindow: jest.fn(),
  sendToAllWindows: jest.fn(),
}));
jest.mock('../lib/workspace-source', () => ({
  readWorkspaceSettingsData: jest.fn(),
  readEffectiveWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/repo-shadow', () => ({
  cleanupUnreferencedRepoShadows: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/split-temporary-workspace', () => ({
  previewSplitTemporaryWorkspaceWorktree: jest.fn(),
  splitTemporaryWorkspaceWorktree: jest.fn(),
}));

import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import {
  cloneRepo,
  createWorktree,
  createWorktreeAvoidingCheckedOutBranch,
  createWorktreeForExistingBranch,
  createWorktreeFromStartPoint,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  getCurrentBranch,
  getRemoteUrl,
  getRepoRootFromWorktree,
  isBranchNameAvailable,
  isGitRepo,
  isRegisteredWorktreePath,
  pruneWorktrees,
  removeWorktree,
  resolveSharedAvailableBranchName,
} from '../lib/git';
import {
  hasManifestRepos,
  readCanopyJson,
  writeCanopyJson,
} from '../lib/canopy-json';
import { ensureAgentsMdSymlink } from '../lib/instruction-files';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  writeAllSidebarItems,
  removeWorkspaceIndexEntry,
} from '../lib/sidebar-items';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { runShellScript } from '../lib/script-runner';
import { getResolvedScriptCommand } from '../lib/script-resolver';
import {
  prepareNewWorkspaceSourceRepo,
  validateWorkspaceRootWorktree,
} from '../lib/workspace-source-control';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { triggerDiscovery } from '../ipc/worktree-discovery';
import {
  combineWorktreeWithWorkspace,
  createOrReuseTemporaryWorkspaceFromRepos,
  createOrReuseTemporaryWorkspaceFromWorkspaces,
  promoteTemporaryWorkspace,
} from '../lib/adhoc-multi-repo-workspaces';
import { combineWorktreeWithExistingWorktree } from '../lib/adhoc-existing-worktree-join';
import {
  recordWorkspaceCrudTelemetry,
  recordWorktreeCrudTelemetry,
} from '../lib/desktop-telemetry';
import { createTemporaryMultiRepoWorkspace } from '../lib/workspace-service';
import { serializeChatProjectOperation } from '../lib/chat-project-operation-queue';
import {
  removeWorkspaceWorktrees,
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktrees,
  writeWorkspaceConfig,
} from '../lib/workspace-persistence';
import { listArchivedContainerManifestsStrict } from '../lib/archived-containers';
import {
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
} from '../lib/archived-container-git';
import { updateWorkspaceRetention } from '../lib/workspace-retention';
import { updateWorkspacePrivateMemory } from '../lib/workspace-private-memory';
import { saveDefaultPluginsAndVisibility } from '../lib/workspace-default-plugins-save';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import { sendToAllWindows, sendToWindow } from '../lib/window-send';
import { validateId } from '../lib/validation';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { clearWorkEntrySummariesForWorkspace } from '../lib/cowork-work-entries';
import { cleanupUnreferencedRepoShadows } from '../lib/repo-shadow';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  previewSplitTemporaryWorkspaceWorktree,
  splitTemporaryWorkspaceWorktree,
} from '../lib/split-temporary-workspace';
import { destroyWorktreeSessions } from '../agents/session-manager';
import { setDelegationActivity } from '../agents/delegation/activity';
import {
  getLiveBackgroundTasksForChat,
  listLiveBackgroundTaskOwners,
  type LiveBackgroundTaskOwner,
} from '../agents/session-manager';
import { createLiveBackgroundTaskOwner } from '../ipc/__tests__/background-work-removal-test-helpers';
import { registerIpcHandler } from '../ipc/register';
import type { DesktopCanopyDispatcher } from '../canopy-runtime/desktop-runtime';
import {
  collectReferencedRepoPaths,
  registerWorkspaceHandlers,
} from '../ipc/workspaces';
import { createWorkspaceLifecycleTestDispatcher } from './fixtures/workspace-lifecycle-dispatcher';
import {
  acquireSplitLock,
  releaseSplitLock,
  SplitLockError,
} from '../services/split-lock-service';

const mockedCloneRepo = jest.mocked(cloneRepo);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedCreateWorktreeAvoidingCheckedOutBranch = jest.mocked(
  createWorktreeAvoidingCheckedOutBranch,
);
const mockedCreateWorktreeForExistingBranch = jest.mocked(
  createWorktreeForExistingBranch,
);
const mockedCreateWorktreeFromStartPoint = jest.mocked(
  createWorktreeFromStartPoint,
);
const mockedDoesLocalBranchExist = jest.mocked(doesLocalBranchExist);
const mockedDoesRemoteBranchExist = jest.mocked(doesRemoteBranchExist);
const mockedFetchOrigin = jest.mocked(fetchOrigin);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedGetRepoRootFromWorktree = jest.mocked(getRepoRootFromWorktree);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedIsGitRepo = jest.mocked(isGitRepo);
const mockedIsRegisteredWorktreePath = jest.mocked(isRegisteredWorktreePath);
const mockedPruneWorktrees = jest.mocked(pruneWorktrees);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);
const mockedClearWorkEntrySummariesForWorkspace = jest.mocked(
  clearWorkEntrySummariesForWorkspace,
);
const mockedDestroyWorktreeSessions = jest.mocked(destroyWorktreeSessions);
const mockedResolveSharedAvailableBranchName = jest.mocked(
  resolveSharedAvailableBranchName,
);
const mockedHasManifestRepos = jest.mocked(hasManifestRepos);
const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedWriteCanopyJson = jest.mocked(writeCanopyJson);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedWriteWorkspaceConfig = jest.mocked(writeWorkspaceConfig);
const mockedListArchivedContainerManifestsStrict = jest.mocked(
  listArchivedContainerManifestsStrict,
);
const mockedReadArchivedGitStagedDescriptor = jest.mocked(
  readArchivedGitStagedDescriptor,
);
const mockedReleaseArchivedGitState = jest.mocked(releaseArchivedGitState);
const mockedUpdateWorkspaceRetention = jest.mocked(updateWorkspaceRetention);
const mockedUpdateWorkspacePrivateMemory = jest.mocked(
  updateWorkspacePrivateMemory,
);
const mockedReadEffectiveWorkspaceConfig = jest.mocked(
  readEffectiveWorkspaceConfig,
);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedRunShellScript = jest.mocked(runShellScript);
const mockedGetResolvedScriptCommand = jest.mocked(getResolvedScriptCommand);
const mockedStartWorkspaceWorktreePostCreateSetup = jest.mocked(
  startWorkspaceWorktreePostCreateSetup,
);
const mockedRegisterIpcHandler = jest.mocked(registerIpcHandler);
const mockedGetLiveBackgroundTasksForChat = jest.mocked(
  getLiveBackgroundTasksForChat,
);
const mockedListLiveBackgroundTaskOwners = jest.mocked(
  listLiveBackgroundTaskOwners,
);
const mockedReadFile = jest.mocked(readFile);
const mockedReaddir = jest.mocked(readdir);
const mockedRm = jest.mocked(rm);
const mockedMkdir = jest.mocked(mkdir);
const mockedWriteFile = jest.mocked(writeFile);
const mockedEnsureAgentsMdSymlink = jest.mocked(ensureAgentsMdSymlink);
const mockedSendToWindow = jest.mocked(sendToWindow);
const mockedValidateWorkspaceRootWorktree = jest.mocked(
  validateWorkspaceRootWorktree,
);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedTriggerDiscovery = jest.mocked(triggerDiscovery);
const mockedCombineWorktreeWithWorkspace = jest.mocked(
  combineWorktreeWithWorkspace,
);
const mockedCombineWorktreeWithExistingWorktree = jest.mocked(
  combineWorktreeWithExistingWorktree,
);
const mockedCreateOrReuseTemporaryWorkspaceFromWorkspaces = jest.mocked(
  createOrReuseTemporaryWorkspaceFromWorkspaces,
);
const mockedCreateOrReuseTemporaryWorkspaceFromRepos = jest.mocked(
  createOrReuseTemporaryWorkspaceFromRepos,
);
const mockedPromoteTemporaryWorkspace = jest.mocked(promoteTemporaryWorkspace);
const mockedRecordWorktreeCrudTelemetry = jest.mocked(
  recordWorktreeCrudTelemetry,
);
const mockedCleanupUnreferencedRepoShadows = jest.mocked(
  cleanupUnreferencedRepoShadows,
);
const mockedPreviewSplitTemporaryWorkspaceWorktree = jest.mocked(
  previewSplitTemporaryWorkspaceWorktree,
);
const mockedSplitTemporaryWorkspaceWorktree = jest.mocked(
  splitTemporaryWorkspaceWorktree,
);

type HandlerFn = (...args: unknown[]) => Promise<unknown>;
function requireRegisteredHandler(channel: string): HandlerFn {
  const call = mockedRegisterIpcHandler.mock.calls.find(
    ([registeredChannel]) => registeredChannel === channel,
  );
  if (!call) {
    throw new Error(`Expected IPC handler for ${channel}`);
  }
  const handler = call[1];
  if (typeof handler !== 'function') {
    throw new Error(`Expected IPC handler for ${channel} to be a function`);
  }
  // Test calls intentionally pass minimal fake Electron events; registration
  // keeps the real event type, so adapt it at this one test-harness boundary.
  return handler as unknown as HandlerFn;
}

let createWorktreeHandler: HandlerFn;
let repairWorktreeHandler: HandlerFn;
let addRepoHandler: HandlerFn;
let addRepoToWorktreeHandler: HandlerFn;
let addFromRemoteHandler: HandlerFn;
let importFromRepoHandler: HandlerFn;
let archiveWorktreeHandler: HandlerFn;
let combineWorktreeHandler: HandlerFn;
let combineExistingWorktreeHandler: HandlerFn;
let createTemporaryFromReposHandler: HandlerFn;
let createTemporaryWorktreeFromReposHandler: HandlerFn;
let approveSplitTemporaryWorkspaceDestructiveHandler: HandlerFn;
let splitTemporaryWorkspaceHandler: HandlerFn;
let setArchiveRetentionHandler: HandlerFn;
let setPrivateMemoryHandler: HandlerFn;
let saveDefaultPluginsHandler: HandlerFn;
let persistedWorktrees: WorktreeData[] = [];

const twoRepoConfig: WorkspaceConfigFile = {
  version: 1,
  type: 'multi-repo',
  sourceRepoPath: '/repos/workspace-source',
  repos: [
    { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
    { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
  ],
};

const request = {
  workspaceId: 'test-workspace',
  existingWorktreeIds: [],
};

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Task I1: the deferred create response carries the RESERVED worktree branch
// name (`<id>-<timestamp>`), not the reconciled post-`git worktree add` name —
// that now lands in Phase B and arrives via the git-ready event. Passing the
// matcher through `toHaveProperty` (a function argument, not an object-literal
// assignment) keeps this lint-clean under `no-unsafe-assignment`.
function expectReservedBranchName(value: unknown): void {
  expect(value).toHaveProperty(
    'branchName',
    expect.stringMatching(/^test-animal-\d+$/),
  );
}

function expectStringCreatedAt(value: unknown): void {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('createdAt' in value) ||
    typeof value.createdAt !== 'string'
  ) {
    throw new Error('Expected response with string createdAt');
  }
}

function expectDeferredSetupFailure(expectedGitError: string | RegExp): void {
  expect(persistedWorktrees).toHaveLength(1);
  expect(persistedWorktrees[0]).toMatchObject({
    id: 'test-animal',
    setupPhase: 'git-pending',
    healthIssue: {
      status: 'broken',
      code: 'git-error',
      message: 'Worktree setup failed.',
      worktreePath: '/mock/workspaces/test-workspace/worktrees/test-animal',
    },
  });
  const gitError = persistedWorktrees[0]?.healthIssue?.gitError;
  expect(gitError).toEqual(expect.stringMatching(expectedGitError));
}

function setProviderTask(owner: LiveBackgroundTaskOwner): void {
  mockedGetLiveBackgroundTasksForChat.mockImplementation(
    (projectId, worktreeId, chatId) =>
      owner.projectId === projectId &&
      owner.worktreeId === worktreeId &&
      owner.chatId === chatId
        ? owner.liveTasks
        : undefined,
  );
  mockedListLiveBackgroundTaskOwners.mockReturnValue([owner]);
}

// CAN-3817: retention and private memory changes go through their typed W5
// commands, whose behavior is covered in lib/__tests__/workspace-retention
// and workspace-private-memory; these pin the IPC routing.
describe('workspace Auto Delete settings', () => {
  it('routes the setting through the typed retention command', async () => {
    await setArchiveRetentionHandler(
      {},
      {
        workspaceId: 'test-workspace',
        archiveRetentionDays: 30,
        autoArchiveDays: 7,
      },
    );

    expect(mockedUpdateWorkspaceRetention).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      patch: { archiveRetentionDays: 30, autoArchiveDays: 7 },
      source: 'workspace_settings',
    });
  });

  it('passes the branch choice and a refusal through unchanged', async () => {
    mockedUpdateWorkspaceRetention.mockRejectedValueOnce(
      new Error('baseline failed'),
    );

    await expect(
      setArchiveRetentionHandler(
        {},
        {
          workspaceId: 'test-workspace',
          archiveRetentionDays: null,
          autoArchiveDeleteBranch: true,
        },
      ),
    ).rejects.toThrow('baseline failed');

    expect(mockedUpdateWorkspaceRetention).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      patch: { archiveRetentionDays: null, autoArchiveDeleteBranch: true },
      source: 'workspace_settings',
    });
  });
});

describe('workspace default plugins', () => {
  it('routes the save through the typed plugins and metadata commands', async () => {
    const request = {
      projectId: 'test-workspace',
      defaultPluginSelections: {
        collectionIds: [],
        skillRefs: [],
        pluginRefs: [],
      },
      alwaysShow: false,
    };

    await saveDefaultPluginsHandler({}, request);

    // With the projection of the registered core.workspace.plugins.update.
    expect(saveDefaultPluginsAndVisibility).toHaveBeenCalledWith(
      request,
      'workspace_settings',
      expect.any(Function),
    );
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
  });
});

describe('workspace private memory setting', () => {
  it('validates the resolved legacy Cowork workspace ID', async () => {
    await setPrivateMemoryHandler(
      {},
      {
        workspaceId: STANDALONE_CHAT_PROJECT_ID,
        worktreeId: 'test-workspace',
        privateMemory: true,
      },
    );
    expect(validateId).toHaveBeenCalledWith('test-workspace', 'workspaceId');
    expect(mockedUpdateWorkspacePrivateMemory).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      privateMemory: true,
      source: 'workspace_settings',
    });
  });

  it('persists an explicit false value and announces the change', async () => {
    const result = await setPrivateMemoryHandler(
      {},
      {
        workspaceId: 'test-workspace',
        privateMemory: false,
      },
    );
    expect(mockedUpdateWorkspacePrivateMemory).toHaveBeenCalledWith({
      workspaceId: 'test-workspace',
      privateMemory: false,
      source: 'workspace_settings',
    });
    expect(result).toHaveProperty('id', 'test-workspace');
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.workspacePrivateMemoryChanged,
      'test-workspace',
    );
  });

  it('rejects malformed input and a refused change without announcing it', async () => {
    await expect(
      setPrivateMemoryHandler(
        {},
        {
          workspaceId: 'test-workspace',
          privateMemory: 'true',
        },
      ),
    ).rejects.toThrow('boolean');
    expect(mockedUpdateWorkspacePrivateMemory).not.toHaveBeenCalled();
    mockedUpdateWorkspacePrivateMemory.mockRejectedValueOnce(
      new Error('Private memory is managed by your organization'),
    );
    await expect(
      setPrivateMemoryHandler(
        {},
        {
          workspaceId: 'test-workspace',
          privateMemory: true,
        },
      ),
    ).rejects.toThrow('managed by your organization');
    expect(sendToAllWindows).not.toHaveBeenCalledWith(
      IPC_CHANNELS.workspacePrivateMemoryChanged,
      expect.anything(),
    );
  });
});

describe('workspace:check-add-from-folder', () => {
  it('returns the local conflict without emitting creation telemetry or writing', async () => {
    const workspace: SidebarItem = {
      type: 'single-repo',
      id: 'bound-workspace',
      name: 'Private local name',
      repoPath: '/repos/bound',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
      owner: {
        type: 'organization',
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        bindingGeneration: 3,
      },
    };
    jest.mocked(isGitRepo).mockResolvedValue(true);
    jest
      .mocked(readAllSidebarItems)
      .mockResolvedValue({ version: 1, items: [workspace] });
    const handler = requireRegisteredHandler('workspace:check-add-from-folder');
    await expect(handler({}, { repoPath: '/repos/bound' })).resolves.toEqual({
      status: 'already-tracked',
      workspaceId: workspace.id,
      owner: workspace.owner,
    });
    expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    expect(writeAllSidebarItems).not.toHaveBeenCalled();
    expect(writeCanopyJson).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    null,
    {},
    { repoPath: null },
    { repoPath: 7 },
    { repoPath: '' },
    { repoPath: 'relative/repo' },
  ])(
    'rejects malformed or relative requests before accessing git or persistence: %p',
    async (request) => {
      const handler = requireRegisteredHandler(
        'workspace:check-add-from-folder',
      );
      await expect(handler({}, request)).rejects.toThrow(
        'repoPath must be an absolute path',
      );
      expect(isGitRepo).not.toHaveBeenCalled();
      expect(readAllSidebarItems).not.toHaveBeenCalled();
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
    },
  );

  it('returns not-tracked for a non-git folder without importing it', async () => {
    jest.mocked(isGitRepo).mockResolvedValue(false);
    const handler = requireRegisteredHandler('workspace:check-add-from-folder');
    await expect(handler({}, { repoPath: '/plain/folder' })).resolves.toEqual({
      status: 'not-tracked',
    });
    expect(writeAllSidebarItems).not.toHaveBeenCalled();
    expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
  });
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetLiveBackgroundTasksForChat.mockReset().mockReturnValue(undefined);
  mockedListLiveBackgroundTaskOwners.mockReset().mockReturnValue([]);
  persistedWorktrees = [];

  registerWorkspaceHandlers(() => null, {
    dispatcher: {
      query: (
        ...args: Parameters<DesktopCanopyDispatcher['query']>
      ): Promise<never> => {
        void args;
        return Promise.reject(new Error('Unexpected dispatcher query'));
      },
      // The metadata channels (W7a), lifecycle commands (W7b-3/2a) and source
      // and composition channels (W7b-4) project their registered operations.
      ...createWorkspaceLifecycleTestDispatcher(),
      queryWorktreeListForLegacyIpc: async ({
        scope,
      }: {
        scope?: { workspaceId?: string };
      }) => ({
        canonicalResult: null,
        legacyResult: await mockedReadWorkspaceWorktrees(
          scope?.workspaceId ?? '',
        ),
      }),
    },
    // An IPC caller, as the lifecycle projections admit it (W7b-3, W7b-2a, Q8).
    resolveCaller: () => ({
      principalId: 'local-desktop-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'desktop',
      grants: ['core.worktree.read'],
    }),
  });

  createWorktreeHandler = requireRegisteredHandler('workspace:create-worktree');
  repairWorktreeHandler = requireRegisteredHandler('workspace:repair-worktree');
  addRepoHandler = requireRegisteredHandler('workspace:add-repo');
  addRepoToWorktreeHandler = requireRegisteredHandler(
    'workspace:add-repo-to-worktree',
  );
  addFromRemoteHandler = requireRegisteredHandler('workspace:add-from-remote');
  importFromRepoHandler = requireRegisteredHandler(
    'workspace:import-from-repo',
  );
  archiveWorktreeHandler = requireRegisteredHandler(
    'workspace:archive-worktree',
  );
  combineWorktreeHandler = requireRegisteredHandler(
    'workspace:combine-worktree-with-workspace',
  );
  combineExistingWorktreeHandler = requireRegisteredHandler(
    'workspace:combine-worktree-with-existing-worktree',
  );
  createTemporaryFromReposHandler = requireRegisteredHandler(
    'workspace:create-temporary-from-repos',
  );
  createTemporaryWorktreeFromReposHandler = requireRegisteredHandler(
    'workspace:create-temporary-worktree-from-repos',
  );
  approveSplitTemporaryWorkspaceDestructiveHandler = requireRegisteredHandler(
    IPC_CHANNELS.workspaceSplitTemporaryApproveDestructive,
  );
  splitTemporaryWorkspaceHandler = requireRegisteredHandler(
    IPC_CHANNELS.workspaceSplitTemporary,
  );
  setArchiveRetentionHandler = requireRegisteredHandler(
    IPC_CHANNELS.workspaceSetArchiveRetention,
  );
  setPrivateMemoryHandler = requireRegisteredHandler(
    IPC_CHANNELS.workspaceSetPrivateMemory,
  );
  saveDefaultPluginsHandler = requireRegisteredHandler(
    IPC_CHANNELS.workspaceSaveDefaultPlugins,
  );

  mockedReadWorkspaceConfig.mockResolvedValue(twoRepoConfig);
  mockedReadAllSidebarItems.mockResolvedValue({
    version: 1,
    items: [
      {
        type: 'multi-repo',
        id: 'test-workspace',
        name: 'Test Workspace',
        color: '#000000',
        repos: twoRepoConfig.repos,
        worktrees: [],
        collapsed: false,
        order: 0,
        sourceRepoPath: '/repos/workspace-source',
      },
    ],
  });
  mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
  mockedPreviewSplitTemporaryWorkspaceWorktree.mockResolvedValue({
    previewRevision: 'default-preview-revision',
    repos: [],
    root: {
      present: false,
      canArchive: true,
      chats: { count: 0, entries: [] },
      pipelines: { count: 0, entries: [] },
      plans: { count: 0, entries: [] },
      attachments: { count: 0, entries: [] },
    },
  });
  mockedSplitTemporaryWorkspaceWorktree.mockResolvedValue({
    success: true,
    results: [],
    warnings: [],
    navigationTarget: { kind: 'home' },
  });
  // `getWorkspaceById` reads the index entry directly (shadow-free); derive
  // it from the same sidebar fixture so per-test `readAllSidebarItems`
  // overrides keep feeding every entry point.
  mockedReadWorkspaceIndexEntry.mockImplementation(async (workspaceId) => {
    const file = await mockedReadAllSidebarItems();
    const item = (file?.items ?? []).find(
      (candidate) => candidate.id === workspaceId,
    );
    if (!item) {
      return null;
    }
    return {
      id: item.id,
      name: item.name,
      type: item.type,
      color: item.color,
      collapsed: item.collapsed ?? false,
      order: item.order ?? 0,
    };
  });
  mockedReadWorkspaceWorktrees.mockImplementation(() =>
    Promise.resolve(persistedWorktrees),
  );
  mockedUpdateWorkspaceWorktrees.mockImplementation(
    async (
      _workspaceId,
      updater: (
        worktrees: WorktreeData[],
      ) => WorktreeData[] | Promise<WorktreeData[]>,
    ) => {
      persistedWorktrees = await Promise.resolve(updater(persistedWorktrees));
      return persistedWorktrees;
    },
  );
  mockedMkdir.mockResolvedValue(undefined);
  mockedWriteFile.mockResolvedValue(undefined);
  mockedRm.mockResolvedValue(undefined);
  mockedReadFile.mockRejectedValue(new Error('ENOENT'));
  mockedReaddir.mockRejectedValue(new Error('ENOENT'));
  // Creation admission lstat-checks candidate paths; none exist by default.
  jest
    .mocked(lstat)
    .mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  mockedHasManifestRepos.mockImplementation(
    (manifest) => Array.isArray(manifest?.repos) && manifest.repos.length > 0,
  );
  mockedReadCanopyJson.mockResolvedValue(null);
  mockedWriteCanopyJson.mockImplementation((_repoPath, manifest) =>
    Promise.resolve(manifest),
  );
  mockedGetRemoteUrl.mockResolvedValue(null);
  mockedIsBranchNameAvailable.mockResolvedValue(true);
  mockedIsGitRepo.mockResolvedValue(true);
  mockedCloneRepo.mockResolvedValue(undefined);
  mockedCreateWorktree.mockResolvedValue('config-branch');
  mockedCreateWorktreeForExistingBranch.mockResolvedValue('config-branch');
  mockedCreateWorktreeFromStartPoint.mockResolvedValue('config-branch');
  mockedDoesLocalBranchExist.mockResolvedValue(true);
  mockedDoesRemoteBranchExist.mockResolvedValue(false);
  mockedFetchOrigin.mockResolvedValue(undefined);
  mockedPruneWorktrees.mockResolvedValue(undefined);
  mockedResolveSharedAvailableBranchName.mockResolvedValue('config-branch');
  mockedCombineWorktreeWithExistingWorktree.mockResolvedValue({
    sourceWorkspaceId: 'source',
    sourceWorktreeId: 'worktree',
    destinationWorkspaceId: 'source',
    destinationWorktreeId: 'worktree',
    destinationWorkspace: {
      type: 'multi-repo',
      id: 'source',
      name: 'Source Workspace',
      color: '#000000',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
    },
    destinationWorktree: {
      id: 'worktree',
      branchName: 'worktree',
      createdAt: '2026-01-01T00:00:00.000Z',
      setupPhase: 'git-ready',
    },
    repoMappings: [],
    selectedRepoIdRewrites: {},
    filePathRewrites: [],
    compatibilitySymlinks: [],
    createdTemporaryWorkspace: false,
    reusedWorkspace: true,
    removedSourceWorktree: false,
    joinedWorktree: {
      workspaceId: 'joined',
      worktreeId: 'worktree',
      repoMappings: [],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
    },
  });
  mockedGetCurrentBranch.mockResolvedValue('main');
  mockedGetRepoRootFromWorktree.mockImplementation((worktreePath: string) =>
    Promise.resolve(worktreePath),
  );
  mockedEnsureAgentsMdSymlink.mockResolvedValue(undefined);
  mockedRunShellScript.mockResolvedValue({
    success: true,
    exitCode: 0,
    output: '',
    timedOut: false,
    durationMs: 10,
  });
  mockedGetResolvedScriptCommand.mockReturnValue(undefined);
  mockedSendToWindow.mockReturnValue(true);
  mockedReadEffectiveWorkspaceConfig.mockResolvedValue({
    sourceRepoPath: twoRepoConfig.sourceRepoPath,
    manifest: null,
    repos: twoRepoConfig.repos,
    scripts: twoRepoConfig.scripts,
    defaultPluginSelections: twoRepoConfig.defaultPluginSelections,
    suppressedRepoIds: twoRepoConfig.suppressedRepoIds,
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
    localConfig: twoRepoConfig,
    alwaysShow: twoRepoConfig.alwaysShow,
  });
  mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
  mockedCombineWorktreeWithWorkspace.mockResolvedValue({
    sourceWorkspaceId: 'source',
    sourceWorktreeId: 'worktree',
    destinationWorkspaceId: 'source',
    destinationWorktreeId: 'worktree',
    destinationWorkspace: {
      type: 'multi-repo',
      id: 'source',
      name: 'Source',
      color: '#000000',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
    },
    destinationWorktree: {
      id: 'worktree',
      branchName: 'main',
      createdAt: '2026-05-19T00:00:00.000Z',
    },
    repoMappings: [],
    selectedRepoIdRewrites: {},
    filePathRewrites: [],
    compatibilitySymlinks: [],
    createdTemporaryWorkspace: false,
    reusedWorkspace: true,
    removedSourceWorktree: false,
  });
  mockedCreateOrReuseTemporaryWorkspaceFromRepos.mockResolvedValue({
    workspace: {
      type: 'multi-repo',
      id: 'temp',
      name: 'Temp',
      color: '#000000',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      temporary: true,
    },
    createdTemporaryWorkspace: true,
    reusedWorkspace: false,
  });
  mockedPromoteTemporaryWorkspace.mockResolvedValue({
    type: 'multi-repo',
    id: 'temp',
    name: 'Temp',
    color: '#000000',
    repos: [],
    worktrees: [],
    collapsed: false,
    order: 0,
  });
});

describe('project split destructive approval', () => {
  const destructiveRequest = {
    workspaceId: 'test-workspace',
    worktreeId: 'test-worktree',
    selections: { 'repo-a': 'remove' as const },
    rootAction: 'archive' as const,
    previewRevision: 'destructive-preview-revision',
  };

  beforeEach(() => {
    mockedPreviewSplitTemporaryWorkspaceWorktree.mockResolvedValue({
      previewRevision: 'destructive-preview-revision',
      repos: [
        {
          repoId: 'repo-a',
          repoName: 'Repo A',
          repoPath: '/repos/repo-a',
          destinationWorkspaceName: 'Destination workspace',
          removalMode: 'delete',
          chats: { count: 0, entries: [] },
          pipelines: { count: 0, entries: [] },
          plans: { count: 0, entries: [] },
        },
      ],
      root: {
        present: false,
        canArchive: true,
        chats: { count: 0, entries: [] },
        pipelines: { count: 0, entries: [] },
        plans: { count: 0, entries: [] },
        attachments: { count: 0, entries: [] },
      },
    });
    mockedSplitTemporaryWorkspaceWorktree.mockImplementation(
      async (_request, hooks) => {
        const preview =
          await mockedPreviewSplitTemporaryWorkspaceWorktree(
            destructiveRequest,
          );
        hooks?.consumeDestructiveApproval?.(preview);
        return {
          success: true,
          results: [],
          warnings: [],
          navigationTarget: { kind: 'home' },
        };
      },
    );
  });

  it('requires and consumes a main-process-issued approval token', async () => {
    await expect(
      splitTemporaryWorkspaceHandler({}, destructiveRequest),
    ).rejects.toThrow('Split project dialog');
    expect(mockedSplitTemporaryWorkspaceWorktree).toHaveBeenCalledTimes(1);

    const approvalResponse =
      await approveSplitTemporaryWorkspaceDestructiveHandler(
        {},
        destructiveRequest,
      );
    if (
      typeof approvalResponse !== 'object' ||
      approvalResponse === null ||
      !('approvalToken' in approvalResponse) ||
      (typeof approvalResponse.approvalToken !== 'string' &&
        approvalResponse.approvalToken !== null)
    ) {
      throw new Error('Expected split approval response');
    }
    const approval: SplitTemporaryWorkspaceDestructiveApprovalResponse = {
      approvalToken: approvalResponse.approvalToken,
    };
    expect(approval.approvalToken).toEqual(expect.any(String));

    await expect(
      splitTemporaryWorkspaceHandler(
        {},
        {
          ...destructiveRequest,
          destructiveApprovalToken: approval.approvalToken,
        },
      ),
    ).resolves.toMatchObject({ success: true });
    expect(mockedSplitTemporaryWorkspaceWorktree).toHaveBeenCalledTimes(2);

    await expect(
      splitTemporaryWorkspaceHandler(
        {},
        {
          ...destructiveRequest,
          destructiveApprovalToken: approval.approvalToken,
        },
      ),
    ).rejects.toThrow('Split project dialog');
    expect(mockedSplitTemporaryWorkspaceWorktree).toHaveBeenCalledTimes(3);
  });
});

describe('workspace:create-worktree parallel rollback', () => {
  beforeEach(() => {
    jest
      .mocked(lstat)
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);
  });
  it('rejects malformed temporary repo paths before creating a project', async () => {
    await expect(
      createTemporaryFromReposHandler(
        {},
        {
          repos: [{ name: 'Repo A', path: null }],
        },
      ),
    ).rejects.toThrow('Repository paths must be absolute');
    await expect(
      createTemporaryWorktreeFromReposHandler(
        {},
        {
          repos: [{ name: 'Repo A', path: 42 }],
        },
      ),
    ).rejects.toThrow('Repository paths must be absolute');

    expect(
      mockedCreateOrReuseTemporaryWorkspaceFromRepos,
    ).not.toHaveBeenCalled();
  });

  it('rejects malformed combine join project ids before delegating', async () => {
    await expect(
      combineWorktreeHandler(
        {},
        {
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceIds: 'join',
          mode: 'temporary',
        },
      ),
    ).rejects.toThrow('joinWorkspaceIds must be an array of strings');
    await expect(
      combineWorktreeHandler(
        {},
        {
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 42,
          joinWorkspaceIds: ['join'],
          mode: 'temporary',
        },
      ),
    ).rejects.toThrow('joinWorkspaceId must be a string');

    expect(mockedCombineWorktreeWithWorkspace).not.toHaveBeenCalled();
  });

  it('triggers discovery after update-source-workspace combine completes', async () => {
    const result = await combineWorktreeHandler(
      {},
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'update-source-workspace',
      },
    );

    expect(result).toMatchObject({
      destinationWorkspaceId: 'source',
      destinationWorktreeId: 'worktree',
    });
    expect(mockedCombineWorktreeWithWorkspace).toHaveBeenCalledWith({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      joinWorkspaceId: 'join',
      mode: 'update-source-workspace',
    });
    expect(mockedTriggerDiscovery).toHaveBeenCalledWith(
      'source',
      'worktree',
      expect.any(Function),
    );
    expect(mockedStartWorkspaceWorktreePostCreateSetup).not.toHaveBeenCalled();
  });

  it('records update telemetry for update-source-workspace existing-worktree joins', async () => {
    await combineExistingWorktreeHandler(
      {},
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        joinWorktreeId: 'join-worktree',
        mode: 'update-source-workspace',
      },
    );

    expect(mockedRecordWorktreeCrudTelemetry).toHaveBeenCalledWith({
      action: 'update',
      workspaceId: 'source',
      source: 'combine_existing_worktree',
    });
  });

  it('runs setup lifecycle for newly created repos in an adhoc temporary combine', async () => {
    const sourceRepo = {
      id: 'source',
      name: 'Repo A',
      repoPath: '/repos/a',
    };
    const joinedRepo = {
      id: 'join',
      name: 'Repo B',
      repoPath: '/repos/b',
    };
    mockedCombineWorktreeWithWorkspace.mockResolvedValueOnce({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      destinationWorkspaceId: 'temp',
      destinationWorktreeId: 'worktree',
      destinationWorkspace: {
        type: 'multi-repo',
        id: 'temp',
        name: 'Repo A & Repo B',
        color: '#000000',
        repos: [sourceRepo, joinedRepo],
        worktrees: [],
        collapsed: false,
        order: 0,
        temporary: true,
      },
      destinationWorktree: {
        id: 'worktree',
        branchName: 'main',
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      repoMappings: [
        {
          sourceRepoId: 'source',
          destinationRepoId: 'source',
          repoName: 'Repo A',
          repoPath: '/repos/a',
          oldWorktreePath: '/old/source',
          newWorktreePath: '/new/source',
        },
        {
          destinationRepoId: 'join',
          repoName: 'Repo B',
          repoPath: '/repos/b',
          newWorktreePath: '/new/join',
        },
      ],
      selectedRepoIdRewrites: { source: 'source' },
      filePathRewrites: [],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: true,
      reusedWorkspace: false,
      removedSourceWorktree: true,
    });

    await combineWorktreeHandler(
      {},
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      },
    );

    expect(mockedStartWorkspaceWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'temp',
        worktreeId: 'worktree',
        repos: [joinedRepo],
      }),
    );
    expect(
      typeof mockedStartWorkspaceWorktreePostCreateSetup.mock.calls[0]?.[0]
        .getWindow,
    ).toBe('function');
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
  });

  it('runs setup lifecycle for newly added repos in update-source-workspace combine', async () => {
    const joinedRepo = {
      id: 'join',
      name: 'Repo B',
      repoPath: '/repos/b',
    };
    mockedCombineWorktreeWithWorkspace.mockResolvedValueOnce({
      sourceWorkspaceId: 'source',
      sourceWorktreeId: 'worktree',
      destinationWorkspaceId: 'source',
      destinationWorktreeId: 'worktree',
      destinationWorkspace: {
        type: 'multi-repo',
        id: 'source',
        name: 'Source',
        color: '#000000',
        repos: [joinedRepo],
        worktrees: [],
        collapsed: false,
        order: 0,
      },
      destinationWorktree: {
        id: 'worktree',
        branchName: 'main',
        createdAt: '2026-05-19T00:00:00.000Z',
      },
      repoMappings: [
        {
          destinationRepoId: 'join',
          repoName: 'Repo B',
          repoPath: '/repos/b',
          newWorktreePath: '/new/join',
        },
      ],
      selectedRepoIdRewrites: {},
      filePathRewrites: [],
      compatibilitySymlinks: [],
      createdTemporaryWorkspace: false,
      reusedWorkspace: true,
      removedSourceWorktree: false,
    });

    await combineWorktreeHandler(
      {},
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'update-source-workspace',
      },
    );

    expect(mockedStartWorkspaceWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'source',
        worktreeId: 'worktree',
        repos: [joinedRepo],
      }),
    );
    expect(
      typeof mockedStartWorkspaceWorktreePostCreateSetup.mock.calls[0]?.[0]
        .getWindow,
    ).toBe('function');
    expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
  });

  it('derives temporary project names and ids and hides them when inactive by default', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedWriteAllSidebarItems.mockImplementation((items) =>
      Promise.resolve({
        version: 1,
        items,
      }),
    );

    const workspace = await createTemporaryMultiRepoWorkspace([
      { id: 'repo-a', name: 'Repo A', repoPath: '/repos/a' },
      { id: 'repo-b', name: 'Repo B', repoPath: '/repos/b' },
      { id: 'repo-c', name: 'Repo C', repoPath: '/repos/c' },
    ]);

    expect(workspace).toMatchObject({
      id: 'repo-a-repo-b-repo-c',
      name: 'Repo A, Repo B & Repo C',
      temporary: true,
      alwaysShow: false,
    });
    const creation = { source: 'temporary_workspace_create', workspace };
    expect(createTemporaryCompositionRecords).toHaveBeenCalledWith(creation);
    expect(indexTemporaryCompositionWorkspace).toHaveBeenCalledWith(creation);
    expect(mockedWriteFile).toHaveBeenCalledWith(
      '/mock/workspaces/repo-a-repo-b-repo-c/CLAUDE.md',
      expect.stringContaining('Repo A, Repo B & Repo C'),
      'utf8',
    );
  });

  it('marks the worktree broken when one deferred parallel create fails', async () => {
    mockedCreateWorktree
      .mockResolvedValueOnce('config-branch') // workspace root succeeds
      .mockResolvedValueOnce('config-branch') // repo-a succeeds
      .mockRejectedValueOnce(new Error('branch already exists')); // repo-b fails

    const result = await createWorktreeHandler({}, request);
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: undefined,
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();

    expectDeferredSetupFailure('branch already exists');
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('keeps a visible broken worktree when deferred setup cleanup would have thrown', async () => {
    mockedCreateWorktree
      .mockResolvedValueOnce('config-branch') // workspace root succeeds
      .mockResolvedValueOnce('config-branch') // repo-a succeeds
      .mockRejectedValueOnce(new Error('branch already exists')); // repo-b fails
    const result = await createWorktreeHandler({}, request);
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: undefined,
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();

    expectDeferredSetupFailure('branch already exists');
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('records all deferred setup failures when multiple repos fail', async () => {
    mockedCreateWorktree
      .mockResolvedValueOnce('config-branch')
      .mockRejectedValueOnce(new Error('error A'))
      .mockRejectedValueOnce(new Error('error B'));

    const result = await createWorktreeHandler({}, request);
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: undefined,
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();
    expectDeferredSetupFailure(/2 repos failed worktree creation/);
    expect(persistedWorktrees[0]?.healthIssue?.gitError).toContain('error A');
    expect(persistedWorktrees[0]?.healthIssue?.gitError).toContain('error B');
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('creates worktrees for all repos on success', async () => {
    mockedCreateWorktree.mockResolvedValue('config-branch');

    const result = await createWorktreeHandler({}, request);

    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: undefined,
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/workspace-source',
      '/mock/workspaces/test-workspace/worktrees/test-animal',
      expect.stringMatching(/^test-animal-\d+$/),
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktree).toHaveBeenCalledTimes(3);
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
  });

  it('creates from a selected base worktree and returns tracked repo base branches', async () => {
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace Root',
        repoPath: '/mock/workspaces/test-workspace/worktrees/base-wt',
      },
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-b',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('release/root')
      .mockResolvedValueOnce('release/a')
      .mockResolvedValueOnce('release/b');

    const result = await createWorktreeHandler(
      {},
      {
        ...request,
        baseWorktreeId: 'base-wt',
      },
    );

    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: {
        [WORKSPACE_ROOT_REPO_ID]: 'release/root',
        'repo-a': 'release/a',
        'repo-b': 'release/b',
      },
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();
    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/repos/workspace-source', '/repos/repo-a', '/repos/repo-b'],
      expect.stringMatching(/^test-animal-\d+$/),
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenNthCalledWith(
      1,
      '/repos/workspace-source',
      '/mock/workspaces/test-workspace/worktrees/test-animal',
      'config-branch',
      'release/root',
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenNthCalledWith(
      2,
      '/repos/repo-a',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      'config-branch',
      'release/a',
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenNthCalledWith(
      3,
      '/repos/repo-b',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-b',
      'config-branch',
      'release/b',
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('rejects conflicting base worktree inputs but allows an existing branch to carry an explicit tracked base', async () => {
    await expect(
      createWorktreeHandler(
        {},
        {
          ...request,
          baseWorktreeId: 'base-wt',
          baseBranch: 'develop',
        },
      ),
    ).rejects.toThrow(/mutually exclusive/i);

    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/release');
    const result = await createWorktreeHandler(
      {},
      {
        ...request,
        baseBranch: 'develop',
        existingBranch: 'feature/release',
      },
    );

    expect(result).toMatchObject({
      branchName: 'feature/release',
      trackedRepoBaseBranches: {
        [WORKSPACE_ROOT_REPO_ID]: 'develop',
        'repo-a': 'develop',
        'repo-b': 'develop',
      },
    });
    await flush();
    await flush();
    expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledTimes(3);
  });

  it.each(['--force', '-b', 'HEAD'])(
    'rejects invalid base branch %s before creating a worktree',
    async (baseBranch) => {
      await expect(
        createWorktreeHandler({}, { ...request, baseBranch }),
      ).rejects.toThrow(/valid branch name/i);
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
      expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
    },
  );

  it('fails base-worktree creation when a child repo resolves a different branch name', async () => {
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace Root',
        repoPath: '/mock/workspaces/test-workspace/worktrees/base-wt',
      },
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-b',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('release/root')
      .mockResolvedValueOnce('release/a')
      .mockResolvedValueOnce('release/b');
    mockedCreateWorktreeFromStartPoint
      .mockResolvedValueOnce('config-branch')
      .mockResolvedValueOnce('config-branch-2')
      .mockResolvedValueOnce('config-branch');

    const result = await createWorktreeHandler(
      {},
      {
        ...request,
        baseWorktreeId: 'base-wt',
      },
    );
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: {
        [WORKSPACE_ROOT_REPO_ID]: 'release/root',
        'repo-a': 'release/a',
        'repo-b': 'release/b',
      },
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();
    expectDeferredSetupFailure(
      'Repo "Repo A" created branch "config-branch-2" instead of "config-branch"',
    );
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('does not normalize AGENTS.md during worktree creation', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: twoRepoConfig.repos,
      sourceRepoPath: '/repos/workspace-source',
    });
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'multi-repo',
          id: 'test-workspace',
          name: 'Test Workspace',
          color: '#000000',
          repos: twoRepoConfig.repos,
          worktrees: [],
          collapsed: false,
          order: 0,
          sourceRepoPath: '/repos/workspace-source',
        },
      ],
    });
    mockedCreateWorktree.mockResolvedValue('config-branch');

    const result = await createWorktreeHandler({}, request);

    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: undefined,
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    await flush();
    await flush();
    expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
    expect(mockedValidateWorkspaceRootWorktree).toHaveBeenCalledWith(
      'test-workspace',
      'test-animal',
    );
  });

  it('defers repair to the needs-repair event and retains identity when project root validation reports blocking issues (Task I1)', async () => {
    mockedValidateWorkspaceRootWorktree.mockResolvedValueOnce([
      {
        code: 'missing-canopy-json',
        message: 'canopy.json is missing from the project root',
        blocking: true,
      },
    ]);

    const result = await createWorktreeHandler({}, request);

    // Task I1: the deferred desktop path no longer returns `needsRepair`
    // synchronously — it returns git-pending, and Phase B surfaces the repair
    // requirement via the `worktree:needs-repair` event (asserted at the
    // service level in worktree-service.test.ts). getWindow is null in this
    // harness, so here the observable IPC contract retains the interrupted identity.
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    expect(result).not.toHaveProperty('needsRepair', true);

    await flush();
    await flush();

    // Phase B added + validated only the ROOT (no child repos), then retained
    // the persisted reservation and root checkout for explicit recovery.
    expect(mockedCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/workspace-source',
      '/mock/workspaces/test-workspace/worktrees/test-animal',
      expect.stringMatching(/^test-animal-\d+$/),
      { backgroundPriority: true },
    );
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(persistedWorktrees).toMatchObject([
      { setupPhase: 'git-pending', creation: { state: 'recovery-required' } },
    ]);
    expect(mockedRm).not.toHaveBeenCalled();
  });

  it('keeps tracked repo base branches on the deferred response and retains identity on a repair-needed Phase B (Task I1)', async () => {
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace Root',
        repoPath: '/mock/workspaces/test-workspace/worktrees/base-wt',
      },
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath:
          '/mock/workspaces/test-workspace/worktrees/base-wt/repos/repo-b',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('release/root')
      .mockResolvedValueOnce('release/a')
      .mockResolvedValueOnce('release/b');
    mockedValidateWorkspaceRootWorktree.mockResolvedValueOnce([
      {
        code: 'missing-canopy-json',
        message: 'canopy.json is missing from the project root',
        blocking: true,
      },
    ]);

    const result = await createWorktreeHandler(
      {},
      {
        ...request,
        baseWorktreeId: 'base-wt',
      },
    );

    // Tracked base branches are resolved in Phase A, so they ride the deferred
    // git-pending response even though the repair itself is deferred to the
    // event + Phase B rollback.
    expectStringCreatedAt(result);
    expect(result).toMatchObject({
      id: 'test-animal',
      trackedRepoBaseBranches: {
        [WORKSPACE_ROOT_REPO_ID]: 'release/root',
        'repo-a': 'release/a',
        'repo-b': 'release/b',
      },
      setupPhase: 'git-pending',
    });
    expectReservedBranchName(result);
    expect(result).not.toHaveProperty('needsRepair', true);

    await flush();
    await flush();

    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('delegates post-create setup to the runtime helper even when no window is attached', async () => {
    mockedCreateWorktree.mockResolvedValue('test-animal');
    await createWorktreeHandler({}, request);
    await flush();
    await flush();

    const [params] =
      mockedStartWorkspaceWorktreePostCreateSetup.mock.calls[0] ?? [];
    expect(params).toBeDefined();
    expect(params).toEqual(
      expect.objectContaining({
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        workspaceRootPath:
          '/mock/workspaces/test-workspace/worktrees/test-animal',
        repos: twoRepoConfig.repos,
      }),
    );
    expect(typeof params?.getWindow).toBe('function');
  });

  it('does not run setup scripts inline during worktree creation', async () => {
    mockedCreateWorktree.mockResolvedValue('test-animal');
    await createWorktreeHandler({}, request);
    await flush();
    await flush();

    expect(mockedRunShellScript).not.toHaveBeenCalled();
    expect(mockedGetResolvedScriptCommand).not.toHaveBeenCalled();
    expect(mockedSendToWindow).not.toHaveBeenCalled();
  });
});

describe('workspace:repair-worktree', () => {
  it('reads repair reservations through the canonical query with the IPC caller', async () => {
    const caller = {
      principalId: 'test-user',
      clientInstanceId: 'test-client',
      authorityId: 'local-desktop',
      interfaceKind: 'test' as const,
      grants: ['core.worktree.read' as const],
    };
    const queryWorktreeListForLegacyIpc = jest.fn(() =>
      Promise.resolve({
        canonicalResult: null,
        legacyResult: [],
      }),
    );
    const resolveCaller = jest.fn(() => caller);
    mockedRegisterIpcHandler.mockClear();
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
        queryWorktreeListForLegacyIpc,
      },
      resolveCaller,
    });
    const repair = requireRegisteredHandler('workspace:repair-worktree');
    const event = {};
    await repair(event, {
      workspaceId: 'test-workspace',
      worktreeId: 'test-animal',
      branchName: 'config-branch',
    });
    expect(resolveCaller).toHaveBeenCalledWith(event);
    expect(queryWorktreeListForLegacyIpc).toHaveBeenCalledWith(
      { scope: { workspaceId: 'test-workspace' } },
      { caller },
    );
    expect(mockedReadWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('recreates missing child repos from tracked repo base branches', async () => {
    await expect(
      repairWorktreeHandler(
        {},
        {
          workspaceId: 'test-workspace',
          worktreeId: 'test-animal',
          branchName: 'config-branch',
          trackedRepoBaseBranches: {
            'repo-a': 'release/a',
            'repo-b': 'release/b',
          },
        },
      ),
    ).resolves.toEqual({
      id: 'test-animal',
      branchName: 'config-branch',
      trackedRepoBaseBranches: {
        'repo-a': 'release/a',
        'repo-b': 'release/b',
      },
    });

    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenNthCalledWith(
      1,
      '/repos/repo-a',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      'config-branch',
      'release/a',
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenNthCalledWith(
      2,
      '/repos/repo-b',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-b',
      'config-branch',
      'release/b',
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('settles a Git setup left pending by a needs-repair detour as ready, releasing sends held for it', async () => {
    beginWorktreeGitSetup('test-workspace', 'test-animal');
    const heldSend = claimWorktreeGitSetup('test-workspace', 'test-animal');

    await repairWorktreeHandler(
      {},
      {
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
        branchName: 'config-branch',
      },
    );

    await expect(heldSend).resolves.toBe('ready');
    expect(
      claimWorktreeGitSetup('test-workspace', 'test-animal'),
    ).toBeUndefined();
  });

  it('recreates missing child repos from an existing branch after root repair', async () => {
    mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');

    await expect(
      repairWorktreeHandler(
        {},
        {
          workspaceId: 'test-workspace',
          worktreeId: 'test-animal',
          branchName: 'feature/foo',
          existingBranch: 'feature/foo',
        },
      ),
    ).resolves.toEqual({
      id: 'test-animal',
      branchName: 'feature/foo',
      trackedRepoBaseBranches: undefined,
    });

    expect(mockedCreateWorktreeForExistingBranch).toHaveBeenNthCalledWith(
      1,
      '/repos/repo-a',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      'feature/foo',
    );
    expect(mockedCreateWorktreeForExistingBranch).toHaveBeenNthCalledWith(
      2,
      '/repos/repo-b',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-b',
      'feature/foo',
    );
    expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
  });

  it('falls back to the requested branch when an existing branch is absent in a child repo', async () => {
    mockedDoesLocalBranchExist.mockImplementation((repoPath) =>
      Promise.resolve(repoPath === '/repos/repo-a'),
    );
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');
    mockedCreateWorktree.mockResolvedValue('repair-branch');

    await expect(
      repairWorktreeHandler(
        {},
        {
          workspaceId: 'test-workspace',
          worktreeId: 'test-animal',
          branchName: 'repair-branch',
          existingBranch: 'feature/foo',
        },
      ),
    ).resolves.toEqual({
      id: 'test-animal',
      branchName: 'repair-branch',
      trackedRepoBaseBranches: undefined,
    });

    expect(mockedFetchOrigin).toHaveBeenCalledTimes(2);
    expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      'feature/foo',
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-b',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-b',
      'repair-branch',
    );
    expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
  });

  it('fails repair when a recreated repo resolves a different branch name', async () => {
    mockedCreateWorktreeFromStartPoint.mockImplementation((repoPath) =>
      Promise.resolve(
        repoPath === '/repos/repo-a' ? 'config-branch-2' : 'config-branch',
      ),
    );

    await expect(
      repairWorktreeHandler(
        {},
        {
          workspaceId: 'test-workspace',
          worktreeId: 'test-animal',
          branchName: 'config-branch',
          trackedRepoBaseBranches: {
            'repo-a': 'release/a',
            'repo-b': 'release/b',
          },
        },
      ),
    ).rejects.toThrow(
      'Repo "Repo A" created branch "config-branch-2" instead of "config-branch"',
    );
  });
});

describe('workspace:add-repo', () => {
  const scriptActionsOperationId: unknown = expect.any(String);

  it('adds the repo locally even when addToSourceControl is requested', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/repos/workspace-source',
      repos: [],
    });

    const result = await addRepoHandler(
      {},
      {
        workspaceId: 'test-workspace',
        repoPath: '/repos/new-repo',
        addToSourceControl: true,
      },
    );

    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
    expect(mockedEnsureAgentsMdSymlink).not.toHaveBeenCalled();
    expect(result).toEqual({
      repo: {
        id: 'new-repo',
        name: 'new-repo',
        repoPath: '/repos/new-repo',
        scriptActionsOperationId,
      },
      scriptActionsOperationId,
    });
  });

  it('persists the added repo to project config without rewriting sourceRepoPath', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/repos/workspace-source',
      repos: [],
    });

    const result = await addRepoHandler(
      {},
      {
        workspaceId: 'test-workspace',
        repoPath: '/repos/new-repo',
        addToSourceControl: true,
      },
    );

    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
    expect(result).toEqual({
      repo: {
        id: 'new-repo',
        name: 'new-repo',
        repoPath: '/repos/new-repo',
        scriptActionsOperationId,
      },
      scriptActionsOperationId,
    });
  });
});

describe('workspace:add-repo and remove-repo for an organization project (CAN-3546)', () => {
  const orgConfig = {
    version: 1 as const,
    type: 'multi-repo' as const,
    owner: {
      type: 'organization' as const,
      organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      projectId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      instanceId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      bindingGeneration: 0,
    },
    repos: [{ id: 'payments', name: 'payments', repoPath: '/repos/payments' }],
  };

  it('writes nothing when the organization refuses the repository', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(structuredClone(orgConfig));
    mockOrgMultiRepoSync.addRepo.mockRejectedValueOnce(
      new Error(
        "web3swift doesn't belong to Acme. Choose repositories that belong to Acme.",
      ),
    );

    await expect(
      addRepoHandler(
        {},
        { workspaceId: 'acme-platform', repoPath: '/repos/web3swift' },
      ),
    ).rejects.toThrow("web3swift doesn't belong to Acme.");

    expect(mockOrgMultiRepoSync.addRepo).toHaveBeenCalledWith(
      'acme-platform',
      '/repos/web3swift',
      expect.any(Function),
    );
    expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
  });

  it('removes a repository through the organization sync', async () => {
    mockedReadWorkspaceConfig.mockResolvedValue(structuredClone(orgConfig));

    await requireRegisteredHandler('workspace:remove-repo')(
      {},
      { workspaceId: 'acme-platform', repoId: 'payments' },
    );

    expect(mockOrgMultiRepoSync.removeRepo).toHaveBeenCalledWith(
      'acme-platform',
      'payments',
      expect.any(Function),
    );
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      'acme-platform',
      expect.objectContaining({ repos: [] }),
    );
  });
});

describe('workspace:add-repo-to-worktree', () => {
  const addRepoRequest = {
    workspaceId: 'test-workspace',
    worktreeId: 'test-animal',
    repoId: 'repo-a',
  };

  it('refuses to remove a non-empty non-git repo directory', async () => {
    const debugEntry = new Dirent<Buffer<ArrayBuffer>>();
    debugEntry.name = Buffer.from('debug.txt');
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReaddir.mockImplementation(() => Promise.resolve([debugEntry]));

    await expect(addRepoToWorktreeHandler({}, addRepoRequest)).rejects.toThrow(
      'already exists and is not empty',
    );

    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedCreateWorktreeAvoidingCheckedOutBranch).not.toHaveBeenCalled();
  });

  it('removes an empty orphan repo directory before recreating it', async () => {
    mockedReadFile.mockRejectedValue(new Error('ENOENT'));
    mockedReaddir.mockImplementation(() => Promise.resolve([]));

    await addRepoToWorktreeHandler({}, addRepoRequest);

    expect(mockedRm).toHaveBeenCalledWith(
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      { recursive: true, force: true },
    );
    expect(mockedCreateWorktreeAvoidingCheckedOutBranch).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a',
      'config-branch',
    );
  });
});

describe('workspace:archive-worktree chat cleanup', () => {
  // The archive boundary (CAN-3811) only archives a worktree in the list;
  // the archive itself then sees the list it saw before.
  beforeEach(() => {
    jest
      .mocked(
        jest.requireMock<{
          readWorkspaceWorktrees: () => Promise<unknown[]>;
        }>('../lib/workspace-persistence').readWorkspaceWorktrees,
      )
      .mockReset()
      .mockResolvedValue([])
      .mockResolvedValueOnce([
        {
          id: 'test-animal',
          branchName: 'branch-test-animal',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
  });

  it('removes archived worktree chat tabs from the unified project chats directory', async () => {
    const owner = createLiveBackgroundTaskOwner(
      'test-workspace',
      'test-animal',
      'chat-a',
      'local_bash',
    );
    mockedGetLiveBackgroundTasksForChat.mockReturnValue(owner.liveTasks);
    mockedListLiveBackgroundTaskOwners.mockReturnValue([owner]);

    await archiveWorktreeHandler(
      {},
      {
        workspaceId: 'test-workspace',
        worktreeId: 'test-animal',
      },
    );

    const cleanupCall = mockedCleanupPersistedWorktreeData.mock.calls[0];
    expect(cleanupCall?.[0]).toBe('test-workspace');
    expect(cleanupCall?.[1]).toBe('test-animal');
    expect(cleanupCall?.[2]?.observabilityMode).toBe('live-service');
    expect(typeof cleanupCall?.[2]?.purgeObservabilityData).toBe('function');
  });

  it('refuses with SplitLockError while the worktree is split-locked, without tearing down', async () => {
    acquireSplitLock('test-workspace', 'test-animal');
    try {
      await expect(
        archiveWorktreeHandler(
          {},
          { workspaceId: 'test-workspace', worktreeId: 'test-animal' },
        ),
      ).rejects.toBeInstanceOf(SplitLockError);
      // The guard runs before any worktree teardown.
      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    } finally {
      releaseSplitLock('test-workspace', 'test-animal');
    }
  });

  it('refuses while a chat in the worktree has live delegates, without tearing down', async () => {
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'test-workspace',
        'test-animal',
        'chat-a',
        'local_agent',
      ),
    );
    setDelegationActivity(
      'workspace-archive-owner',
      'test-workspace/test-animal/chat-a',
      1,
    );
    try {
      await expect(
        archiveWorktreeHandler(
          {},
          { workspaceId: 'test-workspace', worktreeId: 'test-animal' },
        ),
      ).rejects.toThrow('Delegates are still running here. Stop them first.');
      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
      expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    } finally {
      setDelegationActivity(
        'workspace-archive-owner',
        'test-workspace/test-animal/chat-a',
        0,
      );
    }
  });

  it.each(['local_agent', 'local_workflow'] as const)(
    'refuses while a chat in the worktree has a live %s, without tearing down',
    async (taskType) => {
      const owner = createLiveBackgroundTaskOwner(
        'test-workspace',
        'test-animal',
        'chat-a',
        taskType,
      );
      mockedGetLiveBackgroundTasksForChat.mockReturnValue(owner.liveTasks);
      mockedListLiveBackgroundTaskOwners.mockReturnValue([owner]);

      await expect(
        archiveWorktreeHandler(
          {},
          { workspaceId: 'test-workspace', worktreeId: 'test-animal' },
        ),
      ).rejects.toMatchObject({
        code: 'conflict',
        message:
          'Background agents or workflows are still running here. Stop them first.',
      });
      expect(mockedRemoveWorktree).not.toHaveBeenCalled();
      expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
      expect(mockedRecordWorktreeCrudTelemetry).not.toHaveBeenCalled();
    },
  );

  it('rethrows Linux project teardown failures instead of swallowing them', async () => {
    // macOS can recover with its native fallback; Linux must surface rm failure.
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', {
      value: 'linux',
      configurable: true,
    });
    try {
      mockedRemoveWorktree.mockRejectedValueOnce(
        new Error('git teardown failed'),
      );
      mockedIsRegisteredWorktreePath
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockedRm.mockImplementation((targetPath) => {
        if (
          targetPath ===
          '/mock/workspaces/test-workspace/worktrees/test-animal/repos/repo-a'
        ) {
          return Promise.reject(new Error('fallback rm failed'));
        }
        return Promise.resolve(undefined);
      });

      await expect(
        archiveWorktreeHandler(
          {},
          {
            workspaceId: 'test-workspace',
            worktreeId: 'test-animal',
          },
        ),
      ).rejects.toThrow('fallback rm failed');
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('project multi-repo imports', () => {
  it('preserves a template install completed while a manifest import prepares', async () => {
    const installedProject: SidebarItem = {
      type: 'cowork',
      id: 'installed-template',
      name: 'Installed Template',
      color: '#123456',
      collapsed: false,
      order: 0,
    };
    let persistedItems: SidebarItem[] = [];
    mockedReadAllSidebarItems.mockImplementation(() =>
      Promise.resolve({ version: 1, items: [...persistedItems] }),
    );
    mockedWriteAllSidebarItems.mockImplementation((items) => {
      persistedItems = [
        ...persistedItems.filter(
          (existing) => !items.some((item) => item.id === existing.id),
        ),
        ...items,
      ];
      return Promise.resolve({ version: 1, items: persistedItems });
    });
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://github.com/example/repo-a.git',
        },
      ],
    });

    let releaseClone!: () => void;
    let markCloneStarted!: () => void;
    const cloneGate = new Promise<void>((resolve) => {
      releaseClone = resolve;
    });
    const cloneStarted = new Promise<void>((resolve) => {
      markCloneStarted = resolve;
    });
    mockedCloneRepo.mockImplementationOnce(async () => {
      markCloneStarted();
      await cloneGate;
    });

    const manifestImport = importFromRepoHandler(
      {},
      { repoPath: '/repos/workspace-source' },
    );
    await cloneStarted;
    await serializeChatProjectOperation(() => {
      persistedItems = [...persistedItems, installedProject];
      return Promise.resolve();
    });
    releaseClone();

    await manifestImport;
    expect(persistedItems).toEqual(
      expect.arrayContaining([
        installedProject,
        expect.objectContaining({
          type: 'multi-repo',
          sourceRepoPath: '/repos/workspace-source',
        }),
      ]),
    );
  });

  it('adds imported child repos as standalone projects unless a matching remote already exists', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'repo-b',
          name: 'Repo B',
          repoPath: '/repos/existing-repo-b',
          color: '#111111',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });
    mockedReadCanopyJson.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/workspace') {
        return Promise.resolve({
          version: 1,
          repos: [
            {
              id: 'repo-a',
              name: 'Repo A',
              url: 'https://github.com/example/repo-a.git',
            },
            {
              id: 'repo-b',
              name: 'Repo B',
              url: 'https://github.com/example/repo-b.git',
            },
          ],
        });
      }

      return Promise.resolve(null);
    });
    mockedGetRemoteUrl.mockImplementation((repoPath: string) => {
      if (repoPath === '/repos/existing-repo-b') {
        return Promise.resolve('https://octocat@github.com/example/repo-b.git');
      }

      return Promise.resolve(null);
    });

    const result = await addFromRemoteHandler(
      {},
      {
        remoteUrl: 'https://github.com/example/workspace.git',
        destinationDir: '/repos',
      },
    );

    expect(mockedCloneRepo).toHaveBeenCalledTimes(2);
    expect(mockedCloneRepo).toHaveBeenNthCalledWith(
      1,
      'https://github.com/example/workspace.git',
      '/repos/workspace',
    );
    expect(mockedCloneRepo).toHaveBeenNthCalledWith(
      2,
      'https://github.com/example/repo-a.git',
      '/mock/repos/Repo A',
    );
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'multi-repo',
          id: 'workspace',
          sourceRepoPath: '/repos/workspace',
          order: 1,
          repos: [
            expect.objectContaining({
              id: 'repo-a',
              repoPath: '/mock/repos/Repo A',
              manifestUrl: 'https://github.com/example/repo-a.git',
            }),
            expect.objectContaining({
              id: 'repo-b',
              repoPath: '/repos/existing-repo-b',
              manifestUrl: 'https://github.com/example/repo-b.git',
            }),
          ],
        }),
        expect.objectContaining({
          type: 'single-repo',
          id: 'repo-a',
          name: 'Repo A',
          repoPath: '/mock/repos/Repo A',
          order: 2,
        }),
      ],
      { preserveEmptyTemporary: false, preserveUnmentionedWorkspaceIds: true },
    );
    expect(result).toEqual(
      expect.objectContaining({
        type: 'multi-repo',
        id: 'workspace',
        sourceRepoPath: '/repos/workspace',
      }),
    );
  });

  it('persists imported projects before returning from workspace:import-from-repo', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [],
    });
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      repos: [
        {
          id: 'repo-a',
          name: 'Repo A',
          url: 'https://github.com/example/repo-a.git',
        },
      ],
    });

    await expect(
      importFromRepoHandler(
        {},
        {
          repoPath: '/repos/workspace-source',
        },
      ),
    ).resolves.toMatchObject({
      workspace: {
        type: 'multi-repo',
        id: 'workspace-source',
        sourceRepoPath: '/repos/workspace-source',
      },
      clonedRepoIds: ['repo-a'],
    });
    expect(mockedWriteAllSidebarItems).toHaveBeenCalledWith(
      [
        expect.objectContaining({
          type: 'multi-repo',
          id: 'workspace-source',
          sourceRepoPath: '/repos/workspace-source',
          order: 0,
        }),
        expect.objectContaining({
          type: 'single-repo',
          id: 'repo-a',
          repoPath: '/mock/repos/Repo A',
          order: 1,
        }),
      ],
      { preserveEmptyTemporary: false, preserveUnmentionedWorkspaceIds: true },
    );
  });
});

describe('workspace:create (CAN-3806 D11)', () => {
  it('indexes the new multi-repo project in the same call', async () => {
    let persistedItems: SidebarItem[] = [];
    mockedReadAllSidebarItems.mockImplementation(() =>
      Promise.resolve({ version: 1, items: [...persistedItems] }),
    );
    mockedWriteAllSidebarItems.mockImplementation((items) => {
      persistedItems = [
        ...persistedItems.filter(
          (existing) => !items.some((item) => item.id === existing.id),
        ),
        ...items,
      ];
      return Promise.resolve({ version: 1, items: persistedItems });
    });
    jest
      .mocked(prepareNewWorkspaceSourceRepo)
      .mockResolvedValueOnce('/mock/repos/suite');
    const handler = requireRegisteredHandler('workspace:create');

    const created = await handler({}, { name: 'Suite' });

    // The renderer no longer completes the create with projects:save.
    expect(persistedItems).toEqual([
      expect.objectContaining({
        type: 'multi-repo',
        id: 'suite',
        name: 'Suite',
        sourceRepoPath: '/mock/repos/suite',
        order: 0,
      }),
    ]);
    const scriptActionsOperationId: unknown = expect.any(String);
    expect(created).toEqual({
      ...persistedItems[0],
      scriptActionsOperationId,
    });
    expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledWith({
      action: 'create',
      workspaceId: 'suite',
      source: 'new_multi_repo',
    });
  });
});

describe('project type conversion', () => {
  beforeEach(() => {
    // A fresh manifest per read: the conversion assigns its fields in place.
    mockedReadWorkspaceConfig.mockImplementation(() =>
      Promise.resolve({
        version: 1,
        type: 'single-repo',
        repoPath: '/repos/single',
        repos: [],
      }),
    );
    mockWorkspaceIndex.entries = [
      {
        id: 'single',
        name: 'Single',
        type: 'single-repo',
        color: '#123456',
        collapsed: false,
        order: 0,
        pinned: true,
      },
      {
        id: 'multi',
        name: 'Multi',
        type: 'multi-repo',
        color: '#123456',
        collapsed: false,
        order: 1,
        pinned: true,
      },
    ];
  });

  it.each(
    (['update', 'replace'] as const).flatMap((mode) =>
      ['lstat', 'readlink', 'readFile'].map((operation) => ({
        mode,
        operation,
      })),
    ),
  )(
    'rejects $mode conversion when instruction resolver $operation fails',
    async ({ mode, operation }) => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'single',
            name: 'Single',
            repoPath: '/repos/single',
            color: '#123456',
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      const failure = Object.assign(
        new Error(`instruction ${operation} denied`),
        { code: 'EACCES' },
      );
      const entry = statSync(__filename);
      if (operation === 'readlink') entry.isSymbolicLink = (): boolean => true;
      jest.mocked(lstat).mockImplementation((filePath) => {
        if (operation === 'lstat') return Promise.reject(failure);
        return Promise.resolve(
          filePath === '/repos/single/AGENTS.md' ? entry : statSync(__filename),
        );
      });
      jest.mocked(readlink).mockRejectedValue(failure);
      mockedReadFile.mockRejectedValue(failure);
      const handler = requireRegisteredHandler(
        IPC_CHANNELS.workspaceConvertType,
      );
      await expect(
        handler(
          {},
          {
            workspaceId: 'single',
            targetType: 'multi-repo',
            claudeMdMode: mode,
          },
        ),
      ).rejects.toThrow(failure);
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
      expect(mockedWriteFile).not.toHaveBeenCalled();
    },
  );

  it('refuses to convert an organization project to multi-repo (CAN-3546)', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'single',
          name: 'Single',
          repoPath: '/repos/single',
          color: '#123456',
          worktrees: [],
          collapsed: false,
          order: 0,
          owner: {
            type: 'organization',
            organizationId: '11111111-1111-4111-8111-111111111111',
            projectId: '22222222-2222-4222-8222-222222222222',
            instanceId: '33333333-3333-4333-8333-333333333333',
            bindingGeneration: 1,
          },
        },
      ],
    });
    const handler = requireRegisteredHandler(IPC_CHANNELS.workspaceConvertType);
    await expect(
      handler(
        {},
        {
          workspaceId: 'single',
          targetType: 'multi-repo',
          claudeMdMode: 'unchanged',
        },
      ),
    ).rejects.toThrow(
      "Organization projects can't be converted. Create a Multi-Repo project and add this repository instead.",
    );
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    expect(mockedWriteFile).not.toHaveBeenCalled();
  });

  it('generates conversion guidance for AGENTS-only and legacy child repositories', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'single',
          name: 'Single',
          repoPath: '/repos/single',
          color: '#123456',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });
    jest
      .mocked(lstat)
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    const handler = requireRegisteredHandler(IPC_CHANNELS.workspaceConvertType);
    await handler(
      {},
      {
        workspaceId: 'single',
        targetType: 'multi-repo',
        claudeMdMode: 'update',
      },
    );
    const generated = mockedWriteFile.mock.calls.find(
      ([filePath]) => filePath === '/repos/single/AGENTS.md',
    )?.[1];
    expect(typeof generated).toBe('string');
    if (typeof generated !== 'string')
      throw new Error('Missing generated instructions');
    for (const paragraph of generated.split('\n\n').slice(1, 4)) {
      expect(paragraph).toContain('AGENTS.md');
      expect(paragraph).toContain('CLAUDE.md');
    }
  });

  it.each(
    (['unchanged', 'update', 'replace'] as const).flatMap((mode) =>
      ['AGENTS.md', 'CLAUDE.md'].flatMap((fileName) =>
        ['directory', 'symlink'].map((entryKind) => ({
          mode,
          fileName,
          entryKind,
        })),
      ),
    ),
  )(
    'converts with $mode while preserving an unsupported $fileName $entryKind',
    async ({ mode, fileName, entryKind }) => {
      mockedReadAllSidebarItems.mockResolvedValue({
        version: 1,
        items: [
          {
            type: 'single-repo',
            id: 'single',
            name: 'Single',
            repoPath: '/repos/single',
            color: '#123456',
            worktrees: [],
            collapsed: false,
            order: 0,
          },
        ],
      });
      const entryStats = statSync(__dirname);
      if (entryKind === 'symlink') {
        entryStats.isSymbolicLink = (): boolean => true;
      }
      jest
        .mocked(lstat)
        .mockImplementation((filePath) =>
          filePath === `/repos/single/${fileName}`
            ? Promise.resolve(entryStats)
            : Promise.reject(
                Object.assign(new Error('missing'), { code: 'ENOENT' }),
              ),
        );
      jest.mocked(readlink).mockResolvedValue(`docs/${fileName}`);
      const handler = requireRegisteredHandler(
        IPC_CHANNELS.workspaceConvertType,
      );
      await handler(
        {},
        { workspaceId: 'single', targetType: 'multi-repo', claudeMdMode: mode },
      );
      // Only this project's manifest and index entry are written (CAN-3819).
      expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
      expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
        'single',
        expect.objectContaining({
          type: 'multi-repo',
          sourceRepoPath: '/repos/single',
          repoPath: undefined,
          repos: [],
        }),
      );
      expect(mockWorkspaceIndex.entries).toEqual([
        expect.objectContaining({ id: 'single', type: 'multi-repo' }),
        expect.objectContaining({ id: 'multi', type: 'multi-repo' }),
      ]);
      expect(mockedWriteCanopyJson).toHaveBeenCalledWith(
        '/repos/single',
        expect.objectContaining({ repos: [] }),
      );
      expect(
        mockedWriteFile.mock.calls.filter(
          ([filePath]) =>
            typeof filePath === 'string' &&
            /(?:AGENTS|CLAUDE)\.md$/.test(filePath),
        ),
      ).toEqual([]);
      if (mode === 'unchanged') expect(lstat).not.toHaveBeenCalled();
    },
  );

  it('preserves standalone AGENTS.md when converting without instruction changes', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'single-repo',
          id: 'single',
          name: 'Single',
          repoPath: '/repos/single',
          color: '#123456',
          worktrees: [],
          collapsed: false,
          order: 0,
        },
      ],
    });
    jest.mocked(lstat).mockImplementation((filePath) => {
      if (filePath === '/repos/single/AGENTS.md')
        return Promise.resolve(statSync(__filename));
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    mockedReadFile.mockImplementation((filePath) => {
      if (filePath === '/repos/single/AGENTS.md')
        return Promise.resolve('# Preserve my rules');
      return Promise.reject(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    });
    const handler = requireRegisteredHandler(IPC_CHANNELS.workspaceConvertType);
    await handler(
      {},
      {
        workspaceId: 'single',
        targetType: 'multi-repo',
        claudeMdMode: 'unchanged',
      },
    );
    expect(ensureAgentsMdSymlink).not.toHaveBeenCalled();
    expect(
      mockedWriteFile.mock.calls.filter(
        ([filePath]) =>
          typeof filePath === 'string' &&
          /(?:AGENTS|CLAUDE)\.md$/.test(filePath),
      ),
    ).toEqual([]);
  });

  it('waits for a template install and preserves it while converting', async () => {
    const sourceProject: SidebarItem = {
      type: 'single-repo',
      id: 'single',
      name: 'Single',
      repoPath: '/repos/single',
      color: '#123456',
      worktrees: [],
      collapsed: false,
      order: 0,
      pinned: true,
      itemSortMode: 'manual',
    };
    const installedProject: SidebarItem = {
      type: 'cowork',
      id: 'installed-template',
      name: 'Installed Template',
      color: '#654321',
      collapsed: false,
      order: 1,
    };
    let persistedItems: SidebarItem[] = [sourceProject];
    mockedReadAllSidebarItems.mockImplementation(() =>
      Promise.resolve({ version: 1, items: [...persistedItems] }),
    );
    mockedWriteAllSidebarItems.mockImplementation((items) => {
      persistedItems = [
        ...persistedItems.filter(
          (existing) => !items.some((item) => item.id === existing.id),
        ),
        ...items,
      ];
      return Promise.resolve({ version: 1, items: persistedItems });
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
      persistedItems = [...persistedItems, installedProject];
    });
    await installStarted;

    const convertHandler = requireRegisteredHandler(
      IPC_CHANNELS.workspaceConvertType,
    );
    const conversion = convertHandler(
      {},
      {
        workspaceId: sourceProject.id,
        targetType: 'multi-repo',
        claudeMdMode: 'unchanged',
      },
    );
    await flush();
    try {
      expect(mockedWriteWorkspaceConfig).not.toHaveBeenCalled();
      expect(mockedWriteCanopyJson).not.toHaveBeenCalled();
    } finally {
      releaseInstall();
    }
    await Promise.all([install, conversion]);
    // The conversion writes only its own project, so the installed project
    // is never rewritten from a snapshot (CAN-3819).
    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    expect(persistedItems).toEqual([sourceProject, installedProject]);
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      sourceProject.id,
      expect.objectContaining({ type: 'multi-repo', itemSortMode: 'manual' }),
    );
    expect(mockWorkspaceIndex.entries[0]).toEqual(
      expect.objectContaining({
        id: sourceProject.id,
        type: 'multi-repo',
        pinned: true,
      }),
    );
  });

  it('preserves pin and child sort preferences when converting to single-repo', async () => {
    const sourceProject: SidebarItem = {
      type: 'multi-repo',
      id: 'multi',
      name: 'Multi',
      color: '#123456',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      pinned: true,
      itemSortMode: 'manual',
      sourceRepoPath: '/repos/multi',
    };
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [sourceProject],
    });

    const convertHandler = requireRegisteredHandler(
      IPC_CHANNELS.workspaceConvertType,
    );
    await convertHandler(
      {},
      {
        workspaceId: sourceProject.id,
        targetType: 'single-repo',
        claudeMdMode: 'unchanged',
      },
    );

    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    expect(mockedWriteWorkspaceConfig).toHaveBeenCalledWith(
      sourceProject.id,
      expect.objectContaining({
        type: 'single-repo',
        repoPath: '/repos/multi',
        sourceRepoPath: undefined,
        itemSortMode: 'manual',
      }),
    );
    expect(mockWorkspaceIndex.entries[1]).toEqual(
      expect.objectContaining({
        id: sourceProject.id,
        type: 'single-repo',
        pinned: true,
      }),
    );
  });
});

describe('workspace:delete', () => {
  // A deletion's repo-shadow reap is detached work; let it settle so it
  // cannot run into the next test's mocks. This drains every tracked item in
  // the process, so a tracked promise that never settles hangs this hook.
  afterEach(async () => {
    await settleDetachedWork();
  });

  it('refuses while any chat in the workspace has live delegates', async () => {
    setProviderTask(
      createLiveBackgroundTaskOwner(
        'test-workspace',
        'test-animal',
        'chat-a',
        'local_agent',
      ),
    );
    setDelegationActivity(
      'workspace-delete-owner',
      'test-workspace/test-animal/chat-a',
      0,
      1,
    );
    try {
      const deleteHandler = requireRegisteredHandler('workspace:delete');
      await expect(
        deleteHandler({}, { workspaceId: 'test-workspace' }),
      ).rejects.toThrow('Delegates are still running here. Stop them first.');
    } finally {
      setDelegationActivity(
        'workspace-delete-owner',
        'test-workspace/test-animal/chat-a',
        0,
      );
    }
    expect(jest.mocked(removeWorkspaceIndexEntry)).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/workspaces/test-workspace',
      expect.anything(),
    );
  });

  it('rejects a malformed supersede operation id at the IPC boundary', async () => {
    // The suite stubs the validator. Run the real one for this field only,
    // not as a queued `Once` value another test's late call could take.
    const realValidateId: typeof ValidationModule.validateId =
      jest.requireActual<typeof ValidationModule>(
        '../lib/validation',
      ).validateId;
    jest.mocked(validateId).mockImplementation((value, label) => {
      if (label === 'supersedeInterruptedDeletion')
        realValidateId(value, label);
    });
    const deleteHandler = requireRegisteredHandler('workspace:delete');
    try {
      await expect(
        deleteHandler(
          {},
          {
            workspaceId: 'test-workspace',
            supersedeInterruptedDeletion: 'NOT/an-operation-id',
          },
        ),
      ).rejects.toThrow('Invalid supersedeInterruptedDeletion');
    } finally {
      jest.mocked(validateId).mockReset();
    }

    expect(mockedListArchivedContainerManifestsStrict).not.toHaveBeenCalled();
    expect(jest.mocked(removeWorkspaceIndexEntry)).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/workspaces/test-workspace',
      expect.anything(),
    );
  });

  it('preserves the workspace when strict archive inventory fails', async () => {
    mockedListArchivedContainerManifestsStrict.mockRejectedValueOnce(
      new Error('Invalid archived container manifest'),
    );

    const deleteHandler = requireRegisteredHandler('workspace:delete');
    await expect(
      deleteHandler({}, { workspaceId: 'test-workspace' }),
    ).rejects.toThrow('Invalid archived container manifest');

    expect(jest.mocked(removeWorkspaceIndexEntry)).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalledWith(
      '/mock/workspaces/test-workspace',
      expect.anything(),
    );
  });

  it('releases version-3 snapshot refs after durable workspace deletion', async () => {
    const originalWorktree: WorktreeData = {
      id: 'archived-worktree',
      branchName: 'feature/archive',
      createdAt: '2026-09-22T00:00:00.000Z',
    };
    const recoveryManifest: ArchivedContainerRecoveryManifest = {
      version: 3,
      kind: 'worktree',
      id: originalWorktree.id,
      projectId: 'test-workspace',
      name: 'Archived worktree',
      createdAt: originalWorktree.createdAt,
      archivedAt: '2026-09-22T01:00:00.000Z',
      retentionDays: 7,
      expiresAt: '2026-09-29T01:00:00.000Z',
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'multi-repo',
      originalWorktree,
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'digest',
        payloadId: '00000000-0000-4000-8000-000000000001',
        gitCleanupPending: false,
      },
    };
    const repository: ArchivedGitRepositoryState = {
      repoId: 'repo-a',
      repoName: 'Repo A',
      relativePath: 'repos/repo-a',
      referenceRepoPath: '/repos/repo-a',
      branchName: 'feature/archive',
      comparisonBaseCommit: 'base',
      headCommit: 'head',
      indexSnapshotCommit: 'index',
      worktreeSnapshotCommit: 'worktree',
      snapshotRef:
        'refs/app/archived-containers/test-workspace/archived-worktree/repo-a',
    };
    mockedListArchivedContainerManifestsStrict.mockResolvedValueOnce([
      recoveryManifest,
    ]);
    mockedReadArchivedGitStagedDescriptor.mockResolvedValueOnce({
      version: 1,
      status: 'capturing',
      repositories: [repository],
    });

    const deleteHandler = requireRegisteredHandler('workspace:delete');
    await deleteHandler({}, { workspaceId: 'test-workspace' });

    expect(mockedReadArchivedGitStagedDescriptor).toHaveBeenCalledWith(
      'test-workspace',
      'archived-worktree',
    );
    expect(mockedReleaseArchivedGitState).toHaveBeenCalledWith({
      version: 1,
      diffFormatVersion: 1,
      repositories: [repository],
    });
    expect(mockedRm.mock.invocationCallOrder[0]).toBeLessThan(
      mockedReleaseArchivedGitState.mock.invocationCallOrder[0],
    );
  });

  it('routes cowork project deletes through the cowork cleanup path instead of a bare rm', async () => {
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        {
          type: 'cowork',
          id: 'cowork-1',
          name: 'Cowork One',
          color: '#111111',
          collapsed: false,
          order: 0,
          externalPath: '/external/cowork-1',
        },
      ],
    });

    const deleteHandler = requireRegisteredHandler('workspace:delete');
    await deleteHandler({}, { workspaceId: 'cowork-1' });

    expect(mockedDestroyWorktreeSessions).toHaveBeenCalledWith(
      'cowork-1',
      COWORK_HOME_WORKTREE_ID,
    );
    expect(
      mockedDestroyWorktreeSessions.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCleanupPersistedWorktreeData.mock.invocationCallOrder[0],
    );
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'cowork-1',
      'home',
      { deferLocalWatcherCancellationCommit: true },
    );
    expect(mockedClearWorkEntrySummariesForWorkspace).toHaveBeenCalledWith(
      'cowork-1',
    );
    expect(mockedRm).toHaveBeenCalledWith('/mock/workspaces/cowork-1', {
      recursive: true,
      force: true,
    });
    expect(mockedRm).not.toHaveBeenCalledWith('/external/cowork-1', {
      recursive: true,
      force: true,
    });
    expect(removeWorkspaceIndexEntry).toHaveBeenCalledWith('cowork-1');
  });

  it('removes single/multi-repo projects from the index before deleting their data', async () => {
    const deleteHandler = requireRegisteredHandler('workspace:delete');
    await deleteHandler({}, { workspaceId: 'test-workspace' });

    expect(removeWorkspaceIndexEntry).toHaveBeenCalledWith('test-workspace');
    expect(mockedRm).toHaveBeenCalledWith('/mock/workspaces/test-workspace', {
      recursive: true,
      force: true,
    });
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
  });

  it('cleans up repo shadows using repo paths gathered from the post-deletion sidebar items, not the pre-deletion list', async () => {
    const preDeletionItems: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'to-delete',
        name: 'To Delete',
        repoPath: '/repos/to-delete',
        color: '#000000',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
      {
        type: 'multi-repo',
        id: 'keep-multi',
        name: 'Keep Multi',
        color: '#000000',
        repos: [{ id: 'repo-a', name: 'Repo A', repoPath: '/repos/keep-a' }],
        worktrees: [],
        collapsed: false,
        order: 1,
        sourceRepoPath: '/repos/keep-source',
      },
    ];
    const postDeletionItems: SidebarItem[] = preDeletionItems.filter(
      (item) => item.id !== 'to-delete',
    );
    const indexEntry = {
      id: 'to-delete',
      name: 'To Delete',
      type: 'single-repo' as const,
      color: '#000000',
      collapsed: false,
      order: 0,
    };
    // Answer from the deletion's progress rather than queued `Once` values:
    // `clearAllMocks` keeps an earlier test's unconsumed queue, and a read
    // that test's background work makes late would take this test's value.
    const indexEntryRemoved = (): boolean =>
      jest
        .mocked(removeWorkspaceIndexEntry)
        .mock.calls.some(([workspaceId]) => workspaceId === 'to-delete');
    mockedReadWorkspaceIndexEntry
      .mockReset()
      .mockImplementation(() =>
        Promise.resolve(indexEntryRemoved() ? null : indexEntry),
      );
    mockedReadAllSidebarItems.mockReset().mockImplementation(() =>
      Promise.resolve({
        version: 1,
        items: indexEntryRemoved() ? postDeletionItems : preDeletionItems,
      }),
    );

    const deleteHandler = requireRegisteredHandler(
      IPC_CHANNELS.workspaceDelete,
    );
    await deleteHandler({}, { workspaceId: 'to-delete' });

    expect(mockedCleanupUnreferencedRepoShadows).toHaveBeenCalledWith([
      '/repos/keep-source',
      '/repos/keep-a',
    ]);
  });

  it('does not block the delete handler on shadow cleanup failures', async () => {
    mockedCleanupUnreferencedRepoShadows.mockRejectedValueOnce(
      new Error('shadow cleanup boom'),
    );

    const deleteHandler = requireRegisteredHandler(
      IPC_CHANNELS.workspaceDelete,
    );
    await expect(
      deleteHandler({}, { workspaceId: 'test-workspace' }),
    ).resolves.toBeUndefined();
  });
});

describe('collectReferencedRepoPaths', () => {
  it('collects repoPath from single-repo items, sourceRepoPath and repos[].repoPath from multi-repo items, and skips cowork items', () => {
    const items: SidebarItem[] = [
      {
        type: 'single-repo',
        id: 'single',
        name: 'Single',
        repoPath: '/repos/single',
        color: '#000000',
        worktrees: [],
        collapsed: false,
        order: 0,
      },
      {
        type: 'multi-repo',
        id: 'multi',
        name: 'Multi',
        color: '#000000',
        repos: [
          { id: 'repo-a', name: 'Repo A', repoPath: '/repos/multi-a' },
          { id: 'repo-b', name: 'Repo B', repoPath: '/repos/multi-b' },
        ],
        worktrees: [],
        collapsed: false,
        order: 1,
        sourceRepoPath: '/repos/multi-source',
      },
      {
        type: 'multi-repo',
        id: 'multi-no-source',
        name: 'Multi No Source',
        color: '#000000',
        repos: [{ id: 'repo-c', name: 'Repo C', repoPath: '/repos/multi-c' }],
        worktrees: [],
        collapsed: false,
        order: 2,
      },
      {
        type: 'cowork',
        id: 'cowork',
        name: 'Cowork',
        color: '#000000',
        collapsed: false,
        order: 3,
      },
    ];

    expect(collectReferencedRepoPaths(items)).toEqual([
      '/repos/single',
      '/repos/multi-source',
      '/repos/multi-a',
      '/repos/multi-b',
      '/repos/multi-c',
    ]);
  });

  it('returns an empty list for no items', () => {
    expect(collectReferencedRepoPaths([])).toEqual([]);
  });
});

describe('conversion requests after durable workspace mutations', () => {
  beforeEach(() => {
    jest
      .mocked(lstat)
      .mockRejectedValue(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
      );
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);
  });
  it.each([
    [
      'workspace:create-temporary-from-repos',
      { repos: [{ name: 'Web', path: '/repos/web' }] },
    ],
    [
      'workspace:create-temporary-worktree-from-repos',
      { repos: [{ name: 'Web', path: '/repos/web' }] },
    ],
    [
      'workspace:create-temporary-worktree-from-workspaces',
      { workspaceIds: ['source'] },
    ],
    [
      'workspace:combine-worktree-with-workspace',
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      },
    ],
    [
      'workspace:combine-worktree-with-existing-worktree',
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        joinWorktreeId: 'joined',
        mode: 'temporary',
      },
    ],
    [
      'workspace:split-temporary',
      {
        workspaceId: 'test-workspace',
        worktreeId: 'test-worktree',
        selections: {},
      },
    ],
  ])(
    'does not request when a valid %s mutation fails',
    async (channel, request) => {
      const failure = new Error('mutation failed');
      switch (channel) {
        case 'workspace:create-temporary-from-repos':
        case 'workspace:create-temporary-worktree-from-repos':
          mockedCreateOrReuseTemporaryWorkspaceFromRepos.mockRejectedValueOnce(
            failure,
          );
          break;
        case 'workspace:create-temporary-worktree-from-workspaces':
          mockedCreateOrReuseTemporaryWorkspaceFromWorkspaces.mockRejectedValueOnce(
            failure,
          );
          break;
        case 'workspace:combine-worktree-with-workspace':
          mockedCombineWorktreeWithWorkspace.mockRejectedValueOnce(failure);
          break;
        case 'workspace:combine-worktree-with-existing-worktree':
          mockedCombineWorktreeWithExistingWorktree.mockRejectedValueOnce(
            failure,
          );
          break;
        case 'workspace:split-temporary':
          mockedSplitTemporaryWorkspaceWorktree.mockRejectedValueOnce(failure);
          break;
      }
      await expect(
        requireRegisteredHandler(String(channel))({}, request),
      ).rejects.toThrow(failure);
      expect(requestOrgProjectAutoConversion).not.toHaveBeenCalled();
      expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
      expect(mockedRecordWorktreeCrudTelemetry).not.toHaveBeenCalled();
    },
  );

  it('does not request when initial temporary worktree creation fails', async () => {
    const created = await mockedCreateOrReuseTemporaryWorkspaceFromRepos([
      { name: 'Web', path: '/repos/web' },
    ]);
    created.workspace.id = 'test-workspace';
    mockedCreateOrReuseTemporaryWorkspaceFromRepos.mockResolvedValue(created);
    mockedReadWorkspaceIndexEntry.mockRejectedValueOnce(
      new Error('workspace lookup failed'),
    );
    await expect(
      createTemporaryWorktreeFromReposHandler(
        {},
        {
          repos: [{ name: 'Web', path: '/repos/web' }],
        },
      ),
    ).rejects.toThrow('workspace lookup failed');
    expect(requestOrgProjectAutoConversion).not.toHaveBeenCalled();
  });

  it.each([
    [
      'workspace:create-temporary-from-repos',
      { repos: [{ name: 'Web', path: '/repos/web' }] },
    ],
    [
      'workspace:create-temporary-worktree-from-repos',
      { repos: [{ name: 'Web', path: '/repos/web' }] },
    ],
    [
      'workspace:create-temporary-worktree-from-workspaces',
      { workspaceIds: ['source'] },
    ],
    [
      'workspace:combine-worktree-with-workspace',
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        mode: 'temporary',
      },
    ],
    [
      'workspace:combine-worktree-with-existing-worktree',
      {
        sourceWorkspaceId: 'source',
        sourceWorktreeId: 'worktree',
        joinWorkspaceId: 'join',
        joinWorktreeId: 'joined',
        mode: 'temporary',
      },
    ],
  ])('requests once after %s', async (channel, request) => {
    const created = await mockedCreateOrReuseTemporaryWorkspaceFromRepos([
      { name: 'Web', path: '/repos/web' },
    ]);
    created.workspace.id = 'test-workspace';
    mockedCreateOrReuseTemporaryWorkspaceFromRepos.mockResolvedValue(created);
    mockedCreateOrReuseTemporaryWorkspaceFromWorkspaces.mockResolvedValue(
      created,
    );
    jest.mocked(requestOrgProjectAutoConversion).mockClear();
    await requireRegisteredHandler(String(channel))({}, request);
    expect(requestOrgProjectAutoConversion).toHaveBeenCalledTimes(1);
  });

  it.each([true, false])(
    'requests only after successful split completion: %s',
    async (success) => {
      mockedSplitTemporaryWorkspaceWorktree.mockImplementation(
        (request, hooks) => {
          const response = {
            success,
            results: [],
            warnings: [],
            navigationTarget: { kind: 'home' as const },
          };
          hooks?.onComplete?.({
            ...response,
            workspaceId: request.workspaceId,
            worktreeId: request.worktreeId,
          });
          return Promise.resolve(response);
        },
      );
      jest.mocked(requestOrgProjectAutoConversion).mockClear();
      await splitTemporaryWorkspaceHandler(
        {},
        {
          workspaceId: 'test-workspace',
          worktreeId: 'test-worktree',
          selections: {},
        },
      );
      expect(requestOrgProjectAutoConversion).toHaveBeenCalledTimes(
        success ? 1 : 0,
      );
    },
  );
});

it.each([
  'workspace:create-temporary-from-repos',
  'workspace:create-temporary-worktree-from-repos',
  'workspace:create-temporary-worktree-from-workspaces',
  'workspace:combine-worktree-with-workspace',
  'workspace:combine-worktree-with-existing-worktree',
  'workspace:split-temporary',
])('does not request conversion when %s rejects', async (channel) => {
  jest.mocked(requestOrgProjectAutoConversion).mockClear();
  await expect(requireRegisteredHandler(channel)({}, {})).rejects.toThrow();
  expect(requestOrgProjectAutoConversion).not.toHaveBeenCalled();
});

describe('CAN-3846 reply binding', () => {
  it.each([
    ['workspace:combine-worktree-with-workspace', false],
    ['workspace:combine-worktree-with-existing-worktree', true],
  ])(
    'awaits binding before discovery/setup and the %s reply',
    async (channel, existing) => {
      const original = existing
        ? await mockedCombineWorktreeWithExistingWorktree({
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'worktree',
            joinWorkspaceId: 'join',
            joinWorktreeId: 'joined',
            mode: 'temporary',
          })
        : await mockedCombineWorktreeWithWorkspace({
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'worktree',
            joinWorkspaceId: 'join',
            mode: 'temporary',
          });
      const refreshed = {
        ...original,
        filePathRewrites: [],
        compatibilitySymlinks: [],
        repoMappings: [
          {
            destinationRepoId: 'added',
            repoName: 'Added',
            repoPath: '/repos/added',
            newWorktreePath: '/combined/added',
          },
        ],
        destinationWorkspace: {
          ...original.destinationWorkspace,
          collapsed: false,
          repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
          temporary: true,
          owner: {
            type: 'organization' as const,
            organizationId: 'org',
            projectId: 'project',
            instanceId: 'instance',
            bindingGeneration: 1,
          },
        },
      };
      let release: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      jest.mocked(bindCombinationAfterJoin).mockImplementationOnce(async () => {
        entered();
        await blocked;
        return refreshed;
      });
      let replied = false;
      const reply = requireRegisteredHandler(String(channel))(
        {},
        {
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          joinWorktreeId: 'joined',
          mode: 'temporary',
        },
      ).then((value) => {
        replied = true;
        return value;
      });
      // Race against the actual reply: the old handler replies without entering binding.
      await Promise.race([started, reply]);
      expect(replied).toBe(false);
      expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
      expect(
        mockedStartWorkspaceWorktreePostCreateSetup,
      ).not.toHaveBeenCalled();
      expect(requestOrgProjectAutoConversion).not.toHaveBeenCalled();
      release();
      await expect(reply).resolves.toEqual(refreshed);
      expect(bindCombinationAfterJoin).toHaveBeenCalledWith(
        original,
        'temporary',
      );
      expect(requestOrgProjectAutoConversion).toHaveBeenCalledTimes(1);
      if (existing) expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
      else {
        expect(
          mockedStartWorkspaceWorktreePostCreateSetup,
        ).toHaveBeenCalledTimes(1);
        expect(
          mockedStartWorkspaceWorktreePostCreateSetup.mock.calls[0]?.[0],
        ).toMatchObject({
          workspaceId: refreshed.destinationWorkspaceId,
          worktreeId: refreshed.destinationWorktreeId,
          repos: refreshed.destinationWorkspace.repos,
        });
      }
    },
  );
});

describe('Combine binding failures preserve join semantics', () => {
  it.each([
    ['workspace:combine-worktree-with-workspace', false],
    ['workspace:combine-worktree-with-existing-worktree', true],
  ])(
    'does not bind or start post-join effects when %s fails',
    async (channel, existing) => {
      const failure = new Error('join failed');
      if (existing)
        mockedCombineWorktreeWithExistingWorktree.mockRejectedValueOnce(
          failure,
        );
      else mockedCombineWorktreeWithWorkspace.mockRejectedValueOnce(failure);
      await expect(
        requireRegisteredHandler(String(channel))(
          {},
          {
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'worktree',
            joinWorkspaceId: 'join',
            joinWorktreeId: 'joined',
            mode: 'temporary',
          },
        ),
      ).rejects.toThrow(failure);
      expect(bindCombinationAfterJoin).not.toHaveBeenCalled();
      expect(
        mockedStartWorkspaceWorktreePostCreateSetup,
      ).not.toHaveBeenCalled();
      expect(mockedTriggerDiscovery).not.toHaveBeenCalled();
      expect(requestOrgProjectAutoConversion).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['workspace:combine-worktree-with-workspace', false],
    ['workspace:combine-worktree-with-existing-worktree', true],
  ])(
    'retains a committed join and scan when binding is refused for %s',
    async (channel, existing) => {
      // The helper absorbs conversion/reporting failures and returns persisted state or its input.
      bindCombinationAfterJoin.mockImplementationOnce((response) =>
        Promise.resolve(response),
      );
      const reply = await requireRegisteredHandler(String(channel))(
        {},
        {
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'worktree',
          joinWorkspaceId: 'join',
          joinWorktreeId: 'joined',
          mode: 'temporary',
        },
      );
      expect(bindCombinationAfterJoin).toHaveBeenCalledTimes(1);
      expect(reply).toEqual(bindCombinationAfterJoin.mock.calls[0]?.[0]);
      expect(requestOrgProjectAutoConversion).toHaveBeenCalledTimes(1);
      expect(recordWorkspaceCrudTelemetry).toHaveBeenCalledTimes(1);
      if (existing) expect(mockedTriggerDiscovery).toHaveBeenCalledTimes(1);
    },
  );
});

describe('GitHub folder-link clone boundaries', () => {
  it.each([false, true])(
    'normalizes workspace IPC execution and jobs (tracked=%s)',
    async (tracked) => {
      const remoteUrl = ' https://github.com/cursor/plugins/tree/main/pstack ';
      const result = await addFromRemoteHandler(
        {},
        {
          remoteUrl,
          destinationDir: '/repos',
          ...(tracked ? { jobId: 'folder-clone-job' } : {}),
        },
      );
      expect(result).toMatchObject({
        name: 'plugins',
        repoPath: '/repos/plugins',
      });
      if (tracked) {
        expect(cloneRepoWithLiveProgress).toHaveBeenCalledWith(
          'https://github.com/cursor/plugins',
          '/repos/plugins',
          expect.any(Object),
        );
        expect(getCloneJobs().list()).toEqual([]);
      } else {
        expect(mockedCloneRepo).toHaveBeenCalledWith(
          'https://github.com/cursor/plugins',
          '/repos/plugins',
        );
      }
    },
  );

  it('keeps the normalized execution URL in a background job', async () => {
    jest.mocked(cloneRepoWithLiveProgress).mockImplementationOnce(() => {
      expect(getCloneJobs().list()[0]).toMatchObject({
        id: 'folder-background-job',
        repoName: 'plugins',
        remoteUrl: 'https://github.com/cursor/plugins',
      });
      expect(getCloneJobs().background('folder-background-job')).toBe(true);
      return Promise.resolve();
    });
    try {
      await addFromRemoteHandler(
        {},
        {
          remoteUrl: 'https://github.com/cursor/plugins/tree/main/pstack',
          destinationDir: '/repos',
          jobId: 'folder-background-job',
        },
      );
      expect(getCloneJobs().list()[0]).toMatchObject({
        status: 'succeeded',
        background: true,
        workspaceName: 'plugins',
      });
    } finally {
      getCloneJobs().dismiss('folder-background-job');
    }
  });

  const credentialStderr =
    "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
  const rejectClone = (tracked: boolean, message: string): void => {
    if (tracked)
      jest
        .mocked(cloneRepoWithLiveProgress)
        .mockRejectedValueOnce(new Error(message));
    else mockedCloneRepo.mockRejectedValueOnce(new Error(message));
  };
  const addFromRemote = (
    remoteUrl: string,
    tracked: boolean,
  ): Promise<unknown> =>
    Promise.resolve(
      addFromRemoteHandler(
        {},
        {
          remoteUrl,
          destinationDir: '/repos',
          ...(tracked ? { jobId: 'auth-clone-job' } : {}),
        },
      ),
    );
  afterEach(() => {
    getCloneJobs().dismiss('auth-clone-job');
  });

  it.each([false, true])(
    'types an HTTPS github.com credential failure (tracked=%s)',
    async (tracked) => {
      rejectClone(tracked, credentialStderr);
      const error: unknown = await addFromRemote(
        'https://github.com/acme/app.git',
        tracked,
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        name: 'GitHubAuthFailureError',
        message: credentialStderr,
      });
    },
  );

  it('keeps the plain clone error on a background job snapshot', async () => {
    jest.mocked(cloneRepoWithLiveProgress).mockImplementationOnce(() => {
      getCloneJobs().background('auth-clone-job');
      return Promise.reject(new Error(credentialStderr));
    });
    await expect(
      addFromRemote('https://github.com/acme/app.git', true),
    ).rejects.toMatchObject({ name: 'GitHubAuthFailureError' });
    expect(getCloneJobs().list()[0]).toMatchObject({
      id: 'auth-clone-job',
      status: 'failed',
      error:
        'Failed to clone the repository. Check the URL and access, then try again.',
    });
  });

  it.each([
    [false, 'git@github.com:acme/app.git', credentialStderr],
    [true, 'git@github.com:acme/app.git', credentialStderr],
    [false, 'https://github.com/acme/app.git', 'Repository not found'],
    [true, 'https://github.com/acme/app.git', 'Repository not found'],
  ])(
    'keeps other clone failures plain (tracked=%s, %s, %s)',
    async (tracked, remoteUrl, message) => {
      rejectClone(tracked, message);
      const error: unknown = await addFromRemote(remoteUrl, tracked).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name: 'Error', message });
    },
  );

  it.each([false, true])(
    'normalizes direct workspace service callers (progress=%s)',
    async (progress) => {
      await addWorkspaceFromRemote(
        'https://github.com/cursor/plugins/blob/other/pstack/README.md',
        '/repos',
        progress
          ? {
              signal: new AbortController().signal,
              onDestination: jest.fn(),
              onProgress: jest.fn(),
              onCloned: jest.fn(),
            }
          : undefined,
      );
      if (progress) {
        expect(cloneRepoWithLiveProgress).toHaveBeenCalledWith(
          'https://github.com/cursor/plugins',
          '/repos/plugins',
          expect.any(Object),
        );
      } else {
        expect(mockedCloneRepo).toHaveBeenCalledWith(
          'https://github.com/cursor/plugins',
          '/repos/plugins',
        );
      }
    },
  );
});
