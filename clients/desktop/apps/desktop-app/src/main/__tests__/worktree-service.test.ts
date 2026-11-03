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
  destructiveStep: jest.fn(
    (_phase: string, work: () => Promise<unknown>): Promise<unknown> => work(),
  ),
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

jest.mock('@canopy/desktop-instrumentation/electron/main', () => ({
  captureDesktopInstrumentationError: jest.fn(),
}));
import { captureDesktopInstrumentationError } from '@canopy/desktop-instrumentation/electron/main';

jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerArchived: jest.fn(),
}));
import { notifyLedgerContainerArchived } from '../ledger/lifecycle';

jest.mock('../lib/archived-container-recovery', () => ({
  readArchivedContainerRecovery: jest.fn(() => Promise.resolve(null)),
  prepareArchivedContainerRecovery: jest.fn(() =>
    Promise.reject(new Error('recovery unavailable')),
  ),
  finishArchivedContainerRecovery: jest.fn(() => Promise.resolve([])),
}));
import { performance } from 'node:perf_hooks';
import { listUnmanagedWorktreeRepositories } from '../lib/unmanaged-worktree-repository';

jest.mock('../lib/animals', () => ({
  generateUniqueAnimalName: jest.fn((existingNames: Set<string>) =>
    existingNames.has('generated-worktree')
      ? 'generated-worktree-2'
      : 'generated-worktree',
  ),
}));

jest.mock('../lib/workspace-service', () => ({
  listWorkspaceItems: jest.fn(),
}));

jest.mock('../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
}));

const recordUsageMetricEventMock = jest.fn();
const recordSessionDiagnosticMock = jest.fn();
const runArchiveIoRequestMock = jest.fn<
  Promise<unknown>,
  [ArchiveIoOperationRequest]
>();
const eagerSeedNewWorktreeCodeGraphMock = jest.fn(() =>
  Promise.resolve({ status: 'no-compatible-source' }),
);
const releaseCodeGraphRefreshDeferralMock = jest.fn();
const deferCodeGraphRefreshUntilPostCreateSetupMock = jest.fn(
  () => releaseCodeGraphRefreshDeferralMock,
);

jest.mock('../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    get recordUsageMetricEvent(): typeof recordUsageMetricEventMock {
      return recordUsageMetricEventMock;
    },
    get recordSessionDiagnostic(): typeof recordSessionDiagnosticMock {
      return recordSessionDiagnosticMock;
    },
  })),
}));

jest.mock('../lib/code-graph-eager-seed', () => ({
  get eagerSeedNewWorktreeCodeGraph(): typeof eagerSeedNewWorktreeCodeGraphMock {
    return eagerSeedNewWorktreeCodeGraphMock;
  },
}));

jest.mock('../lib/code-graph-scheduler', () => ({
  get deferCodeGraphRefreshUntilPostCreateSetup(): typeof deferCodeGraphRefreshUntilPostCreateSetupMock {
    return deferCodeGraphRefreshUntilPostCreateSetupMock;
  },
}));

jest.mock('../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (request: ArchiveIoOperationRequest): Promise<unknown> =>
    runArchiveIoRequestMock(request),
}));

jest.mock('../lib/git-executable', () => ({
  getResolvedGitExecutableForSpawn: jest.fn(() => Promise.resolve('git')),
}));

jest.mock('node:fs/promises', () => ({
  lstat: jest.fn(),
  mkdir: jest.fn(() => Promise.resolve()),
  readdir: jest.fn(() => Promise.resolve([])),
  readlink: jest.fn(),
  rm: jest.fn(() => Promise.resolve()),
}));

jest.mock('../lib/paths', () => ({
  getWorktreeDataDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/data/worktree-data/${workspaceId}/${worktreeId}`,
  ),
  getWorktreeDataRootDir: jest.fn(
    (workspaceId: string) => `/data/worktree-data/${workspaceId}`,
  ),
  getArchivedContainerExecutionsDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/archives/${workspaceId}/${worktreeId}/pipeline-executions`,
  ),
  getWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/worktrees/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceDir: jest.fn(
    (workspaceId: string) => `/workspaces/${workspaceId}`,
  ),
  getWorkspaceWorktreeDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/workspace-worktrees/${workspaceId}/${worktreeId}`,
  ),
  getWorkspaceWorktreeRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string, repoId: string) =>
      `/workspace-worktrees/${workspaceId}/${worktreeId}/repos/${repoId}`,
  ),
  getWorkspaceWorktreeRootRepoDir: jest.fn(
    (workspaceId: string, worktreeId: string) =>
      `/workspace-worktrees/${workspaceId}/${worktreeId}/root`,
  ),
  getWorkspaceWorktreesRootDir: jest.fn(
    (workspaceId: string) => `/workspace-worktrees/${workspaceId}`,
  ),
  getArchivedContainersRootDir: jest.fn(
    (workspaceId: string) => `/archives/${workspaceId}`,
  ),
}));

jest.mock('../lib/git', () => {
  const removeWorktree = jest.fn<Promise<void>, [string, string]>();
  return {
    bestEffortPruneWorktrees: jest.fn(),
    cleanupPersistedTurnDiffTreeRefs: jest.fn(),
    createWorktree: jest.fn(),
    createWorktreeForExistingBranch: jest.fn(),
    createWorktreeFromStartPoint: jest.fn(),
    deleteBranch: jest.fn(),
    deleteBranchIfMatches: jest.fn(),
    forceDeleteBranch: jest.fn(),
    doesLocalBranchExist: jest.fn(),
    doesRemoteBranchExist: jest.fn(),
    fetchOrigin: jest.fn(),
    listCheckedOutBranches: jest.fn(),
    getCanopyJsonHash: jest.fn(),
    getCurrentBranch: jest.fn(),
    getCurrentBranchDisplayName: jest.fn(),
    getDiffStats: jest.fn(),
    getGitCommonDir: jest.fn(),
    getRemoteUrl: jest.fn(),
    getRepoRootFromWorktree: jest.fn(),
    hasBranchBeenPushedToRemote: jest.fn(),
    hasCommitsAhead: jest.fn(),
    hasLocalCommit: jest.fn(),
    hasRemoteTrackingBranch: jest.fn(),
    hasUncommittedChanges: jest.fn(),
    hasUnpushedCommits: jest.fn(),
    hasUnpulledCommits: jest.fn(),
    isBranchNameAvailable: jest.fn(),
    isAncestor: jest.fn(),
    isRegisteredWorktreePath: jest.fn(),
    pruneWorktrees: jest.fn(),
    removeWindowsWorktreeReparsePoints: jest.fn(() => Promise.resolve()),
    removeWorktree,
    resolveRefSha: jest.fn(),
    resolveSharedAvailableBranchName: jest.fn(),
    validateBranchName: jest.fn(),
    WORKTREE_GIT_TIMEOUT_MS: 30_000,
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

jest.mock('../lib/worktree-base-branches', () => ({
  resolveEffectiveBaseBranchForRepo: jest.fn(),
  resolveEffectiveBaseBranchesForWorktree: jest.fn(),
  resolveRepoDefaultBranch: jest.fn().mockResolvedValue(null),
}));

jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));

jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));

jest.mock('../lib/workspace-persistence', () => ({
  markWorkspaceWorktreeRecentlyRemoved: jest.fn(),
  removeWorkspaceWorktrees: jest.fn(),
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
  readWorkspaceWorktreesDetailed: jest.fn(),
  updateWorkspaceWorktree: jest.fn(),
  updateWorkspaceWorktrees: jest.fn(),
}));

jest.mock('../lib/sidebar-items', () => ({
  readAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
  writeAllSidebarItems: jest.fn(() =>
    Promise.resolve({ version: 1, items: [] }),
  ),
  readWorkspaceIndexEntry: jest.fn(),
}));

jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: jest.fn(),
}));

jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn(),
}));

jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn(),
}));

jest.mock('../lib/script-resolver', () => ({
  resolveProjectScripts: jest.fn(),
  resolveWorkspaceRepoScripts: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootScripts: jest.fn(() => Promise.resolve({})),
  toScriptOverrides: jest.fn(),
}));

jest.mock('../lib/hook-resolver', () => ({
  resolveProjectHooks: jest.fn(),
  resolveWorkspaceRepoHooks: jest.fn(() => Promise.resolve({})),
  resolveWorkspaceRootHooks: jest.fn(() => Promise.resolve({})),
  toHookOverrides: jest.fn(),
}));

jest.mock('../lib/worktree-repo-entries', () => ({
  listWorkspaceWorktreeRepoEntries: jest.fn(),
}));

jest.mock('../lib/worktree-health', () => ({
  validateWorktreeHealth: jest.fn(),
}));

jest.mock('../lib/worktree-repair', () => ({
  recordWorktreeHealth: jest.fn(),
}));

jest.mock('../lib/workspace-source-control', () => ({
  repairWorkspaceRootWorktree: jest.fn(),
  validateWorkspaceRootWorktree: jest.fn(),
}));

jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(),
}));

const runWithScopeDeletionLifecycleMock = jest.fn(
  async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> =>
    operation(),
);
const commitWorktreeQueueDeletionMock = jest.fn();
const rollbackWorktreeQueueDeletionMock = jest.fn();
const beginWorktreeQueueDeletionMock = jest.fn(() => ({
  get commit(): typeof commitWorktreeQueueDeletionMock {
    return commitWorktreeQueueDeletionMock;
  },
  get rollback(): typeof rollbackWorktreeQueueDeletionMock {
    return rollbackWorktreeQueueDeletionMock;
  },
}));

jest.mock('../services/chat-state-service', () => ({
  getChatStateService: (): unknown => ({
    get runWithScopeDeletionLifecycle(): typeof runWithScopeDeletionLifecycleMock {
      return runWithScopeDeletionLifecycleMock;
    },
  }),
}));

jest.mock('../services/chat-queue-service', () => ({
  getChatQueueService: (): unknown => ({
    get beginWorktreeDeletion(): typeof beginWorktreeQueueDeletionMock {
      return beginWorktreeQueueDeletionMock;
    },
  }),
}));

jest.mock('../lib/archived-container-retention', () => ({
  createArchivedContainerTiming: jest.fn(() => ({
    archivedAt: '2026-07-22T00:00:00.000Z',
    expiresAt: '2026-07-29T00:00:00.000Z',
  })),
  resolveContainerRetentionDays: jest.fn(() => Promise.resolve(7)),
}));

jest.mock('../lib/archived-container-provider-state', () => ({
  captureArchivedContainerProviderState: jest.fn(() => Promise.resolve([])),
}));

const releaseLocalScopeFenceMock = jest.fn(() => Promise.resolve());
const commitLocalScopeCancellationMock = jest.fn();
const cancelLocalScopeMock = jest.fn(() => Promise.resolve());
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: (): unknown => ({
    get cancelLocalScope(): typeof cancelLocalScopeMock {
      return cancelLocalScopeMock;
    },
    get releaseLocalScopeFence(): typeof releaseLocalScopeFenceMock {
      return releaseLocalScopeFenceMock;
    },
    get commitLocalScopeCancellation(): typeof commitLocalScopeCancellationMock {
      return commitLocalScopeCancellationMock;
    },
  }),
}));

jest.mock('../lib/archived-containers', () => ({
  assertArchivedContainerSourceGeneration: jest.fn(() => Promise.resolve()),
  beginArchivedContainerCapture: jest.fn(() =>
    Promise.resolve({
      chats: { version: 1, tabs: [], activeTabId: '' },
      chatArchives: { version: 1, archived: [] },
    }),
  ),
  broadcastArchivedContainersChanged: jest.fn(),
  commitArchivedContainer: jest.fn(() => Promise.resolve()),
  countArchivedContainerExecutions: jest.fn(() => Promise.resolve(0)),
  countArchivedContainers: jest.fn(() => Promise.resolve(0)),
  readArchivedContainerManifest: jest.fn(() =>
    Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
  ),
  readArchivedContainerManifestIncludingExpired: jest.fn(() =>
    Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' })),
  ),
  withArchivedWorkspaceOperationLock: jest.fn(
    (_workspaceId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));

jest.mock('../lib/unmanaged-worktree-repository', () => ({
  listUnmanagedWorktreeRepositories: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../lib/archived-container-git', () => ({
  readArchivedGitStagedDescriptor: jest.fn(() => Promise.resolve(null)),
  captureArchivedContainerGitState: jest.fn(() =>
    Promise.resolve({
      gitState: {
        version: 1,
        diffFormatVersion: 1,
        repositories: [
          {
            repoId: '__single_repo__',
            repoName: 'project-1',
            relativePath: '.',
            referenceRepoPath: '/repos/project-1',
            branchName: 'feature/retained',
            comparisonBaseCommit: '1111111111111111111111111111111111111111',
            headCommit: '2222222222222222222222222222222222222222',
            indexSnapshotCommit: '3333333333333333333333333333333333333333',
            worktreeSnapshotCommit: '4444444444444444444444444444444444444444',
            snapshotRef:
              'refs/app/archived-containers/project-1/wt-1/__single_repo__',
          },
        ],
      },
      gitChanges: {
        status: 'complete',
        capturedAt: '2026-07-22T00:00:00.000Z',
        fileCount: 0,
        insertions: 0,
        deletions: 0,
        repositories: [
          {
            repoId: '__single_repo__',
            repoName: 'project-1',
            fileCount: 0,
            insertions: 0,
            deletions: 0,
          },
        ],
      },
      pullRequestMetadata: {
        capturedAt: '2026-07-22T00:00:01.000Z',
        repositories: [
          {
            repoId: '__single_repo__',
            repoName: 'project-1',
            status: 'complete',
            pullRequest: null,
          },
        ],
      },
    }),
  ),
  discardIncompleteArchivedGitCapture: jest.fn(() => Promise.resolve(true)),
  isMissingWorktreeIncompleteArchivedGitCaptureError: jest.fn(
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'An incomplete archived Git capture requires recovery.',
  ),
  isArchivedGitCaptureRecoveryRequiredError: jest.fn(
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'An incomplete archived Git capture requires recovery.',
  ),
  completeArchivedContainerGitCapture: jest.fn(() => Promise.resolve()),
  prepareArchivedContainerTeardown: jest.fn(() =>
    Promise.resolve({
      canonicalPath: '/worktrees/project-1/wt-1',
      quarantinePath: '/worktrees/project-1/wt-1',
      alreadyRemoved: false,
      targets: [
        {
          repoId: '__single_repo__',
          referenceRepoPath: '/repos/project-1',
          quarantineRepoPath: '/worktrees/project-1/wt-1',
          branchName: 'feature/retained',
        },
      ],
    }),
  ),
}));

const mockWorktreeContainerArchived = jest.fn();
jest.mock('../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    get worktreeContainerArchived(): typeof mockWorktreeContainerArchived {
      return mockWorktreeContainerArchived;
    },
  })),
}));

jest.mock('../lib/macos-worktree-directory-cleanup', () => ({
  queueOrphanedMacosWorktreeDirectory: jest.fn(() => Promise.resolve()),
  removeExactMacosWorktreeDirectory: jest.fn(() => Promise.resolve()),
  removeStagedMacosWorktreeDirectory: jest.fn(() => Promise.resolve()),
  restoreStagedMacosWorktreeDirectory: jest.fn(() => Promise.resolve()),
  stageExactMacosWorktreeDirectoryForRemoval: jest.fn(() =>
    Promise.resolve('/worktrees/project-1/.wt-1.deleting-test'),
  ),
}));

jest.mock('../pipelines/worktree-cleanup', () => ({
  cleanupWorktreePipelines: jest.fn(),
}));

jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));

jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));

const initializePanelLayoutModeMock = jest.fn(() =>
  Promise.resolve<'minimal' | 'advanced'>('minimal'),
);
jest.mock('../panels/layout-mode-persistence', () => ({
  panelLayoutModePersistenceStore: {
    get initialize(): typeof initializePanelLayoutModeMock {
      return initializePanelLayoutModeMock;
    },
  },
}));

const schedulePortalStructuralSyncMock = jest.fn();
jest.mock('../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: (): void => {
    schedulePortalStructuralSyncMock();
  },
}));

jest.mock('../lib/main-process-logging', () => ({
  logMainProcessWarn: jest.fn(),
}));

jest.mock('@canopy/desktop-shared/node/pipelines/cli-runtime', () => ({
  createCliExecutionRuntime: jest.fn(() => ({
    executionsDir: '/cli/executions',
    tempRootDir: '/cli/temp',
    bundledActionsDir: '/cli/actions',
    getProjectActionsDir: jest.fn((repoPath: string) => repoPath),
    getProjectPipelinesDir: jest.fn((repoPath: string) => repoPath),
  })),
}));

jest.mock(
  '@canopy/desktop-shared/node/pipelines/executor/execution-state',
  () => ({
    listExecutionSummaries: jest.fn(),
  }),
);

import { WorktreeRegistryUnreadableError } from '../lib/worktree-list-repository';
import {
  W5AuthorityUnreachableError,
  W5RecordUnservedError,
} from '../lib/w5-file-store';
import type { Dirent } from 'node:fs';
import { lstat, readdir, readlink, rm } from 'node:fs/promises';
import type {
  MultiRepoSidebarItem,
  PreferencesData,
  SidebarItem,
  SingleRepoSidebarItem,
  UsageMetricEvent,
  WorktreeData,
  WorktreeGitFailedEvent,
} from '@canopy/desktop-shared/types';
import { WORKSPACE_ROOT_REPO_ID } from '@canopy/desktop-shared/types';
import type { WorktreeHealthIssue } from '@canopy/desktop-shared/types';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';
import {
  bestEffortPruneWorktrees,
  cleanupPersistedTurnDiffTreeRefs,
  createWorktree,
  createWorktreeForExistingBranch,
  createWorktreeFromStartPoint,
  deleteBranch,
  deleteBranchIfMatches,
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  forceDeleteBranch,
  getCanopyJsonHash,
  getCurrentBranch,
  getCurrentBranchDisplayName,
  getDiffStats,
  getGitCommonDir,
  getRemoteUrl,
  hasBranchBeenPushedToRemote,
  hasCommitsAhead,
  hasLocalCommit,
  hasRemoteTrackingBranch,
  hasUncommittedChanges,
  hasUnpushedCommits,
  hasUnpulledCommits,
  isBranchNameAvailable,
  isAncestor,
  isRegisteredWorktreePath,
  listCheckedOutBranches,
  pruneWorktrees,
  removeWindowsWorktreeReparsePoints,
  removeWorktree,
  resolveRefSha,
  resolveSharedAvailableBranchName,
  validateBranchName,
  WORKTREE_GIT_TIMEOUT_MS,
  withWorktreeRemovalLock,
} from '../lib/git';
import { listWorkspaceItems } from '../lib/workspace-service';
import { WorktreeCreationRefusedError } from '../lib/worktree-creation-selection';
import {
  resolveEffectiveBaseBranchForRepo,
  resolveEffectiveBaseBranchesForWorktree,
  resolveRepoDefaultBranch,
} from '../lib/worktree-base-branches';
import {
  aggregateMultiRepoDiffStats,
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  buildUsageRepoScopes,
  captureWorktreeDeletionUsageSnapshot,
  createSingleRepoWorktree,
  createMultiRepoWorktree,
  getWorktreeDiffStatsOnly,
  getWorktreeStats,
  invalidateWorktreeStats,
  getWorktreeCliRecord,
  listWorktreeCliRows,
  listWorktreePipelineExecutions,
  warningRequiresDestructiveCleanup,
} from '../lib/worktree-service';
import type { WorktreeArchiveLiveServices } from '../lib/worktree-service';
import {
  beginWorktreeGitSetup,
  claimWorktreeGitSetup,
  settleWorktreeGitSetup,
} from '../lib/worktree-git-setup';
import { createCliExecutionRuntime } from '@canopy/desktop-shared/node/pipelines/cli-runtime';
import { listExecutionSummaries } from '@canopy/desktop-shared/node/pipelines/executor/execution-state';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  removeWorkspaceWorktrees,
  updateWorkspaceWorktree,
  updateWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import {
  consumeWorktreeSetupCancellation,
  isWorktreeSetupCancellationRequested,
  markWorktreeSetupCancellation,
} from '../lib/worktree-setup-cancellation';
import { resolveProjectReferenceRepoPath } from '../lib/project-reference-repo';
import { resolveWorkspaceReferenceRepoPath } from '../lib/workspace-reference-repo';
import { validateWorkspaceRootWorktree } from '../lib/workspace-source-control';
import { validateWorktreeHealth } from '../lib/worktree-health';
import { recordWorktreeHealth } from '../lib/worktree-repair';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import { cleanupWorktreePipelines } from '../pipelines/worktree-cleanup';
import { generateUniqueAnimalName } from '../lib/animals';
import {
  readAllSidebarItems,
  readWorkspaceIndexEntry,
  writeAllSidebarItems,
} from '../lib/sidebar-items';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import { readPreferencesFile } from '../lib/preferences-store';
import { listWorkspaceWorktreeRepoEntries } from '../lib/worktree-repo-entries';
import { resolveContainerRetentionDays } from '../lib/archived-container-retention';
import { captureArchivedContainerProviderState } from '../lib/archived-container-provider-state';
import {
  assertArchivedContainerSourceGeneration,
  beginArchivedContainerCapture,
  commitArchivedContainer,
  countArchivedContainerExecutions,
  countArchivedContainers,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { isWorkspaceTargetRemovalPending } from '../lib/workspace-target-exclusion';
import {
  BROWSER_RETIREMENT_DEADLINE_MS,
  withBrowserRetirementDeadline,
} from '../lib/browser-retirement-deadline';
import {
  commitTaskBrowserRetirement,
  prepareTaskBrowserRetirement,
  retireRemovedBrowserTask,
  settleFailedTaskBrowserRetirement,
} from '../browser/browser-profile-lifecycle';
import {
  prepareArchivedContainerRecovery,
  readArchivedContainerRecovery,
} from '../lib/archived-container-recovery';
import { KeyedAsyncLock } from '../lib/keyed-async-lock';
import { currentLocalFenceHolder } from '../app-advisor/local-fence-holder';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import {
  captureArchivedContainerGitState,
  completeArchivedContainerGitCapture,
  discardIncompleteArchivedGitCapture,
  prepareArchivedContainerTeardown,
  readArchivedGitStagedDescriptor,
  type ArchivedGitStagedDescriptor,
} from '../lib/archived-container-git';
import {
  queueOrphanedMacosWorktreeDirectory,
  removeExactMacosWorktreeDirectory,
  removeStagedMacosWorktreeDirectory,
  restoreStagedMacosWorktreeDirectory,
  stageExactMacosWorktreeDirectoryForRemoval,
} from '../lib/macos-worktree-directory-cleanup';
import { logMainProcessWarn } from '../lib/main-process-logging';

const logMainProcessWarnMock = jest.mocked(logMainProcessWarn);

const mockedLstat = jest.mocked(lstat);
const mockedReaddir = jest.mocked(readdir);
const mockedReadlink = jest.mocked(readlink);
const mockedRm = jest.mocked(rm);
const mockedGenerateUniqueAnimalName = jest.mocked(generateUniqueAnimalName);
const mockedCreateWorktree = jest.mocked(createWorktree);
const mockedCreateWorktreeForExistingBranch = jest.mocked(
  createWorktreeForExistingBranch,
);
const mockedCreateWorktreeFromStartPoint = jest.mocked(
  createWorktreeFromStartPoint,
);
const mockedDoesLocalBranchExist = jest.mocked(doesLocalBranchExist);
const mockedDoesRemoteBranchExist = jest.mocked(doesRemoteBranchExist);
const mockedListCheckedOutBranches = jest.mocked(listCheckedOutBranches);
const mockedDeleteBranch = jest.mocked(deleteBranch);
const mockedDeleteBranchIfMatches = jest.mocked(deleteBranchIfMatches);
const mockedForceDeleteBranch = jest.mocked(forceDeleteBranch);
const mockedBestEffortPruneWorktrees = jest.mocked(bestEffortPruneWorktrees);
const mockedRemoveWindowsWorktreeReparsePoints = jest.mocked(
  removeWindowsWorktreeReparsePoints,
);
const mockedRemoveWorktree = jest.mocked(removeWorktree);
const mockedResolveRefSha = jest.mocked(resolveRefSha);
const mockedWithWorktreeRemovalLock = jest.mocked(withWorktreeRemovalLock);
const mockedPruneWorktrees = jest.mocked(pruneWorktrees);
const mockedListWorkspaceItems = jest.mocked(listWorkspaceItems);
const mockedReadWorkspaceIndexEntry = jest.mocked(readWorkspaceIndexEntry);
const mockedReadEffectiveWorkspaceConfig = jest.mocked(
  readEffectiveWorkspaceConfig,
);
const mockedGetDiffStats = jest.mocked(getDiffStats);
const mockedGetGitCommonDir = jest.mocked(getGitCommonDir);
const mockedGetCurrentBranch = jest.mocked(getCurrentBranch);
const mockedGetCurrentBranchDisplayName = jest.mocked(
  getCurrentBranchDisplayName,
);
const mockedGetRemoteUrl = jest.mocked(getRemoteUrl);
const mockedFetchOrigin = jest.mocked(fetchOrigin);

/** Asserts `repoPath` got the bounded, non-interactive pre-create fetch. */
function expectBoundedOriginFetch(repoPath: string): void {
  const options = mockedFetchOrigin.mock.calls.find(
    ([calledPath]) => calledPath === repoPath,
  )?.[1];
  expect(options).toMatchObject({
    nonInteractive: true,
    timeoutMs: WORKTREE_GIT_TIMEOUT_MS,
  });
  expect(options?.signal).toBeInstanceOf(AbortSignal);
}
const mockedHasCommitsAhead = jest.mocked(hasCommitsAhead);
const mockedHasLocalCommit = jest.mocked(hasLocalCommit);
const mockedHasUncommittedChanges = jest.mocked(hasUncommittedChanges);
const mockedHasRemoteTrackingBranch = jest.mocked(hasRemoteTrackingBranch);
const mockedHasUnpushedCommits = jest.mocked(hasUnpushedCommits);
const mockedHasUnpulledCommits = jest.mocked(hasUnpulledCommits);
const mockedHasBranchBeenPushedToRemote = jest.mocked(
  hasBranchBeenPushedToRemote,
);
const mockedIsBranchNameAvailable = jest.mocked(isBranchNameAvailable);
const mockedIsAncestor = jest.mocked(isAncestor);
const mockedIsRegisteredWorktreePath = jest.mocked(isRegisteredWorktreePath);
const mockedValidateBranchName = jest.mocked(validateBranchName);
const mockedResolveSharedAvailableBranchName = jest.mocked(
  resolveSharedAvailableBranchName,
);
const mockedGetCanopyJsonHash = jest.mocked(getCanopyJsonHash);
const mockedResolveEffectiveBaseBranchForRepo = jest.mocked(
  resolveEffectiveBaseBranchForRepo,
);
const mockedResolveEffectiveBaseBranchesForWorktree = jest.mocked(
  resolveEffectiveBaseBranchesForWorktree,
);
const mockedResolveRepoDefaultBranch = jest.mocked(resolveRepoDefaultBranch);
const mockedCreateCliExecutionRuntime = jest.mocked(createCliExecutionRuntime);
const mockedListExecutionSummaries = jest.mocked(listExecutionSummaries);
const mockedReadWorkspaceConfig = jest.mocked(readWorkspaceConfig);
const mockedReadWorkspaceWorktrees = jest.mocked(readWorkspaceWorktrees);
const mockedRemoveWorkspaceWorktrees = jest.mocked(removeWorkspaceWorktrees);
const mockedResolveProjectReferenceRepoPath = jest.mocked(
  resolveProjectReferenceRepoPath,
);
const mockedResolveWorkspaceReferenceRepoPath = jest.mocked(
  resolveWorkspaceReferenceRepoPath,
);

function setPlatform(platform: NodeJS.Platform): () => void {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(
    process,
    'platform',
  );
  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: platform,
  });

  return (): void => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  };
}
const mockedUpdateWorkspaceWorktree = jest.mocked(updateWorkspaceWorktree);
const mockedUpdateWorkspaceWorktrees = jest.mocked(updateWorkspaceWorktrees);
const mockedValidateWorktreeHealth = jest.mocked(validateWorktreeHealth);
const mockedValidateWorkspaceRootWorktree = jest.mocked(
  validateWorkspaceRootWorktree,
);
const mockedRecordWorktreeHealth = jest.mocked(recordWorktreeHealth);
const mockedCleanupPersistedWorktreeData = jest.mocked(
  cleanupPersistedWorktreeData,
);
const mockedCleanupWorktreePipelines = jest.mocked(cleanupWorktreePipelines);
const mockedReadAllSidebarItems = jest.mocked(readAllSidebarItems);
const mockedWriteAllSidebarItems = jest.mocked(writeAllSidebarItems);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedListWorkspaceWorktreeRepoEntries = jest.mocked(
  listWorkspaceWorktreeRepoEntries,
);
const mockedResolveContainerRetentionDays = jest.mocked(
  resolveContainerRetentionDays,
);
const mockedCaptureArchivedContainerProviderState = jest.mocked(
  captureArchivedContainerProviderState,
);
const mockedPrepareArchivedContainerRecovery = jest.mocked(
  prepareArchivedContainerRecovery,
);
const mockedReadArchivedContainerRecovery = jest.mocked(
  readArchivedContainerRecovery,
);
const mockedBeginArchivedContainerCapture = jest.mocked(
  beginArchivedContainerCapture,
);
const mockedAssertArchivedContainerSourceGeneration = jest.mocked(
  assertArchivedContainerSourceGeneration,
);
const mockedCommitArchivedContainer = jest.mocked(commitArchivedContainer);
const mockedNotifyLedgerContainerArchived = jest.mocked(
  notifyLedgerContainerArchived,
);
const mockedCountArchivedContainerExecutions = jest.mocked(
  countArchivedContainerExecutions,
);
const mockedCountArchivedContainers = jest.mocked(countArchivedContainers);
const mockedCaptureArchivedContainerGitState = jest.mocked(
  captureArchivedContainerGitState,
);
const mockedReadArchivedGitStagedDescriptor = jest.mocked(
  readArchivedGitStagedDescriptor,
);
const mockedCompleteArchivedContainerGitCapture = jest.mocked(
  completeArchivedContainerGitCapture,
);
const mockedDiscardIncompleteArchivedGitCapture = jest.mocked(
  discardIncompleteArchivedGitCapture,
);
const mockedPrepareArchivedContainerTeardown = jest.mocked(
  prepareArchivedContainerTeardown,
);
const mockedQueueOrphanedMacosWorktreeDirectory = jest.mocked(
  queueOrphanedMacosWorktreeDirectory,
);
const mockedRemoveExactMacosWorktreeDirectory = jest.mocked(
  removeExactMacosWorktreeDirectory,
);
const mockedRemoveStagedMacosWorktreeDirectory = jest.mocked(
  removeStagedMacosWorktreeDirectory,
);
const mockedRestoreStagedMacosWorktreeDirectory = jest.mocked(
  restoreStagedMacosWorktreeDirectory,
);
const mockedStageExactMacosWorktreeDirectoryForRemoval = jest.mocked(
  stageExactMacosWorktreeDirectoryForRemoval,
);
function pathMatchesRmCall(
  actualPath: Parameters<typeof rm>[0],
  expectedPath: string | RegExp,
): boolean {
  if (typeof expectedPath === 'string') {
    return actualPath === expectedPath;
  }

  return typeof actualPath === 'string' && expectedPath.test(actualPath);
}

function isRobustWorktreeRemoveOptions(
  options: Parameters<typeof rm>[1] | undefined,
): boolean {
  return (
    options?.recursive === true &&
    options?.force === true &&
    typeof options.maxRetries === 'number' &&
    typeof options.retryDelay === 'number'
  );
}

function expectRobustWorktreeRemoveCall(expectedPath: string | RegExp): void {
  const matchedCall = mockedRm.mock.calls.find(([actualPath, options]) => {
    return (
      pathMatchesRmCall(actualPath, expectedPath) &&
      isRobustWorktreeRemoveOptions(options)
    );
  });
  expect(matchedCall).toBeDefined();
}

function expectNoRobustWorktreeRemoveCall(expectedPath: string | RegExp): void {
  const matchedCall = mockedRm.mock.calls.find(([actualPath, options]) => {
    return (
      pathMatchesRmCall(actualPath, expectedPath) &&
      isRobustWorktreeRemoveOptions(options)
    );
  });
  expect(matchedCall).toBeUndefined();
}

function recordedUsageEvents(): UsageMetricEvent[] {
  return recordUsageMetricEventMock.mock.calls.map(
    ([event]: [UsageMetricEvent]) => event,
  );
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolveDeferred: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });

  if (!resolveDeferred) {
    throw new Error('Expected deferred resolver to be assigned');
  }

  return { promise, resolve: resolveDeferred };
}

function makeLstatResult(
  isSymbolicLink: boolean,
): Awaited<ReturnType<typeof lstat>> {
  return {
    isSymbolicLink: () => isSymbolicLink,
  } as Awaited<ReturnType<typeof lstat>>;
}

function buildWorkspace(): SingleRepoSidebarItem {
  return {
    type: 'single-repo',
    id: 'project-1',
    name: 'Project One',
    repoPath: '/repos/project-1',
    color: '#abcdef',
    worktrees: [
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
        branchPromptSent: true,
        trackedBaseBranch: 'main',
        seenPipelineExecutionIds: ['exec-seen'],
        lastKnownPrStatus: {
          lastCheckedAt: '2026-04-20T01:00:00.000Z',
          repos: [
            {
              repoId: 'project-1',
              repoName: 'Project One',
              status: {
                prNumber: 12,
                prUrl: 'https://example.com/pr/12',
                state: 'open',
                title: 'Feature',
                checkStatus: 'passing',
                checkDetails: [],
                reviewStatus: 'approved',
                reviewers: [],
                hasConflicts: false,
                commentCount: 0,
                updatedAt: '2026-04-20T00:30:00.000Z',
              },
            },
          ],
        },
        pausedHookKeys: ['pre-commit'],
      },
    ],
    collapsed: false,
    order: 0,
  };
}

function buildMultiRepoWorkspace(): {
  type: 'multi-repo';
  id: string;
  name: string;
  color: string;
  sourceRepoPath: string;
  repos: Array<{ id: string; name: string; repoPath: string }>;
  worktrees: [];
  collapsed: false;
  order: number;
} {
  return {
    type: 'multi-repo',
    id: 'workspace-1',
    name: 'Workspace One',
    color: '#fedcba',
    sourceRepoPath: '/repos/source',
    repos: [
      {
        id: 'repo-a',
        name: 'Repo A',
        repoPath: '/repos/repo-a',
      },
      {
        id: 'repo-b',
        name: 'Repo B',
        repoPath: '/repos/repo-b',
      },
    ],
    worktrees: [],
    collapsed: false,
    order: 0,
  };
}

function buildMultiRepoArchiveCapture(branches: {
  root: string;
  repoA: string;
  repoB: string;
}): Awaited<ReturnType<typeof captureArchivedContainerGitState>> {
  const repositories = [
    {
      repoId: WORKSPACE_ROOT_REPO_ID,
      repoName: 'Workspace root',
      relativePath: '.',
      referenceRepoPath: '/refs/source',
      branchName: branches.root,
    },
    {
      repoId: 'repo-a',
      repoName: 'Repo A',
      relativePath: 'repos/repo-a',
      referenceRepoPath: '/repos/repo-a',
      branchName: branches.repoA,
    },
    {
      repoId: 'repo-b',
      repoName: 'Repo B',
      relativePath: 'repos/repo-b',
      referenceRepoPath: '/repos/repo-b',
      branchName: branches.repoB,
    },
  ].map((repository) => ({
    ...repository,
    comparisonBaseCommit: '1111111111111111111111111111111111111111',
    headCommit: '2222222222222222222222222222222222222222',
    indexSnapshotCommit: '3333333333333333333333333333333333333333',
    worktreeSnapshotCommit: '4444444444444444444444444444444444444444',
    snapshotRef: `refs/app/archived-containers/workspace-1/wt-1/${repository.repoId}`,
  }));
  return {
    gitState: {
      version: 1,
      diffFormatVersion: 1,
      repositories,
    },
    gitChanges: {
      status: 'complete',
      capturedAt: '2026-07-22T00:00:00.000Z',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: repositories.map((repository) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        fileCount: 0,
        insertions: 0,
        deletions: 0,
      })),
    },
    pullRequestMetadata: {
      capturedAt: '2026-07-22T00:00:01.000Z',
      repositories: repositories.map((repository) => ({
        repoId: repository.repoId,
        repoName: repository.repoName,
        status: 'complete' as const,
        pullRequest: null,
      })),
    },
  };
}

function buildTemporaryMultiRepoWorkspace(): MultiRepoSidebarItem {
  return {
    ...buildMultiRepoWorkspace(),
    sourceRepoPath: undefined,
    temporary: true,
  };
}

function directoryEntry(name: string): Dirent {
  return {
    name,
    parentPath: '',
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isDirectory: () => true,
    isFIFO: () => false,
    isFile: () => false,
    isSocket: () => false,
    isSymbolicLink: () => false,
  };
}

// The test fixtures model readdir's default string encoding, not its buffer overload.
const mockedStringReaddir = mockedReaddir as unknown as jest.MockedFunction<
  (path: Parameters<typeof readdir>[0]) => Promise<Dirent[] | string[]>
>;

function mockReaddirImplementation(
  implementation: (
    path: Parameters<typeof readdir>[0],
  ) => Promise<Dirent[] | string[]>,
): void {
  mockedStringReaddir.mockImplementation(implementation);
}

function makePartialPreferences(
  overrides: Partial<PreferencesData>,
): PreferencesData {
  // A partial fixture: these tests rely on unset preferences staying undefined.
  const preferences: Partial<PreferencesData> = { ...overrides };
  return preferences as PreferencesData;
}

function mockNoContainerRetentionDays(): void {
  const legacyNoRetention = { days: 0 };
  // Preserve the legacy null result these tests use to exercise no-retention behavior.
  Reflect.set(legacyNoRetention, 'days', null);
  mockedResolveContainerRetentionDays.mockImplementation(() =>
    Promise.resolve(legacyNoRetention.days),
  );
}

describe('worktree-service', () => {
  it.each([
    [
      'Local branches were preserved because their deletion could not be safely verified.',
      false,
    ],
    ['Failed to remove persisted turn diff tree refs for this worktree.', true],
  ])(
    'classifies archive warning %s as cleanupRequired=%s',
    (warning, expected) => {
      expect(warningRequiresDestructiveCleanup(warning)).toBe(expected);
    },
  );

  beforeEach(() => {
    runArchiveIoRequestMock.mockImplementation(
      async (request: ArchiveIoOperationRequest) => {
        if (request.type === 'remove-worktree') {
          await mockedRemoveWorktree(
            request.input.referenceRepoPath,
            request.input.worktreePath,
          );
          return { removed: true };
        }
        if (request.type === 'remove-directory') {
          await mockedRemoveWindowsWorktreeReparsePoints(request.input.path);
          await mockedRm(request.input.path, { recursive: true, force: true });
          return { removed: true };
        }
        if (request.type === 'delete-branches') {
          let deleted = 0;
          for (const branch of request.input.branches) {
            if (
              branch.mode === 'merged-only' &&
              !(await mockedIsAncestor(
                branch.referenceRepoPath,
                branch.expectedTip,
                'HEAD',
              ))
            ) {
              continue;
            }
            await mockedDeleteBranchIfMatches(
              branch.referenceRepoPath,
              branch.branchName,
              branch.expectedTip,
            );
            deleted += 1;
          }
          return { deleted };
        }
        throw new Error(`Unexpected archive request: ${request.type}`);
      },
    );
    jest.clearAllMocks();
    jest
      .mocked(listUnmanagedWorktreeRepositories)
      .mockReset()
      .mockResolvedValue([]);
    invalidateWorktreeStats('project-1', 'wt-1');
    mockedReaddir.mockResolvedValue([]);
    mockedGetGitCommonDir.mockImplementation((repoPath) =>
      Promise.resolve(`${repoPath}/.git`),
    );
    mockedIsAncestor.mockResolvedValue(true);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({
        deleteBranchOnArchive: false,
        workspaceDefaultLayoutMode: 'minimal',
      }),
    );
    initializePanelLayoutModeMock.mockResolvedValue('minimal');
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedCaptureArchivedContainerProviderState.mockResolvedValue([]);
    mockedPrepareArchivedContainerRecovery
      .mockReset()
      .mockRejectedValue(new Error('recovery unavailable'));
    mockedReadArchivedContainerRecovery.mockReset().mockResolvedValue(null);
    mockedBeginArchivedContainerCapture.mockResolvedValue({
      projectId: 'project-1',
      containerId: 'wt-1',
      directory: '/archives/project-1/wt-1',
      chats: { version: 1, tabs: [], activeTabId: '' },
      chatArchives: { version: 1, archived: [] },
      chatFilePresent: false,
      chatArchivesFilePresent: false,
    });
    mockedCommitArchivedContainer.mockResolvedValue(undefined);
    mockedCountArchivedContainerExecutions.mockResolvedValue(0);
    mockedCountArchivedContainers.mockResolvedValue(0);
    // `getWorkspaceById` is deliberately shadow-free: it reads the index
    // entry, effective config, and persisted worktrees directly instead of
    // the full sidebar read. Derive all three from the same
    // `mockedListWorkspaceItems` fixture each test already sets, so
    // `mockResolvedValue([buildMultiRepoWorkspace()])` keeps feeding every
    // entry point.
    const findFixtureWorkspace = async (
      workspaceId: string,
    ): Promise<SidebarItem | undefined> => {
      const items =
        (await mockedListWorkspaceItems({ includeEmptyTemporary: true })) ?? [];
      return items.find((candidate) => candidate.id === workspaceId);
    };
    mockedReadWorkspaceIndexEntry.mockImplementation(async (workspaceId) => {
      const item = await findFixtureWorkspace(workspaceId);
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
    mockedReadEffectiveWorkspaceConfig.mockImplementation(
      async (workspaceId) => {
        const item = await findFixtureWorkspace(workspaceId);
        if (!item || item.type === 'cowork') {
          throw new Error(
            `Fixture project ${workspaceId} is not a code project`,
          );
        }
        const shared = {
          manifest: null,
          scripts: undefined,
          defaultPluginSelections: undefined,
          suppressedManifestRepos: [],
          unresolvedManifestRepoIds: [],
          ...(item.alwaysShow !== undefined
            ? { alwaysShow: item.alwaysShow }
            : {}),
        };
        if (item.type === 'single-repo') {
          return {
            ...shared,
            sourceRepoPath: undefined,
            repos: [],
            localConfig: {
              version: 1,
              type: 'single-repo',
              repoPath: item.repoPath,
              repos: [],
            },
          };
        }
        return {
          ...shared,
          ...(item.temporary !== undefined
            ? { temporary: item.temporary }
            : {}),
          sourceRepoPath: item.sourceRepoPath,
          repos: item.repos,
          localConfig: {
            version: 1,
            type: 'multi-repo',
            repos: item.repos,
            sourceRepoPath: item.sourceRepoPath,
          },
        };
      },
    );
    mockedReadWorkspaceWorktrees.mockImplementation(async (workspaceId) => {
      const item = await findFixtureWorkspace(workspaceId);
      return item && item.type !== 'cowork' ? item.worktrees : [];
    });
    jest
      .mocked(readWorkspaceWorktreesDetailed)
      .mockImplementation(async (workspaceId) => ({
        authority: 'ok',
        worktrees: await mockedReadWorkspaceWorktrees(workspaceId),
      }));
    mockedGenerateUniqueAnimalName.mockImplementation(
      (existingNames: Set<string>) =>
        existingNames.has('generated-worktree')
          ? 'generated-worktree-2'
          : 'generated-worktree',
    );
    mockedLstat.mockImplementation((path) => {
      if (String(path).includes('generated-worktree'))
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      return Promise.resolve(makeLstatResult(false));
    });
    mockedReadlink.mockResolvedValue('');
    mockedRm.mockResolvedValue(undefined);
    mockedCreateWorktree.mockResolvedValue('feature/wt-1');
    mockedBestEffortPruneWorktrees.mockImplementation(() => {});
    mockedRemoveWindowsWorktreeReparsePoints.mockResolvedValue(undefined);
    mockedRemoveWorktree.mockResolvedValue(undefined);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/wt-1');
    mockedResolveSharedAvailableBranchName.mockResolvedValue(
      'generated-worktree',
    );
    mockedPruneWorktrees.mockResolvedValue(undefined);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({
        deleteBranchOnArchive: false,
        workspaceDefaultLayoutMode: 'minimal',
      }),
    );
    mockedCleanupPersistedWorktreeData.mockResolvedValue([]);
    mockedQueueOrphanedMacosWorktreeDirectory.mockResolvedValue(undefined);
    mockedRemoveExactMacosWorktreeDirectory.mockResolvedValue(undefined);
    mockedRemoveStagedMacosWorktreeDirectory.mockResolvedValue(undefined);
    mockedRestoreStagedMacosWorktreeDirectory.mockResolvedValue(undefined);
    mockedStageExactMacosWorktreeDirectoryForRemoval.mockResolvedValue(
      '/worktrees/project-1/.wt-1.deleting-00000000-0000-4000-8000-000000000000',
    );
    mockedCleanupWorktreePipelines.mockResolvedValue({
      warnings: [],
      relocatedCount: 0,
      failedRelocationIds: [],
    });
    mockedListWorkspaceItems.mockResolvedValue([buildWorkspace()]);
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: true,
    });
    mockedResolveEffectiveBaseBranchesForWorktree.mockResolvedValue({});
    mockedGetDiffStats.mockResolvedValue({ insertions: 4, deletions: 2 });
    mockedGetCurrentBranch.mockResolvedValue('feature/wt-1');
    mockedResolveRefSha.mockResolvedValue(
      '1111111111111111111111111111111111111111',
    );
    mockedGetCurrentBranchDisplayName.mockResolvedValue('feature/wt-1');
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedGetRemoteUrl.mockResolvedValue('git@github.com:org/project-1.git');
    mockedHasCommitsAhead.mockResolvedValue(true);
    mockedHasUncommittedChanges.mockResolvedValue(false);
    mockedHasRemoteTrackingBranch.mockResolvedValue(true);
    mockedHasUnpushedCommits.mockResolvedValue(false);
    mockedHasUnpulledCommits.mockResolvedValue(false);
    mockedHasBranchBeenPushedToRemote.mockResolvedValue(true);
    mockedIsBranchNameAvailable.mockResolvedValue(true);
    mockedIsRegisteredWorktreePath.mockImplementation((_repoPath, path) =>
      Promise.resolve(!path.includes('generated-worktree')),
    );
    mockedValidateBranchName.mockResolvedValue(true);
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedDoesRemoteBranchExist.mockResolvedValue(true);
    mockedListCheckedOutBranches.mockResolvedValue(new Map());
    mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/wt-1');
    mockedGetCanopyJsonHash.mockResolvedValue('canopy-hash');
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/project-1',
      repos: [],
    });
    mockedRemoveWorkspaceWorktrees.mockResolvedValue([]);
    mockedReadAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedWriteAllSidebarItems.mockResolvedValue({ version: 1, items: [] });
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([]);
    mockedResolveProjectReferenceRepoPath.mockResolvedValue('/repos/project-1');
    mockedResolveWorkspaceReferenceRepoPath.mockResolvedValue('/refs/source');
    mockedUpdateWorkspaceWorktree.mockResolvedValue(true);
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => updater([]),
    );
    mockedValidateWorktreeHealth.mockResolvedValue(null);
    mockedValidateWorkspaceRootWorktree.mockResolvedValue([]);
    mockedRecordWorktreeHealth.mockImplementation(({ worktreeId, issue }) =>
      Promise.resolve({
        status: 'recorded',
        worktree: {
          id: worktreeId,
          branchName: 'feature/wt-1',
          createdAt: '2026-04-20T00:00:00.000Z',
          ...(issue ? { healthIssue: issue } : {}),
        },
      }),
    );
  });

  it('records a single-repo worktree_created event after setup becomes git-ready', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
    });

    expect(created.id).toBe('generated-worktree');
    expect(recordedUsageEvents()).toEqual([
      expect.objectContaining({
        type: 'worktree_created',
        workspaceId: 'project-1',
        worktreeId: created.id,
        repos: [
          expect.objectContaining({
            repoId: '__single_repo__',
            repoLabel: 'project-1',
          }),
        ],
      }),
    ]);
    expect(initializePanelLayoutModeMock).toHaveBeenCalledWith(
      'project-1',
      created.id,
      'minimal',
    );
  });

  it('persists a new worktree at the top of the manual order', async () => {
    const existing: WorktreeData = {
      id: 'existing-worktree',
      branchName: 'feature/existing',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    let persistedWorktrees: WorktreeData[] = [existing];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [existing.id],
    });

    expect(persistedWorktrees.map((worktree) => worktree.id)).toEqual([
      created.id,
      existing.id,
    ]);
  });

  it.each(['committed', 'unreadable', 'partial'] as const)(
    'retains reservation metadata after a failed write with %s registry authority',
    async (outcome) => {
      let persisted: WorktreeData[] = [];
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          persisted = await updater(persisted);
          throw new Error('post-commit group reconciliation failed');
        },
      );
      jest.mocked(readWorkspaceWorktreesDetailed).mockImplementation(() =>
        Promise.resolve({
          authority: outcome === 'committed' ? 'ok' : outcome,
          // A partial read leaves out rows it cannot read, such as this one.
          worktrees: outcome === 'committed' ? persisted : [],
        }),
      );
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'project-1',
          existingWorktreeIds: [],
        }),
      ).rejects.toThrow('post-commit group reconciliation failed');
      expect(persisted.map((item) => item.id)).toEqual(['generated-worktree']);
      expect(mockedRm).not.toHaveBeenCalledWith(
        '/data/worktree-data/project-1/generated-worktree',
        { recursive: true, force: true },
      );
    },
  );

  it('cleans reservation metadata when an authoritative read confirms no committed row', async () => {
    mockedUpdateWorkspaceWorktrees.mockRejectedValueOnce(
      new Error('registry write failed'),
    );
    jest
      .mocked(readWorkspaceWorktreesDetailed)
      .mockResolvedValueOnce({ authority: 'absent', worktrees: [] });
    await expect(
      createSingleRepoWorktree({
        workspaceId: 'project-1',
        existingWorktreeIds: [],
      }),
    ).rejects.toThrow('registry write failed');
    expect(mockedRm).toHaveBeenCalledWith(
      '/data/worktree-data/project-1/generated-worktree',
      { recursive: true, force: true },
    );
  });

  it('keeps a created single-repo worktree usable when mode seeding fails', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    initializePanelLayoutModeMock.mockRejectedValueOnce(
      new Error('seed failed'),
    );

    await expect(
      createSingleRepoWorktree({
        workspaceId: 'project-1',
        existingWorktreeIds: [],
      }),
    ).resolves.toMatchObject({ id: 'generated-worktree' });
    expect(logMainProcessWarnMock).toHaveBeenCalledWith(
      'Failed to seed worktree panel layout mode',
      expect.objectContaining({
        workspaceId: 'project-1',
        worktreeId: 'generated-worktree',
        error: 'seed failed',
      }),
    );
  });

  it('keeps retained archived-container ids reserved for new worktrees', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockReaddirImplementation(
      (path): Promise<Dirent[] | string[]> =>
        Promise.resolve(
          String(path) === '/archives/project-1'
            ? [directoryEntry('generated-worktree')]
            : [],
        ),
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
    });

    expect(created.id).toBe('generated-worktree-2');
  });

  it('skips a generated single-repo worktree id when the matching branch name is unavailable', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedIsBranchNameAvailable.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(!/^generated-worktree-\d+$/.test(branchName)),
    );
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
    });

    expect(created.id).toBe('generated-worktree-2');
    expect(created.branchName).toMatch(/^generated-worktree-2-\d+$/);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree-2',
      created.branchName,
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/data/worktree-data/project-1/generated-worktree',
      { recursive: true, force: true },
    );
  });

  it('names a single-repo default branch after the generated worktree id when asked', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    // Only the bare id is checked, so the first id's branch being taken
    // skips to the next id rather than adding a timestamp.
    mockedIsBranchNameAvailable.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(branchName !== 'generated-worktree'),
    );
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      defaultBranchNaming: 'worktree-id',
    });

    expect(created.id).toBe('generated-worktree-2');
    expect(created.branchName).toBe('generated-worktree-2');
    expect(
      mockedIsBranchNameAvailable.mock.calls.map(([, name]) => name),
    ).toEqual(['generated-worktree', 'generated-worktree-2']);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree-2',
      'generated-worktree-2',
    );
    expect(persistedWorktrees[0]).toMatchObject({
      id: 'generated-worktree-2',
      branchName: 'generated-worktree-2',
    });
  });

  it('keeps the timestamped single-repo default branch when no naming is requested', async () => {
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
    });

    expect(created.id).toBe('generated-worktree');
    expect(created.branchName).toMatch(/^generated-worktree-\d{13}$/);
    expect(mockedIsBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/project-1',
      created.branchName,
    );
  });

  it('records a multi-repo worktree_created event with child and root repo scopes', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    const [event] = recordedUsageEvents();
    expect(event).toMatchObject({
      type: 'worktree_created',
      workspaceId: 'workspace-1',
      worktreeId: created.id,
    });
    expect(event?.type === 'worktree_created' ? event.repos : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: WORKSPACE_ROOT_REPO_ID }),
        expect.objectContaining({ repoId: 'repo-a', repoLabel: 'Repo A' }),
        expect.objectContaining({ repoId: 'repo-b', repoLabel: 'Repo B' }),
      ]),
    );
    expect(initializePanelLayoutModeMock).toHaveBeenCalledWith(
      'workspace-1',
      created.id,
      'minimal',
    );
  });

  it('creates a single-repo restore from a local base without fetching and tracks it', async () => {
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/restored');

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/restored',
      baseBranch: 'main',
      allowBaseBranchNetwork: false,
    });

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/restored',
      'main',
    );
    expect(created.trackedBaseBranch).toBe('main');
  });

  it('uses an existing local base branch without fetching by default', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/local-base');

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/local-base',
      baseBranch: 'main',
    });

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/local-base',
      'main',
    );
    expect(created.trackedBaseBranch).toBe('main');
  });

  it('starts from the commit of a tag or other commit-ish base, as git worktree add did', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedResolveRefSha.mockResolvedValue(
      '2222222222222222222222222222222222222222',
    );
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/from-tag');

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/from-tag',
      baseBranch: 'v1.2.0',
    });

    expect(mockedResolveRefSha).toHaveBeenCalledWith(
      '/repos/project-1',
      'v1.2.0^{commit}',
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/from-tag',
      '2222222222222222222222222222222222222222',
    );
    expect(created.trackedBaseBranch).toBe('v1.2.0');
  });

  it('still refuses a base that names no branch, tag or commit', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedResolveRefSha.mockRejectedValue(new Error('unknown revision'));

    await expect(
      createSingleRepoWorktree({
        workspaceId: 'project-1',
        branchName: 'feature/missing-base',
        baseBranch: 'no-such-ref',
      }),
    ).rejects.toThrow('Base branch "no-such-ref" was not found');
    expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
  });

  it('refuses a missing base or a detached base task with a typed refusal', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);
    mockedResolveRefSha.mockRejectedValue(new Error('unknown revision'));
    const missing = createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/missing-base',
      baseBranch: 'no-such-ref',
    });
    await expect(missing).rejects.toBeInstanceOf(WorktreeCreationRefusedError);
    await expect(missing).rejects.toMatchObject({ reason: 'base-not-found' });

    mockedGetCurrentBranch.mockResolvedValue('HEAD');
    const detached = createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/detached-base',
      baseWorktreeId: 'base',
    });
    await expect(detached).rejects.toBeInstanceOf(WorktreeCreationRefusedError);
    await expect(detached).rejects.toMatchObject({
      reason: 'base-task-detached',
      message: 'Cannot determine a branch name for worktree "base"',
    });
    expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
  });

  it('never passes a dash-prefixed base to git as a revision', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedDoesRemoteBranchExist.mockResolvedValue(false);

    await expect(
      createSingleRepoWorktree({
        workspaceId: 'project-1',
        branchName: 'feature/dash-base',
        baseBranch: '--all',
      }),
    ).rejects.toThrow('Base branch "--all" was not found');
    expect(mockedResolveRefSha).not.toHaveBeenCalledWith(
      '/repos/project-1',
      expect.stringContaining('--all'),
    );
  });

  it('fetches an explicit remote base even when a same-named local branch exists', async () => {
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedDoesRemoteBranchExist.mockResolvedValue(true);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/remote-base');

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/remote-base',
      baseBranch: 'origin/main',
    });

    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/project-1');
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/remote-base',
      'origin/main',
    );
    expect(created.trackedBaseBranch).toBe('main');
  });

  it('creates a worktree from an exact locally available commit', async () => {
    const commitSha = '4'.repeat(40);
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedHasLocalCommit.mockResolvedValue(true);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/exact-base');

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/exact-base',
      baseBranch: commitSha,
      allowBaseBranchNetwork: false,
    });

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/exact-base',
      commitSha,
    );
    expect(created.trackedBaseBranch).toBe(commitSha);
  });

  it('uses a 40-hex local branch when no same-named commit exists', async () => {
    const branchName = 'f'.repeat(40);
    mockedHasLocalCommit.mockResolvedValue(false);
    mockedDoesLocalBranchExist.mockResolvedValue(true);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue(
      'feature/hex-branch-base',
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      branchName: 'feature/hex-branch-base',
      baseBranch: branchName,
      allowBaseBranchNetwork: false,
    });

    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/generated-worktree',
      'feature/hex-branch-base',
      branchName,
    );
    expect(created.trackedBaseBranch).toBe(branchName);
  });

  it('creates a multi-repo restore from each valid local base and falls back per missing entry', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('feature/restored');
    mockedCreateWorktree.mockResolvedValue('feature/restored');

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      branchName: 'feature/restored',
      baseBranchesByRepo: {
        [WORKSPACE_ROOT_REPO_ID]: 'main',
        'repo-a': 'develop',
      },
      allowBaseBranchNetwork: false,
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/refs/source',
      '/workspace-worktrees/workspace-1/generated-worktree/root',
      'feature/restored',
      'main',
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-a',
      'feature/restored',
      'develop',
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-b',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-b',
      'feature/restored',
    );
    expect(created.trackedRepoBaseBranches).toEqual({
      [WORKSPACE_ROOT_REPO_ID]: 'main',
      'repo-a': 'develop',
    });
  });

  it('creates a workspace-root-only worktree without child repositories', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      includedRepoIds: [],
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(mockedCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/refs/source',
      '/workspace-worktrees/workspace-1/generated-worktree/root',
      expect.stringMatching(/^generated-worktree-/),
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalledWith(
      expect.stringMatching(/^\/repos\//),
      expect.anything(),
      expect.anything(),
    );
    expect(persistedWorktrees[0]).toMatchObject({ includedRepoIds: [] });
  });

  it('skips a generated multi-repo worktree id when any matching repo branch name is unavailable', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedIsBranchNameAvailable.mockImplementation((_repoPath, branchName) =>
      Promise.resolve(!/^generated-worktree-\d+$/.test(branchName)),
    );
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(created.id).toBe('generated-worktree-2');
    expect(created.branchName).toMatch(/^generated-worktree-2-\d+$/);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/refs/source',
      '/workspace-worktrees/workspace-1/generated-worktree-2/root',
      created.branchName,
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace-worktrees/workspace-1/generated-worktree-2/repos/repo-a',
      created.branchName,
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-b',
      '/workspace-worktrees/workspace-1/generated-worktree-2/repos/repo-b',
      created.branchName,
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/data/worktree-data/workspace-1/generated-worktree',
      { recursive: true, force: true },
    );
  });

  it('names a multi-repo default branch after the generated worktree id when asked', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedIsBranchNameAvailable.mockImplementation((repoPath, branchName) =>
      Promise.resolve(
        !(repoPath === '/repos/repo-b' && branchName === 'generated-worktree'),
      ),
    );
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      defaultBranchNaming: 'worktree-id',
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(created.id).toBe('generated-worktree-2');
    expect(created.branchName).toBe('generated-worktree-2');
    expect(
      new Set(mockedIsBranchNameAvailable.mock.calls.map(([, name]) => name)),
    ).toEqual(new Set(['generated-worktree', 'generated-worktree-2']));
    for (const [repoPath, worktreePath] of [
      [
        '/refs/source',
        '/workspace-worktrees/workspace-1/generated-worktree-2/root',
      ],
      [
        '/repos/repo-a',
        '/workspace-worktrees/workspace-1/generated-worktree-2/repos/repo-a',
      ],
      [
        '/repos/repo-b',
        '/workspace-worktrees/workspace-1/generated-worktree-2/repos/repo-b',
      ],
    ]) {
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        repoPath,
        worktreePath,
        'generated-worktree-2',
      );
    }
    expect(persistedWorktrees[0]).toMatchObject({
      id: 'generated-worktree-2',
      branchName: 'generated-worktree-2',
    });
  });

  it('keeps the timestamped multi-repo default branch when no naming is requested', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedCreateWorktree.mockImplementation(
      (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(created.id).toBe('generated-worktree');
    expect(created.branchName).toMatch(/^generated-worktree-\d{13}$/);
    expect(mockedIsBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/repo-a',
      created.branchName,
    );
  });

  it('builds source-backed usage repo scopes with project root and child repos', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);

    await expect(
      buildUsageRepoScopes('workspace-1', 'wt-1', {
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: '/repos/source',
        repos: buildMultiRepoWorkspace().repos,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoLabel: 'Project root',
      }),
      expect.objectContaining({ repoId: 'repo-a', repoLabel: 'Repo A' }),
      expect.objectContaining({ repoId: 'repo-b', repoLabel: 'Repo B' }),
    ]);
  });

  it('captures single-repo deletion snapshots and degrades missing repo stats to zero changes', async () => {
    mockedGetDiffStats.mockRejectedValue(new Error('missing repo'));
    mockedHasUncommittedChanges.mockRejectedValue(new Error('missing repo'));
    mockedHasCommitsAhead.mockRejectedValue(new Error('missing repo'));

    await expect(
      captureWorktreeDeletionUsageSnapshot('project-1', 'wt-1', {
        version: 1,
        type: 'single-repo',
        repoPath: '/repos/project-1',
        repos: [],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        repoId: '__single_repo__',
        hadChanges: false,
        insertions: 0,
        deletions: 0,
        hasUncommittedChanges: false,
        hasCommitsAhead: false,
      }),
    ]);
  });

  it('captures multi-repo deletion snapshots and marks changed repos', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedGetDiffStats
      .mockResolvedValueOnce({ insertions: 0, deletions: 0 })
      .mockResolvedValueOnce({ insertions: 5, deletions: 1 })
      .mockResolvedValueOnce({ insertions: 0, deletions: 0 });
    mockedHasUncommittedChanges
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false);
    mockedHasCommitsAhead
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const snapshot = await captureWorktreeDeletionUsageSnapshot(
      'workspace-1',
      'wt-1',
      {
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: '/repos/source',
        repos: buildMultiRepoWorkspace().repos,
      },
    );

    expect(snapshot).toEqual([
      expect.objectContaining({
        repoId: WORKSPACE_ROOT_REPO_ID,
        hadChanges: false,
      }),
      expect.objectContaining({
        repoId: 'repo-a',
        hadChanges: true,
        insertions: 5,
        deletions: 1,
      }),
      expect.objectContaining({
        repoId: 'repo-b',
        hadChanges: true,
        hasCommitsAhead: true,
      }),
    ]);
  });

  it('records worktree_deleted after a single-repo archive succeeds', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
      },
    ]);
    mockedCleanupPersistedWorktreeData.mockImplementationOnce(() => {
      expect(recordedUsageEvents()).toEqual([]);
      return Promise.resolve([]);
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(recordedUsageEvents()).toEqual([
      expect.objectContaining({
        type: 'worktree_deleted',
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        deletedWithChanges: true,
        repos: [
          expect.objectContaining({
            repoId: '__single_repo__',
            hadChanges: true,
          }),
        ],
      }),
    ]);
    expect(mockedRemoveWorktree).toHaveBeenCalled();
  });

  it('forgets a failed Git setup outcome once its worktree is archived', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-failed-setup',
        branchName: 'feature/wt-failed-setup',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    beginWorktreeGitSetup('project-1', 'wt-failed-setup')('failed');

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-failed-setup',
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(
      claimWorktreeGitSetup('project-1', 'wt-failed-setup'),
    ).toBeUndefined();
  });

  it('keeps a timed-out archive teardown retryable through its verified quarantine', async () => {
    const restorePlatform = setPlatform('darwin');
    const originalTeardown =
      mockedPrepareArchivedContainerTeardown.getMockImplementation();
    const originalStagedDescriptor =
      mockedReadArchivedGitStagedDescriptor.getMockImplementation();
    const originalDiscard =
      mockedDiscardIncompleteArchivedGitCapture.getMockImplementation();
    const timeout = Object.assign(new Error('Archive Git command timed out.'), {
      code: 'ETIMEDOUT',
      killed: true,
    });
    const runNormally = runArchiveIoRequestMock.getMockImplementation();
    let remainingTimeouts = 2;
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedPrepareArchivedContainerTeardown.mockResolvedValue({
      canonicalPath: '/worktrees/project-1/wt-1',
      quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
      alreadyRemoved: false,
      targets: [
        {
          repoId: '__single_repo__',
          referenceRepoPath: '/repos/project-1',
          preMoveRepoPath: '/worktrees/project-1/wt-1',
          quarantineRepoPath: '/worktrees/project-1/.wt-1.archive-quarantine',
          branchName: 'feature/retained',
        },
      ],
    });
    runArchiveIoRequestMock.mockImplementation(
      async (request: ArchiveIoOperationRequest) => {
        if (request.type === 'remove-worktree' && remainingTimeouts-- > 0) {
          throw timeout;
        }
        return runNormally?.(request);
      },
    );
    mockedStageExactMacosWorktreeDirectoryForRemoval.mockRejectedValue(
      new Error('Invalid repoId'),
    );

    try {
      const request = {
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteWithoutRetentionIfMissing: true,
      } as const;
      await expect(archiveSingleRepoWorktree(request)).rejects.toBe(timeout);
      expect(
        runArchiveIoRequestMock.mock.calls.filter(
          ([operation]) => operation.type === 'remove-worktree',
        ),
      ).toHaveLength(1);
      expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledTimes(1);
      expect(
        mockedStageExactMacosWorktreeDirectoryForRemoval,
      ).not.toHaveBeenCalled();
      expect(mockedPruneWorktrees).not.toHaveBeenCalled();
      expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
      expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();

      remainingTimeouts = 0;
      mockedLstat.mockImplementation((path) =>
        String(path) === '/worktrees/project-1/wt-1'
          ? Promise.reject(
              Object.assign(new Error('missing'), { code: 'ENOENT' }),
            )
          : Promise.resolve(makeLstatResult(false)),
      );
      mockedReadArchivedGitStagedDescriptor.mockResolvedValue({
        version: 1,
        status: 'ready',
        teardown: {
          phase: 'verified',
          canonicalPath: '/worktrees/project-1/wt-1',
          quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
        },
      } as unknown as ArchivedGitStagedDescriptor);
      mockedDiscardIncompleteArchivedGitCapture.mockResolvedValue(false);
      await expect(archiveSingleRepoWorktree(request)).resolves.toEqual({
        success: true,
        warnings: [],
      });
      expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledTimes(2);
      expect(mockedCommitArchivedContainer).toHaveBeenCalledTimes(1);
    } finally {
      if (originalTeardown) {
        mockedPrepareArchivedContainerTeardown.mockImplementation(
          originalTeardown,
        );
      }
      if (originalStagedDescriptor) {
        mockedReadArchivedGitStagedDescriptor.mockImplementation(
          originalStagedDescriptor,
        );
      }
      if (originalDiscard) {
        mockedDiscardIncompleteArchivedGitCapture.mockImplementation(
          originalDiscard,
        );
      }
      restorePlatform();
    }
  });

  it('rejects a missing-checkout retry when its archive journal fails validation', async () => {
    const invalidJournal = new Error(
      'Archived Git recovery paths failed integrity validation.',
    );
    mockedLstat.mockImplementation((path) =>
      String(path) === '/worktrees/project-1/wt-1'
        ? Promise.reject(
            Object.assign(new Error('missing'), { code: 'ENOENT' }),
          )
        : Promise.resolve(makeLstatResult(false)),
    );
    mockedReadArchivedGitStagedDescriptor.mockResolvedValueOnce({
      version: 1,
      status: 'ready',
      teardown: {
        phase: 'verified',
        canonicalPath: '/worktrees/project-1/wt-1',
        quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
      },
    } as unknown as ArchivedGitStagedDescriptor);
    mockedPrepareArchivedContainerTeardown.mockRejectedValueOnce(
      invalidJournal,
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).rejects.toBe(invalidJournal);
    expect(mockedDiscardIncompleteArchivedGitCapture).not.toHaveBeenCalled();
    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledTimes(1);
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it.each([
    [
      WORKSPACE_ROOT_REPO_ID,
      '/workspace-worktrees/workspace-1/.wt-1.archive-quarantine',
    ],
    [
      'repo-a',
      '/workspace-worktrees/workspace-1/.wt-1.archive-quarantine/repos/repo-a',
    ],
  ])(
    'keeps a timed-out multi-repo %s teardown in the archive worker',
    async (repoId, quarantineRepoPath) => {
      const restorePlatform = setPlatform('darwin');
      const originalCapture =
        mockedCaptureArchivedContainerGitState.getMockImplementation();
      const originalTeardown =
        mockedPrepareArchivedContainerTeardown.getMockImplementation();
      const originalStagedDescriptor =
        mockedReadArchivedGitStagedDescriptor.getMockImplementation();
      const originalDiscard =
        mockedDiscardIncompleteArchivedGitCapture.getMockImplementation();
      const timeout = Object.assign(
        new Error('Archive Git command timed out.'),
        {
          code: 'ETIMEDOUT',
          killed: true,
        },
      );
      const workspace = buildMultiRepoWorkspace();
      mockedListWorkspaceItems.mockResolvedValue([workspace]);
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: workspace.sourceRepoPath,
        repos: workspace.repos,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: 'feature/root',
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      ]);
      mockedCaptureArchivedContainerGitState.mockResolvedValue(
        buildMultiRepoArchiveCapture({
          root: 'feature/root',
          repoA: 'feature/repo-a',
          repoB: 'feature/repo-b',
        }),
      );
      mockedPrepareArchivedContainerTeardown.mockResolvedValue({
        canonicalPath: '/workspace-worktrees/workspace-1/wt-1',
        quarantinePath:
          '/workspace-worktrees/workspace-1/.wt-1.archive-quarantine',
        alreadyRemoved: false,
        targets: [
          {
            repoId,
            preMoveRepoPath:
              repoId === WORKSPACE_ROOT_REPO_ID
                ? '/workspace-worktrees/workspace-1/wt-1'
                : '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
            referenceRepoPath:
              repoId === WORKSPACE_ROOT_REPO_ID
                ? '/refs/source'
                : '/repos/repo-a',
            quarantineRepoPath,
          },
        ],
      });
      const runNormally = runArchiveIoRequestMock.getMockImplementation();
      let remainingTimeouts = 1;
      runArchiveIoRequestMock.mockImplementation(
        async (request: ArchiveIoOperationRequest) => {
          if (request.type === 'remove-worktree' && remainingTimeouts-- > 0) {
            throw timeout;
          }
          return runNormally?.(request);
        },
      );
      mockedStageExactMacosWorktreeDirectoryForRemoval.mockRejectedValue(
        new Error('Invalid repoId'),
      );

      try {
        const request = {
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          deleteWithoutRetentionIfMissing: true,
        } as const;
        await expect(archiveMultiRepoWorktree(request)).rejects.toBe(timeout);
        expect(
          runArchiveIoRequestMock.mock.calls.filter(
            ([operation]) => operation.type === 'remove-worktree',
          ),
        ).toHaveLength(1);
        expect(
          mockedStageExactMacosWorktreeDirectoryForRemoval,
        ).not.toHaveBeenCalled();
        expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();

        mockedLstat.mockImplementation((path) =>
          String(path) === '/workspace-worktrees/workspace-1/wt-1'
            ? Promise.reject(
                Object.assign(new Error('missing'), { code: 'ENOENT' }),
              )
            : Promise.resolve(makeLstatResult(false)),
        );
        mockedReadArchivedGitStagedDescriptor.mockResolvedValue({
          version: 1,
          status: 'ready',
          teardown: {
            phase: 'verified',
            canonicalPath: '/workspace-worktrees/workspace-1/wt-1',
            quarantinePath:
              '/workspace-worktrees/workspace-1/.wt-1.archive-quarantine',
          },
        } as unknown as ArchivedGitStagedDescriptor);
        mockedDiscardIncompleteArchivedGitCapture.mockResolvedValue(false);
        await expect(archiveMultiRepoWorktree(request)).resolves.toEqual({
          success: true,
          warnings: [],
        });
        expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledTimes(2);
        expect(mockedCommitArchivedContainer).toHaveBeenCalledTimes(1);
      } finally {
        if (originalCapture) {
          mockedCaptureArchivedContainerGitState.mockImplementation(
            originalCapture,
          );
        }
        if (originalTeardown) {
          mockedPrepareArchivedContainerTeardown.mockImplementation(
            originalTeardown,
          );
        }
        if (originalStagedDescriptor) {
          mockedReadArchivedGitStagedDescriptor.mockImplementation(
            originalStagedDescriptor,
          );
        }
        if (originalDiscard) {
          mockedDiscardIncompleteArchivedGitCapture.mockImplementation(
            originalDiscard,
          );
        }
        restorePlatform();
      }
    },
  );

  it('fences no-retention watcher commands before single-repo Git teardown', async () => {
    mockNoContainerRetentionDays();

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      retainAsArchivedContainer: false,
    });

    expect(cancelLocalScopeMock).toHaveBeenCalledWith('project-1', 'wt-1');
    expect(cancelLocalScopeMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockedRemoveWorktree.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('fences and commits watcher cancellation as its own fence holder (CAN-4989)', async () => {
    mockNoContainerRetentionDays();
    const holders: unknown[] = [];
    const record = (): Promise<void> => {
      holders.push(currentLocalFenceHolder());
      return Promise.resolve();
    };
    cancelLocalScopeMock.mockImplementation(record);
    commitLocalScopeCancellationMock.mockImplementation(record);
    try {
      await archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: false,
      });
    } finally {
      cancelLocalScopeMock.mockImplementation(() => Promise.resolve());
      commitLocalScopeCancellationMock.mockReset();
    }

    expect(holders).toHaveLength(2);
    expect(new Set(holders).size).toBe(1);
    expect(holders[0]).not.toBe(currentLocalFenceHolder());
  });

  it('fences and commits multi-repo watcher cancellation as its own fence holder (CAN-4989)', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockNoContainerRetentionDays();
    const holders: unknown[] = [];
    const record = (): Promise<void> => {
      holders.push(currentLocalFenceHolder());
      return Promise.resolve();
    };
    cancelLocalScopeMock.mockImplementation(record);
    commitLocalScopeCancellationMock.mockImplementation(record);
    try {
      await archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
      });
    } finally {
      cancelLocalScopeMock.mockImplementation(() => Promise.resolve());
      commitLocalScopeCancellationMock.mockReset();
    }

    expect(holders).toHaveLength(2);
    expect(new Set(holders).size).toBe(1);
    expect(holders[0]).not.toBe(currentLocalFenceHolder());
  });

  it.each(['single', 'multi'])(
    'lets admitted activity acquire the workspace lock while %s-repo deletion drains it',
    async (kind) => {
      const projectId = kind === 'multi' ? 'workspace-1' : 'project-1';
      if (kind === 'multi') {
        const workspace = buildMultiRepoWorkspace();
        mockedListWorkspaceItems.mockResolvedValue([workspace]);
        mockedReadWorkspaceConfig.mockResolvedValue({
          version: 1,
          type: 'multi-repo',
          sourceRepoPath: workspace.sourceRepoPath,
          repos: workspace.repos,
        });
      }
      const workspaceLock = new KeyedAsyncLock();
      const archiveLock = jest.mocked(withArchivedWorkspaceOperationLock);
      archiveLock.mockImplementation(
        <T>(id: string, operation: () => Promise<T>): Promise<T> =>
          workspaceLock.run(id, operation),
      );
      let enterDrain: () => void = () => {};
      let releaseDrain: () => void = () => {};
      let activityCompleted = false;
      const entered = new Promise<void>((resolve) => {
        enterDrain = resolve;
      });
      const release = new Promise<void>((resolve) => {
        releaseDrain = resolve;
      });
      runWithScopeDeletionLifecycleMock.mockImplementationOnce(
        async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
          enterDrain();
          await release;
          return operation();
        },
      );
      try {
        const archive =
          kind === 'multi'
            ? archiveMultiRepoWorktree({
                workspaceId: projectId,
                worktreeId: 'wt-1',
                retainAsArchivedContainer: false,
              })
            : archiveSingleRepoWorktree({
                workspaceId: projectId,
                worktreeId: 'wt-1',
                repoPath: '/repos/project-1',
                retainAsArchivedContainer: false,
              });
        await entered;
        const activity = workspaceLock.run(projectId, () => {
          activityCompleted = true;
          return Promise.resolve();
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        const completedDuringDrain = activityCompleted;
        releaseDrain();
        await Promise.all([archive, activity]);
        expect(completedDuringDrain).toBe(true);
      } finally {
        releaseDrain();
        archiveLock.mockImplementation(
          <T>(_id: string, operation: () => Promise<T>): Promise<T> =>
            operation(),
        );
      }
    },
  );

  it('keeps the full single-repo archive inside the scope deletion lifecycle', async () => {
    let lifecycleFenceActive = false;
    runWithScopeDeletionLifecycleMock.mockImplementationOnce(
      async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
        lifecycleFenceActive = true;
        try {
          return await operation();
        } finally {
          lifecycleFenceActive = false;
        }
      },
    );
    const cleanupLiveState = jest.fn(() => {
      expect(lifecycleFenceActive).toBe(true);
      return Promise.resolve();
    });
    commitWorktreeQueueDeletionMock.mockImplementationOnce(() => {
      expect(lifecycleFenceActive).toBe(true);
    });

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      observabilityMode: 'live-service',
      liveServices: { cleanupLiveState },
      retainAsArchivedContainer: false,
    });

    expect(runWithScopeDeletionLifecycleMock).toHaveBeenCalledWith(
      { projectId: 'project-1', worktreeId: 'wt-1' },
      expect.any(Function),
    );
    expect(beginWorktreeQueueDeletionMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
    expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(
      beginWorktreeQueueDeletionMock.mock.invocationCallOrder[0],
    ).toBeGreaterThan(
      runWithScopeDeletionLifecycleMock.mock.invocationCallOrder[0] ?? 0,
    );
    expect(cleanupLiveState).toHaveBeenCalledTimes(1);
    expect(lifecycleFenceActive).toBe(false);
  });

  it('keeps the full multi-repo archive inside the scope deletion lifecycle', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    let lifecycleFenceActive = false;
    runWithScopeDeletionLifecycleMock.mockImplementationOnce(
      async <T>(_scope: unknown, operation: () => Promise<T>): Promise<T> => {
        lifecycleFenceActive = true;
        try {
          return await operation();
        } finally {
          lifecycleFenceActive = false;
        }
      },
    );
    const cleanupLiveState = jest.fn(() => {
      expect(lifecycleFenceActive).toBe(true);
      return Promise.resolve();
    });
    commitWorktreeQueueDeletionMock.mockImplementationOnce(() => {
      expect(lifecycleFenceActive).toBe(true);
    });

    await archiveMultiRepoWorktree({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      observabilityMode: 'live-service',
      liveServices: { cleanupLiveState },
      retainAsArchivedContainer: false,
    });

    expect(runWithScopeDeletionLifecycleMock).toHaveBeenCalledWith(
      { projectId: 'workspace-1', worktreeId: 'wt-1' },
      expect.any(Function),
    );
    expect(beginWorktreeQueueDeletionMock).toHaveBeenCalledWith(
      'workspace-1',
      'wt-1',
    );
    expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
    expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(cleanupLiveState).toHaveBeenCalledTimes(1);
    expect(lifecycleFenceActive).toBe(false);
  });

  it('unfreezes ordinary worktree queues when archive admission fails', async () => {
    runWithScopeDeletionLifecycleMock.mockRejectedValueOnce(
      new Error('scope lifecycle failed'),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('scope lifecycle failed');

    expect(beginWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(commitWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
  });

  describe('removal-pending mark', () => {
    it.each(['single-repo', 'multi-repo'] as const)(
      'CAN-5158 internal %s removal still marks pending synchronously',
      async (kind) => {
        runWithScopeDeletionLifecycleMock.mockRejectedValueOnce(
          new Error('scope lifecycle failed'),
        );
        const archive =
          kind === 'single-repo'
            ? archiveSingleRepoWorktree
            : archiveMultiRepoWorktree;
        const operation = archive({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
        });
        const pendingAtReturn = isWorkspaceTargetRemovalPending(
          'project-1',
          'wt-1',
        );

        await expect(operation).rejects.toThrow('scope lifecycle failed');
        expect(pendingAtReturn).toBe(true);
        expect(isWorkspaceTargetRemovalPending('project-1', 'wt-1')).toBe(
          false,
        );
      },
    );

    // Records whether the target was marked each time a structural sync was
    // scheduled: `true` is the edge that hides the row, `false` the edge that
    // lets a failed archive show it again.
    function recordPendingAtEachSync(
      projectId: string,
      worktreeId: string,
    ): boolean[] {
      const pendingAtSync: boolean[] = [];
      schedulePortalStructuralSyncMock.mockReset();
      schedulePortalStructuralSyncMock.mockImplementation(() => {
        pendingAtSync.push(
          isWorkspaceTargetRemovalPending(projectId, worktreeId),
        );
      });
      return pendingAtSync;
    }

    it('marks a single-repo worktree for the whole archive and syncs at both edges', async () => {
      const pendingAtSync = recordPendingAtEachSync('project-1', 'wt-1');
      let pendingDuringArchive: boolean | undefined;
      const cleanupLiveState = jest.fn(() => {
        pendingDuringArchive = isWorkspaceTargetRemovalPending(
          'project-1',
          'wt-1',
        );
        return Promise.resolve();
      });

      await archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        observabilityMode: 'live-service',
        liveServices: { cleanupLiveState },
        retainAsArchivedContainer: false,
      });

      expect(pendingDuringArchive).toBe(true);
      expect(pendingAtSync).toEqual([true, false]);
      expect(isWorkspaceTargetRemovalPending('project-1', 'wt-1')).toBe(false);
    });

    it('marks a multi-repo worktree for the whole archive and syncs at both edges', async () => {
      const workspace = buildMultiRepoWorkspace();
      mockedListWorkspaceItems.mockResolvedValue([workspace]);
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: workspace.sourceRepoPath,
        repos: workspace.repos,
      });
      const pendingAtSync = recordPendingAtEachSync('workspace-1', 'wt-1');
      let pendingDuringArchive: boolean | undefined;
      const cleanupLiveState = jest.fn(() => {
        pendingDuringArchive = isWorkspaceTargetRemovalPending(
          'workspace-1',
          'wt-1',
        );
        return Promise.resolve();
      });

      await archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        observabilityMode: 'live-service',
        liveServices: { cleanupLiveState },
        retainAsArchivedContainer: false,
      });

      expect(pendingDuringArchive).toBe(true);
      expect(pendingAtSync).toEqual([true, false]);
      expect(isWorkspaceTargetRemovalPending('workspace-1', 'wt-1')).toBe(
        false,
      );
    });

    it('removes the persisted row before the mark is released', async () => {
      const pendingAtSync = recordPendingAtEachSync('project-1', 'wt-1');
      const pendingAtRemoval: boolean[] = [];
      mockedRemoveWorkspaceWorktrees.mockImplementation(() => {
        pendingAtRemoval.push(
          isWorkspaceTargetRemovalPending('project-1', 'wt-1'),
        );
        return Promise.resolve([]);
      });

      await archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: false,
      });

      // No snapshot built between the release and the closing sync can show
      // the row: it left the persisted list while the mark was still set.
      expect(pendingAtRemoval).toEqual([true]);
      expect(pendingAtSync).toEqual([true, false]);
      expect(
        mockedRemoveWorkspaceWorktrees.mock.invocationCallOrder[0],
      ).toBeLessThan(
        schedulePortalStructuralSyncMock.mock.invocationCallOrder[1] ?? 0,
      );
    });

    it('releases the mark and syncs again when the archive fails', async () => {
      const pendingAtSync = recordPendingAtEachSync('project-1', 'wt-1');
      const cleanupLiveState = jest.fn(() =>
        Promise.reject(new Error('live cleanup failed')),
      );

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
          observabilityMode: 'live-service',
          liveServices: { cleanupLiveState },
          retainAsArchivedContainer: false,
        }),
      ).rejects.toThrow('live cleanup failed');

      expect(pendingAtSync).toEqual([true, false]);
      expect(isWorkspaceTargetRemovalPending('project-1', 'wt-1')).toBe(false);
    });

    it('releases the mark when archive admission rejects', async () => {
      const pendingAtSync = recordPendingAtEachSync('project-1', 'wt-1');
      runWithScopeDeletionLifecycleMock.mockRejectedValueOnce(
        new Error('scope lifecycle failed'),
      );

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('scope lifecycle failed');

      expect(pendingAtSync).toEqual([true, false]);
      expect(isWorkspaceTargetRemovalPending('project-1', 'wt-1')).toBe(false);
    });

    it('releases the mark when the lifecycle throws before the archive body runs', async () => {
      const pendingAtSync = recordPendingAtEachSync('project-1', 'wt-1');
      runWithScopeDeletionLifecycleMock.mockImplementationOnce(() => {
        throw new Error('scope lifecycle threw');
      });

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('scope lifecycle threw');

      expect(pendingAtSync).toEqual([true, false]);
      expect(beginWorktreeQueueDeletionMock).not.toHaveBeenCalled();
      expect(isWorkspaceTargetRemovalPending('project-1', 'wt-1')).toBe(false);
    });
  });

  describe('browser profile retirement deadline', () => {
    const NEXT_START_WARNING =
      'Browser data for this worktree will be cleared the next time the app starts.';
    const DEFERRED_LOG = 'Worktree archive deferred browser profile retirement';
    const mockedPrepareRetirement = jest.mocked(prepareTaskBrowserRetirement);
    const mockedCommitRetirement = jest.mocked(commitTaskBrowserRetirement);
    const mockedSettleRetirement = jest.mocked(
      settleFailedTaskBrowserRetirement,
    );
    const mockedRetireRemovedTask = jest.mocked(retireRemovedBrowserTask);

    // Real timers would make each case wait out the deadline, and a hang on
    // unbounded code would only surface as a slow Jest timeout.
    beforeEach(() => {
      jest.useFakeTimers({
        doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'],
      });
    });

    afterEach(() => {
      jest.useRealTimers();
      mockedPrepareRetirement.mockReset();
      mockedPrepareRetirement.mockResolvedValue('profile-retirement');
      mockedCommitRetirement.mockReset();
      mockedCommitRetirement.mockResolvedValue(false);
      mockedSettleRetirement.mockReset();
      mockedSettleRetirement.mockResolvedValue(undefined);
      mockedRetireRemovedTask.mockReset();
      mockedRetireRemovedTask.mockResolvedValue(undefined);
    });

    function neverSettles<T>(): Promise<T> {
      return new Promise<T>(() => undefined);
    }

    function flush(): Promise<void> {
      return new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    function archive(
      liveServices?: WorktreeArchiveLiveServices,
    ): ReturnType<typeof archiveSingleRepoWorktree> {
      return archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: false,
        ...(liveServices
          ? { observabilityMode: 'live-service', liveServices }
          : {}),
      });
    }

    /** Runs the archive up to the hung profile call, then expires one deadline. */
    async function expireDeadlineOf(hung: jest.Mock): Promise<void> {
      for (let turn = 0; turn < 100 && hung.mock.calls.length === 0; turn += 1)
        await flush();
      expect(hung).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(BROWSER_RETIREMENT_DEADLINE_MS);
    }

    function expectDeferredOnTimeout(step: string): void {
      expect(logMainProcessWarnMock).toHaveBeenCalledWith(
        DEFERRED_LOG,
        expect.objectContaining({ step, code: 'timeout' }),
      );
    }

    /**
     * A timeout is not a failure: the abandoned call still retires the
     * profile once metadata answers, and startup reconciliation remains the
     * retry, so the archive logs it instead of warning the user.
     */
    async function expectArchivedWithoutBrowserWarning(
      archived: ReturnType<typeof archiveSingleRepoWorktree>,
    ): Promise<void> {
      const result = await archived;
      expect(result.success).toBe(true);
      expect(result.warnings).not.toContain(NEXT_START_WARNING);
    }

    it('defers a prepare that never settles and finishes the archive', async () => {
      mockedPrepareRetirement.mockImplementationOnce(() => neverSettles());

      const archived = archive();
      await expireDeadlineOf(mockedPrepareRetirement);

      await expectArchivedWithoutBrowserWarning(archived);
      expectDeferredOnTimeout('prepare');
    });

    it('defers a commit that never settles and finishes the archive', async () => {
      mockedCommitRetirement.mockImplementationOnce(() => neverSettles());

      const archived = archive();
      await expireDeadlineOf(mockedCommitRetirement);

      await expectArchivedWithoutBrowserWarning(archived);
      expectDeferredOnTimeout('commit');
    });

    it('finishes the archive when the deferred retirement never settles', async () => {
      mockedPrepareRetirement.mockRejectedValueOnce(
        new Error('profile metadata unavailable'),
      );
      mockedRetireRemovedTask.mockImplementationOnce(() => neverSettles());

      const archived = archive();
      await expireDeadlineOf(mockedRetireRemovedTask);

      await expectArchivedWithoutBrowserWarning(archived);
      expect(logMainProcessWarnMock).toHaveBeenCalledWith(
        'Worktree archive could not retire browser profile',
        expect.objectContaining({ code: 'timeout' }),
      );
    });

    it('still warns when the deferred retirement fails', async () => {
      mockedPrepareRetirement.mockRejectedValueOnce(
        new Error('profile metadata unavailable'),
      );
      mockedRetireRemovedTask.mockRejectedValueOnce(
        new Error('profile metadata unavailable'),
      );

      const result = await archive();

      expect(result.success).toBe(true);
      expect(result.warnings).toContain(NEXT_START_WARNING);
    });

    it('retires the profile without a warning when metadata answers again before the archive commits', async () => {
      // Concurrent archives queue on the same profile metadata, so one
      // archive's prepare can outlast its deadline and still answer seconds
      // later, long before that archive reaches its commit.
      let resolveLate: (operationId: string | null) => void = () => undefined;
      mockedPrepareRetirement.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveLate = resolve;
          }),
      );

      const held = archiveHeldInCleanup();
      await expireDeadlineOf(mockedPrepareRetirement);
      await held.reachCleanup();
      resolveLate('late-retirement');
      await flush();
      held.finish();

      await expectArchivedWithoutBrowserWarning(held.archived);
      // The deferred retirement is made, not skipped behind a call that has
      // long since answered.
      expect(mockedRetireRemovedTask).toHaveBeenCalledTimes(1);
      expect(mockedRetireRemovedTask).toHaveBeenCalledWith('project-1', 'wt-1');
      expect(logMainProcessWarnMock).not.toHaveBeenCalledWith(
        'Worktree archive could not retire browser profile',
        expect.anything(),
      );
    });

    it('reports the archive failure when settling the retirement never settles', async () => {
      mockedSettleRetirement.mockImplementationOnce(() => neverSettles());

      const archived = archive({
        cleanupLiveState: () =>
          Promise.reject(new Error('live cleanup failed')),
      });
      const failure = expect(archived).rejects.toThrow('live cleanup failed');
      await expireDeadlineOf(mockedSettleRetirement);

      await failure;
      expectDeferredOnTimeout('settle');
    });

    it('waits out one deadline, not one per profile call', async () => {
      mockedPrepareRetirement.mockImplementation(() => neverSettles());
      mockedCommitRetirement.mockImplementation(() => neverSettles());
      mockedRetireRemovedTask.mockImplementation(() => neverSettles());

      const archived = archive();
      await expireDeadlineOf(mockedPrepareRetirement);

      // No second advance: the calls after the first expiry are skipped.
      await expect(archived).resolves.toMatchObject({ success: true });
      expect(mockedCommitRetirement).not.toHaveBeenCalled();
      expect(mockedRetireRemovedTask).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    });

    it('clears the deadline when profile metadata answers in time', async () => {
      await expect(archive()).resolves.toMatchObject({ success: true });

      expect(jest.getTimerCount()).toBe(0);
      expect(logMainProcessWarnMock).not.toHaveBeenCalledWith(
        DEFERRED_LOG,
        expect.anything(),
      );
      expect(mockedCommitRetirement).toHaveBeenCalledTimes(1);
      expect(mockedRetireRemovedTask).not.toHaveBeenCalled();
    });

    it('absorbs an abandoned call that rejects after the deadline', async () => {
      let rejectLate: (error: Error) => void = () => undefined;
      mockedPrepareRetirement.mockImplementationOnce(
        () =>
          new Promise<string | null>((_resolve, reject) => {
            rejectLate = reject;
          }),
      );
      const unhandled = jest.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const archived = archive();
        await expireDeadlineOf(mockedPrepareRetirement);
        await archived;

        rejectLate(new Error('profile metadata unavailable'));
        await flush();
        await flush();

        expect(unhandled).not.toHaveBeenCalled();
        expect(mockedSettleRetirement).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('settles a retirement that was prepared after the archive stopped waiting', async () => {
      let resolveLate: (operationId: string | null) => void = () => undefined;
      mockedPrepareRetirement.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveLate = resolve;
          }),
      );

      const archived = archive();
      await expireDeadlineOf(mockedPrepareRetirement);
      await archived;
      expect(mockedSettleRetirement).not.toHaveBeenCalled();

      resolveLate('late-retirement');
      await flush();

      // A fence prepared with no archive left to commit or abort it would
      // keep the profile unusable until restart.
      expect(mockedSettleRetirement).toHaveBeenCalledTimes(1);
      expect(mockedSettleRetirement).toHaveBeenCalledWith('late-retirement');
      expect(mockedCommitRetirement).not.toHaveBeenCalled();
      expect(mockedRetireRemovedTask).not.toHaveBeenCalled();
    });

    /** An archive held inside its live-state cleanup until `finish` is called. */
    function archiveHeldInCleanup(): {
      archived: ReturnType<typeof archiveSingleRepoWorktree>;
      reachCleanup: () => Promise<void>;
      finish: () => void;
    } {
      let finish: () => void = () => undefined;
      const cleanupLiveState = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      return {
        archived: archive({ cleanupLiveState }),
        reachCleanup: async (): Promise<void> => {
          for (
            let turn = 0;
            turn < 100 && cleanupLiveState.mock.calls.length === 0;
            turn += 1
          )
            await flush();
          expect(cleanupLiveState).toHaveBeenCalledTimes(1);
        },
        finish: (): void => finish(),
      };
    }

    it('holds a retirement prepared late until its own archive has ended', async () => {
      let resolveLate: (operationId: string | null) => void = () => undefined;
      mockedPrepareRetirement.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveLate = resolve;
          }),
      );

      const held = archiveHeldInCleanup();
      await expireDeadlineOf(mockedPrepareRetirement);
      await held.reachCleanup();
      resolveLate('late-retirement');
      await flush();
      await flush();

      // Settling now would abort the fence while the worktree is still
      // there, and the archive would then remove the owner with nothing left
      // to retire its profile before the next start.
      expect(mockedSettleRetirement).not.toHaveBeenCalled();

      held.finish();
      await expect(held.archived).resolves.toMatchObject({ success: true });
      await flush();

      expect(mockedSettleRetirement).toHaveBeenCalledTimes(1);
      expect(mockedSettleRetirement).toHaveBeenCalledWith('late-retirement');
    });

    it('settles a fence once its failed archive ends when a later call already expired', async () => {
      // Prepare answers in time; a later profile call of the same archive,
      // such as the retirement inside tab-state cleanup, then expires.
      const hung = jest.fn(() => neverSettles<void>());
      const archived = archive({
        cleanupLiveState: async () => {
          await withBrowserRetirementDeadline(hung).catch(() => undefined);
          throw new Error('live cleanup failed');
        },
      });
      const failure = expect(archived).rejects.toThrow('live cleanup failed');
      await expireDeadlineOf(hung);
      await failure;
      await flush();

      // The scope skips the settle itself, so without a later settle the
      // fence would stay on a worktree that still exists.
      expectDeferredOnTimeout('settle');
      expect(mockedSettleRetirement).toHaveBeenCalledTimes(1);
      expect(mockedSettleRetirement).toHaveBeenCalledWith('profile-retirement');
    });

    it('leaves a retirement prepared late alone while a retry is running', async () => {
      let resolveLate: (operationId: string | null) => void = () => undefined;
      mockedPrepareRetirement.mockImplementationOnce(
        () =>
          new Promise<string | null>((resolve) => {
            resolveLate = resolve;
          }),
      );
      const failed = archive({
        cleanupLiveState: () =>
          Promise.reject(new Error('live cleanup failed')),
      });
      const failure = expect(failed).rejects.toThrow('live cleanup failed');
      await expireDeadlineOf(mockedPrepareRetirement);
      await failure;

      // The retry prepares in time and can be handed the same fence.
      const retry = archiveHeldInCleanup();
      await retry.reachCleanup();
      resolveLate('late-retirement');
      await flush();
      await flush();

      expect(mockedSettleRetirement).not.toHaveBeenCalled();

      retry.finish();
      await expect(retry.archived).resolves.toMatchObject({ success: true });
      await flush();

      // By now the retry has committed the fence, so settling finds nothing.
      expect(mockedCommitRetirement).toHaveBeenCalledTimes(1);
      expect(mockedSettleRetirement).toHaveBeenCalledTimes(1);
      expect(mockedSettleRetirement).toHaveBeenCalledWith('late-retirement');
    });

    it('does not retire a second time when an abandoned commit completes late', async () => {
      let resolveLate: (pendingCleanup: boolean) => void = () => undefined;
      mockedCommitRetirement.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            resolveLate = resolve;
          }),
      );

      const archived = archive();
      await expireDeadlineOf(mockedCommitRetirement);
      await archived;

      resolveLate(true);
      await flush();

      expect(mockedCommitRetirement).toHaveBeenCalledTimes(1);
      expect(mockedRetireRemovedTask).not.toHaveBeenCalled();
      expect(mockedSettleRetirement).not.toHaveBeenCalled();
    });
  });

  it('releases stale active turns when archive fails after live session cleanup', async () => {
    const cleanupLiveState = jest.fn(
      (
        _projectId: string,
        _worktreeId: string,
        onSessionsDestroyed?: () => void,
      ) => {
        onSessionsDestroyed?.();
        return Promise.resolve();
      },
    );
    mockedReadWorkspaceConfig.mockRejectedValueOnce(new Error('config failed'));

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        observabilityMode: 'live-service',
        liveServices: { cleanupLiveState },
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow('config failed');

    expect(cleanupLiveState).toHaveBeenCalledTimes(1);
    expect(commitWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    expect(rollbackWorktreeQueueDeletionMock).toHaveBeenCalledWith({
      sessionsDestroyed: true,
    });
  });

  it('does not restart queues after irreversible archive deletion', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    const persistedWorktree = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt,
    };
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/project-1',
      repos: [],
      temporary: true,
    });
    mockedReadWorkspaceWorktrees
      .mockResolvedValueOnce([persistedWorktree])
      .mockResolvedValueOnce([persistedWorktree])
      .mockResolvedValueOnce([]);
    mockedRemoveWorkspaceWorktrees.mockResolvedValueOnce([persistedWorktree]);
    mockedReadAllSidebarItems.mockRejectedValueOnce(
      new Error('temporary project bookkeeping failed'),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('temporary project bookkeeping failed');

    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    );
    expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
    expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
  });

  it('rejects automatic deletion when activity changed after eligibility', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        lastTouchedAt: '2026-09-02T12:00:00.000Z',
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        expectedCreatedAt: createdAt,
        expectedLastTouchedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('Auto Delete eligibility changed');

    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(captureDesktopInstrumentationError).not.toHaveBeenCalled();
  });

  it('rejects a first touch after an automatic candidate was collected without a timestamp', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
        lastTouchedAt: '2026-09-02T12:00:00.000Z',
      },
    ]);
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        expectedLastTouchedAt: undefined,
        revalidateAutoArchivePolicy: () => Promise.resolve({}),
      }),
    ).rejects.toThrow('Auto Delete eligibility changed');
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('revalidates Auto Delete policy after acquiring the operation lock', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        lastTouchedAt: '2026-08-20T00:00:00.000Z',
      },
    ]);
    const revalidateAutoArchivePolicy = jest
      .fn()
      .mockRejectedValue(
        new Error('Auto Delete policy changed before deletion'),
      );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        expectedCreatedAt: createdAt,
        expectedLastTouchedAt: '2026-08-20T00:00:00.000Z',
        revalidateAutoArchivePolicy,
      }),
    ).rejects.toThrow('Auto Delete policy changed before deletion');

    expect(revalidateAutoArchivePolicy).toHaveBeenCalledTimes(1);
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('captures retained worktree state and commits it before destructive cleanup', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCleanupWorktreePipelines.mockResolvedValue({
      warnings: [],
      relocatedCount: 2,
      failedRelocationIds: [],
    });
    mockedCountArchivedContainerExecutions.mockResolvedValue(2);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
    });

    expect(mockedBeginArchivedContainerCapture).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      { expectedCreatedAt: '2026-04-20T00:00:00.000Z' },
    );
    expect(mockedCaptureArchivedContainerProviderState).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        containerId: 'wt-1',
        includeClaude: true,
      }),
    );
    expect(mockedCleanupWorktreePipelines).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.anything(),
      expect.objectContaining({
        relocateArtifactsTo: '/archives/project-1/wt-1/pipeline-executions',
      }),
    );
    expect(
      typeof mockedCleanupWorktreePipelines.mock.calls[0]?.[3]
        ?.archiveCaptureExecutor,
    ).toBe('function');
    expect(mockedCountArchivedContainerExecutions).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.objectContaining({
        chatSearchDisposition: 'container-archived',
      }),
    );
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wt-1',
        branchName: 'feature/retained',
        retentionDays: 7,
        executionCount: 2,
        pullRequestMetadata: {
          capturedAt: '2026-07-22T00:00:01.000Z',
          repositories: [
            {
              repoId: '__single_repo__',
              repoName: 'project-1',
              status: 'complete',
              pullRequest: null,
            },
          ],
        },
      }),
    );
    expect(mockedAssertArchivedContainerSourceGeneration).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      '2026-04-20T00:00:00.000Z',
    );
    expect(
      mockedAssertArchivedContainerSourceGeneration.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCommitArchivedContainer.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      mockedCaptureArchivedContainerGitState.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCaptureArchivedContainerProviderState.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(
      mockedCaptureArchivedContainerProviderState.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedPrepareArchivedContainerTeardown.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(mockedRemoveWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      mockedCommitArchivedContainer.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    // The manifest commit must land BEFORE cleanupPersistedWorktreeData
    // destroys the live chat files: a commit failure aborts while the
    // originals are intact, and the cleanup's container-archived search
    // disposition indexes a real manifest instead of racing an ENOENT.
    expect(
      mockedCommitArchivedContainer.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCleanupPersistedWorktreeData.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('completes a committed archive when derived search cleanup fails', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockWorktreeContainerArchived.mockRejectedValueOnce(
      new Error('Search index worker is closing'),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({
      success: true,
      warnings: ['Failed to update the chat search index for this archive.'],
    });

    expect(mockedCommitArchivedContainer).toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalled();
    expect(mockedRemoveWorktree).toHaveBeenCalled();
  });

  it('releases the local watcher fence when the archive manifest commit fails', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedCommitArchivedContainer.mockRejectedValueOnce(
      new Error('manifest commit failed'),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('manifest commit failed');

    expect(releaseLocalScopeFenceMock).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(commitLocalScopeCancellationMock).not.toHaveBeenCalled();
  });

  it('retains the local watcher fence when cancellation commit fails after worktree removal', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    commitLocalScopeCancellationMock.mockRejectedValueOnce(
      new Error('watcher commit failed'),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('watcher commit failed');

    expect(mockedRemoveWorktree).toHaveBeenCalled();
    expect(releaseLocalScopeFenceMock).not.toHaveBeenCalled();
  });

  describe('Ledger lifecycle participant', () => {
    const createdAt = '2026-04-20T00:00:00.000Z';

    it('tells the Ledger once after a retained archive commits', async () => {
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        { id: 'wt-1', branchName: 'feature/retained', createdAt },
      ]);

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledWith(
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'project-1',
            worktreeId: 'wt-1',
          },
          containerCreatedAt: createdAt,
        },
        { retained: true },
      );
      // Right after the archive manifest commits, before destructive cleanup.
      const notifiedAt =
        mockedNotifyLedgerContainerArchived.mock.invocationCallOrder[0] ?? 0;
      expect(
        mockedCommitArchivedContainer.mock.invocationCallOrder[0],
      ).toBeLessThan(notifiedAt);
      expect(notifiedAt).toBeLessThan(
        mockedCleanupPersistedWorktreeData.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('keeps a committed archive read-only when later cleanup fails', async () => {
      mockedRemoveWorkspaceWorktrees.mockRejectedValueOnce(
        new Error('worktree registry write failed'),
      );

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('worktree registry write failed');

      // The archive exists and can be restored, so its scope must be archived
      // for a restore to rebind it.
      expect(mockedCommitArchivedContainer).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledWith(
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'project-1',
            worktreeId: 'wt-1',
          },
          containerCreatedAt: createdAt,
        },
        { retained: true },
      );
    });

    it('tells the Ledger once after a permanent deletion commits', async () => {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
          retainAsArchivedContainer: false,
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledWith(
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'project-1',
            worktreeId: 'wt-1',
          },
          containerCreatedAt: createdAt,
        },
        { retained: false },
      );
      expect(
        mockedRemoveWorkspaceWorktrees.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mockedNotifyLedgerContainerArchived.mock.invocationCallOrder[0] ?? 0,
      );
    });

    it('tells the Ledger once after a multi-repo archive commits', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        sourceRepoPath: '/repos/source',
        repos: buildMultiRepoWorkspace().repos,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        { id: 'wt-1', branchName: 'feature/wt-1', createdAt },
      ]);

      await expect(
        archiveMultiRepoWorktree({
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledWith(
        {
          container: {
            kind: 'code_worktree',
            workspaceId: 'workspace-1',
            worktreeId: 'wt-1',
          },
          containerCreatedAt: createdAt,
        },
        { retained: true },
      );
    });

    it('does not tell the Ledger when the archive manifest commit fails', async () => {
      mockedCommitArchivedContainer.mockRejectedValueOnce(
        new Error('manifest commit failed'),
      );

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('manifest commit failed');

      expect(mockedNotifyLedgerContainerArchived).not.toHaveBeenCalled();
    });

    it('does not tell the Ledger when a deletion cannot remove the worktree record', async () => {
      mockedRemoveWorkspaceWorktrees.mockRejectedValueOnce(
        new Error('worktree registry write failed'),
      );

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
          retainAsArchivedContainer: false,
        }),
      ).rejects.toThrow('worktree registry write failed');

      expect(mockedNotifyLedgerContainerArchived).not.toHaveBeenCalled();
    });

    it('completes the archive when the Ledger participant throws', async () => {
      mockedNotifyLedgerContainerArchived.mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mockedNotifyLedgerContainerArchived).toHaveBeenCalledTimes(1);
      expect(commitLocalScopeCancellationMock).toHaveBeenCalledWith(
        'project-1',
        'wt-1',
      );
      expect(commitWorktreeQueueDeletionMock).toHaveBeenCalledTimes(1);
      expect(rollbackWorktreeQueueDeletionMock).not.toHaveBeenCalled();
    });

    it('skips the Ledger when no persisted record identifies the deleted worktree', async () => {
      mockedReadWorkspaceWorktrees.mockResolvedValue([]);

      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          repoPath: '/repos/project-1',
          retainAsArchivedContainer: false,
        }),
      ).resolves.toMatchObject({ success: true });

      expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalled();
      expect(mockedNotifyLedgerContainerArchived).not.toHaveBeenCalled();
    });
  });

  it('deletes the local branch when the archive action explicitly requests it', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedForceDeleteBranch.mockResolvedValue(undefined);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: false }),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
    });

    expect(mockedForceDeleteBranch).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
    );
    expect(mockedDeleteBranch).not.toHaveBeenCalled();
  });

  it('rejects a single-repo archive request for a different repository', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/unrelated',
        deleteBranch: true,
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'requested repository does not match the project repository',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
    expect(captureDesktopInstrumentationError).toHaveBeenCalledTimes(1);
    const [reported, reportOptions] =
      jest.mocked(captureDesktopInstrumentationError).mock.calls[0] ?? [];
    expect(reported).toBeInstanceOf(Error);
    expect(reportOptions?.context?.operation).toBe('worktree_archive');
    expect(reportOptions?.context?.code).toBe('other');
    expect(typeof reportOptions?.context?.operationId).toBe('string');
    expect(
      JSON.stringify(
        jest.mocked(captureDesktopInstrumentationError).mock.calls,
      ),
    ).not.toContain('/repos/');
  });

  it('rejects a branch switch after single-repo archive confirmation', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockResolvedValue('feature/switched');

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
        expectedBranchName: 'feature/wt-1',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'branch changed after deletion was confirmed for "feature/wt-1"',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('rejects a detached checkout after single-repo archive confirmation', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockResolvedValue('HEAD');

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: false,
        expectedBranchName: 'feature/wt-1',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'branch changed after deletion was confirmed for "feature/wt-1"',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects a captured branch mismatch before retained archive teardown', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
        expectedBranchName: 'feature/confirmed',
      }),
    ).rejects.toThrow(
      'branch changed after deletion was confirmed for "feature/confirmed"',
    );

    expect(mockedPrepareArchivedContainerTeardown).not.toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('allows divergent child branches when preserving a retained multi-repo archive', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedCaptureArchivedContainerGitState.mockResolvedValueOnce(
      buildMultiRepoArchiveCapture({
        root: 'feature/root',
        repoA: 'feature/repo-a',
        repoB: 'feature/repo-b',
      }),
    );
    mockedPrepareArchivedContainerTeardown.mockResolvedValueOnce({
      canonicalPath: '/workspace-worktrees/workspace-1/wt-1',
      quarantinePath: '/workspace-worktrees/workspace-1/wt-1',
      alreadyRemoved: false,
      targets: [],
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        expectedBranchName: 'feature/root',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledWith(
      expect.objectContaining({ deleteBranches: false }),
    );
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('allows confirmed retained archives without a workspace-root repository', async () => {
    const workspace = buildTemporaryMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/shared',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    const capture = buildMultiRepoArchiveCapture({
      root: 'feature/shared',
      repoA: 'feature/shared',
      repoB: 'feature/shared',
    });
    capture.gitState.repositories = capture.gitState.repositories.filter(
      (repository) => repository.repoId !== WORKSPACE_ROOT_REPO_ID,
    );
    mockedCaptureArchivedContainerGitState.mockResolvedValueOnce(capture);
    mockedPrepareArchivedContainerTeardown.mockResolvedValueOnce({
      canonicalPath: '/workspace-worktrees/workspace-1/wt-1',
      quarantinePath: '/workspace-worktrees/workspace-1/wt-1',
      alreadyRemoved: false,
      targets: [],
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        expectedBranchName: 'feature/shared',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledWith(
      expect.objectContaining({ deleteBranches: false }),
    );
  });

  it('rejects a root branch switch before preserving a retained multi-repo archive', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedCaptureArchivedContainerGitState.mockResolvedValueOnce(
      buildMultiRepoArchiveCapture({
        root: 'feature/switched',
        repoA: 'feature/repo-a',
        repoB: 'feature/repo-b',
      }),
    );

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        expectedBranchName: 'feature/root',
      }),
    ).rejects.toThrow(
      'workspace-root branch changed after archive was confirmed for "feature/root"',
    );

    expect(mockedPrepareArchivedContainerTeardown).not.toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('rejects a root branch switch before preserving a non-retained multi-repo worktree', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockImplementation((worktreePath) =>
      Promise.resolve(
        worktreePath.endsWith('/root') ? 'feature/switched' : 'feature/child',
      ),
    );

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        expectedBranchName: 'feature/root',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'repository "__workspace_root__" changed branches after archive was confirmed for "feature/root"',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
  });

  it('rejects a detached root after multi-repo archive confirmation', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockImplementation((worktreePath) =>
      Promise.resolve(
        worktreePath.endsWith('/root') ? 'HEAD' : 'feature/child',
      ),
    );

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        expectedBranchName: 'feature/root',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'repository "__workspace_root__" changed branches after archive was confirmed for "feature/root"',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
  });

  it('journals divergent multi-repo branches against their own deletion targets', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/root',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    mockedGetCurrentBranch.mockImplementation((worktreePath) => {
      if (worktreePath.endsWith('/root'))
        return Promise.resolve('feature/root');
      if (worktreePath.endsWith('/repo-a')) {
        return Promise.resolve('feature/repo-a');
      }
      return Promise.resolve('feature/repo-b');
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: true,
        expectedBranchName: 'feature/root',
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(persistedWorktree.pendingArchiveBranchDeletions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          repoId: WORKSPACE_ROOT_REPO_ID,
          branchName: 'feature/root',
        }),
        expect.objectContaining({
          repoId: 'repo-a',
          branchName: 'feature/repo-a',
        }),
        expect.objectContaining({
          repoId: 'repo-b',
          branchName: 'feature/repo-b',
        }),
      ]),
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/repo-a',
      'feature/repo-a',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/repo-b',
      'feature/repo-b',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/refs/source',
      'feature/root',
      '1111111111111111111111111111111111111111',
    );
  });

  it.each(['ENOENT', 'EACCES', 'ENOTDIR', 'symlink'])(
    'CAN-5158 excluded child cleanup treats %s as absent only for ENOENT',
    async (childState) => {
      const workspace = buildMultiRepoWorkspace();
      mockedListWorkspaceItems.mockResolvedValue([workspace]);
      mockedReadWorkspaceConfig.mockResolvedValue({
        version: 1,
        type: 'multi-repo',
        repos: workspace.repos,
      });
      mockedReadWorkspaceWorktrees.mockResolvedValue([
        {
          id: 'wt-1',
          branchName: 'feature/root',
          createdAt: '2026-04-20T00:00:00.000Z',
          includedRepoIds: ['repo-a'],
        },
      ]);
      const childPath = '/workspace-worktrees/workspace-1/wt-1/repos/repo-b';
      const childError = Object.assign(new Error(`child path: ${childState}`), {
        code: childState,
      });
      mockedLstat.mockImplementation((candidatePath) => {
        if (String(candidatePath) !== childPath)
          return Promise.resolve(makeLstatResult(false));
        return childState === 'symlink'
          ? Promise.resolve(makeLstatResult(true))
          : Promise.reject(childError);
      });

      const removal = archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
        deleteBranch: false,
      });
      if (childState === 'EACCES' || childState === 'ENOTDIR') {
        await expect(removal).rejects.toThrow(childError.message);
      } else {
        await expect(removal).resolves.toMatchObject({ success: true });
      }
      expect(mockedLstat).toHaveBeenCalledWith(childPath);
      if (childState === 'symlink') {
        expect(mockedRemoveWorktree).toHaveBeenCalledWith(
          '/repos/repo-b',
          childPath,
        );
      } else {
        expect(mockedRemoveWorktree).not.toHaveBeenCalledWith(
          '/repos/repo-b',
          childPath,
        );
      }
      expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
      expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
    },
  );

  it('removes a temporary clone as owned files during non-retained teardown', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    const clonePath = '/workspace-worktrees/workspace-1/wt-1/repos/temporary';
    jest.mocked(listUnmanagedWorktreeRepositories).mockResolvedValue([
      {
        repoId: 'temporary',
        path: clonePath,
        repository: { kind: 'standalone-clone' },
      },
      {
        repoId: 'linked',
        path: '/workspace-worktrees/workspace-1/wt-1/repos/linked',
        repository: { kind: 'linked-worktree', referenceRepoPath: '/outside' },
      },
    ]);
    await archiveMultiRepoWorktree({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      retainAsArchivedContainer: false,
    });
    expect(mockedRm).toHaveBeenCalledWith(
      clonePath,
      expect.objectContaining({ recursive: true, force: true }),
    );
    expect(mockedRemoveWorktree).not.toHaveBeenCalledWith(clonePath, clonePath);
    expect(mockedRemoveWorktree).toHaveBeenCalledWith(
      '/outside',
      '/workspace-worktrees/workspace-1/wt-1/repos/linked',
    );
    expect(cleanupPersistedTurnDiffTreeRefs).not.toHaveBeenCalledWith(
      clonePath,
      'workspace-1',
      'wt-1',
    );
    expect(cleanupPersistedTurnDiffTreeRefs).toHaveBeenCalledWith(
      '/outside',
      'workspace-1',
      'wt-1',
    );
  });

  it('settles every repository turn diff cleanup before archive returns', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    let releaseCleanup!: () => void;
    const pendingCleanup = new Promise<void>((release) => {
      releaseCleanup = release;
    });
    jest
      .mocked(cleanupPersistedTurnDiffTreeRefs)
      .mockImplementation((repoPath) =>
        repoPath === '/repos/repo-a'
          ? pendingCleanup
          : Promise.reject(new Error('ref cleanup failed')),
      );
    try {
      let settled = false;
      const archive = archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
      }).finally(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(cleanupPersistedTurnDiffTreeRefs).toHaveBeenCalledWith(
        '/repos/repo-b',
        'workspace-1',
        'wt-1',
      );
      expect(settled).toBe(false);
      releaseCleanup();
      await expect(archive).resolves.toMatchObject({
        warnings: [
          'Failed to remove persisted turn diff tree refs for this worktree.',
        ],
      });
    } finally {
      releaseCleanup();
      jest.mocked(cleanupPersistedTurnDiffTreeRefs).mockReset();
    }
  });

  it('preserves stale quarantine branches outside captured repository scope', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: true }),
    );
    mockedCaptureArchivedContainerGitState.mockResolvedValueOnce(
      buildMultiRepoArchiveCapture({
        root: 'feature/root',
        repoA: 'feature/repo-a',
        repoB: 'feature/repo-b',
      }),
    );
    mockedPrepareArchivedContainerTeardown.mockResolvedValueOnce({
      canonicalPath: '/workspace-worktrees/workspace-1/wt-1',
      quarantinePath: '/workspace-worktrees/workspace-1/wt-1',
      alreadyRemoved: false,
      targets: [
        {
          repoId: 'repo-a',
          referenceRepoPath: '/repos/repo-a',
          preMoveRepoPath: '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
          quarantineRepoPath:
            '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
          branchName: 'feature/repo-a',
        },
        {
          repoId: 'stale-repo',
          referenceRepoPath: '/repos/stale',
          preMoveRepoPath:
            '/workspace-worktrees/workspace-1/wt-1/repos/stale-repo',
          quarantineRepoPath:
            '/workspace-worktrees/workspace-1/wt-1/repos/stale-repo',
          branchName: 'unrelated/stale',
        },
      ],
      pendingBranchDeletions: [],
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDeleteBranch).toHaveBeenCalledWith(
      '/repos/repo-a',
      'feature/repo-a',
    );
    expect(mockedDeleteBranch).not.toHaveBeenCalledWith(
      '/repos/stale',
      'unrelated/stale',
    );
  });

  it('surfaces an explicit local branch deletion failure', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedForceDeleteBranch.mockRejectedValue(
      new Error('branch is locked by another process'),
    );
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: false }),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
      }),
    ).rejects.toThrow('branch is locked by another process');
  });

  it('retries a journaled explicit branch deletion after quarantine removal', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches
      .mockRejectedValueOnce(new Error('branch is locked by another process'))
      .mockResolvedValueOnce(undefined);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    const pendingBranchDeletions = [
      {
        repoId: '__single_repo__',
        referenceRepoPath: '/repos/project-1',
        repositoryIdentity: '/repos/project-1/.git',
        branchName: 'feature/retained',
        expectedTip: '1111111111111111111111111111111111111111',
      },
    ];
    mockedPrepareArchivedContainerTeardown
      .mockResolvedValueOnce({
        canonicalPath: '/worktrees/project-1/wt-1',
        quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
        alreadyRemoved: false,
        targets: [
          {
            repoId: '__single_repo__',
            referenceRepoPath: '/repos/project-1',
            preMoveRepoPath: '/worktrees/project-1/wt-1',
            quarantineRepoPath: '/worktrees/project-1/.wt-1.archive-quarantine',
            branchName: 'feature/retained',
          },
        ],
        pendingBranchDeletions,
      })
      .mockResolvedValueOnce({
        canonicalPath: '/worktrees/project-1/wt-1',
        quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
        alreadyRemoved: true,
        targets: [],
        pendingBranchDeletions,
      });

    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
    } as const;
    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'branch is locked by another process',
    );
    await expect(archiveSingleRepoWorktree(request)).resolves.toEqual({
      success: true,
      warnings: [],
    });

    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ deleteBranches: true }),
    );
    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deleteBranches: true }),
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(2);
    expect(mockedCompleteArchivedContainerGitCapture).toHaveBeenCalledTimes(1);
  });

  it('replays the persisted merged-only policy after quarantine removal', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: true }),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedPrepareArchivedContainerTeardown.mockResolvedValueOnce({
      canonicalPath: '/worktrees/project-1/wt-1',
      quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
      alreadyRemoved: true,
      targets: [],
      branchDeletionMode: 'merged-only',
      pendingBranchDeletions: [
        {
          repoId: '__single_repo__',
          referenceRepoPath: '/repos/project-1',
          repositoryIdentity: '/repos/project-1/.git',
          branchName: 'feature/retained',
          expectedTip: '1111111111111111111111111111111111111111',
        },
      ],
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalledWith(
      expect.objectContaining({
        deleteBranches: true,
        branchDeletionMode: 'merged-only',
      }),
    );
    expect(mockedIsAncestor).toHaveBeenCalledWith(
      '/repos/project-1',
      '1111111111111111111111111111111111111111',
      'HEAD',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
  });

  it('clears a journaled deletion when the retry preserves the branch', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches.mockRejectedValueOnce(
      new Error('branch is locked by another process'),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    const pendingBranchDeletions = [
      {
        repoId: '__single_repo__',
        referenceRepoPath: '/repos/project-1',
        repositoryIdentity: '/repos/project-1/.git',
        branchName: 'feature/retained',
        expectedTip: '1111111111111111111111111111111111111111',
      },
    ];
    mockedPrepareArchivedContainerTeardown
      .mockResolvedValueOnce({
        canonicalPath: '/worktrees/project-1/wt-1',
        quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
        alreadyRemoved: false,
        targets: [
          {
            repoId: '__single_repo__',
            referenceRepoPath: '/repos/project-1',
            preMoveRepoPath: '/worktrees/project-1/wt-1',
            quarantineRepoPath: '/worktrees/project-1/.wt-1.archive-quarantine',
            branchName: 'feature/retained',
          },
        ],
        pendingBranchDeletions,
      })
      .mockResolvedValueOnce({
        canonicalPath: '/worktrees/project-1/wt-1',
        quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
        alreadyRemoved: true,
        targets: [],
        pendingBranchDeletions: [],
      });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
      }),
    ).rejects.toThrow('branch is locked by another process');
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ deleteBranches: false }),
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(1);
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('recovers explicit branch deletion after a non-retained retry', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches
      .mockRejectedValueOnce(new Error('branch is locked by another process'))
      .mockResolvedValueOnce(undefined);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/retained')
      .mockRejectedValueOnce(new Error('worktree is gone'));
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
      retainAsArchivedContainer: false,
    } as const;

    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'branch is locked by another process',
    );
    await expect(archiveSingleRepoWorktree(request)).resolves.toEqual({
      success: true,
      warnings: [],
    });

    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(2);
    expect(mockedDeleteBranchIfMatches).toHaveBeenLastCalledWith(
      '/repos/project-1',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
    expect(persistedWorktree.pendingArchiveBranchDeletion).toEqual({
      referenceRepoPath: '/repos/project-1',
      repositoryIdentity: '/repos/project-1/.git',
      branchName: 'feature/retained',
      expectedTip: '1111111111111111111111111111111111111111',
    });
  });

  it('refuses a non-retained deletion retry after the repository path changes', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches.mockRejectedValueOnce(
      new Error('branch is locked by another process'),
    );
    mockedGetCurrentBranch.mockResolvedValue('feature/retained');
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
      retainAsArchivedContainer: false,
    } as const;

    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'branch is locked by another process',
    );
    await expect(
      archiveSingleRepoWorktree({
        ...request,
        repoPath: '/repos/replacement-project-1',
      }),
    ).rejects.toThrow(
      'requested repository does not match the project repository',
    );

    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(1);
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(persistedWorktree.pendingArchiveBranchDeletion).toEqual({
      referenceRepoPath: '/repos/project-1',
      repositoryIdentity: '/repos/project-1/.git',
      branchName: 'feature/retained',
      expectedTip: '1111111111111111111111111111111111111111',
    });
  });

  it('refuses a multi-repo deletion retry after a configured repository is replaced', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos.map((repo) =>
        repo.id === 'repo-a'
          ? { ...repo, repoPath: '/repos/replacement-repo-a' }
          : repo,
      ),
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletions: [
          {
            repoId: 'repo-a',
            referenceRepoPath: '/repos/repo-a',
            repositoryIdentity: '/repos/repo-a/.git',
            branchName: 'feature/retained',
            expectedTip: '1111111111111111111111111111111111111111',
          },
        ],
      },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: true,
        expectedBranchName: 'feature/retained',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'repository "repo-a" no longer matches its pending deletion repository',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('refuses a multi-repo deletion retry after a repository identity changes', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));
    mockedGetGitCommonDir.mockResolvedValue('/identities/replacement.git');
    const pendingDeletion: NonNullable<
      WorktreeData['pendingArchiveBranchDeletions']
    >[number] = {
      repoId: 'repo-a',
      referenceRepoPath: '/repos/repo-a',
      repositoryIdentity: '/identities/original.git',
      branchName: 'feature/retained',
      expectedTip: '1111111111111111111111111111111111111111',
    };
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletions: [pendingDeletion],
      },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow('no longer matches its pending deletion repository');

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
  });

  it('refuses a multi-repo deletion retry for an unknown journaled repository', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletions: [
          {
            repoId: 'forged-repo',
            referenceRepoPath: '/repos/external',
            repositoryIdentity: '/repos/external/.git',
            branchName: 'feature/external',
            expectedTip: '1111111111111111111111111111111111111111',
          },
        ],
      },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'repository "forged-repo" is not part of the project configuration',
    );

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('rejects an advanced branch before a non-retained archive retry removes it', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('git remove failed'));
    mockedGetCurrentBranch.mockResolvedValue('feature/retained');
    mockedResolveRefSha
      .mockResolvedValueOnce('1111111111111111111111111111111111111111')
      .mockResolvedValueOnce('2222222222222222222222222222222222222222');
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
      retainAsArchivedContainer: false,
    } as const;

    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'git remove failed',
    );
    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'Cannot safely delete local branch "feature/retained" because it changed after deletion was confirmed.',
    );

    expect(mockedUpdateWorkspaceWorktree).toHaveBeenCalledTimes(1);
    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(persistedWorktree.pendingArchiveBranchDeletion).toEqual({
      referenceRepoPath: '/repos/project-1',
      repositoryIdentity: '/repos/project-1/.git',
      branchName: 'feature/retained',
      expectedTip: '1111111111111111111111111111111111111111',
    });
  });

  it('completes a non-retained retry when its journaled branch is already gone', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));
    mockedDoesLocalBranchExist.mockResolvedValue(false);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletion: {
          referenceRepoPath: '/repos/project-1',
          repositoryIdentity: '/repos/project-1/.git',
          branchName: 'feature/retained',
          expectedTip: '1111111111111111111111111111111111111111',
        },
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDoesLocalBranchExist).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
    );
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
  });

  it('resumes a journaled single-repo deletion when retry options omit deleteBranch', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletion: {
          referenceRepoPath: '/repos/project-1',
          repositoryIdentity: '/repos/project-1/.git',
          branchName: 'feature/retained',
          expectedTip: '1111111111111111111111111111111111111111',
        },
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalled();
  });

  it('resumes journaled multi-repo deletions when retry options omit deleteBranch', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/root',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletions: [
          {
            repoId: WORKSPACE_ROOT_REPO_ID,
            referenceRepoPath: '/refs/source',
            repositoryIdentity: '/refs/source/.git',
            branchName: 'feature/root',
            expectedTip: '1111111111111111111111111111111111111111',
          },
          {
            repoId: 'repo-a',
            referenceRepoPath: '/repos/repo-a',
            repositoryIdentity: '/repos/repo-a/.git',
            branchName: 'feature/repo-a',
            expectedTip: '1111111111111111111111111111111111111111',
          },
          {
            repoId: 'repo-b',
            referenceRepoPath: '/repos/repo-b',
            repositoryIdentity: '/repos/repo-b/.git',
            branchName: 'feature/repo-b',
            expectedTip: '1111111111111111111111111111111111111111',
          },
        ],
      },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/refs/source',
      'feature/root',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/repo-a',
      'feature/repo-a',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/repo-b',
      'feature/repo-b',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalled();
  });

  it('durably clears a non-retained deletion guard before a preserve retry continues', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches.mockRejectedValueOnce(
      new Error('branch is locked by another process'),
    );
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/retained')
      .mockRejectedValue(new Error('worktree is gone'));
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      retainAsArchivedContainer: false,
    } as const;

    await expect(
      archiveSingleRepoWorktree({ ...request, deleteBranch: true }),
    ).rejects.toThrow('branch is locked by another process');
    expect(persistedWorktree.pendingArchiveBranchDeletion).toEqual({
      referenceRepoPath: '/repos/project-1',
      repositoryIdentity: '/repos/project-1/.git',
      branchName: 'feature/retained',
      expectedTip: '1111111111111111111111111111111111111111',
    });

    mockedCleanupPersistedWorktreeData.mockRejectedValueOnce(
      new Error('cleanup interrupted'),
    );
    await expect(
      archiveSingleRepoWorktree({ ...request, deleteBranch: false }),
    ).rejects.toThrow('cleanup interrupted');
    expect(persistedWorktree.pendingArchiveBranchDeletion).toBeUndefined();

    await expect(
      archiveSingleRepoWorktree({ ...request, deleteBranch: true }),
    ).rejects.toThrow(
      'Cannot safely delete local branch "feature/retained" because its archived tip was not recorded.',
    );
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(1);
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('stops a non-retained preserve retry when its deletion guard cannot be cleared', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletion: {
          referenceRepoPath: '/repos/project-1',
          repositoryIdentity: '/repos/project-1/.git',
          branchName: 'feature/retained',
          expectedTip: '1111111111111111111111111111111111111111',
        },
      },
    ]);
    mockedUpdateWorkspaceWorktree.mockResolvedValue(false);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: false,
        retainAsArchivedContainer: false,
      }),
    ).rejects.toThrow(
      'Cannot safely preserve the local branch because its pending deletion journal could not be cleared.',
    );
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
  });

  it('refuses to delete a replaced branch during a non-retained retry', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranchIfMatches
      .mockRejectedValueOnce(new Error('branch is locked by another process'))
      .mockRejectedValueOnce(
        new Error('branch changed after its deletion was scheduled'),
      );
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/retained')
      .mockRejectedValueOnce(new Error('worktree is gone'));
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    const request = {
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: true,
      retainAsArchivedContainer: false,
    } as const;

    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'branch is locked by another process',
    );
    await expect(archiveSingleRepoWorktree(request)).rejects.toThrow(
      'branch changed after its deletion was scheduled',
    );

    expect(mockedDeleteBranchIfMatches).toHaveBeenNthCalledWith(
      2,
      '/repos/project-1',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('preserves the local branch when the archive action explicitly requests it', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: true }),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      deleteBranch: false,
    });

    expect(mockedDeleteBranch).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('uses merged-only deletion for the saved archive preference', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedDeleteBranch.mockResolvedValue(undefined);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: true }),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
    });

    expect(mockedDeleteBranch).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
    );
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('treats an unmerged merged-only branch as a no-op', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadPreferencesFile.mockResolvedValue(
      makePartialPreferences({ deleteBranchOnArchive: true }),
    );
    mockedDeleteBranch.mockRejectedValueOnce(new Error('branch is unmerged'));
    mockedIsAncestor.mockResolvedValue(false);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/unmerged',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).resolves.toMatchObject({ success: true });
    expect(mockedDeleteBranch).toHaveBeenCalledWith(
      '/repos/project-1',
      'feature/retained',
    );
  });

  it('continues a delete-to-manifest-commit retry and clears the staged descriptor only after the version-2 commit', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedPrepareArchivedContainerTeardown.mockResolvedValueOnce({
      canonicalPath: '/worktrees/project-1/wt-1',
      quarantinePath: '/worktrees/project-1/.wt-1.archive-quarantine',
      alreadyRemoved: true,
      targets: [],
    });
    mockedCleanupWorktreePipelines.mockResolvedValue({
      warnings: [],
      relocatedCount: 2,
      failedRelocationIds: [],
    });
    mockedCountArchivedContainerExecutions.mockResolvedValue(2);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedCaptureArchivedContainerGitState).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'project-1',
        containerId: 'wt-1',
      }),
    );
    expect(mockedPrepareArchivedContainerTeardown).toHaveBeenCalled();
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.anything(),
      expect.objectContaining({
        relocateArtifactsTo: '/archives/project-1/wt-1/pipeline-executions',
      }),
    );
    expect(
      typeof mockedCleanupWorktreePipelines.mock.calls[0]?.[3]
        ?.archiveCaptureExecutor,
    ).toBe('function');
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 2,
        id: 'wt-1',
        executionCount: 2,
      }),
    );
    expect(mockedCompleteArchivedContainerGitCapture).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
    );
    expect(
      mockedCommitArchivedContainer.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockedCompleteArchivedContainerGitCapture.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
  });

  it('archives chats without discarding a partial Git capture after the worktree is gone', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCaptureArchivedContainerGitState.mockRejectedValueOnce(
      new Error('An incomplete archived Git capture requires recovery.'),
    );
    jest.mocked(prepareArchivedContainerRecovery).mockResolvedValueOnce({
      kind: 'files-only',
      source: 'partial',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    const committed = mockedCommitArchivedContainer.mock.calls[0]?.[0];
    expect(committed).toMatchObject({
      version: 3,
      kind: 'worktree',
      id: 'wt-1',
    });
    expect(committed?.originalWorktree).toMatchObject({ id: 'wt-1' });
    const recoveryArgs = jest.mocked(prepareArchivedContainerRecovery).mock
      .calls[0]?.[0];
    expect(recoveryArgs).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'wt-1',
    });
    expect(recoveryArgs?.worktree.id).toBe('wt-1');
    expect(mockedCompleteArchivedContainerGitCapture).not.toHaveBeenCalled();
    expect(mockedDiscardIncompleteArchivedGitCapture).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.objectContaining({ chatSearchDisposition: 'container-archived' }),
    );
  });

  it('archives a restored files-only worktree again without requiring its removed Git pointer', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    mockedLstat.mockImplementation((candidatePath) => {
      if (String(candidatePath).endsWith('/.git')) {
        return Promise.reject(
          Object.assign(new Error('missing Git pointer'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(makeLstatResult(false));
    });
    jest.mocked(prepareArchivedContainerRecovery).mockResolvedValueOnce({
      kind: 'files-only',
      source: 'retained',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedCaptureArchivedContainerGitState).not.toHaveBeenCalled();
    expect(
      jest.mocked(prepareArchivedContainerRecovery).mock.calls[0]?.[0],
    ).toMatchObject({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      worktree: { restoredFromFilesOnlyArchiveId: 'original-archive' },
    });
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, id: 'wt-1' }),
    );
  });

  it('resumes a staged Git capture even if a files-only restore lost its Git pointer again', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    mockedLstat.mockImplementation((candidatePath) =>
      String(candidatePath).endsWith('/.git')
        ? Promise.reject(
            Object.assign(new Error('missing Git pointer'), { code: 'ENOENT' }),
          )
        : Promise.resolve(makeLstatResult(false)),
    );
    const stagedDescriptor: ArchivedGitStagedDescriptor = {
      version: 1,
      status: 'capturing',
      repositories: [],
    };
    mockedReadArchivedGitStagedDescriptor.mockResolvedValueOnce(
      stagedDescriptor,
    );

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      retainAsArchivedContainer: true,
    });

    expect(mockedCaptureArchivedContainerGitState).toHaveBeenCalledTimes(1);
    expect(prepareArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, id: 'wt-1' }),
    );
  });

  it('archives a restored multi-repo files-only worktree when every Git pointer is absent', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    mockReaddirImplementation(
      (candidatePath): Promise<Dirent[] | string[]> =>
        Promise.resolve(
          String(candidatePath).endsWith('/repos') ? ['repo-a', 'repo-b'] : [],
        ),
    );
    mockedLstat.mockImplementation((candidatePath) => {
      if (String(candidatePath).endsWith('/.git')) {
        return Promise.reject(
          Object.assign(new Error('missing Git pointer'), { code: 'ENOENT' }),
        );
      }
      return Promise.resolve(makeLstatResult(false));
    });
    jest.mocked(prepareArchivedContainerRecovery).mockResolvedValueOnce({
      kind: 'files-only',
      source: 'retained',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedCaptureArchivedContainerGitState).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, id: 'wt-1' }),
    );
  });

  it('validates a repaired multi-repo Git pointer after files-only restore', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    mockReaddirImplementation(
      (candidatePath): Promise<Dirent[] | string[]> =>
        Promise.resolve(
          String(candidatePath).endsWith('/repos') ? ['repo-a', 'repo-b'] : [],
        ),
    );
    mockedLstat.mockImplementation((candidatePath) =>
      String(candidatePath).endsWith('/repos/repo-a/.git')
        ? Promise.resolve(makeLstatResult(false))
        : Promise.reject(
            Object.assign(new Error('missing Git pointer'), {
              code: 'ENOENT',
            }),
          ),
    );
    const foreignGitError = new Error(
      'The worktree belongs to a different Git repository.',
    );
    mockedCaptureArchivedContainerGitState.mockRejectedValueOnce(
      foreignGitError,
    );

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: true,
      }),
    ).rejects.toBe(foreignGitError);

    expect(mockedCaptureArchivedContainerGitState).toHaveBeenCalledTimes(1);
    expect(prepareArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
  });

  it('does not treat an unreadable Git pointer as a files-only restore', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    const unreadableGitError = Object.assign(
      new Error('Git pointer is unreadable'),
      { code: 'EACCES' },
    );
    mockedLstat.mockImplementation((candidatePath) =>
      String(candidatePath).endsWith('/.git')
        ? Promise.reject(unreadableGitError)
        : Promise.resolve(makeLstatResult(false)),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).rejects.toBe(unreadableGitError);

    expect(mockedCaptureArchivedContainerGitState).not.toHaveBeenCalled();
    expect(prepareArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
  });

  it('validates installed Git metadata even when the worktree came from files-only recovery', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        restoredFromFilesOnlyArchiveId: 'original-archive',
      },
    ]);
    const foreignGitError = new Error(
      'The worktree belongs to a different Git repository.',
    );
    mockedCaptureArchivedContainerGitState.mockRejectedValueOnce(
      foreignGitError,
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).rejects.toBe(foreignGitError);
    expect(prepareArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
  });

  it('keeps transient Git capture failures retryable instead of committing files-only recovery', async () => {
    const gitCaptureError = Object.assign(new Error('Git command timed out'), {
      code: 'ETIMEDOUT',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCaptureArchivedContainerGitState.mockRejectedValueOnce(
      gitCaptureError,
    );
    jest.mocked(prepareArchivedContainerRecovery).mockResolvedValueOnce({
      kind: 'files-only',
      source: 'retained',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).rejects.toBe(gitCaptureError);

    expect(prepareArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
  });

  it('retries Git capture before reusing a staged files-only recovery journal', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    jest.mocked(readArchivedContainerRecovery).mockResolvedValueOnce({
      kind: 'files-only',
      source: 'retained',
      digest: 'a'.repeat(64),
      payloadId: '11111111-1111-4111-8111-111111111111',
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedCaptureArchivedContainerGitState).toHaveBeenCalledTimes(1);
    expect(readArchivedContainerRecovery).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, id: 'wt-1' }),
    );
  });

  it('reports and throws the files-only recovery failure while retaining the Git capture failure as its cause', async () => {
    const gitCaptureError = new Error(
      'An incomplete archived Git capture requires recovery.',
    );
    const recoveryError = Object.assign(new Error('recovery disk full'), {
      code: 'ENOSPC',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCaptureArchivedContainerGitState.mockRejectedValueOnce(
      gitCaptureError,
    );
    jest
      .mocked(prepareArchivedContainerRecovery)
      .mockRejectedValueOnce(recoveryError);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        retainAsArchivedContainer: true,
      }),
    ).rejects.toBe(recoveryError);

    expect(recoveryError).toMatchObject({ cause: gitCaptureError });
    const report = jest
      .mocked(captureDesktopInstrumentationError)
      .mock.calls.at(-1);
    expect(report?.[1]?.context).toMatchObject({
      operation: 'worktree_archive',
      phase: 'file-recovery',
      code: 'ENOSPC',
    });
  });

  it('discards an incomplete Git capture when deleting a chat whose worktree is still missing', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/deleted',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedLstat.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDiscardIncompleteArchivedGitCapture).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      { allowMissingWorktree: true },
    );
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
  });

  it('preserves the local branch when deleting a chat whose worktree is already missing', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/deleted',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedLstat.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteBranch: true,
        expectedBranchName: 'feature/deleted',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).resolves.toEqual({
      success: true,
      warnings: [
        'The local branch was preserved because its deletion could not be safely verified.',
      ],
    });

    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('preserves local branches when deleting a multi-repo chat whose worktree is already missing', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/deleted',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedLstat.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: true,
        expectedBranchName: 'feature/deleted',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).resolves.toEqual({
      success: true,
      warnings: [
        'Local branches were preserved because their deletion could not be safely verified.',
      ],
    });

    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('retains a delete when the worktree path was recreated before main handles it', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/restored',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDiscardIncompleteArchivedGitCapture).not.toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ version: 2, id: 'wt-1' }),
    );
  });

  it('preserves the worktree record when a missing-path capture cannot be discarded', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/recovery-required',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedLstat.mockRejectedValueOnce(
      Object.assign(new Error('missing'), { code: 'ENOENT' }),
    );
    mockedDiscardIncompleteArchivedGitCapture.mockResolvedValueOnce(false);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        deleteWithoutRetentionIfMissing: true,
      }),
    ).rejects.toThrow('An incomplete archived Git capture requires recovery.');

    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
  });

  it('retains a required archive container even when the worktree is empty', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/required-empty',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      retainAsArchivedContainer: true,
      requireArchivedContainer: true,
    });

    expect(mockedBeginArchivedContainerCapture).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      { expectedCreatedAt: '2026-04-20T00:00:00.000Z' },
    );
    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'wt-1',
        branchName: 'feature/required-empty',
      }),
    );
    expect(mockedCleanupPersistedWorktreeData).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      expect.objectContaining({ chatSearchDisposition: 'container-archived' }),
    );
  });

  it('commits a newly archived worktree as locked when requested', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/locked-archive',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
      retainAsArchivedContainer: true,
      lockAfterArchive: true,
    });

    const committed = mockedCommitArchivedContainer.mock.calls[0]?.[0];
    expect(committed).toBeDefined();
    expect(committed?.id).toBe('wt-1');
    expect(typeof committed?.lockedAt).toBe('string');
    expect(committed?.lockedAt).toBe(committed?.archivedAt);
  });

  it('does not commit retained worktree state when execution relocation fails', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCleanupWorktreePipelines.mockResolvedValue({
      warnings: [
        "Failed to archive pipeline execution 'exec-failed' artifacts; the live artifacts were preserved.",
      ],
      relocatedCount: 0,
      failedRelocationIds: ['exec-failed'],
    });

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow(
      'Failed to archive workflow execution artifacts: exec-failed',
    );

    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
  });

  it('commits the complete staged execution count on a capture retry', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedCleanupWorktreePipelines.mockResolvedValue({
      warnings: [],
      relocatedCount: 0,
      failedRelocationIds: [],
    });
    mockedCountArchivedContainerExecutions.mockResolvedValue(2);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
    });

    expect(mockedCommitArchivedContainer).toHaveBeenCalledWith(
      expect.objectContaining({ executionCount: 2 }),
    );
  });

  it('omits generated default branches from retained manifests', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/repos/project-1',
    });

    const committed = mockedCommitArchivedContainer.mock.calls[0]?.[0];
    expect(committed).toBeDefined();
    expect(committed).not.toHaveProperty('branchName');
  });

  it('does not commit a retained manifest when worktree teardown fails', async () => {
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedRemoveWorktree.mockRejectedValue(new Error('git remove failed'));
    mockedIsRegisteredWorktreePath.mockResolvedValue(true);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('git remove failed');

    expect(mockedBeginArchivedContainerCapture).toHaveBeenCalled();
    expect(mockedCommitArchivedContainer).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
  });

  it('records worktree_deleted after a multi-repo archive succeeds', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/repos/source',
      repos: buildMultiRepoWorkspace().repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
      },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    const [event] = recordedUsageEvents();
    expect(event).toMatchObject({
      type: 'worktree_deleted',
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      deletedWithChanges: true,
    });
    expect(event?.type === 'worktree_deleted' ? event.repos : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ repoId: WORKSPACE_ROOT_REPO_ID }),
        expect.objectContaining({ repoId: 'repo-a' }),
        expect.objectContaining({ repoId: 'repo-b' }),
      ]),
    );
  });

  it('waits for every repository turn-diff cleanup before finalizing a multi-repo archive', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/repos/source',
      repos: buildMultiRepoWorkspace().repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    const heldCleanup = createDeferred<undefined>();
    let heldCleanupFinished = false;
    jest
      .mocked(cleanupPersistedTurnDiffTreeRefs)
      .mockRejectedValueOnce(new Error('repo-a turn-diff cleanup failed'))
      .mockImplementationOnce(async () => {
        await heldCleanup.promise;
        heldCleanupFinished = true;
      });
    let settled = false;
    const archive = archiveMultiRepoWorktree({
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
    }).finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(cleanupPersistedTurnDiffTreeRefs).toHaveBeenNthCalledWith(
      1,
      '/repos/repo-a',
      'workspace-1',
      'wt-1',
    );
    expect(cleanupPersistedTurnDiffTreeRefs).toHaveBeenNthCalledWith(
      2,
      '/repos/repo-b',
      'workspace-1',
      'wt-1',
    );
    expect(settled).toBe(false);
    expect(recordedUsageEvents()).toEqual([]);

    heldCleanup.resolve(undefined);
    await expect(archive).resolves.toMatchObject({ success: true });
    expect(heldCleanupFinished).toBe(true);
    expect(recordedUsageEvents()).toEqual([
      expect.objectContaining({ type: 'worktree_deleted' }),
    ]);
  });

  it('waits for the worktree read before rejecting an invalid project config', async () => {
    const heldWorktrees = createDeferred<WorktreeData[]>();
    let worktreeReadFinished = false;
    mockedReadEffectiveWorkspaceConfig.mockRejectedValueOnce(
      new Error('Invalid canopy.json'),
    );
    mockedReadWorkspaceWorktrees.mockImplementationOnce(async () => {
      const worktrees = await heldWorktrees.promise;
      worktreeReadFinished = true;
      return worktrees;
    });
    let settled = false;
    const record = getWorktreeCliRecord('project-1', 'wt-1').finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedReadWorkspaceWorktrees).toHaveBeenCalledWith('project-1');
    expect(settled).toBe(false);

    heldWorktrees.resolve(buildWorkspace().worktrees);
    await expect(record).rejects.toThrow('Invalid canopy.json');
    expect(worktreeReadFinished).toBe(true);
  });

  it('waits for every repository fetch before rejecting a missing multi-repo base branch', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    const heldFetch = createDeferred<undefined>();
    let heldFetchFinished = false;
    mockedFetchOrigin.mockImplementation(async (repoPath) => {
      if (repoPath === '/repos/repo-a') {
        await heldFetch.promise;
        heldFetchFinished = true;
      }
    });
    mockedDoesRemoteBranchExist.mockImplementation((repoPath) =>
      Promise.resolve(repoPath !== '/repos/repo-b'),
    );
    let settled = false;
    const created = createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      baseBranch: 'origin/main',
    }).finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/repo-a');
    expect(mockedDoesRemoteBranchExist).toHaveBeenCalledWith(
      '/repos/repo-b',
      'main',
    );
    expect(settled).toBe(false);

    heldFetch.resolve(undefined);
    await expect(created).rejects.toThrow(
      'Base branch "origin/main" was not found',
    );
    expect(heldFetchFinished).toBe(true);
  });

  it('waits for every mapped repository fetch before rejecting an unknown repo', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    const heldFetch = createDeferred<undefined>();
    let heldFetchFinished = false;
    mockedFetchOrigin.mockImplementation(async (repoPath) => {
      if (repoPath === '/repos/repo-a') {
        await heldFetch.promise;
        heldFetchFinished = true;
      }
    });
    mockedDoesRemoteBranchExist.mockResolvedValue(true);
    let settled = false;
    const created = createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      baseBranchesByRepo: {
        'repo-a': 'origin/main',
        'repo-unknown': 'main',
      },
    }).finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/repo-a');
    expect(settled).toBe(false);

    heldFetch.resolve(undefined);
    await expect(created).rejects.toThrow(
      'Base branch was provided for unknown repo "repo-unknown"',
    );
    expect(heldFetchFinished).toBe(true);
  });

  it('waits for every worktree stats fetch before rejecting a missing CLI row', async () => {
    const workspace = buildWorkspace();
    const [firstWorktree] = workspace.worktrees;
    workspace.worktrees = [
      firstWorktree,
      { ...firstWorktree, id: 'wt-2', branchName: 'feature/wt-2' },
    ];
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    // The listing sees both rows; the per-row reads see wt-2 already removed.
    mockedReadWorkspaceWorktrees
      .mockResolvedValueOnce(workspace.worktrees)
      .mockResolvedValue([firstWorktree]);
    const heldFetch = createDeferred<undefined>();
    let heldFetchFinished = false;
    mockedFetchOrigin.mockImplementation(async (repoPath) => {
      if (repoPath === '/worktrees/project-1/wt-1') {
        await heldFetch.promise;
        heldFetchFinished = true;
      }
    });
    let settled = false;
    const rows = listWorktreeCliRows('project-1').finally(() => {
      settled = true;
    });

    for (let turn = 0; turn < 50; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    expect(mockedFetchOrigin).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      expect.anything(),
    );
    expect(settled).toBe(false);

    heldFetch.resolve(undefined);
    await expect(rows).rejects.toThrow('Worktree wt-2 not found');
    expect(heldFetchFinished).toBe(true);
  });

  it('refuses to delete a replaced child branch during a non-retained multi-repo retry', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    let checkoutGone = false;
    mockedGetCurrentBranch.mockImplementation(() =>
      checkoutGone
        ? Promise.reject(new Error('worktree is gone'))
        : Promise.resolve('feature/retained'),
    );
    mockedDeleteBranchIfMatches
      .mockRejectedValueOnce(new Error('branch is locked by another process'))
      .mockRejectedValueOnce(
        new Error('branch changed after its deletion was scheduled'),
      );
    const request = {
      workspaceId: 'workspace-1',
      worktreeId: 'wt-1',
      deleteBranch: true,
      retainAsArchivedContainer: false,
    } as const;

    await expect(archiveMultiRepoWorktree(request)).rejects.toThrow(
      'branch is locked by another process',
    );
    checkoutGone = true;
    await expect(archiveMultiRepoWorktree(request)).rejects.toThrow(
      'branch changed after its deletion was scheduled',
    );

    expect(mockedDeleteBranchIfMatches).toHaveBeenNthCalledWith(
      2,
      '/repos/repo-a',
      'feature/retained',
      '1111111111111111111111111111111111111111',
    );
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('clears non-retained multi-repo deletion guards when a retry preserves branches', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    let persistedWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/retained',
      createdAt: '2026-04-20T00:00:00.000Z',
      pendingArchiveBranchDeletions: [
        {
          repoId: 'repo-a',
          referenceRepoPath: '/repos/repo-a',
          repositoryIdentity: '/repos/repo-a/.git',
          branchName: 'feature/retained',
          expectedTip: '1111111111111111111111111111111111111111',
        },
      ],
    };
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve([persistedWorktree]),
    );
    mockedUpdateWorkspaceWorktree.mockImplementation(
      (_workspaceId, _worktreeId, updater) => {
        persistedWorktree = updater(persistedWorktree);
        return Promise.resolve(true);
      },
    );
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: false,
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(persistedWorktree.pendingArchiveBranchDeletions).toBeUndefined();
    expect(mockedDeleteBranchIfMatches).not.toHaveBeenCalled();
    expect(mockedForceDeleteBranch).not.toHaveBeenCalled();
  });

  it('drops malformed multi-repo deletion guards before retrying Git deletion', async () => {
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedResolveContainerRetentionDays.mockResolvedValue(7);
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/retained',
        createdAt: '2026-04-20T00:00:00.000Z',
        pendingArchiveBranchDeletions: [
          {
            repoId: 'repo-a',
            referenceRepoPath: '/repos/repo-a',
            repositoryIdentity: '/repos/repo-a/.git',
            branchName: ' feature/retained ',
            expectedTip: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          },
          {
            repoId: 'repo-b',
            referenceRepoPath: 'relative/repo-b',
            repositoryIdentity: 'relative/repo-b/.git',
            branchName: '-invalid',
            expectedTip: 'not-a-git-object',
          },
        ],
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValue(new Error('worktree is gone'));

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
        deleteBranch: true,
        retainAsArchivedContainer: false,
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledTimes(1);
    expect(mockedDeleteBranchIfMatches).toHaveBeenCalledWith(
      '/repos/repo-a',
      'feature/retained',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
  });

  it('returns persisted worktree details, PR snapshot, path, and diff stats', async () => {
    const record = await getWorktreeCliRecord('project-1', 'wt-1');

    expect(record).toMatchObject({
      workspaceId: 'project-1',
      workspaceName: 'Project One',
      workspaceType: 'single-repo',
      id: 'wt-1',
      branchName: 'feature/wt-1',
      path: '/worktrees/project-1/wt-1',
      branchPromptSent: true,
      trackedBaseBranch: 'main',
      seenPipelineExecutionIds: ['exec-seen'],
      pausedHookKeys: ['pre-commit'],
      lastKnownPrStatus: {
        repos: [
          {
            repoId: 'project-1',
            status: {
              prNumber: 12,
              state: 'open',
            },
          },
        ],
      },
      stats: {
        projectId: 'project-1',
        worktreeId: 'wt-1',
        insertions: 4,
        deletions: 2,
        branchName: 'feature/wt-1',
        baseBranch: 'main',
        baseBranchExistsLocally: true,
        baseBranchExistsInRemote: true,
        hasOriginRemote: true,
        hasCommitsAhead: true,
        hasRemoteTrackingBranch: true,
        hasBranchBeenPushed: true,
        canopyJsonHash: 'canopy-hash',
      },
    });
  });

  it('returns zero stats and persists a health issue before running git stats', async () => {
    const issue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'invalid-git-worktree',
      message:
        'Git metadata for this worktree is incomplete or points to a missing location.',
      checkedAt: '2026-04-22T00:00:00.000Z',
      worktreePath: '/worktrees/project-1/wt-1',
      gitError: 'Missing gitdir target: /missing',
    };
    mockedValidateWorktreeHealth.mockResolvedValue(issue);

    await expect(getWorktreeStats('project-1', 'wt-1')).resolves.toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      insertions: 0,
      deletions: 0,
      healthIssue: issue,
    });

    expect(mockedRecordWorktreeHealth).toHaveBeenCalledWith({
      source: 'diff-stats',
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      issue,
    });
    expect(mockedGetDiffStats).not.toHaveBeenCalled();
  });

  it('treats a git-pending reservation as incomplete instead of unhealthy', async () => {
    const workspace = buildWorkspace();
    workspace.worktrees = [
      {
        ...workspace.worktrees[0],
        setupPhase: 'git-pending',
      },
    ];
    mockedListWorkspaceItems.mockResolvedValue([workspace]);

    await expect(getWorktreeStats('project-1', 'wt-1')).resolves.toEqual({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      insertions: 0,
      deletions: 0,
    });

    expect(mockedValidateWorktreeHealth).not.toHaveBeenCalled();
    expect(mockedRecordWorktreeHealth).not.toHaveBeenCalled();
    expect(mockedGetDiffStats).not.toHaveBeenCalled();
  });

  it('clears a stale persisted health issue when normal stats validate', async () => {
    const issue: WorktreeHealthIssue = {
      status: 'broken',
      code: 'missing-git-metadata',
      message: 'Git metadata is missing for this worktree.',
      checkedAt: '2026-04-22T00:00:00.000Z',
      worktreePath: '/worktrees/project-1/wt-1',
    };
    const workspace = buildWorkspace();
    workspace.worktrees = [
      {
        ...workspace.worktrees[0],
        healthIssue: issue,
      },
    ];
    mockedListWorkspaceItems.mockResolvedValue([workspace]);

    await getWorktreeStats('project-1', 'wt-1');

    expect(mockedRecordWorktreeHealth).toHaveBeenCalledWith({
      source: 'diff-stats',
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      issue: null,
    });
    expect(mockedGetDiffStats).toHaveBeenCalled();
  });

  it('skips the network git fetch when skipFetch is set', async () => {
    const restorePlatform = setPlatform('darwin');
    try {
      // Default setup is a healthy single-repo worktree with an origin remote.
      await getWorktreeStats('project-1', 'wt-1');
      expect(mockedFetchOrigin).toHaveBeenCalledWith(
        '/worktrees/project-1/wt-1',
        {
          prune: true,
          ttlMs: 5 * 60_000,
        },
      );
    } finally {
      restorePlatform();
    }

    mockedFetchOrigin.mockClear();
    mockedGetDiffStats.mockClear();

    await getWorktreeStats('project-1', 'wt-1', { skipFetch: true });
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenLastCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoPath: '/worktrees/project-1/wt-1',
      allowRemoteLookup: false,
    });
    expect(mockedResolveRepoDefaultBranch).toHaveBeenLastCalledWith(
      '/worktrees/project-1/wt-1',
      { allowRemoteLookup: false },
    );
    // Local diff stats are still computed without the network fetch.
    expect(mockedGetDiffStats).toHaveBeenCalled();
  });

  it('collects diff-only stats without full-stat side effects', async () => {
    const workspace = buildWorkspace();
    workspace.worktrees[0].trackedBaseBranch = 'develop';
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedGetDiffStats.mockResolvedValue({ insertions: 7, deletions: 3 });

    await expect(
      getWorktreeDiffStatsOnly('project-1', 'wt-1'),
    ).resolves.toEqual({ insertions: 7, deletions: 3 });
    expect(mockedGetDiffStats).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      'develop',
    );
    expect(mockedValidateWorktreeHealth).not.toHaveBeenCalled();
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedResolveEffectiveBaseBranchForRepo).not.toHaveBeenCalled();
    expect(mockedResolveRepoDefaultBranch).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'worktree_stats_timing',
        worktreeStatsMode: 'diff_only',
      }),
    );
  });

  it('uses a locally resolved base for diff-only stats when tracking is absent', async () => {
    const workspace = buildWorkspace();
    workspace.worktrees[0].trackedBaseBranch = undefined;
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: 'main',
      existsLocally: true,
      existsInRemote: false,
    });

    await getWorktreeDiffStatsOnly('project-1', 'wt-1');

    expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: 'wt-1',
      repoId: undefined,
      repoPath: '/worktrees/project-1/wt-1',
      allowRemoteLookup: false,
    });
    expect(mockedGetDiffStats).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      'main',
    );
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('retains HEAD-only diff stats when no local base can be resolved', async () => {
    const workspace = buildWorkspace();
    workspace.worktrees[0].trackedBaseBranch = undefined;
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedResolveEffectiveBaseBranchForRepo.mockResolvedValue({
      branch: null,
      existsLocally: false,
      existsInRemote: false,
    });

    await getWorktreeDiffStatsOnly('project-1', 'wt-1');

    expect(mockedGetDiffStats).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      undefined,
    );
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedUpdateWorkspaceWorktree).not.toHaveBeenCalled();
  });

  it('records diff-only timing when collection fails', async () => {
    mockedGetDiffStats.mockRejectedValue(new Error('git unavailable'));

    await expect(getWorktreeDiffStatsOnly('project-1', 'wt-1')).rejects.toThrow(
      'git unavailable',
    );

    expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'worktree_stats_timing',
        worktreeStatsMode: 'diff_only',
        worktreeStatsOutcome: 'failure',
      }),
    );
  });

  it('uses canonical checkout entries for multi-repo diff-only stats', async () => {
    const workspace = {
      ...buildMultiRepoWorkspace(),
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-20T00:00:00.000Z',
          trackedRepoBaseBranches: {
            [WORKSPACE_ROOT_REPO_ID]: 'main',
            'repo-ready': 'develop',
            'repo-suppressed': 'main',
            'repo-pending': 'main',
          },
        },
      ],
    };
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: WORKSPACE_ROOT_REPO_ID,
        repoName: 'Workspace Root',
        repoPath: '/workspace-worktrees/project-1/wt-1/root',
      },
      {
        repoId: 'repo-ready',
        repoName: 'Ready',
        repoPath: '/workspace-worktrees/project-1/wt-1/root/repos/repo-ready',
      },
    ]);
    mockedGetDiffStats
      .mockResolvedValueOnce({ insertions: 5, deletions: 1 })
      .mockResolvedValueOnce({ insertions: 2, deletions: 3 });

    await expect(
      getWorktreeDiffStatsOnly('workspace-1', 'wt-1'),
    ).resolves.toEqual({ insertions: 7, deletions: 4 });
    expect(mockedListWorkspaceWorktreeRepoEntries).toHaveBeenCalledWith(
      'workspace-1',
      '/workspace-worktrees/workspace-1/wt-1/root',
    );
    expect(mockedGetDiffStats.mock.calls).toEqual([
      ['/workspace-worktrees/project-1/wt-1/root', 'main'],
      ['/workspace-worktrees/project-1/wt-1/root/repos/repo-ready', 'develop'],
    ]);
  });

  it('records slow worktree stats with git and diff timing', async () => {
    const nowSpy = jest
      .spyOn(performance, 'now')
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(50)
      .mockReturnValueOnce(150)
      .mockReturnValueOnce(300);
    try {
      await getWorktreeStats('project-1', 'wt-1');

      expect(recordSessionDiagnosticMock).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'worktree_stats_timing',
          projectId: 'project-1',
          worktreeId: 'wt-1',
          elapsedMs: 300,
          diffStatsElapsedMs: 100,
          worktreeStatsMode: 'full',
        }),
      );
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('reuses the effective branch as the default for an untracked single-repo worktree', async () => {
    const workspace = buildWorkspace();
    workspace.worktrees[0].trackedBaseBranch = undefined;
    mockedListWorkspaceItems.mockResolvedValue([workspace]);

    const stats = await getWorktreeStats('project-1', 'wt-1');

    expect(stats.defaultBranch).toBe('main');
    expect(mockedResolveEffectiveBaseBranchForRepo).toHaveBeenCalledTimes(1);
    expect(mockedResolveRepoDefaultBranch).not.toHaveBeenCalled();
  });

  it('joins concurrent worktree-stat requests with the same freshness mode', async () => {
    const diffStatsDeferred = createDeferred<{
      insertions: number;
      deletions: number;
    }>();
    mockedGetDiffStats.mockReturnValue(diffStatsDeferred.promise);

    const first = getWorktreeStats('project-1', 'wt-1', { skipFetch: true });
    const second = getWorktreeStats('project-1', 'wt-1', {
      skipFetch: true,
    });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(mockedGetDiffStats).toHaveBeenCalledTimes(1);
    diffStatsDeferred.resolve({ insertions: 4, deletions: 2 });

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toEqual(firstResult);
    expect(mockedValidateWorktreeHealth).toHaveBeenCalledTimes(1);
    expect(mockedGetDiffStats).toHaveBeenCalledTimes(1);
  });

  it('reuses a completed fresh result for stale-ok and cache-only consumers', async () => {
    const fresh = await getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    const staleOk = await getWorktreeStats('project-1', 'wt-1', {
      freshness: 'stale-ok',
    });
    const cacheOnly = await getWorktreeStats('project-1', 'wt-1', {
      freshness: 'cache-only',
    });

    expect(staleOk).toEqual(fresh);
    expect(cacheOnly).toEqual(fresh);
    expect(mockedValidateWorktreeHealth).toHaveBeenCalledTimes(1);
    expect(mockedGetDiffStats).toHaveBeenCalledTimes(1);
    expect(mockedFetchOrigin).not.toHaveBeenCalled();
  });

  it('does not reuse completed stats after persisted computation inputs change', async () => {
    const workspace = buildWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);

    await expect(
      getWorktreeStats('project-1', 'wt-1', { freshness: 'fresh-local' }),
    ).resolves.toMatchObject({ insertions: 4, deletions: 2 });

    const worktree = workspace.worktrees[0];
    if (!worktree) {
      throw new Error('Expected worktree fixture');
    }
    worktree.trackedBaseBranch = 'release';

    await expect(
      getWorktreeStats('project-1', 'wt-1', { freshness: 'cache-only' }),
    ).resolves.toBeNull();

    mockedGetDiffStats.mockResolvedValue({ insertions: 9, deletions: 3 });
    await expect(
      getWorktreeStats('project-1', 'wt-1', { freshness: 'fresh-local' }),
    ).resolves.toMatchObject({ insertions: 9, deletions: 3 });
    expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);
  });

  it('does not join in-flight stats after persisted computation inputs change', async () => {
    const workspace = buildWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    const diffResolvers: Array<
      (stats: { insertions: number; deletions: number }) => void
    > = [];
    mockedGetDiffStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          diffResolvers.push(resolve);
        }),
    );

    const older = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(1);

    const worktree = workspace.worktrees[0];
    if (!worktree) {
      throw new Error('Expected worktree fixture');
    }
    worktree.trackedBaseBranch = 'release';
    const newer = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(2);

    diffResolvers[1]?.({ insertions: 9, deletions: 3 });
    await expect(newer).resolves.toMatchObject({ insertions: 9, deletions: 3 });
    diffResolvers[0]?.({ insertions: 1, deletions: 1 });
    await expect(older).resolves.toMatchObject({ insertions: 1, deletions: 1 });

    await expect(
      getWorktreeStats('project-1', 'wt-1', { freshness: 'cache-only' }),
    ).resolves.toMatchObject({ insertions: 9, deletions: 3 });
  });

  it('lets a stale-ok consumer join an active remote-capable generation', async () => {
    const restorePlatform = setPlatform('darwin');
    const diffStatsDeferred = createDeferred<{
      insertions: number;
      deletions: number;
    }>();
    mockedGetDiffStats.mockReturnValue(diffStatsDeferred.promise);

    try {
      const remote = getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-remote',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      const structural = getWorktreeStats('project-1', 'wt-1', {
        freshness: 'stale-ok',
      });

      expect(mockedGetDiffStats).toHaveBeenCalledTimes(1);
      expect(mockedFetchOrigin).toHaveBeenCalledTimes(1);
      diffStatsDeferred.resolve({ insertions: 4, deletions: 2 });
      const [remoteResult, structuralResult] = await Promise.all([
        remote,
        structural,
      ]);
      expect(structuralResult).toEqual(remoteResult);
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it('does not start local revalidation when stale data has a remote refresh', async () => {
    const restorePlatform = setPlatform('darwin');
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const initial = await getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-local',
      });
      expect(initial).toMatchObject({ insertions: 4, deletions: 2 });

      now += 6_000;
      const remoteDiffStats = createDeferred<{
        insertions: number;
        deletions: number;
      }>();
      mockedGetDiffStats.mockReturnValue(remoteDiffStats.promise);
      const remote = getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-remote',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const stale = await getWorktreeStats('project-1', 'wt-1', {
        freshness: 'stale-ok',
      });
      expect(stale).toMatchObject({ insertions: 4, deletions: 2 });
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);

      remoteDiffStats.resolve({ insertions: 9, deletions: 3 });
      await expect(remote).resolves.toMatchObject({
        insertions: 9,
        deletions: 3,
      });
      await expect(
        getWorktreeStats('project-1', 'wt-1', { freshness: 'cache-only' }),
      ).resolves.toMatchObject({ insertions: 9, deletions: 3 });
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
      restorePlatform();
    }
  });

  it('serves bounded stale data while one local revalidation refreshes the cache', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const initial = await getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-local',
      });
      expect(initial).toMatchObject({ insertions: 4, deletions: 2 });

      now += 6_000;
      mockedGetDiffStats.mockResolvedValue({ insertions: 9, deletions: 3 });
      const stale = await getWorktreeStats('project-1', 'wt-1', {
        freshness: 'stale-ok',
      });
      expect(stale).toMatchObject({ insertions: 4, deletions: 2 });

      let refreshed = null;
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        refreshed = await getWorktreeStats('project-1', 'wt-1', {
          freshness: 'cache-only',
        });
        if (refreshed?.insertions === 9) break;
      }
      expect(refreshed).toMatchObject({ insertions: 9, deletions: 3 });
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('waits for fresh local stats after the maximum stale bound', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      await getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-local',
      });
      now += 61_000;
      mockedGetDiffStats.mockResolvedValue({ insertions: 8, deletions: 5 });

      await expect(
        getWorktreeStats('project-1', 'wt-1', {
          freshness: 'stale-ok',
        }),
      ).resolves.toMatchObject({ insertions: 8, deletions: 5 });
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('returns a cache-only miss without launching git stats', async () => {
    await expect(
      getWorktreeStats('project-1', 'wt-1', {
        freshness: 'cache-only',
      }),
    ).resolves.toBeNull();

    expect(mockedValidateWorktreeHealth).not.toHaveBeenCalled();
    expect(mockedGetDiffStats).not.toHaveBeenCalled();
  });

  it('does not let an invalidated older generation overwrite newer completed stats', async () => {
    const diffResolvers: Array<
      (stats: { insertions: number; deletions: number }) => void
    > = [];
    mockedGetDiffStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          diffResolvers.push(resolve);
        }),
    );

    const older = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(1);

    invalidateWorktreeStats('project-1', 'wt-1');
    const newer = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(2);

    diffResolvers[1]?.({ insertions: 9, deletions: 3 });
    await expect(newer).resolves.toMatchObject({
      insertions: 9,
      deletions: 3,
    });
    diffResolvers[0]?.({ insertions: 1, deletions: 1 });
    await expect(older).resolves.toMatchObject({
      insertions: 1,
      deletions: 1,
    });

    await expect(
      getWorktreeStats('project-1', 'wt-1', {
        freshness: 'cache-only',
      }),
    ).resolves.toMatchObject({ insertions: 9, deletions: 3 });
  });

  it('preserves newer cached stats when invalidation occurs during identity resolution', async () => {
    const workspace = buildWorkspace();
    const blockedIdentityRead = createDeferred<SidebarItem[]>();
    mockedListWorkspaceItems
      .mockImplementationOnce(() => blockedIdentityRead.promise)
      .mockResolvedValue([workspace]);
    const diffResolvers: Array<
      (stats: { insertions: number; deletions: number }) => void
    > = [];
    mockedGetDiffStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          diffResolvers.push(resolve);
        }),
    );

    const older = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    invalidateWorktreeStats('project-1', 'wt-1');
    const newer = getWorktreeStats('project-1', 'wt-1', {
      freshness: 'fresh-local',
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(1);
    diffResolvers[0]?.({ insertions: 9, deletions: 3 });
    await expect(newer).resolves.toMatchObject({ insertions: 9, deletions: 3 });

    blockedIdentityRead.resolve([workspace]);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(diffResolvers).toHaveLength(2);
    await expect(
      getWorktreeStats('project-1', 'wt-1', { freshness: 'cache-only' }),
    ).resolves.toMatchObject({ insertions: 9, deletions: 3 });

    diffResolvers[1]?.({ insertions: 9, deletions: 3 });
    await expect(older).resolves.toMatchObject({ insertions: 9, deletions: 3 });
  });

  it('does not join local-only and remote-capable worktree-stat requests', async () => {
    const restorePlatform = setPlatform('darwin');
    try {
      const localRequest = getWorktreeStats('project-1', 'wt-1', {
        skipFetch: true,
      });
      const remoteRequest = getWorktreeStats('project-1', 'wt-1');

      await Promise.all([localRequest, remoteRequest]);

      expect(mockedValidateWorktreeHealth).toHaveBeenCalledTimes(2);
      expect(mockedGetDiffStats).toHaveBeenCalledTimes(2);
      expect(mockedFetchOrigin).toHaveBeenCalledTimes(1);
    } finally {
      restorePlatform();
    }
  });

  it('does not let an older local computation overwrite newer remote stats', async () => {
    const restorePlatform = setPlatform('darwin');
    const diffResolvers: Array<
      (stats: { insertions: number; deletions: number }) => void
    > = [];
    mockedGetDiffStats.mockImplementation(
      () =>
        new Promise((resolve) => {
          diffResolvers.push(resolve);
        }),
    );

    try {
      const olderLocal = getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-local',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(diffResolvers).toHaveLength(1);

      const newerRemote = getWorktreeStats('project-1', 'wt-1', {
        freshness: 'fresh-remote',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(diffResolvers).toHaveLength(2);

      diffResolvers[1]?.({ insertions: 9, deletions: 3 });
      await expect(newerRemote).resolves.toMatchObject({
        insertions: 9,
        deletions: 3,
      });

      diffResolvers[0]?.({ insertions: 1, deletions: 1 });
      await expect(olderLocal).resolves.toMatchObject({
        insertions: 1,
        deletions: 1,
      });

      await expect(
        getWorktreeStats('project-1', 'wt-1', { freshness: 'cache-only' }),
      ).resolves.toMatchObject({ insertions: 9, deletions: 3 });
    } finally {
      restorePlatform();
    }
  });

  it('prunes deleted remote branches during multi-repo stats refreshes', async () => {
    const restorePlatform = setPlatform('darwin');
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/worktrees/workspace-1/wt-1/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath: '/worktrees/workspace-1/wt-1/repo-b',
      },
    ]);

    try {
      await aggregateMultiRepoDiffStats(
        'workspace-1',
        'wt-1',
        '/worktrees/workspace-1/wt-1',
      );

      expect(mockedFetchOrigin).toHaveBeenCalledWith(
        '/worktrees/workspace-1/wt-1/repo-a',
        {
          prune: true,
          ttlMs: 5 * 60_000,
        },
      );
      expect(mockedFetchOrigin).toHaveBeenCalledWith(
        '/worktrees/workspace-1/wt-1/repo-b',
        {
          prune: true,
          ttlMs: 5 * 60_000,
        },
      );
    } finally {
      restorePlatform();
    }
  });

  it('keeps multi-repo skipFetch stats local-only during base resolution', async () => {
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/worktrees/workspace-1/wt-1/repo-a',
      },
    ]);

    await aggregateMultiRepoDiffStats(
      'workspace-1',
      'wt-1',
      '/worktrees/workspace-1/wt-1',
      { skipFetch: true },
    );

    expect(mockedFetchOrigin).not.toHaveBeenCalled();
    expect(mockedResolveEffectiveBaseBranchesForWorktree).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: 'wt-1',
      cwd: '/worktrees/workspace-1/wt-1',
      allowRemoteLookup: false,
    });
  });

  it('skips automatic network git fetches on Windows', async () => {
    const restorePlatform = setPlatform('win32');

    try {
      await getWorktreeStats('project-1', 'wt-1');

      expect(mockedFetchOrigin).not.toHaveBeenCalled();
      expect(mockedGetDiffStats).toHaveBeenCalled();
    } finally {
      restorePlatform();
    }
  });

  it('lists CLI pipeline executions from the default CLI runtime and filters by project and worktree', async () => {
    mockedListExecutionSummaries.mockResolvedValue([
      {
        id: 'match',
        pipeline_id: 'pipeline-match',
        pipeline_name: 'Matching Pipeline',
        status: 'success',
        status_reasons: [],
        project_id: 'project-1',
        worktree_id: 'wt-1',
        started_at: '2026-04-20T00:00:00.000Z',
        cwd: '/worktrees/project-1/wt-1',
      },
      {
        id: 'other-worktree',
        pipeline_id: 'pipeline-other-worktree',
        pipeline_name: 'Other Worktree',
        status: 'success',
        status_reasons: [],
        project_id: 'project-1',
        worktree_id: 'wt-2',
        started_at: '2026-04-20T00:00:00.000Z',
        cwd: '/worktrees/project-1/wt-2',
      },
      {
        id: 'other-project',
        pipeline_id: 'pipeline-other-project',
        pipeline_name: 'Other Project',
        status: 'success',
        status_reasons: [],
        project_id: 'project-2',
        worktree_id: 'wt-1',
        started_at: '2026-04-20T00:00:00.000Z',
        cwd: '/worktrees/project-2/wt-1',
      },
    ]);

    await expect(
      listWorktreePipelineExecutions({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual([
      {
        id: 'match',
        pipelineName: 'Matching Pipeline',
        status: 'success',
      },
    ]);

    expect(mockedCreateCliExecutionRuntime).toHaveBeenCalledWith({
      cwd: process.cwd(),
    });
    expect(mockedListExecutionSummaries).toHaveBeenCalledWith(
      '/cli/executions',
    );
  });

  it('rejects pipeline execution listing for an unknown worktree', async () => {
    await expect(
      listWorktreePipelineExecutions({
        workspaceId: 'project-1',
        worktreeId: 'wt-missing',
      }),
    ).rejects.toThrow('Worktree wt-missing not found');

    expect(mockedCreateCliExecutionRuntime).not.toHaveBeenCalled();
    expect(mockedListExecutionSummaries).not.toHaveBeenCalled();
  });

  it('retains the multi-repo worktree directory when child repo creation fails', async () => {
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedCreateWorktree
      .mockResolvedValueOnce('feature/shared')
      .mockResolvedValueOnce('feature/shared')
      .mockRejectedValueOnce(new Error('repo b failed'));

    await expect(
      createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        existingWorktreeIds: [],
      }),
    ).rejects.toThrow('repo b failed');

    expectNoRobustWorktreeRemoveCall(
      /^\/workspace-worktrees\/workspace-1\/[^/]+$/,
    );
    expectNoRobustWorktreeRemoveCall(
      /^\/workspace-worktrees\/workspace-1\/[^/]+\/root$/,
    );
  });

  it('creates worktrees for local-only temporary multi-repo projects without a root git worktree', async () => {
    mockedCreateWorktree.mockImplementation((_repoPath, _path, branch) =>
      Promise.resolve(branch),
    );
    mockedListWorkspaceItems.mockResolvedValue([
      buildTemporaryMultiRepoWorkspace(),
    ]);

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(created.id).toBe('generated-worktree');
    expect(created.branchName).toMatch(/^generated-worktree-\d+$/);
    expect(mockedResolveWorkspaceReferenceRepoPath).not.toHaveBeenCalled();
    expect(mockedValidateWorkspaceRootWorktree).not.toHaveBeenCalled();
    expect(mockedCreateWorktree).toHaveBeenCalledTimes(2);
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-a',
      created.branchName,
    );
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/repo-b',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-b',
      created.branchName,
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalledWith(
      expect.anything(),
      '/workspace-worktrees/workspace-1/generated-worktree/root',
      expect.anything(),
    );
  });

  it('branches local-only temporary multi-repo worktrees from the selected child repo branches', async () => {
    mockedListWorkspaceItems.mockResolvedValue([
      buildTemporaryMultiRepoWorkspace(),
    ]);
    mockedListWorkspaceWorktreeRepoEntries.mockResolvedValue([
      {
        repoId: 'repo-a',
        repoName: 'Repo A',
        repoPath: '/workspace-worktrees/workspace-1/base/repos/repo-a',
      },
      {
        repoId: 'repo-b',
        repoName: 'Repo B',
        repoPath: '/workspace-worktrees/workspace-1/base/repos/repo-b',
      },
    ]);
    mockedGetCurrentBranch
      .mockResolvedValueOnce('feature/repo-a')
      .mockResolvedValueOnce('feature/repo-b');
    mockedCreateWorktreeFromStartPoint.mockResolvedValue('generated-worktree');

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      baseWorktreeId: 'base',
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    expect(mockedResolveSharedAvailableBranchName).toHaveBeenCalledWith(
      ['/repos/repo-a', '/repos/repo-b'],
      expect.stringMatching(/^generated-worktree-\d+$/),
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledTimes(2);
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-a',
      'generated-worktree',
      'feature/repo-a',
    );
    expect(mockedCreateWorktreeFromStartPoint).toHaveBeenCalledWith(
      '/repos/repo-b',
      '/workspace-worktrees/workspace-1/generated-worktree/repos/repo-b',
      'generated-worktree',
      'feature/repo-b',
    );
    expect(created.trackedRepoBaseBranches).toEqual({
      'repo-a': 'feature/repo-a',
      'repo-b': 'feature/repo-b',
    });
  });

  it('returns the persisted reservation timestamp for deferred single-repo setup', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
    });

    const persisted = persistedWorktrees.find(
      (worktree) => worktree.id === created.id,
    );
    expect(typeof created.createdAt).toBe('string');
    expect(created).toMatchObject({
      setupPhase: 'git-pending',
    });
    expect(persisted?.createdAt).toBe(created.createdAt);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/repos/project-1',
      expect.any(String),
      expect.any(String),
      { backgroundPriority: true },
    );
  });

  it('seeds the layout mode before exposing a deferred single-repo reservation', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    let releaseGit: (() => void) | undefined;
    mockedCreateWorktree.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        releaseGit = (): void => resolve('generated-worktree');
      }),
    );
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
    });

    try {
      expect(created).toMatchObject({ setupPhase: 'git-pending' });
      expect(initializePanelLayoutModeMock).toHaveBeenCalledWith(
        'project-1',
        created.id,
        'minimal',
      );
    } finally {
      releaseGit?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });

  it('does not hold deferred desktop Git-ready on an eager code-graph seed', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitReady = jest.fn();
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      onGitReady,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(eagerSeedNewWorktreeCodeGraphMock).not.toHaveBeenCalled();
    expect(onGitReady).toHaveBeenCalledTimes(1);
    expect(
      persistedWorktrees.find((worktree) => worktree.id === created.id),
    ).toMatchObject({ setupPhase: 'git-ready' });

    expect(deferCodeGraphRefreshUntilPostCreateSetupMock).toHaveBeenCalledWith(
      'project-1',
      created.id,
    );
  });

  it('keeps a deferred single-repo reservation pending until the pre-ready hook settles', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    let releaseBeforeGitReady: (() => void) | undefined;
    const beforeGitReady = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          releaseBeforeGitReady = resolve;
        }),
    );
    const onGitReady = jest.fn();
    const onGitSetupSettled = jest.fn();
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      beforeGitReady,
      onGitSetupSettled,
      onGitReady,
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(beforeGitReady).toHaveBeenCalledTimes(1);
    expect(onGitReady).not.toHaveBeenCalled();
    expect(onGitSetupSettled).not.toHaveBeenCalled();
    expect(
      persistedWorktrees.find((worktree) => worktree.id === created.id),
    ).toMatchObject({ setupPhase: 'git-pending' });
    const pendingSetup = claimWorktreeGitSetup('project-1', created.id);
    expect(pendingSetup).toBeDefined();

    releaseBeforeGitReady?.();
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(pendingSetup).resolves.toBe('ready');
    expect(claimWorktreeGitSetup('project-1', created.id)).toBeUndefined();
    expect(onGitReady).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: created.id,
      outcome: 'ready',
    });
    expect(
      persistedWorktrees.find((worktree) => worktree.id === created.id),
    ).toMatchObject({ setupPhase: 'git-ready' });
  });

  it('releases the refresh deferral when single-repo setup fails to start', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startProjectPostCreateSetup: () => {
        throw new Error('setup failed to start');
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(releaseCodeGraphRefreshDeferralMock).toHaveBeenCalledTimes(1);
  });

  it('tracks the held single-repo post-create setup without awaiting it', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    let releaseSetup: (() => void) | undefined;
    let setupFinished = false;
    const startProjectPostCreateSetup = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseSetup = resolve;
        }).then(() => {
          setupFinished = true;
        }),
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startProjectPostCreateSetup,
    });
    expect(created.id).toBeTruthy();
    let settled = false;
    const settling = settleDetachedWork().then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(startProjectPostCreateSetup).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseSetup?.();
    await settling;

    expect(settled).toBe(true);
    expect(setupFinished).toBe(true);
    expect(releaseCodeGraphRefreshDeferralMock).not.toHaveBeenCalled();
  });

  it('releases the refresh deferral when single-repo setup rejects asynchronously', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startProjectPostCreateSetup: () =>
        Promise.reject(new Error('setup failed')),
    });
    await settleDetachedWork();

    expect(releaseCodeGraphRefreshDeferralMock).toHaveBeenCalledTimes(1);
  });

  it('returns the persisted reservation timestamp for deferred multi-repo setup', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }

    const persisted = persistedWorktrees.find(
      (worktree) => worktree.id === created.id,
    );
    expect(typeof created.createdAt).toBe('string');
    expect(created).toMatchObject({
      setupPhase: 'git-pending',
    });
    expect(persisted?.createdAt).toBe(created.createdAt);

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  });

  it('does not hold deferred multi-repo Git-ready on an eager code-graph seed', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitReady = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      onGitReady,
    });
    if (created.needsRepair) {
      throw new Error('Expected a successful create response');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(eagerSeedNewWorktreeCodeGraphMock).not.toHaveBeenCalled();
    expect(onGitReady).toHaveBeenCalledTimes(1);
    expect(
      persistedWorktrees.find((worktree) => worktree.id === created.id),
    ).toMatchObject({ setupPhase: 'git-ready' });
    expect(deferCodeGraphRefreshUntilPostCreateSetupMock).toHaveBeenCalledWith(
      'workspace-1',
      created.id,
    );
  });

  describe.each(['single-repo', 'multi-repo'] as const)(
    '%s reserved setup storage failures',
    (kind) => {
      it.each(['removed', 'replaced'] as const)(
        'settles cancelled rather than failed when Git fails after its reservation is %s',
        async (change) => {
          let persisted: WorktreeData[] = [];
          const workspaceId =
            kind === 'single-repo' ? 'project-1' : 'workspace-1';
          if (kind === 'multi-repo') {
            mockedListWorkspaceItems.mockResolvedValue([
              buildMultiRepoWorkspace(),
            ]);
          }
          mockedReadWorkspaceWorktrees.mockImplementation(() =>
            Promise.resolve(persisted),
          );
          mockedUpdateWorkspaceWorktrees.mockImplementation(
            async (_id, updater) => {
              persisted = await updater(persisted);
              return persisted;
            },
          );
          mockedCreateWorktree.mockImplementationOnce(() => {
            persisted =
              change === 'removed'
                ? []
                : persisted.map((row) => ({
                    ...row,
                    createdAt: '2026-04-21T00:00:00.000Z',
                  }));
            return Promise.reject(new Error('checkout interrupted by removal'));
          });
          const onGitFailed = jest.fn();
          const onGitSetupSettled = jest.fn();
          const create =
            kind === 'single-repo'
              ? createSingleRepoWorktree
              : createMultiRepoWorktree;
          const created = await create({
            workspaceId,
            existingWorktreeIds: [],
            deferGitSetup: true,
            onGitFailed,
            onGitSetupSettled,
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(onGitFailed).not.toHaveBeenCalled();
          expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
          expect(onGitSetupSettled).toHaveBeenCalledWith({
            projectId: workspaceId,
            worktreeId: created.id,
            outcome: 'cancelled',
          });
          await expect(
            claimWorktreeGitSetup(workspaceId, created.id),
          ).resolves.toBe('cancelled');
          if (change === 'replaced') {
            expect(mockedRemoveWorktree).not.toHaveBeenCalled();
            expect(mockedRm).not.toHaveBeenCalled();
          }
        },
      );

      it.each(
        [
          new WorktreeRegistryUnreadableError(),
          new W5AuthorityUnreachableError('refused', 'connect'),
          new W5RecordUnservedError('limit-exceeded', 'worktrees'),
        ].flatMap((storageError) =>
          (['setup write', 'failure write'] as const).map((stage) => ({
            storageError,
            stage,
          })),
        ),
      )(
        'retains a typed storage failure when authority recovers after $stage throws: $storageError',
        async ({ storageError, stage }) => {
          let persisted: WorktreeData[] = [];
          let failNextWrite = false;
          const workspaceId =
            kind === 'single-repo' ? 'project-1' : 'workspace-1';
          if (kind === 'multi-repo') {
            mockedListWorkspaceItems.mockResolvedValue([
              buildMultiRepoWorkspace(),
            ]);
          }
          mockedReadWorkspaceWorktrees.mockImplementation(() =>
            Promise.resolve(persisted),
          );
          jest
            .mocked(readWorkspaceWorktreesDetailed)
            .mockImplementation(() =>
              Promise.resolve({ authority: 'ok', worktrees: persisted }),
            );
          mockedUpdateWorkspaceWorktrees.mockImplementation(
            async (_id, updater) => {
              if (failNextWrite) {
                failNextWrite = false;
                throw storageError;
              }
              persisted = await updater(persisted);
              return persisted;
            },
          );
          mockedCreateWorktree.mockImplementation((_repo, _path, branch) => {
            failNextWrite = stage === 'setup write';
            return Promise.resolve(branch);
          });
          const onGitFailed = jest.fn();
          const onGitSetupSettled = jest.fn();
          const create =
            kind === 'single-repo'
              ? createSingleRepoWorktree
              : createMultiRepoWorktree;
          const created = await create({
            workspaceId,
            existingWorktreeIds: [],
            deferGitSetup: true,
            beforeGitReady: () => {
              if (stage === 'failure write') {
                failNextWrite = true;
                throw new Error('Git finalization failed');
              }
            },
            onGitFailed,
            onGitSetupSettled,
          });
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(onGitFailed).toHaveBeenCalledWith(
            expect.objectContaining({
              error:
                stage === 'failure write'
                  ? 'Git finalization failed'
                  : storageError.message,
              failureReason: 'storage-unavailable',
            }),
          );
          expect(onGitSetupSettled).toHaveBeenCalledWith({
            projectId: workspaceId,
            worktreeId: created.id,
            outcome: 'failed',
          });
          expect(mockedRemoveWorktree).not.toHaveBeenCalled();
          expect(mockedRm).not.toHaveBeenCalled();
        },
      );

      it.each([
        ['unreadable', 'before checkout'],
        ['unreadable', 'after checkout'],
        ['unreadable', 'cancelled after checkout'],
        ['partial', 'after checkout'],
        ['absent', 'after checkout'],
      ] as const)(
        'fails without cleanup when storage becomes %s %s',
        async (authority, moment) => {
          let persisted: WorktreeData[] = [];
          let storageUnavailable = false;
          const workspaceId =
            kind === 'single-repo' ? 'project-1' : 'workspace-1';
          if (kind === 'multi-repo') {
            mockedListWorkspaceItems.mockResolvedValue([
              buildMultiRepoWorkspace(),
            ]);
          }
          mockedReadWorkspaceWorktrees.mockImplementation(() =>
            Promise.resolve(storageUnavailable ? [] : persisted),
          );
          jest.mocked(readWorkspaceWorktreesDetailed).mockImplementation(() =>
            Promise.resolve({
              authority: storageUnavailable ? authority : 'ok',
              worktrees: storageUnavailable ? [] : persisted,
            }),
          );
          mockedUpdateWorkspaceWorktrees.mockImplementation(
            async (_id, updater, options) => {
              if (storageUnavailable) {
                if (
                  authority === 'unreadable' ||
                  (authority === 'partial' &&
                    options?.requireAuthoritativeRead) ||
                  (authority === 'absent' && options?.requireExistingList)
                ) {
                  throw new Error(`W5 storage is ${authority}`);
                }
                // A permissive updater sees missing rows, not a thrown read.
                return updater([], { authority });
              }
              persisted = await updater(persisted);
              if (moment === 'before checkout') storageUnavailable = true;
              return persisted;
            },
          );
          if (moment !== 'before checkout') {
            mockedCreateWorktree.mockImplementationOnce(
              (_repo, _path, branch) => {
                storageUnavailable = true;
                if (moment === 'cancelled after checkout') {
                  const reservation = persisted[0];
                  if (!reservation) throw new Error('Missing reservation');
                  markWorktreeSetupCancellation({
                    workspaceId,
                    worktreeId: reservation.id,
                    createdAt: reservation.createdAt,
                  });
                }
                return Promise.resolve(branch);
              },
            );
          }
          const onGitFailed = jest.fn();
          const onGitSetupSettled = jest.fn();
          const create =
            kind === 'single-repo'
              ? createSingleRepoWorktree
              : createMultiRepoWorktree;
          const created = await create({
            workspaceId,
            existingWorktreeIds: [],
            deferGitSetup: true,
            onGitFailed,
            onGitSetupSettled,
          });
          await new Promise<void>((resolve) => setImmediate(resolve));

          const reservation = persisted[0];
          if (moment === 'cancelled after checkout' && reservation) {
            consumeWorktreeSetupCancellation({
              workspaceId,
              worktreeId: created.id,
              createdAt: reservation.createdAt,
            });
          }
          const expectedError: unknown = expect.stringMatching(
            /storage.*(unreadable|partial|absent)/i,
          );
          expect(onGitFailed).toHaveBeenCalledWith(
            expect.objectContaining({
              error: expectedError,
              failureReason: 'storage-unavailable',
            }),
          );
          expect(onGitSetupSettled).toHaveBeenCalledWith({
            projectId: workspaceId,
            worktreeId: created.id,
            outcome: 'failed',
          });
          await expect(
            claimWorktreeGitSetup(workspaceId, created.id),
          ).resolves.toBe('failed');
          if (moment === 'before checkout') {
            expect(mockedCreateWorktree).not.toHaveBeenCalled();
          } else {
            expect(mockedCreateWorktree).toHaveBeenCalledTimes(1);
          }
          expect(mockedRemoveWorktree).not.toHaveBeenCalled();
          expect(mockedDeleteBranch).not.toHaveBeenCalled();
          expect(mockedRm).not.toHaveBeenCalled();
          expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
          expect(persisted).toEqual([
            expect.objectContaining({ id: created.id }),
          ]);
        },
      );

      it('reports the original setup error when recording failure throws', async () => {
        let persisted: WorktreeData[] = [];
        let setupFailed = false;
        const workspaceId =
          kind === 'single-repo' ? 'project-1' : 'workspace-1';
        if (kind === 'multi-repo') {
          mockedListWorkspaceItems.mockResolvedValue([
            buildMultiRepoWorkspace(),
          ]);
        }
        mockedReadWorkspaceWorktrees.mockImplementation(() =>
          Promise.resolve(persisted),
        );
        jest
          .mocked(readWorkspaceWorktreesDetailed)
          .mockImplementation(() =>
            Promise.resolve({ authority: 'ok', worktrees: persisted }),
          );
        mockedUpdateWorkspaceWorktrees.mockImplementation(
          async (_id, updater) => {
            if (setupFailed) {
              throw new Error('failure write failed');
            }
            persisted = await updater(persisted);
            return persisted;
          },
        );
        mockedCreateWorktree.mockImplementationOnce(() => {
          setupFailed = true;
          return Promise.reject(new Error('original Git failure'));
        });
        const onGitFailed = jest.fn();
        const onGitSetupSettled = jest.fn();
        const create =
          kind === 'single-repo'
            ? createSingleRepoWorktree
            : createMultiRepoWorktree;
        const created = await create({
          workspaceId,
          existingWorktreeIds: [],
          deferGitSetup: true,
          onGitFailed,
          onGitSetupSettled,
        });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(onGitFailed).toHaveBeenCalledWith(
          expect.objectContaining({ error: 'original Git failure' }),
        );
        expect(onGitSetupSettled).toHaveBeenCalledWith(
          expect.objectContaining({ outcome: 'failed' }),
        );
        await expect(
          claimWorktreeGitSetup(workspaceId, created.id),
        ).resolves.toBe('failed');
      });

      it.each(['removed', 'replaced'] as const)(
        'settles cancelled without cleanup when the reservation is %s during the failure write',
        async (change) => {
          let persisted: WorktreeData[] = [];
          let replacement: WorktreeData[] = [];
          let setupFailed = false;
          let failureCheckReservation: WorktreeData | undefined;
          const workspaceId =
            kind === 'single-repo' ? 'project-1' : 'workspace-1';
          if (kind === 'multi-repo') {
            mockedListWorkspaceItems.mockResolvedValue([
              buildMultiRepoWorkspace(),
            ]);
          }
          mockedReadWorkspaceWorktrees.mockImplementation(() =>
            Promise.resolve(persisted),
          );
          jest.mocked(readWorkspaceWorktreesDetailed).mockImplementation(() => {
            if (setupFailed) failureCheckReservation = persisted[0];
            return Promise.resolve({ authority: 'ok', worktrees: persisted });
          });
          mockedUpdateWorkspaceWorktrees.mockImplementation(
            async (_id, updater) => {
              if (setupFailed) {
                // Replace under the write lock, after the catch's current check.
                expect(failureCheckReservation).toBe(persisted[0]);
                expect(failureCheckReservation).toBeDefined();
                replacement =
                  change === 'removed'
                    ? []
                    : persisted.map((row) => ({
                        ...row,
                        createdAt: '2026-04-21T00:00:00.000Z',
                        branchName: 'feature/replacement',
                        setupPhase: 'git-pending',
                      }));
                persisted = replacement;
              }
              persisted = await updater(persisted);
              return persisted;
            },
          );
          mockedCreateWorktree.mockImplementationOnce(() => {
            setupFailed = true;
            return Promise.reject(new Error('original Git failure'));
          });
          const onGitFailed = jest.fn();
          const onGitSetupSettled = jest.fn();
          const create =
            kind === 'single-repo'
              ? createSingleRepoWorktree
              : createMultiRepoWorktree;
          const created = await create({
            workspaceId,
            existingWorktreeIds: [],
            deferGitSetup: true,
            onGitFailed,
            onGitSetupSettled,
          });
          await new Promise<void>((resolve) => setImmediate(resolve));

          expect(failureCheckReservation).toMatchObject({
            id: created.id,
            createdAt: created.createdAt,
          });
          expect(onGitFailed).not.toHaveBeenCalled();
          expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
          expect(onGitSetupSettled).toHaveBeenCalledWith({
            projectId: workspaceId,
            worktreeId: created.id,
            outcome: 'cancelled',
          });
          await expect(
            claimWorktreeGitSetup(workspaceId, created.id),
          ).resolves.toBe('cancelled');
          expect(persisted).toEqual(replacement);
          expect(mockedRemoveWorktree).not.toHaveBeenCalled();
          expect(mockedDeleteBranch).not.toHaveBeenCalled();
          expect(mockedRm).not.toHaveBeenCalled();
          expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
        },
      );
    },
  );

  it('marks deferred multi-repo setup failures as broken instead of removing the reservation', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitFailed = jest.fn();
    const onGitSetupSettled = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([
      buildTemporaryMultiRepoWorkspace(),
    ]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockImplementation((repoPath, _path, branch) => {
      if (repoPath === '/repos/repo-b') {
        return Promise.reject(new Error('repo b setup failed'));
      }
      return Promise.resolve(branch);
    });

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitSetupSettled,
      onGitFailed,
    });
    if (created.needsRepair) {
      throw new Error('Expected a pending create response');
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    const persisted = persistedWorktrees.find(
      (worktree) => worktree.id === created.id,
    );
    expect(persisted).toMatchObject({
      id: created.id,
      setupPhase: 'git-pending',
      healthIssue: {
        status: 'broken',
        code: 'git-error',
        message: 'Worktree setup failed.',
        worktreePath: '/workspace-worktrees/workspace-1/generated-worktree',
        gitError: 'repo b setup failed',
      },
    });
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(onGitFailed).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: created.id,
      outcome: 'failed',
    });
    const [event] = onGitFailed.mock.calls[0] as [WorktreeGitFailedEvent];
    expect(event).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: created.id,
      error: 'repo b setup failed',
    });
    expect(event.healthIssue).toMatchObject({
      code: 'git-error',
      gitError: 'repo b setup failed',
    });
    await expect(
      claimWorktreeGitSetup('workspace-1', created.id),
    ).resolves.toBe('failed');
    expect(claimWorktreeGitSetup('workspace-1', created.id)).toBeUndefined();
  });

  it('releases the refresh deferral when multi-repo setup fails to start', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');

    await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startWorkspacePostCreateSetup: () => {
        throw new Error('setup failed to start');
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(releaseCodeGraphRefreshDeferralMock).toHaveBeenCalledTimes(1);
  });

  it('tracks the held multi-repo post-create setup without awaiting it', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');
    let releaseSetup: (() => void) | undefined;
    let setupFinished = false;
    const startWorkspacePostCreateSetup = jest.fn(
      (): Promise<void> =>
        new Promise<void>((resolve) => {
          releaseSetup = resolve;
        }).then(() => {
          setupFinished = true;
        }),
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startWorkspacePostCreateSetup,
    });
    expect(created.id).toBeTruthy();
    let settled = false;
    const settling = settleDetachedWork().then(() => {
      settled = true;
    });
    for (let turn = 0; turn < 5; turn += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(startWorkspacePostCreateSetup).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseSetup?.();
    await settling;

    expect(settled).toBe(true);
    expect(setupFinished).toBe(true);
    expect(releaseCodeGraphRefreshDeferralMock).not.toHaveBeenCalled();
  });

  it('releases the refresh deferral when multi-repo setup rejects asynchronously', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');

    await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      startPostCreateSetup: true,
      startWorkspacePostCreateSetup: () =>
        Promise.reject(new Error('setup failed')),
    });
    await settleDetachedWork();

    expect(releaseCodeGraphRefreshDeferralMock).toHaveBeenCalledTimes(1);
  });

  it('defers the workspace-root git worktree add and repair validation to Phase B for deferred multi-repo creation (Task I1)', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitReady = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitReady,
    });
    if (created.needsRepair) {
      throw new Error('Expected a pending create response');
    }

    // The reservation returns immediately as git-pending WITHOUT doing any git
    // worktree add (root or child) or repair validation — those are Phase B now.
    expect(created).toMatchObject({ setupPhase: 'git-pending' });
    expect(mockedCreateWorktree).not.toHaveBeenCalled();
    expect(mockedValidateWorkspaceRootWorktree).not.toHaveBeenCalled();

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Phase B ran the workspace-root add against the resolved reference repo,
    // then validated it, then created the children, then signalled git-ready.
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/refs/source',
      expect.any(String),
      expect.any(String),
      { backgroundPriority: true },
    );
    expect(mockedValidateWorkspaceRootWorktree).toHaveBeenCalledTimes(1);
    expect(onGitReady).toHaveBeenCalledTimes(1);
  });

  it('retains the reservation and emits onNeedsRepair without creating child repos when deferred Phase B finds blocking repair issues (Task I1)', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitReady = jest.fn();
    const onNeedsRepair = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');
    mockedValidateWorkspaceRootWorktree.mockResolvedValue([
      {
        code: 'missing-claude-md',
        message: 'CLAUDE.md is missing from the project root worktree.',
        blocking: true,
      },
    ]);

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitReady,
      onNeedsRepair,
    });
    if (created.needsRepair) {
      // The deferred path never surfaces repair synchronously in the response.
      throw new Error('Expected a git-pending response, not a needsRepair one');
    }
    expect(created).toMatchObject({ setupPhase: 'git-pending' });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Root was created and validated, then the blocking issue short-circuited:
    // the persisted reservation is retained, onNeedsRepair fires, and NO
    // child repo worktrees are created (child creation happens only after the
    // repair gate passes).
    expect(mockedCreateWorktree).toHaveBeenCalledWith(
      '/refs/source',
      expect.any(String),
      expect.any(String),
      { backgroundPriority: true },
    );
    expect(mockedCreateWorktree).not.toHaveBeenCalledWith(
      '/repos/repo-a',
      expect.anything(),
      expect.anything(),
    );
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(persistedWorktrees).toMatchObject([
      { setupPhase: 'git-pending', creation: { state: 'recovery-required' } },
    ]);
    expect(onGitReady).not.toHaveBeenCalled();
    expect(onNeedsRepair).toHaveBeenCalledTimes(1);
    const [repairEvent] = onNeedsRepair.mock.calls[0] as [
      {
        projectId: string;
        worktreeId: string;
        branchName: string;
        repairIssues: unknown[];
      },
    ];
    expect(repairEvent).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: created.id,
      repairIssues: [
        expect.objectContaining({ code: 'missing-claude-md', blocking: true }),
      ],
    });
  });

  it.each(['ready', 'cancelled'] as const)(
    'keeps the Git setup pending through a deferred needs-repair detour until the repair settles it %s',
    async (outcome) => {
      let persistedWorktrees: WorktreeData[] = [];
      const onGitSetupSettled = jest.fn();
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedReadWorkspaceWorktrees.mockImplementation(() =>
        Promise.resolve(persistedWorktrees),
      );
      mockedUpdateWorkspaceWorktrees.mockImplementation(
        async (_workspaceId, updater) => {
          persistedWorktrees = await updater(persistedWorktrees);
          return persistedWorktrees;
        },
      );
      mockedCreateWorktree.mockResolvedValue('generated-worktree');
      mockedValidateWorkspaceRootWorktree.mockResolvedValue([
        {
          code: 'missing-claude-md',
          message: 'CLAUDE.md is missing from the project root worktree.',
          blocking: true,
        },
      ]);
      const onNeedsRepair = jest.fn();

      const created = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        existingWorktreeIds: [],
        deferGitSetup: true,
        onNeedsRepair,
        onGitSetupSettled,
      });
      const pendingSetup = claimWorktreeGitSetup('workspace-1', created.id);
      expect(pendingSetup).toBeDefined();
      let settled: string | undefined;
      void pendingSetup?.then((value) => {
        settled = value;
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      // A held send waits through the repair instead of ending cancelled.
      expect(onNeedsRepair).toHaveBeenCalledTimes(1);
      expect(settled).toBeUndefined();
      expect(onGitSetupSettled).not.toHaveBeenCalled();

      settleWorktreeGitSetup('workspace-1', created.id, outcome);
      await expect(pendingSetup).resolves.toBe(outcome);
    },
  );

  it('reports deferred repair requirements through onGitFailed when no repair handler is registered', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitReady = jest.fn();
    const onGitFailed = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');
    mockedValidateWorkspaceRootWorktree.mockResolvedValue([
      {
        code: 'missing-claude-md',
        message: 'CLAUDE.md is missing from the project root worktree.',
        blocking: true,
      },
    ]);

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitReady,
      onGitFailed,
    });
    if (created.needsRepair) {
      throw new Error('Expected a git-pending response, not a needsRepair one');
    }

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(persistedWorktrees).toMatchObject([
      { setupPhase: 'git-pending', creation: { state: 'recovery-required' } },
    ]);
    expect(onGitReady).not.toHaveBeenCalled();
    expect(onGitFailed).toHaveBeenCalledTimes(1);
    const [failureEvent] = onGitFailed.mock.calls[0] as [
      WorktreeGitFailedEvent,
    ];
    expect(failureEvent).toMatchObject({
      projectId: 'workspace-1',
      worktreeId: created.id,
      error: 'Created worktree requires repair.',
    });
  });

  it('keeps the non-deferred (CLI) repair-required throw for blocking issues without a repair flag (Task I1: CLI unchanged)', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockResolvedValue('generated-worktree');
    mockedValidateWorkspaceRootWorktree.mockResolvedValue([
      {
        code: 'missing-claude-md',
        message: 'CLAUDE.md is missing from the project root worktree.',
        blocking: true,
      },
    ]);

    // Non-deferred: root setup runs synchronously and, without `--repair`
    // (repairWorkspaceRoot) and with `startPostCreateSetup: false`, the CLI
    // still gets the repair-required throw (not the deferred event).
    await expect(
      createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        existingWorktreeIds: [],
        startPostCreateSetup: false,
      }),
    ).rejects.toThrow(/requires repair and cannot be finalized from the CLI/);
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('does not clean up disk paths when cancelled single-repo setup is superseded by a reused worktree id', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitSetupSettled = jest.fn();
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockImplementationOnce(
      (_repoPath, _worktreePath, branchName) => {
        persistedWorktrees = [
          {
            id: 'generated-worktree',
            branchName: 'feature/new-worktree',
            createdAt: '2026-04-21T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ];
        return Promise.resolve(branchName);
      },
    );

    const created = await createSingleRepoWorktree({
      workspaceId: 'project-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitSetupSettled,
    });

    expect(created).toMatchObject({
      setupPhase: 'git-pending',
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranch).not.toHaveBeenCalled();
    expectNoRobustWorktreeRemoveCall(`/worktrees/project-1/${created.id}`);
    expect(mockedRm).not.toHaveBeenCalledWith(
      `/data/worktree-data/project-1/${created.id}`,
      {
        recursive: true,
        force: true,
      },
    );
    expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledWith({
      projectId: 'project-1',
      worktreeId: created.id,
      outcome: 'cancelled',
    });
    await expect(claimWorktreeGitSetup('project-1', created.id)).resolves.toBe(
      'cancelled',
    );
    expect(persistedWorktrees).toEqual([
      {
        id: created.id,
        branchName: 'feature/new-worktree',
        createdAt: '2026-04-21T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
  });

  it('does not clean up disk paths when cancelled multi-repo setup is superseded by a reused worktree id', async () => {
    let persistedWorktrees: WorktreeData[] = [];
    const onGitSetupSettled = jest.fn();
    mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedCreateWorktree.mockImplementationOnce(
      (_repoPath, _worktreePath, branchName) => {
        persistedWorktrees = [
          {
            id: 'generated-worktree',
            branchName: 'feature/new-worktree',
            createdAt: '2026-04-21T00:00:00.000Z',
            setupPhase: 'git-pending',
          },
        ];
        return Promise.resolve(branchName);
      },
    );

    const created = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      existingWorktreeIds: [],
      deferGitSetup: true,
      onGitSetupSettled,
    });

    expect(created).toMatchObject({
      setupPhase: 'git-pending',
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(mockedCreateWorktree).toHaveBeenCalledTimes(1);
    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedDeleteBranch).not.toHaveBeenCalled();
    expectNoRobustWorktreeRemoveCall(
      `/workspace-worktrees/workspace-1/${created.id}`,
    );
    expect(onGitSetupSettled).toHaveBeenCalledTimes(1);
    expect(onGitSetupSettled).toHaveBeenCalledWith({
      projectId: 'workspace-1',
      worktreeId: created.id,
      outcome: 'cancelled',
    });
    await expect(
      claimWorktreeGitSetup('workspace-1', created.id),
    ).resolves.toBe('cancelled');
    expect(persistedWorktrees).toEqual([
      {
        id: created.id,
        branchName: 'feature/new-worktree',
        createdAt: '2026-04-21T00:00:00.000Z',
        setupPhase: 'git-pending',
      },
    ]);
  });

  it('consumes setup cancellation when single-repo archive fails before teardown starts', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-pending',
        branchName: 'feature/wt-pending',
        createdAt,
        setupPhase: 'git-pending',
      },
    ]);
    mockedReadWorkspaceConfig.mockRejectedValueOnce(new Error('config failed'));

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-pending',
      }),
    ).rejects.toThrow('config failed');

    expect(
      isWorktreeSetupCancellationRequested({
        workspaceId: 'project-1',
        worktreeId: 'wt-pending',
        createdAt,
      }),
    ).toBe(false);
  });

  it('archives a single-repo worktree after fallback removal even when prune fails', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-pending',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('git remove failed'));
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expectRobustWorktreeRemoveCall('/worktrees/project-1/wt-1');
    expect(mockedBestEffortPruneWorktrees).toHaveBeenCalledWith(
      '/repos/project-1',
      'worktree-service safeRemoveWorktree',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    );
    const removePredicate = mockedRemoveWorkspaceWorktrees.mock.calls[0]?.[1];
    if (removePredicate === undefined) {
      throw new Error('Expected removeWorkspaceWorktrees predicate');
    }
    const matchingWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt,
    };
    const differentCreatedAtWorktree: WorktreeData = {
      id: 'wt-1',
      branchName: 'feature/wt-1',
      createdAt: '2026-04-21T00:00:00.000Z',
    };
    const differentIdWorktree: WorktreeData = {
      id: 'wt-2',
      branchName: 'feature/wt-2',
      createdAt: '2026-04-20T00:00:00.000Z',
    };
    expect(removePredicate(matchingWorktree)).toBe(true);
    expect(removePredicate(differentCreatedAtWorktree)).toBe(false);
    expect(removePredicate(differentIdWorktree)).toBe(false);
  });

  it('does not physically remove a worktree when Git removal fails and registration remains', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('git remove failed'));
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('git remove failed');

    expectNoRobustWorktreeRemoveCall('/worktrees/project-1/wt-1');
    expect(mockedBestEffortPruneWorktrees).not.toHaveBeenCalled();
    expect(mockedPruneWorktrees).toHaveBeenCalledWith('/repos/project-1');
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('retries a timed-out Git worktree removal before using a physical fallback', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    const timeoutError = Object.assign(new Error('git remove timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValueOnce(undefined);
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        // Hard-delete teardown path (no retained container), still used by
        // split/session-transfer callers; the default now archives.
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(2);
    expect(mockedWithWorktreeRemovalLock).toHaveBeenCalledTimes(1);
    expect(mockedWithWorktreeRemovalLock).toHaveBeenCalledWith(
      '/repos/project-1',
      expect.any(Function),
    );
    expect(
      mockedStageExactMacosWorktreeDirectoryForRemoval,
    ).not.toHaveBeenCalled();
    expectNoRobustWorktreeRemoveCall('/worktrees/project-1/wt-1');
  });

  it('stages and prunes an exact macOS worktree after repeated delete timeouts', async () => {
    const restorePlatform = setPlatform('darwin');
    const createdAt = '2026-04-20T00:00:00.000Z';
    const timeoutError = Object.assign(new Error('git remove timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValue(timeoutError);
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).resolves.toEqual({ success: true, warnings: [] });
    } finally {
      restorePlatform();
    }

    expect(mockedRemoveWorktree).toHaveBeenCalledTimes(2);
    expect(
      mockedStageExactMacosWorktreeDirectoryForRemoval,
    ).toHaveBeenCalledWith('project-1', 'wt-1', '/worktrees/project-1/wt-1');
    expect(mockedPruneWorktrees).toHaveBeenCalledTimes(2);
    expect(mockedRemoveStagedMacosWorktreeDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
      '/worktrees/project-1/.wt-1.deleting-00000000-0000-4000-8000-000000000000',
    );
    expect(mockedRestoreStagedMacosWorktreeDirectory).not.toHaveBeenCalled();
  });

  it('restores a staged macOS worktree when the guarded prune fails', async () => {
    const restorePlatform = setPlatform('darwin');
    const createdAt = '2026-04-20T00:00:00.000Z';
    const timeoutError = Object.assign(new Error('git remove timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValue(timeoutError);
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true);
    mockedPruneWorktrees
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('guarded prune failed'));

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('guarded prune failed');
    } finally {
      restorePlatform();
    }

    expect(mockedRestoreStagedMacosWorktreeDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
      '/worktrees/project-1/.wt-1.deleting-00000000-0000-4000-8000-000000000000',
    );
    expect(mockedRemoveStagedMacosWorktreeDirectory).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('uses guarded timeout recovery for nested repository worktrees', async () => {
    const restorePlatform = setPlatform('darwin');
    const timeoutError = Object.assign(new Error('git remove timed out'), {
      killed: true,
      signal: 'SIGTERM',
    });
    const workspace = buildMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: workspace.sourceRepoPath,
      repos: workspace.repos,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedRemoveWorktree
      .mockRejectedValueOnce(timeoutError)
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValue(undefined);
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockedStageExactMacosWorktreeDirectoryForRemoval.mockResolvedValueOnce(
      '/workspace-worktrees/workspace-1/wt-1/repos/.repo-a.deleting-00000000-0000-4000-8000-000000000000',
    );

    try {
      await expect(
        archiveMultiRepoWorktree({
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
        }),
      ).resolves.toEqual({ success: true, warnings: [] });
    } finally {
      restorePlatform();
    }

    expect(
      mockedStageExactMacosWorktreeDirectoryForRemoval,
    ).toHaveBeenCalledWith(
      'workspace-1',
      'wt-1',
      '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
      'repo-a',
    );
    expect(mockedRemoveStagedMacosWorktreeDirectory).toHaveBeenCalledWith(
      'workspace-1',
      'wt-1',
      '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
      '/workspace-worktrees/workspace-1/wt-1/repos/.repo-a.deleting-00000000-0000-4000-8000-000000000000',
      'repo-a',
    );
  });

  it('prunes stale registration before physically removing a failed worktree', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('missing .git file'));
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        // Hard-delete teardown path (no retained container), still used by
        // split/session-transfer callers; the default now archives.
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedPruneWorktrees).toHaveBeenCalledWith('/repos/project-1');
    expectRobustWorktreeRemoveCall('/worktrees/project-1/wt-1');
  });

  it('archives a single-repo worktree with a warning when Git unregisters it but Windows leaves locked files', async () => {
    const restorePlatform = setPlatform('win32');
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedRm.mockRejectedValueOnce(
      Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }),
    );
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).resolves.toEqual({
        success: true,
        warnings: [
          'Git unregistered this worktree, but Windows left locked files behind at /worktrees/project-1/wt-1: resource busy or locked',
        ],
      });
    } finally {
      restorePlatform();
    }

    expectRobustWorktreeRemoveCall('/worktrees/project-1/wt-1');
    expect(mockedRm).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      expect.objectContaining({ maxRetries: 50 }),
    );
    expect(mockedIsRegisteredWorktreePath).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/wt-1',
    );
    expect(mockedBestEffortPruneWorktrees).toHaveBeenCalledWith(
      '/repos/project-1',
      'worktree-service safeRemoveWorktree',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    );
  });

  it('archives a local-only multi-repo worktree with warnings when locked child files block parent cleanup', async () => {
    const restorePlatform = setPlatform('win32');
    const createdAt = '2026-04-20T00:00:00.000Z';
    const workspace = buildTemporaryMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
      temporary: true,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
      },
    ]);
    mockedRm
      .mockRejectedValueOnce(
        Object.assign(new Error('child resource busy'), { code: 'EBUSY' }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error('parent resource busy'), { code: 'EBUSY' }),
      );
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    try {
      await expect(
        archiveMultiRepoWorktree({
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
        }),
      ).resolves.toEqual({
        success: true,
        warnings: [
          'Git unregistered this worktree, but Windows left locked files behind at /workspace-worktrees/workspace-1/wt-1/repos/repo-a: child resource busy',
          'Windows left locked files behind at /workspace-worktrees/workspace-1/wt-1: parent resource busy',
        ],
      });
    } finally {
      restorePlatform();
    }

    expect(mockedIsRegisteredWorktreePath).toHaveBeenCalledWith(
      '/repos/repo-a',
      '/workspace-worktrees/workspace-1/wt-1/repos/repo-a',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'workspace-1',
      expect.any(Function),
    );
  });

  it('keeps multi-repo metadata when Windows parent cleanup fails without child warnings', async () => {
    const restorePlatform = setPlatform('win32');
    const workspace = buildTemporaryMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
      temporary: true,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedRm.mockRejectedValueOnce(
      Object.assign(new Error('parent resource busy'), { code: 'EBUSY' }),
    );

    try {
      await expect(
        archiveMultiRepoWorktree({
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
        }),
      ).rejects.toThrow('parent resource busy');
    } finally {
      restorePlatform();
    }

    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
  });

  it('keeps multi-repo metadata when macOS orphan cleanup cannot be queued', async () => {
    const restorePlatform = setPlatform('darwin');
    const workspace = buildTemporaryMultiRepoWorkspace();
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
      temporary: true,
    });
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedRm.mockRejectedValueOnce(new Error('parent resource busy'));
    mockedRemoveExactMacosWorktreeDirectory.mockRejectedValueOnce(
      new Error('native removal denied'),
    );
    mockedQueueOrphanedMacosWorktreeDirectory.mockRejectedValueOnce(
      new Error('queue persistence failed'),
    );

    try {
      await expect(
        archiveMultiRepoWorktree({
          workspaceId: 'workspace-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
        }),
      ).rejects.toThrow('queue persistence failed');
    } finally {
      restorePlatform();
    }

    expect(mockedQueueOrphanedMacosWorktreeDirectory).toHaveBeenCalledTimes(1);
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
  });

  it('never reaches the macOS native fallback after a lifecycle refuses checkout removal', async () => {
    const restorePlatform = setPlatform('darwin');
    const lifecycle = jest.requireMock<{ destructiveStep: jest.Mock }>(
      '../lib/w5-destructive-recovery',
    );
    lifecycle.destructiveStep.mockImplementation(
      (phase: string, work: () => Promise<unknown>): Promise<unknown> =>
        phase === 'checkout-directory-removal'
          ? Promise.reject(new Error('replacement incarnation refused'))
          : work(),
    );
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('replacement incarnation refused');
    } finally {
      restorePlatform();
      lifecycle.destructiveStep.mockImplementation(
        (_phase: string, work: () => Promise<unknown>): Promise<unknown> =>
          work(),
      );
    }

    expect(mockedRemoveExactMacosWorktreeDirectory).not.toHaveBeenCalled();
    expect(mockedQueueOrphanedMacosWorktreeDirectory).not.toHaveBeenCalled();
  });

  it('uses the macOS native fallback for the exact top-level worktree directory', async () => {
    const restorePlatform = setPlatform('darwin');
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedRm.mockRejectedValueOnce(new Error('resource busy or locked'));
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).resolves.toEqual({ success: true, warnings: [] });
    } finally {
      restorePlatform();
    }

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedRemoveExactMacosWorktreeDirectory).toHaveBeenCalledWith(
      'project-1',
      'wt-1',
      '/worktrees/project-1/wt-1',
    );
    expect(mockedRm).toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      expect.objectContaining({ maxRetries: 2 }),
    );
    expect(mockedQueueOrphanedMacosWorktreeDirectory).not.toHaveBeenCalled();
    expect(mockedIsRegisteredWorktreePath).toHaveBeenCalledWith(
      '/repos/project-1',
      '/worktrees/project-1/wt-1',
    );
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    );
  });

  it('finishes a macOS archive and queues cleanup when both directory removals fail after Git unregistered it', async () => {
    const restorePlatform = setPlatform('darwin');
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedRm.mockRejectedValueOnce(new Error('resource busy or locked'));
    mockedRemoveExactMacosWorktreeDirectory.mockRejectedValueOnce(
      new Error('native removal denied'),
    );
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).resolves.toEqual({
        success: true,
        warnings: [
          'Git unregistered this worktree, but macOS left files behind at /worktrees/project-1/wt-1: Node removal failed (resource busy or locked); macOS native removal also failed (native removal denied)',
        ],
      });
    } finally {
      restorePlatform();
    }

    expect(mockedQueueOrphanedMacosWorktreeDirectory).toHaveBeenCalledTimes(1);
    const queuedCleanup =
      mockedQueueOrphanedMacosWorktreeDirectory.mock.calls[0]?.[0];
    expect(queuedCleanup).toMatchObject({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      worktreePath: '/worktrees/project-1/wt-1',
    });
    expect(queuedCleanup?.error).toBeInstanceOf(Error);
    expect(mockedRemoveWorkspaceWorktrees).toHaveBeenCalledWith(
      'project-1',
      expect.any(Function),
    );
  });

  it('keeps macOS worktree metadata when orphan cleanup cannot be queued', async () => {
    const restorePlatform = setPlatform('darwin');
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedRm.mockRejectedValueOnce(new Error('resource busy or locked'));
    mockedRemoveExactMacosWorktreeDirectory.mockRejectedValueOnce(
      new Error('native removal denied'),
    );
    mockedQueueOrphanedMacosWorktreeDirectory.mockRejectedValueOnce(
      new Error('queue persistence failed'),
    );
    mockedIsRegisteredWorktreePath.mockResolvedValue(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          // Hard-delete teardown path (no retained container), still used by
          // split/session-transfer callers; the default now archives.
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('queue persistence failed');
    } finally {
      restorePlatform();
    }

    expect(mockedQueueOrphanedMacosWorktreeDirectory).toHaveBeenCalledTimes(1);
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedCleanupPersistedWorktreeData).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
  });

  it('does not raw-remove a worktree when Windows reparse-point cleanup fails', async () => {
    const restorePlatform = setPlatform('win32');
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockRejectedValueOnce(new Error('missing .git'));
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('scan failed'));
    mockedRemoveWindowsWorktreeReparsePoints.mockRejectedValueOnce(
      new Error('scan failed'),
    );
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    try {
      await expect(
        archiveSingleRepoWorktree({
          workspaceId: 'project-1',
          worktreeId: 'wt-1',
          retainAsArchivedContainer: false,
          repoPath: '/repos/project-1',
        }),
      ).rejects.toThrow('scan failed');
    } finally {
      restorePlatform();
    }

    expect(mockedRm).not.toHaveBeenCalledWith(
      '/worktrees/project-1/wt-1',
      expect.any(Object),
    );
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
    expect(mockedRemoveExactMacosWorktreeDirectory).not.toHaveBeenCalled();
    expect(recordedUsageEvents()).toEqual([]);
  });

  it('keeps a single-repo archive failed when fallback removal fails and Git still registers the worktree', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt,
        setupPhase: 'git-ready',
      },
    ]);
    mockedGetCurrentBranch.mockResolvedValueOnce('');
    mockedRemoveWorktree.mockRejectedValueOnce(new Error('git remove failed'));
    mockedRm.mockRejectedValueOnce(
      Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }),
    );
    mockedIsRegisteredWorktreePath
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).rejects.toThrow('resource busy or locked');

    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('rejects stale single-repo archive requests before cleanup', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/recreated',
        createdAt: '2026-04-21T00:00:00.000Z',
      },
    ]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        repoPath: '/repos/project-1',
        expectedCreatedAt: '2026-04-20T00:00:00.000Z',
      }),
    ).rejects.toThrow('Worktree wt-1 changed after archive was requested');

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('consumes setup cancellation when multi-repo archive fails before teardown starts', async () => {
    const createdAt = '2026-04-20T00:00:00.000Z';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-pending',
        branchName: 'feature/wt-pending',
        createdAt,
        setupPhase: 'git-pending',
      },
    ]);
    mockedReadWorkspaceConfig.mockRejectedValueOnce(new Error('config failed'));

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-pending',
      }),
    ).rejects.toThrow('config failed');

    expect(
      isWorktreeSetupCancellationRequested({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-pending',
        createdAt,
      }),
    ).toBe(false);
  });

  it('refuses required-container archive before destructive teardown', async () => {
    const workspace: MultiRepoSidebarItem = {
      ...buildMultiRepoWorkspace(),
      worktrees: [
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      ],
    };
    mockedListWorkspaceItems.mockResolvedValue([workspace]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: workspace.repos,
      sourceRepoPath: workspace.sourceRepoPath,
    });
    // The only way a required container cannot be prepared now is a worktree
    // that is not registered in the workspace (deletion retention is always
    // on, so retention itself can never refuse).
    mockedListWorkspaceItems.mockResolvedValue([
      { ...workspace, worktrees: [] },
    ]);

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: workspace.id,
        worktreeId: 'wt-1',
        retainAsArchivedContainer: true,
        requireArchivedContainer: true,
      }),
    ).rejects.toThrow('not registered in the project');

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('refuses a required single-repo container before destructive teardown', async () => {
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
      },
    ]);
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/project-1',
      repos: [],
    });
    // Unregistered worktree: the required container cannot be prepared.
    mockedReadWorkspaceWorktrees.mockResolvedValue([]);

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: true,
        requireArchivedContainer: true,
      }),
    ).rejects.toThrow('not registered in the project');

    expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    expect(mockedCleanupWorktreePipelines).not.toHaveBeenCalled();
    expect(mockedRemoveWorkspaceWorktrees).not.toHaveBeenCalled();
  });

  it('removes tracked compatibility symlinks through the single-repo archive flow', async () => {
    const linkPath = '/worktrees/project-1/previous-wt';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
        compatibilitySymlinks: [
          {
            path: linkPath,
            targetPath: '/worktrees/project-1/wt-1',
            reason: 'adhoc-multi-repo-transition',
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'previous-wt',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      },
    ]);
    mockedLstat.mockImplementation((candidatePath) =>
      Promise.resolve(makeLstatResult(String(candidatePath) === linkPath)),
    );
    mockedReadlink.mockResolvedValue('wt-1');

    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'project-1',
        worktreeId: 'wt-1',
        retainAsArchivedContainer: false,
        repoPath: '/repos/project-1',
      }),
    ).resolves.toEqual({ success: true, warnings: [] });

    expect(mockedRm).toHaveBeenCalledWith(linkPath, { force: true });
  });

  it('preserves real paths that occupy tracked compatibility symlink locations during archive', async () => {
    const linkPath = '/worktrees/project-1/previous-wt';
    mockedReadWorkspaceWorktrees.mockResolvedValue([
      {
        id: 'wt-1',
        branchName: 'feature/wt-1',
        createdAt: '2026-04-20T00:00:00.000Z',
        compatibilitySymlinks: [
          {
            path: linkPath,
            targetPath: '/worktrees/project-1/wt-1',
            reason: 'adhoc-multi-repo-transition',
            sourceWorkspaceId: 'source',
            sourceWorktreeId: 'previous-wt',
            createdAt: '2026-05-19T00:00:00.000Z',
          },
        ],
      },
    ]);
    mockedLstat.mockResolvedValue(makeLstatResult(false));

    await archiveSingleRepoWorktree({
      workspaceId: 'project-1',
      worktreeId: 'wt-1',
      retainAsArchivedContainer: false,
      repoPath: '/repos/project-1',
    });

    expect(mockedRm).not.toHaveBeenCalledWith(linkPath, { force: true });
  });

  it('soft deletes an empty temporary project after archiving its last multi-repo worktree', async () => {
    const temporaryItem: MultiRepoSidebarItem = {
      type: 'multi-repo',
      id: 'workspace-1',
      name: 'Temporary Workspace',
      color: '#fedcba',
      repos: [],
      worktrees: [],
      collapsed: false,
      order: 0,
      temporary: true,
    };
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
      temporary: true,
    });
    mockedReadWorkspaceWorktrees
      .mockResolvedValueOnce([
        {
          id: 'wt-1',
          branchName: 'feature/wt-1',
          createdAt: '2026-04-20T00:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([]);
    mockedReadAllSidebarItems.mockResolvedValue({
      version: 1,
      items: [
        temporaryItem,
        {
          ...buildWorkspace(),
          id: 'project-2',
        },
      ],
    });

    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'workspace-1',
        worktreeId: 'wt-1',
      }),
    ).resolves.toEqual({
      success: true,
      removedTemporaryWorkspaceId: 'workspace-1',
      removedTemporaryWorkspaceName: 'Temporary Workspace',
      warnings: [],
    });

    expect(mockedWriteAllSidebarItems).not.toHaveBeenCalled();
    expect(mockedRm).not.toHaveBeenCalledWith('/workspaces/workspace-1', {
      recursive: true,
      force: true,
    });
  });

  it('keeps tracked compatibility symlink names reserved for new worktrees until archive removes the owner', async () => {
    const linkPath = '/workspace-worktrees/workspace-1/generated-worktree';
    const ownerWorktree: WorktreeData = {
      id: 'owner',
      branchName: 'feature/owner',
      createdAt: '2026-04-20T00:00:00.000Z',
      compatibilitySymlinks: [
        {
          path: linkPath,
          targetPath: '/workspace-worktrees/workspace-1/owner',
          reason: 'adhoc-multi-repo-transition',
          sourceWorkspaceId: 'source',
          sourceWorktreeId: 'generated-worktree',
          createdAt: '2026-05-19T00:00:00.000Z',
        },
      ],
    };
    let persistedWorktrees: WorktreeData[] = [ownerWorktree];
    mockedListWorkspaceItems.mockImplementation(() =>
      Promise.resolve([
        {
          ...buildMultiRepoWorkspace(),
          worktrees: persistedWorktrees,
        },
      ]),
    );
    mockedReadWorkspaceConfig.mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: '/repos/source',
      repos: buildMultiRepoWorkspace().repos,
    });
    mockedReadWorkspaceWorktrees.mockImplementation(() =>
      Promise.resolve(persistedWorktrees),
    );
    mockedUpdateWorkspaceWorktrees.mockImplementation(
      async (_workspaceId, updater) => {
        persistedWorktrees = await updater(persistedWorktrees);
        return persistedWorktrees;
      },
    );
    mockedRemoveWorkspaceWorktrees.mockImplementation(
      (_workspaceId, predicate) => {
        const removed = persistedWorktrees.filter(predicate);
        persistedWorktrees = persistedWorktrees.filter(
          (worktree) => !predicate(worktree),
        );
        return Promise.resolve(removed);
      },
    );
    mockedLstat.mockImplementation((candidatePath) => {
      if (String(candidatePath).includes('generated-worktree'))
        return Promise.reject(
          Object.assign(new Error('missing'), { code: 'ENOENT' }),
        );
      return Promise.resolve(
        makeLstatResult(String(candidatePath) === linkPath),
      );
    });
    mockedReadlink.mockResolvedValue('owner');

    const createdBeforeArchive = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      deferGitSetup: true,
    });
    if (createdBeforeArchive.needsRepair) {
      throw new Error('Expected a successful create response');
    }
    expect(createdBeforeArchive.id).toBe('generated-worktree-2');

    await archiveMultiRepoWorktree({
      workspaceId: 'workspace-1',
      worktreeId: 'owner',
    });

    const createdAfterArchive = await createMultiRepoWorktree({
      workspaceId: 'workspace-1',
      deferGitSetup: true,
    });
    if (createdAfterArchive.needsRepair) {
      throw new Error('Expected a successful create response');
    }
    expect(createdAfterArchive.id).toBe('generated-worktree');
  });

  describe('createSingleRepoWorktree with existingBranch', () => {
    it('rejects combining existingBranch with branchName', async () => {
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'ws-1',
          existingBranch: 'feature/foo',
          branchName: 'other',
        }),
      ).rejects.toThrow(/cannot be combined/i);
    });

    it('tracks a base branch while reusing an existing branch', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(true);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');

      const result = await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'feature/foo',
        baseBranch: 'develop',
      });

      expect(result).toEqual(
        expect.objectContaining({
          branchName: 'feature/foo',
          trackedBaseBranch: 'develop',
        }),
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('worktrees'),
        'feature/foo',
      );
      expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
    });

    it('rejects a branch that is already checked out', async () => {
      mockedListCheckedOutBranches.mockResolvedValue(
        new Map([['feature/foo', '/Users/me/repo']]),
      );
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'ws-1',
          existingBranch: 'feature/foo',
        }),
      ).rejects.toThrow(/already checked out/i);
    });

    it('refuses a checked-out or missing branch with a typed refusal', async () => {
      mockedListCheckedOutBranches.mockResolvedValue(
        new Map([['feature/foo', '/Users/me/repo']]),
      );
      const checkedOut = createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'feature/foo',
      });
      await expect(checkedOut).rejects.toBeInstanceOf(
        WorktreeCreationRefusedError,
      );
      await expect(checkedOut).rejects.toMatchObject({
        reason: 'branch-checked-out',
        message:
          'Branch "feature/foo" is already checked out at /Users/me/repo',
      });

      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      const missing = createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'missing',
      });
      await expect(missing).rejects.toBeInstanceOf(
        WorktreeCreationRefusedError,
      );
      await expect(missing).rejects.toMatchObject({
        reason: 'branch-not-found',
        message: 'Branch "missing" was not found',
      });
    });

    it('rejects a branch that does not exist locally or on origin', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'ws-1',
          existingBranch: 'missing',
        }),
      ).rejects.toThrow(/was not found/i);
    });

    it('creates the worktree via createWorktreeForExistingBranch', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(true);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');

      const result = await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'feature/foo',
      });

      expect(result.branchName).toBe('feature/foo');
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        expect.any(String), // reference repo path from the harness config
        expect.stringContaining('worktrees'),
        'feature/foo',
      );
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
      expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
    });

    it('bounds the pre-create origin fetch and never prompts for credentials', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(true);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');

      await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'feature/foo',
      });

      expect(mockedFetchOrigin).toHaveBeenCalledTimes(1);
      expectBoundedOriginFetch('/repos/project-1');
    });

    it('falls back to local refs when the bounded origin fetch fails', async () => {
      mockedFetchOrigin.mockRejectedValueOnce(new Error('timed out'));
      mockedDoesLocalBranchExist.mockResolvedValue(true);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/foo');

      const result = await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        existingBranch: 'feature/foo',
      });

      expect(result.branchName).toBe('feature/foo');
    });

    it('names the failed origin refresh when the branch is missing', async () => {
      mockedFetchOrigin.mockRejectedValueOnce(new Error('timed out'));
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);

      await expect(
        createSingleRepoWorktree({
          workspaceId: 'ws-1',
          existingBranch: 'missing',
        }),
      ).rejects.toThrow(
        'Branch "missing" was not found, and origin could not be refreshed',
      );
    });
  });

  describe('createSingleRepoWorktree with an invalid branch name', () => {
    it('refuses the name with a typed refusal', async () => {
      mockedValidateBranchName.mockResolvedValue(false);
      const created = createSingleRepoWorktree({
        workspaceId: 'ws-1',
        branchName: 'bad..name',
      });
      await expect(created).rejects.toBeInstanceOf(
        WorktreeCreationRefusedError,
      );
      await expect(created).rejects.toMatchObject({
        reason: 'invalid-branch-name',
        message: 'Invalid branch name: "bad..name"',
      });
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
    });
  });

  describe('createSingleRepoWorktree with suggestedBranch', () => {
    it('rejects combining suggestedBranch with another branch intent', async () => {
      await expect(
        createSingleRepoWorktree({
          workspaceId: 'ws-1',
          suggestedBranch: 'feature/linear',
          branchName: 'other',
        }),
      ).rejects.toThrow(/cannot be combined/i);
    });

    it('fetches origin and checks out a remote suggested branch', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(true);
      mockedCreateWorktreeForExistingBranch.mockResolvedValue('feature/linear');

      const result = await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        suggestedBranch: 'feature/linear',
      });

      expect(result.branchName).toBe('feature/linear');
      expect(mockedFetchOrigin).toHaveBeenCalledWith(expect.any(String));
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('worktrees'),
        'feature/linear',
      );
      expect(mockedCreateWorktree).not.toHaveBeenCalled();
    });

    it('creates a suggested branch only after confirming it is absent', async () => {
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedCreateWorktree.mockResolvedValue('feature/linear');

      const result = await createSingleRepoWorktree({
        workspaceId: 'ws-1',
        suggestedBranch: 'feature/linear',
      });

      expect(result.branchName).toBe('feature/linear');
      expect(mockedFetchOrigin).toHaveBeenCalledWith(expect.any(String));
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        expect.any(String),
        expect.stringContaining('worktrees'),
        'feature/linear',
      );
      expect(mockedCreateWorktreeForExistingBranch).not.toHaveBeenCalled();
    });
  });

  describe('createMultiRepoWorktree with existingBranch', () => {
    it('reuses existingBranch in a non-source-backed multi-repo project', async () => {
      mockedListWorkspaceItems.mockResolvedValue([
        buildTemporaryMultiRepoWorkspace(),
      ]);
      mockedDoesLocalBranchExist.mockResolvedValue(true);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      const result = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        existingBranch: 'feature/foo',
        baseBranchesByRepo: {
          'repo-a': 'main',
          'repo-b': 'develop',
        },
        existingWorktreeIds: [],
      });

      if (result.needsRepair) {
        throw new Error('Expected a successful create response');
      }
      expect(result.branchName).toBe('feature/foo');
      expect(result.trackedRepoBaseBranches).toEqual({
        'repo-a': 'main',
        'repo-b': 'develop',
      });
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-a',
        expect.stringContaining('repo-a'),
        'feature/foo',
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.stringContaining('repo-b'),
        'feature/foo',
      );
    });

    it('checks out the branch in repos where it exists and creates it fresh elsewhere', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockImplementation((repoPath: string) =>
        Promise.resolve(
          repoPath === '/refs/source' || repoPath === '/repos/repo-a',
        ),
      );
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );
      mockedCreateWorktree.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      const result = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        existingBranch: 'feature/foo',
        existingWorktreeIds: [],
      });
      if (result.needsRepair) {
        throw new Error('Expected a successful create response');
      }

      expect(result.branchName).toBe('feature/foo');
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/refs/source',
        expect.stringContaining('root'),
        'feature/foo',
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-a',
        expect.stringContaining('repo-a'),
        'feature/foo',
      );
      // The pre-create reference check is bounded; per-repo checks are not.
      expectBoundedOriginFetch('/refs/source');
      expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/repo-a');
      expect(mockedFetchOrigin).toHaveBeenCalledWith('/repos/repo-b');
      const repoAFetchOrder =
        mockedFetchOrigin.mock.invocationCallOrder[
          mockedFetchOrigin.mock.calls.findIndex(
            ([repoPath]) => repoPath === '/repos/repo-a',
          )
        ];
      const repoALocalCheckOrder =
        mockedDoesLocalBranchExist.mock.invocationCallOrder[
          mockedDoesLocalBranchExist.mock.calls.findIndex(
            ([repoPath]) => repoPath === '/repos/repo-a',
          )
        ];
      if (repoAFetchOrder === undefined || repoALocalCheckOrder === undefined) {
        throw new Error('Expected repo-a fetch and branch-check calls');
      }
      expect(repoAFetchOrder).toBeLessThan(repoALocalCheckOrder);
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.stringContaining('repo-b'),
        'feature/foo',
      );
      expect(mockedCreateWorktreeFromStartPoint).not.toHaveBeenCalled();
    });

    it('aborts when a branch appears in a repository outside the restore allowlist', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockImplementation((repoPath: string) =>
        Promise.resolve(
          repoPath === '/refs/source' ||
            repoPath === '/repos/repo-a' ||
            repoPath === '/repos/repo-b',
        ),
      );
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedListCheckedOutBranches.mockResolvedValue(new Map());
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      await expect(
        createMultiRepoWorktree({
          workspaceId: 'workspace-1',
          existingBranch: 'feature/archive',
          existingBranchRepoPaths: ['/refs/source', '/repos/repo-a'],
          existingWorktreeIds: [],
        }),
      ).rejects.toThrow(
        'availability changed in repository "/repos/repo-b" after restore validation',
      );

      expect(mockedCreateWorktreeForExistingBranch).not.toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.any(String),
        'feature/archive',
      );
    });
  });

  describe('createMultiRepoWorktree with suggestedBranch', () => {
    it('resolves the suggested branch against the source repo before creating children', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockImplementation((repoPath: string) =>
        Promise.resolve(
          repoPath === '/refs/source' || repoPath === '/repos/repo-a',
        ),
      );
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );
      mockedCreateWorktree.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      const result = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        suggestedBranch: 'feature/linear',
        existingWorktreeIds: [],
      });
      if (result.needsRepair) {
        throw new Error('Expected a successful create response');
      }

      expect(result.branchName).toBe('feature/linear');
      expect(mockedFetchOrigin).toHaveBeenCalledWith('/refs/source');
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/refs/source',
        expect.stringContaining('root'),
        'feature/linear',
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-a',
        expect.stringContaining('repo-a'),
        'feature/linear',
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.stringContaining('repo-b'),
        'feature/linear',
      );
    });

    it('resolves the suggested branch independently for each child repo', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath === '/repos/repo-a'),
      );
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );
      mockedCreateWorktree.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      const result = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        suggestedBranch: 'feature/linear',
        existingWorktreeIds: [],
      });
      if (result.needsRepair) {
        throw new Error('Expected a successful create response');
      }

      expect(result.branchName).toBe('feature/linear');
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/refs/source',
        expect.stringContaining('root'),
        'feature/linear',
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-a',
        expect.stringContaining('repo-a'),
        'feature/linear',
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.stringContaining('repo-b'),
        'feature/linear',
      );
    });

    it('reuses a suggested branch that exists locally only in a child repo', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockImplementation((repoPath: string) =>
        Promise.resolve(repoPath === '/repos/repo-a'),
      );
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedCreateWorktreeForExistingBranch.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );
      mockedCreateWorktree.mockImplementation(
        (_repoPath, _worktreePath, branch) => Promise.resolve(branch),
      );

      const result = await createMultiRepoWorktree({
        workspaceId: 'workspace-1',
        suggestedBranch: 'feature/linear',
        existingWorktreeIds: [],
      });
      if (result.needsRepair) {
        throw new Error('Expected a successful create response');
      }

      expect(result.branchName).toBe('feature/linear');
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/refs/source',
        expect.stringContaining('root'),
        'feature/linear',
      );
      expect(mockedCreateWorktreeForExistingBranch).toHaveBeenCalledWith(
        '/repos/repo-a',
        expect.stringContaining('repo-a'),
        'feature/linear',
      );
      expect(mockedCreateWorktree).toHaveBeenCalledWith(
        '/repos/repo-b',
        expect.stringContaining('repo-b'),
        'feature/linear',
      );
    });

    it('rejects a child repo that creates a different suggested branch name', async () => {
      mockedListWorkspaceItems.mockResolvedValue([buildMultiRepoWorkspace()]);
      mockedDoesLocalBranchExist.mockResolvedValue(false);
      mockedDoesRemoteBranchExist.mockResolvedValue(false);
      mockedCreateWorktree.mockImplementation(
        (repoPath: string, _worktreePath: string, branch: string) =>
          Promise.resolve(
            repoPath === '/repos/repo-b' ? `${branch}-2` : branch,
          ),
      );

      await expect(
        createMultiRepoWorktree({
          workspaceId: 'workspace-1',
          suggestedBranch: 'feature/linear',
          existingWorktreeIds: [],
        }),
      ).rejects.toThrow(
        'Repo "Repo B" created branch "feature/linear-2" instead of "feature/linear"',
      );
    });
  });
});
