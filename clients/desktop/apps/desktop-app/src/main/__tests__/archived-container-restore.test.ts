/* eslint-disable @typescript-eslint/explicit-function-return-type, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import type * as NodeFsPromisesModule from 'node:fs/promises';
import type * as NodeOsModule from 'node:os';
import type * as ClaudeProjectPathsModule from '../lib/claude-project-paths';
import { dirname, join } from 'node:path';
import {
  APP_ADVISOR_PROJECT_ID,
  type ArchivedContainerManifest,
  type ArchivedChatsFile,
  type ChatTabsFile,
  type TrackedPlanData,
} from '@canopy/desktop-shared/types';

// Real filesystem; a test can queue a held or failing removal.
jest.mock('node:fs/promises', () => {
  const actual =
    jest.requireActual<typeof NodeFsPromisesModule>('node:fs/promises');
  return { ...actual, rm: jest.fn(actual.rm) };
});
jest.mock('node:os', () => ({
  ...jest.requireActual<typeof NodeOsModule>('node:os'),
  homedir: jest.fn(),
}));

jest.mock('../lib/archived-containers', () => ({
  broadcastArchivedContainersChanged: jest.fn(),
  purgeArchivedContainerAfterRestore: jest.fn(() => Promise.resolve(true)),
  readArchivedContainerChatArchives: jest.fn(),
  readArchivedContainerChats: jest.fn(),
  getArchivedContainerChatStorage: jest.fn().mockResolvedValue({}),
  readArchivedContainerManifest: jest.fn(),
  readArchivedContainerTrackedPlans: jest.fn(() =>
    Promise.resolve({ version: 1, plans: [] }),
  ),
  removeArchivedContainerPayloadsAfterPartialRestore: jest.fn(() =>
    Promise.resolve(),
  ),
  restoreArchivedContainerWorkspaceRootFiles: jest.fn(() =>
    Promise.resolve([]),
  ),
  commitArchivedContainer: jest.fn(() => Promise.resolve()),
  withArchivedContainerOperationLock: jest.fn(
    (
      _projectId: string,
      _containerId: string,
      operation: () => Promise<unknown>,
    ) => operation(),
  ),
}));
jest.mock('../lib/chat-archives', () => ({
  RESTORE_WINDOW_MS: 7 * 24 * 60 * 60 * 1_000,
  // Mirrors the real last-activity semantics: the last message timestamp
  // wins over createdAt.
  isTabWithinRestoreWindow: (
    tab: { createdAt: string; messages: Array<{ timestamp?: number }> },
    now: number,
  ): boolean => {
    const created = Date.parse(tab.createdAt);
    let last = Number.isFinite(created) ? created : 0;
    for (const message of tab.messages) {
      if (typeof message.timestamp === 'number') {
        last = Math.max(last, message.timestamp);
      }
    }
    return last > 0 && now - last <= 7 * 24 * 60 * 60 * 1_000;
  },
  writeChatArchivesFile: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/chat-tabs', () => ({
  writeChatTabsFile: jest.fn(() => Promise.resolve()),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    importStorageScope: async (
      scope: { projectId: string; worktreeId: string },
      _source: unknown,
      tabs: ChatTabsFile,
      archives: ArchivedChatsFile,
    ) => {
      const chatTabs = jest.requireMock('../lib/chat-tabs');
      const chatArchives = jest.requireMock('../lib/chat-archives');
      await chatTabs.writeChatTabsFile(scope.projectId, scope.worktreeId, tabs);
      await chatArchives.writeChatArchivesFile(
        scope.projectId,
        scope.worktreeId,
        archives,
      );
    },
  }),
}));
jest.mock('../lib/worktree-service', () => ({
  archiveMultiRepoWorktree: jest.fn(() => Promise.resolve({ success: true })),
  archiveSingleRepoWorktree: jest.fn(() => Promise.resolve({ success: true })),
  createMultiRepoWorktree: jest.fn(),
  createSingleRepoWorktree: jest.fn(),
  retryDeferredTemporaryWorkspaceDeletion: jest.fn(() => Promise.resolve(null)),
}));
jest.mock('../lib/archived-container-git', () => ({
  assertArchivedGitStateRestorable: jest.fn(() => Promise.resolve()),
  resolveArchivedContainerRestoreBaseBranches: jest.fn(() =>
    Promise.resolve({ baseBranchesByRepo: {}, warnings: [] }),
  ),
  restoreArchivedContainerGitState: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/archived-container-recovery', () => ({
  finishArchivedContainerRecovery: jest.fn(() => Promise.resolve([])),
  restoreArchivedRecoveryFiles: jest.fn(),
  restoreArchivedRecoveryWorkspaceRootFiles: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../lib/github-pr', () => ({
  fetchArchivedPullRequestMetadata: jest.fn(),
}));
jest.mock('../lib/workspace-persistence', () => ({
  readWorkspaceConfig: jest.fn(),
  readWorkspaceWorktrees: jest.fn(),
  updateWorkspaceWorktrees: jest.fn(
    (_projectId: string, update: (worktrees: unknown[]) => unknown[]) =>
      Promise.resolve(update([])),
  ),
}));
jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: jest.fn(),
}));
jest.mock('../lib/project-reference-repo', () => ({
  resolveProjectReferenceRepoPath: jest.fn((value: string) =>
    Promise.resolve(value),
  ),
}));
jest.mock('../lib/workspace-reference-repo', () => ({
  resolveWorkspaceReferenceRepoPath: jest.fn((value: string) =>
    Promise.resolve(value),
  ),
}));
jest.mock('../lib/git', () => ({
  appendBranchSuffix: (branchName: string, suffix: number): string =>
    `${branchName}-${suffix}`,
  doesLocalBranchExist: jest.fn(() => Promise.resolve(false)),
  doesRemoteBranchExist: jest.fn(() => Promise.resolve(false)),
  fetchOrigin: jest.fn(() => Promise.resolve()),
  isAncestor: jest.fn(() => Promise.resolve(true)),
  isBranchNameAvailable: jest.fn(() => Promise.resolve(true)),
  listCheckedOutBranches: jest.fn(() => Promise.resolve(new Map())),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(
    (projectId: string, worktreeId: string, selectedRepoId?: string) =>
      `/worktrees/${projectId}/${worktreeId}${selectedRepoId ? `/${selectedRepoId}` : ''}`,
  ),
}));
jest.mock('../lib/codex-session-artifacts', () => ({
  findCodexRolloutFiles: jest.fn(() => Promise.resolve([])),
  resolveCodexHomeForTab: jest.fn(() => Promise.resolve('/codex-home')),
}));
jest.mock('../codex/fork-thread', () => ({
  forkCodexThreadByIdViaOneShot: jest.fn(),
}));
jest.mock('../lib/claude-project-paths', () => {
  const actual = jest.requireActual<typeof ClaudeProjectPathsModule>(
    '../lib/claude-project-paths',
  );
  return {
    ...actual,
    resolveClaudeCodeSessionTranscriptPath: jest.fn(() =>
      Promise.resolve(null),
    ),
    claudeProjectDirCandidates: jest.fn(() =>
      Promise.resolve(['project-slug']),
    ),
  };
});
jest.mock('../lib/cowork-work-entries', () => ({
  createWorkEntry: jest.fn(),
  listWorkEntries: jest.fn(),
  removeWorkEntryRow: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/worktree-data-cleanup', () => ({
  cleanupPersistedWorktreeData: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../pipelines/execution-runtime', () => ({
  createElectronExecutionRuntime: jest.fn(),
}));
jest.mock('../chat-search/service', () => ({
  ChatSearchService: jest.fn().mockImplementation(() => ({
    worktreeContainerRestored: jest.fn(),
  })),
  getChatSearchService: jest.fn(),
}));
jest.mock('../lib/project-worktree-runtime', () => ({
  startProjectWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/workspace-worktree-runtime', () => ({
  startWorkspaceWorktreePostCreateSetup: jest.fn(),
}));
jest.mock('../lib/paths', () => ({
  getWorkspaceWorktreesFilePath: jest.fn(
    (projectId: string) => `/workspaces/${projectId}/worktrees.json`,
  ),
  getArchivedContainerAttachmentsDir: jest.fn(),
  getArchivedContainerExecutionsDir: jest.fn(),
  getArchivedContainerProviderSessionsDir: jest.fn(),
  getArchivedContainerRecoveryEvidenceDir: jest.fn(
    (_projectId: string, worktreeId: string, containerId: string) =>
      join(
        mockRecoveryEvidenceRoot,
        worktreeId,
        'archive-recovery-evidence',
        containerId,
      ),
  ),
  getArchivedContainerSummaryPath: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(),
  getWorktreeSummaryFilePath: jest.fn(),
  getWorkspaceWorktreeDir: jest.fn(
    (projectId: string, worktreeId: string) =>
      `/worktrees/${projectId}/${worktreeId}`,
  ),
}));
jest.mock('../lib/plan-persistence', () => ({
  installRestoredTrackedPlans: jest.fn(() => Promise.resolve()),
}));
jest.mock('../ledger/lifecycle', () => ({
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
}));
jest.mock('../cost-index/lifecycle', () => ({
  restoreEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../browser/browser-profile-lifecycle', () => ({
  withBrowserTaskOwnerRemoval: jest.fn(
    (
      _projectId: string,
      _worktreeId: string,
      removeOwner: () => Promise<unknown>,
    ) => removeOwner(),
  ),
}));
const mockTransferPlanExploreTargets = jest.fn(
  (): Promise<string[]> => Promise.resolve([]),
);
jest.mock('../lib/plan-explore-registry', () => ({
  transferPlanExploreTargets: (...args: unknown[]): Promise<string[]> =>
    mockTransferPlanExploreTargets(...args),
}));

import {
  finishArchivedContainerRecovery,
  restoreArchivedRecoveryFiles,
  restoreArchivedRecoveryWorkspaceRootFiles,
} from '../lib/archived-container-recovery';
import { restoreArchivedContainer } from '../lib/archived-container-restore';
import {
  assertArchivedGitStateRestorable,
  resolveArchivedContainerRestoreBaseBranches,
  restoreArchivedContainerGitState,
} from '../lib/archived-container-git';
import {
  purgeArchivedContainerAfterRestore as purgeArchivedContainer,
  readArchivedContainerChatArchives,
  readArchivedContainerChats,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
  removeArchivedContainerPayloadsAfterPartialRestore,
  restoreArchivedContainerWorkspaceRootFiles,
  commitArchivedContainer,
} from '../lib/archived-containers';
import { installRestoredTrackedPlans } from '../lib/plan-persistence';
import { writeChatArchivesFile } from '../lib/chat-archives';
import { writeChatTabsFile } from '../lib/chat-tabs';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
  createMultiRepoWorktree,
  createSingleRepoWorktree,
} from '../lib/worktree-service';
import {
  readWorkspaceConfig,
  readWorkspaceWorktrees,
  updateWorkspaceWorktrees,
} from '../lib/workspace-persistence';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import {
  doesLocalBranchExist,
  doesRemoteBranchExist,
  fetchOrigin,
  isAncestor,
  isBranchNameAvailable,
  listCheckedOutBranches,
} from '../lib/git';
import {
  findCodexRolloutFiles,
  resolveCodexHomeForTab,
} from '../lib/codex-session-artifacts';
import { forkCodexThreadByIdViaOneShot } from '../codex/fork-thread';
import {
  createWorkEntry,
  listWorkEntries,
  removeWorkEntryRow,
} from '../lib/cowork-work-entries';
import { createElectronExecutionRuntime } from '../pipelines/execution-runtime';
import {
  ChatSearchService,
  getChatSearchService,
} from '../chat-search/service';
import {
  getArchivedContainerAttachmentsDir,
  getArchivedContainerExecutionsDir,
  getArchivedContainerProviderSessionsDir,
  getArchivedContainerRecoveryEvidenceDir,
  getArchivedContainerSummaryPath,
  getWorktreeAttachmentsDir,
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeDir,
} from '../lib/paths';
import { fetchArchivedPullRequestMetadata } from '../lib/github-pr';
import { startProjectWorktreePostCreateSetup } from '../lib/project-worktree-runtime';
import { startWorkspaceWorktreePostCreateSetup } from '../lib/workspace-worktree-runtime';
import { cleanupPersistedWorktreeData } from '../lib/worktree-data-cleanup';
import {
  notifyLedgerContainerPurged,
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../ledger/lifecycle';

/** The restore's Ledger incarnations: the archived and the restored one. */
function worktreeRestoreIncarnations(): [unknown, unknown] {
  return [
    {
      container: {
        kind: 'code_worktree',
        workspaceId: PROJECT_ID,
        worktreeId: CONTAINER_ID,
      },
      containerCreatedAt: '2026-07-01T00:00:00.000Z',
    },
    {
      container: {
        kind: 'code_worktree',
        workspaceId: PROJECT_ID,
        worktreeId: 'new-worktree',
      },
      containerCreatedAt: '2026-07-22T00:00:00.000Z',
    },
  ];
}

/** Each call's position, to check it ran before the matching purge. */
function callOrder(mock: {
  mock: { invocationCallOrder: number[] };
}): number[] {
  return mock.mock.invocationCallOrder;
}

const PROJECT_ID = 'workspace-1';
const CONTAINER_ID = 'old-worktree';
let rootDir: string;
let mockRecoveryEvidenceRoot: string;
let currentManifest: ArchivedContainerManifest;
let searchService: ChatSearchService;
let worktreeContainerRestored: jest.SpiedFunction<
  ChatSearchService['worktreeContainerRestored']
>;

function manifest(
  overrides: Partial<ArchivedContainerManifest> = {},
): ArchivedContainerManifest {
  return {
    version: 1,
    id: CONTAINER_ID,
    kind: 'worktree',
    projectId: PROJECT_ID,
    name: 'Original worktree',
    createdAt: '2026-07-01T00:00:00.000Z',
    archivedAt: '2026-07-20T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2026-07-27T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: 'single-repo',
    ...overrides,
  };
}

function version2Manifest(): ArchivedContainerManifest {
  const version2: ArchivedContainerManifest = {
    ...manifest(),
    version: 2,
    kind: 'worktree',
    branchName: 'feature/archive',
    workspaceType: 'single-repo',
    originalWorktree: {
      id: CONTAINER_ID,
      branchName: 'feature/archive',
      createdAt: '2026-07-01T00:00:00.000Z',
    },
    gitState: {
      version: 1,
      diffFormatVersion: 1,
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: 'source',
          relativePath: '.',
          referenceRepoPath: '/repos/source',
          branchName: 'feature/archive',
          comparisonBaseBranch: 'main',
          baseBranchCommit: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          comparisonBaseCommit: '1111111111111111111111111111111111111111',
          headCommit: '2222222222222222222222222222222222222222',
          indexSnapshotCommit: '3333333333333333333333333333333333333333',
          worktreeSnapshotCommit: '4444444444444444444444444444444444444444',
          snapshotRef:
            'refs/app/archived-containers/workspace-1/old-worktree/__single_repo__',
        },
      ],
    },
    gitChanges: {
      status: 'complete',
      capturedAt: '2026-07-20T00:00:00.000Z',
      fileCount: 1,
      insertions: 1,
      deletions: 0,
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: 'source',
          fileCount: 1,
          insertions: 1,
          deletions: 0,
        },
      ],
    },
    pullRequestMetadata: {
      capturedAt: '2026-07-20T00:00:01.000Z',
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: 'source',
          status: 'complete',
          pullRequest: null,
        },
      ],
    },
  };
  return version2;
}

const emptyArchives: ArchivedChatsFile = { version: 1, archived: [] };

describe('archived container restore', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-restore-'));
    mockRecoveryEvidenceRoot = join(rootDir, 'worktree-data');
    jest.mocked(homedir).mockReturnValue(join(rootDir, 'home'));
    currentManifest = manifest();
    jest
      .mocked(readArchivedContainerManifest)
      .mockImplementation(() => Promise.resolve(currentManifest));
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
    jest
      .mocked(readArchivedContainerChatArchives)
      .mockResolvedValue(emptyArchives);
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'single-repo',
      repoPath: '/repos/source',
      repos: [],
    });
    jest.mocked(doesLocalBranchExist).mockResolvedValue(false);
    jest.mocked(doesRemoteBranchExist).mockResolvedValue(false);
    jest.mocked(fetchOrigin).mockResolvedValue(undefined);
    jest.mocked(isAncestor).mockResolvedValue(true);
    jest.mocked(isBranchNameAvailable).mockResolvedValue(true);
    jest.mocked(listCheckedOutBranches).mockResolvedValue(new Map());
    jest
      .mocked(resolveArchivedContainerRestoreBaseBranches)
      .mockResolvedValue({ baseBranchesByRepo: {}, warnings: [] });
    jest.mocked(createSingleRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'generated-worktree',
      createdAt: '2026-07-22T00:00:00.000Z',
    });
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'new-worktree',
        branchName: 'generated-worktree',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    ]);
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'new-entry',
        title: 'Archived entry title',
        createdAt: '2026-07-22T00:00:00.000Z',
        chatCount: 0,
      },
    ]);
    jest.mocked(createElectronExecutionRuntime).mockReturnValue({
      executionsDir: join(rootDir, 'live-executions'),
      tempRootDir: join(rootDir, 'temp'),
      bundledActionsDir: join(rootDir, 'actions'),
      getProjectActionsDir: (repoPath: string) => repoPath,
      getProjectPipelinesDir: (repoPath: string) => repoPath,
      // Pipeline fixtures do not enforce an org model policy.
      isModelBlockedByOrgPolicy: (): Promise<boolean> => Promise.resolve(false),
      isOrgModelPolicyActive: (): Promise<boolean> => Promise.resolve(false),
    });
    jest
      .mocked(getArchivedContainerExecutionsDir)
      .mockReturnValue(join(rootDir, 'archived-executions'));
    jest
      .mocked(getArchivedContainerProviderSessionsDir)
      .mockReturnValue(join(rootDir, 'provider-sessions'));
    jest
      .mocked(getArchivedContainerSummaryPath)
      .mockReturnValue(join(rootDir, 'missing-summary.json'));
    jest
      .mocked(getWorktreeSummaryFilePath)
      .mockImplementation((_projectId, worktreeId) =>
        join(rootDir, 'summaries', `${worktreeId}.json`),
      );
    jest
      .mocked(getArchivedContainerAttachmentsDir)
      .mockReturnValue(join(rootDir, 'archived-attachments'));
    jest
      .mocked(getWorktreeAttachmentsDir)
      .mockImplementation((_projectId, worktreeId) =>
        join(rootDir, 'attachments', worktreeId),
      );
    searchService = new ChatSearchService();
    worktreeContainerRestored = jest.spyOn(
      searchService,
      'worktreeContainerRestored',
    );
    jest.mocked(getChatSearchService).mockReturnValue(searchService);
    jest
      .mocked(resolveCodexHomeForTab)
      .mockResolvedValue(join(rootDir, 'codex-home'));
    jest.mocked(findCodexRolloutFiles).mockResolvedValue([]);
    jest.mocked(commitArchivedContainer).mockImplementation((next) => {
      currentManifest = next;
      return Promise.resolve();
    });
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('removes an unpublished recovery destination when file restoration fails', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };
    const destination = join(rootDir, 'failed-recovery');
    jest.mocked(getWorkspaceWorktreeDir).mockReturnValueOnce(destination);
    jest
      .mocked(restoreArchivedRecoveryFiles)
      .mockImplementationOnce(async () => {
        await mkdir(destination);
        await writeFile(join(destination, 'partial.txt'), 'partial copy');
        throw new Error('recovery copy interrupted');
      });
    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('recovery copy interrupted');
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
  });

  it('restores retained workspace-root payloads from a version-3 recovery', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(restoreArchivedRecoveryWorkspaceRootFiles).toHaveBeenCalledWith(
      expect.objectContaining({ version: 3, id: CONTAINER_ID }),
      `/worktrees/${PROJECT_ID}/${result.restoredWorktreeId}`,
    );
  });

  it('stamps and reuses a recovery destination when interrupted after copying files', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };
    jest
      .mocked(updateWorkspaceWorktrees)
      .mockRejectedValueOnce(new Error('process interrupted after copy'))
      .mockImplementationOnce(
        (_projectId, update: (worktrees: unknown[]) => unknown[]) =>
          Promise.resolve(update([])),
      );

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('process interrupted after copy');
    expect(currentManifest).toMatchObject({
      restoreStaging: {
        kind: 'worktree',
        id: expect.stringMatching(/^recovery-/),
        createdAt: expect.any(String),
      },
    });
    const stagedId = Reflect.get(
      Reflect.get(currentManifest, 'restoreStaging'),
      'id',
    );

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({ restoredWorktreeId: stagedId });
    expect(getWorkspaceWorktreeDir).toHaveBeenCalledTimes(2);
    expect(getWorkspaceWorktreeDir).toHaveBeenNthCalledWith(
      1,
      PROJECT_ID,
      stagedId,
    );
    expect(getWorkspaceWorktreeDir).toHaveBeenNthCalledWith(
      2,
      PROJECT_ID,
      stagedId,
    );
  });

  it('removes staged recovery evidence when worktree registration fails', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      restoreStaging: {
        kind: 'worktree',
        id: 'recovery-staged',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };
    const evidenceDir = getArchivedContainerRecoveryEvidenceDir(
      PROJECT_ID,
      'recovery-staged',
      CONTAINER_ID,
    );
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, 'retained'), 'evidence');
    jest
      .mocked(updateWorkspaceWorktrees)
      .mockRejectedValueOnce(new Error('worktree registration failed'));

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('worktree registration failed');
    await expect(access(evidenceDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('waits for staged evidence removal before rejecting a failed recovery registration', async () => {
    jest.mocked(readWorkspaceWorktrees).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      return [];
    });
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      restoreStaging: {
        kind: 'worktree',
        id: 'recovery-staged',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };
    const evidenceDir = getArchivedContainerRecoveryEvidenceDir(
      PROJECT_ID,
      'recovery-staged',
      CONTAINER_ID,
    );
    await mkdir(evidenceDir, { recursive: true });
    jest
      .mocked(updateWorkspaceWorktrees)
      .mockRejectedValueOnce(new Error('worktree registration failed'));
    let releaseEvidenceRemoval: () => void = () => {};
    const evidenceRemovalHeld = new Promise<void>((resolve) => {
      releaseEvidenceRemoval = resolve;
    });
    let markEvidenceRemovalStarted: () => void = () => {};
    const evidenceRemovalStarted = new Promise<void>((resolve) => {
      markEvidenceRemovalStarted = resolve;
    });
    const actualRm =
      jest.requireActual<typeof NodeFsPromisesModule>('node:fs/promises').rm;
    jest
      .mocked(rm)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('destination cleanup failed'))
      .mockImplementationOnce(async (path, options) => {
        markEvidenceRemovalStarted();
        await evidenceRemovalHeld;
        await actualRm(path, options);
      });
    let settled = false;
    const restore = restoreArchivedContainer(PROJECT_ID, CONTAINER_ID).finally(
      () => {
        settled = true;
      },
    );

    const restoreRejected = expect(restore).rejects.toThrow(
      'destination cleanup failed',
    );
    try {
      await Promise.race([evidenceRemovalStarted, restoreRejected]);
      // Let an early rejection propagate while evidence removal stays held.
      await new Promise<void>((resolve) => setImmediate(resolve));
      // Stale-destination clear, failed destination cleanup, held evidence.
      expect(rm).toHaveBeenCalledTimes(3);
      expect(settled).toBe(false);
    } finally {
      releaseEvidenceRemoval();
      await restoreRejected;
    }
    await expect(access(evidenceDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rolls back the exact files-only destination when later payload installation fails', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      restoreStaging: {
        kind: 'worktree',
        id: 'recovery-staged',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };
    const destination = join(rootDir, 'failed-published-recovery');
    const evidenceDir = getArchivedContainerRecoveryEvidenceDir(
      PROJECT_ID,
      'recovery-staged',
      CONTAINER_ID,
    );
    let worktrees = [
      {
        id: 'recovery-staged',
        branchName: 'feature/archive',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    ];
    jest.mocked(getWorkspaceWorktreeDir).mockReturnValue(destination);
    jest
      .mocked(readWorkspaceWorktrees)
      .mockImplementation(() => Promise.resolve(worktrees));
    jest
      .mocked(updateWorkspaceWorktrees)
      .mockImplementation((_projectId, update) => {
        worktrees = update(worktrees);
        // Like the real writer, resolve with the list it committed.
        return Promise.resolve(worktrees);
      });
    jest.mocked(restoreArchivedRecoveryFiles).mockImplementation(async () => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, 'restored.txt'), 'restored');
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, 'snapshot.bundle'), 'evidence');
    });
    jest
      .mocked(restoreArchivedRecoveryWorkspaceRootFiles)
      .mockRejectedValueOnce(new Error('workspace payload install failed'));

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('workspace payload install failed');

    expect(worktrees).toEqual([]);
    expect(cleanupPersistedWorktreeData).toHaveBeenCalledWith(
      PROJECT_ID,
      'recovery-staged',
    );
    await expect(access(destination)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(access(evidenceDir)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
  });

  it('preserves the included repository scope for files-only recovery', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      workspaceType: 'multi-repo',
      originalWorktree: {
        ...original.originalWorktree,
        includedRepoIds: ['repo-a'],
      },
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    };

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    const update = jest.mocked(updateWorkspaceWorktrees).mock.calls[0]?.[1];
    expect(update?.([])).toEqual([
      expect.objectContaining({
        includedRepoIds: ['repo-a'],
        restoredFromFilesOnlyArchiveId: CONTAINER_ID,
      }),
    ]);
  });

  it('preserves restoredTo when version-3 cleanup remains pending', async () => {
    const original = version2Manifest();
    if (original.version !== 2) throw new Error('Expected Git manifest');
    currentManifest = {
      ...original,
      version: 3,
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
        gitCleanupPending: true,
      },
    };
    jest
      .mocked(finishArchivedContainerRecovery)
      .mockImplementationOnce((manifest) => {
        manifest.recovery = {
          ...manifest.recovery,
          gitCleanupPending: true,
        };
        return Promise.resolve([]);
      });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(currentManifest.restoredTo).toMatchObject({
      kind: 'worktree',
      id: result.restoredWorktreeId,
    });
    // The archive, with its restore destination, stays: no intent is needed
    // until a later attempt purges it.
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(recordLedgerRestoreIntent).not.toHaveBeenCalled();
  });

  it('creates a version-2 restore from a validated archived base branch', async () => {
    currentManifest = version2Manifest();
    jest.mocked(resolveArchivedContainerRestoreBaseBranches).mockResolvedValue({
      baseBranchesByRepo: { __single_repo__: 'main' },
      warnings: [],
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(createSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: PROJECT_ID,
        baseBranch: 'main',
        allowBaseBranchNetwork: false,
        seedPanelLayoutMode: false,
      }),
    );
    expect(result.warnings).toEqual([]);
  });

  it('falls back and returns a restore-toast warning when the archived base is invalid', async () => {
    currentManifest = version2Manifest();
    const warning =
      'Base branch "main" for source no longer contains archived commit aaaaaaaa. Restored that repository using the current project default; review its base branch.';
    jest
      .mocked(resolveArchivedContainerRestoreBaseBranches)
      .mockResolvedValue({ baseBranchesByRepo: {}, warnings: [warning] });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    const createOptions = jest.mocked(createSingleRepoWorktree).mock
      .calls[0]?.[0];
    expect(createOptions).toBeDefined();
    expect(createOptions).not.toHaveProperty('baseBranch');
    expect(result.warnings).toEqual([warning]);
  });

  it('reuses an available local branch that still contains the archived head', async () => {
    currentManifest = version2Manifest();
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(resolveArchivedContainerRestoreBaseBranches).mockResolvedValue({
      baseBranchesByRepo: { __single_repo__: 'main' },
      warnings: [],
    });
    jest.mocked(createSingleRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive',
      createdAt: '2026-07-22T00:00:00.000Z',
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(isAncestor).toHaveBeenCalledWith(
      '/repos/source',
      '2222222222222222222222222222222222222222',
      'refs/heads/feature/archive',
    );
    expect(createSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        existingBranch: 'feature/archive',
        baseBranch: 'main',
      }),
    );
    expect(restoreArchivedContainerGitState).toHaveBeenCalledWith(
      expect.objectContaining({ preserveDescendantHead: true }),
    );
    expect(result.warnings).toEqual([]);
  });

  it('reuses a preserved generated branch captured by a version-2 archive', async () => {
    const capturedManifest = version2Manifest();
    if (capturedManifest.version !== 2) {
      throw new Error('Expected a version-2 archived-container manifest.');
    }
    currentManifest = {
      ...capturedManifest,
      branchName: undefined,
      originalWorktree: {
        ...capturedManifest.originalWorktree,
        branchName: 'generated-worktree',
      },
      gitState: {
        ...capturedManifest.gitState,
        repositories: capturedManifest.gitState.repositories.map(
          (repository) => ({
            ...repository,
            branchName: 'generated-worktree',
          }),
        ),
      },
    };
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(createSingleRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'generated-worktree',
      createdAt: '2026-07-22T00:00:00.000Z',
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(createSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ existingBranch: 'generated-worktree' }),
    );
    expect(restoreArchivedContainerGitState).toHaveBeenCalledWith(
      expect.objectContaining({ preserveDescendantHead: true }),
    );
  });

  it('uses a unique branch and explains when the local branch diverged', async () => {
    currentManifest = version2Manifest();
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(isAncestor).mockResolvedValue(false);
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(createSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-2' }),
    );
    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because its source history no longer contains archived commit 22222222; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('uses a unique branch and explains when the local branch is checked out elsewhere', async () => {
    currentManifest = version2Manifest();
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest
      .mocked(listCheckedOutBranches)
      .mockResolvedValue(
        new Map([['feature/archive', '/worktrees/other-worktree']]),
      );
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because it is already checked out in another Git worktree; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('checks repositories added after archival before reusing a branch', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(doesLocalBranchExist)
      .mockImplementation((repoPath) =>
        Promise.resolve(repoPath === '/repos/source'),
      );
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest
      .mocked(listCheckedOutBranches)
      .mockImplementation((repoPath) =>
        Promise.resolve(
          repoPath === '/repos/added'
            ? new Map([['feature/archive', '/worktrees/other-worktree']])
            : new Map(),
        ),
      );
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-2',
      createdAt: '2026-10-15T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(listCheckedOutBranches).toHaveBeenCalledWith('/repos/added');
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-2' }),
    );
    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because it is already checked out in another Git worktree; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('carries the archived repository allowlist into multi-repo creation', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(doesLocalBranchExist)
      .mockImplementation((repoPath) =>
        Promise.resolve(repoPath === '/repos/source'),
      );
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(listCheckedOutBranches).mockResolvedValue(new Map());
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive',
      trackedRepoBaseBranches: {},
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        existingBranch: 'feature/archive',
        existingBranchRepoPaths: ['/repos/source'],
      }),
    );
  });

  it('does not reuse an unrelated branch in a repository added after archival', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(doesLocalBranchExist)
      .mockImplementation(() => Promise.resolve(true));
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(listCheckedOutBranches).mockResolvedValue(new Map());
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-2',
      createdAt: '2026-10-15T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(doesLocalBranchExist).toHaveBeenCalledWith(
      '/repos/added',
      'feature/archive',
    );
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-2' }),
    );
    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because a repository added after archival already has a local or remote branch with that name; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('does not reuse a remote-only branch in a repository added after archival', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(doesLocalBranchExist)
      .mockImplementation((repoPath) =>
        Promise.resolve(repoPath === '/repos/source'),
      );
    jest
      .mocked(doesRemoteBranchExist)
      .mockImplementation((repoPath, branch) =>
        Promise.resolve(
          repoPath === '/repos/added' && branch === 'feature/archive',
        ),
      );
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest.mocked(listCheckedOutBranches).mockResolvedValue(new Map());
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-2',
      createdAt: '2026-10-15T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(fetchOrigin).toHaveBeenCalledWith('/repos/added');
    expect(doesRemoteBranchExist).toHaveBeenCalledWith(
      '/repos/added',
      'feature/archive',
    );
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-2' }),
    );
    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because a repository added after archival already has a local or remote branch with that name; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('avoids a remote-only preferred branch when no archived local branch remains', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest.mocked(doesLocalBranchExist).mockResolvedValue(false);
    jest
      .mocked(doesRemoteBranchExist)
      .mockImplementation((repoPath, branch) =>
        Promise.resolve(
          repoPath === '/repos/added' && branch === 'feature/archive',
        ),
      );
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repoPath, branch) =>
        Promise.resolve(branch !== 'feature/archive'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-2',
      trackedRepoBaseBranches: {},
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-2' }),
    );
  });

  it('avoids remote-only collisions while selecting a suffixed restore branch', async () => {
    currentManifest = {
      ...version2Manifest(),
      workspaceType: 'multi-repo',
    };
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/source',
      repos: [{ id: 'added', name: 'Added', repoPath: '/repos/added' }],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest
      .mocked(doesRemoteBranchExist)
      .mockImplementation((repoPath, branch) =>
        Promise.resolve(
          repoPath === '/repos/added' && branch === 'feature/archive-2',
        ),
      );
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([]);
    jest
      .mocked(listCheckedOutBranches)
      .mockImplementation((repoPath) =>
        Promise.resolve(
          repoPath === '/repos/source'
            ? new Map([['feature/archive', '/worktrees/other']])
            : new Map(),
        ),
      );
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repoPath, branch) =>
        Promise.resolve(branch !== 'feature/archive'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-3',
      trackedRepoBaseBranches: {},
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(doesRemoteBranchExist).toHaveBeenCalledWith(
      '/repos/added',
      'feature/archive-2',
    );
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feature/archive-3' }),
    );
  });

  it('uses a unique branch and explains when another tracked worktree owns the branch', async () => {
    currentManifest = version2Manifest();
    jest.mocked(doesLocalBranchExist).mockResolvedValue(true);
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'tracked-worktree',
        branchName: 'feature/archive',
        createdAt: '2026-07-21T00:00:00.000Z',
      },
    ]);
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(result.warnings).toContain(
      'Local branch "feature/archive" could not be reused because it is already assigned to tracked worktree "tracked-worktree"; restored as "feature/archive-2" to preserve the existing branch.',
    );
  });

  it('reports the restored location when an archived repository name is occupied', async () => {
    currentManifest = manifest();
    jest
      .mocked(restoreArchivedContainerWorkspaceRootFiles)
      .mockResolvedValueOnce([
        { originalName: 'temporary', restoredName: 'temporary-archived' },
      ]);
    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);
    expect(result.warnings).toContain(
      'Restored archived repository repos/temporary to repos/temporary-archived because its original path is already in use.',
    );
  });

  it('deduplicates the branch and strips resumability from stale tabs', async () => {
    currentManifest = manifest({ branchName: 'feature/archive' });
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );
    const chats: ChatTabsFile = {
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Old chat',
          createdAt: '2020-01-01T00:00:00.000Z',
          messages: [],
          sdkSessionId: 'session-old',
          claudeForkSessionOnNextSend: true,
          staleSessionDetected: true,
          staleSessionResumeId: 'resume-old',
          queuedMessages: [],
          lastTurnWasResumeAttempt: true,
        },
      ],
    };
    jest.mocked(readArchivedContainerChats).mockResolvedValue(chats);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      kind: 'worktree',
      restoredWorktreeId: 'new-worktree',
      branchName: 'generated-worktree',
    });

    expect(createSingleRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: PROJECT_ID,
        branchName: 'feature/archive-2',
        deferGitSetup: false,
        startPostCreateSetup: false,
        seedPanelLayoutMode: false,
      }),
    );
    expect(startProjectWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: 'new-worktree',
      }),
    );
    expect(restoreArchivedContainerWorkspaceRootFiles).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      '/worktrees/workspace-1/new-worktree',
    );
    const restored = jest.mocked(writeChatTabsFile).mock.calls[0]?.[2];
    expect(restored?.tabs[0]).toMatchObject({ readOnly: true });
    expect(restored?.tabs[0]).not.toHaveProperty('sdkSessionId');
    expect(restored?.tabs[0]).not.toHaveProperty('claudeForkSessionOnNextSend');
    expect(purgeArchivedContainer).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
    expect(
      jest.mocked(writeChatTabsFile).mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(purgeArchivedContainer).mock.invocationCallOrder[0],
    );
  });

  it('aborts version-2 restore preflight before destination creation', async () => {
    currentManifest = version2Manifest();
    jest
      .mocked(assertArchivedGitStateRestorable)
      .mockRejectedValueOnce(
        new Error(
          'Archived Git state for repository source is unavailable; the archive was preserved.',
        ),
      );

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('repository source');

    expect(createSingleRepoWorktree).not.toHaveBeenCalled();
    expect(commitArchivedContainer).not.toHaveBeenCalled();
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
  });

  it('rolls back a version-2 destination when Git state application fails', async () => {
    currentManifest = version2Manifest();
    jest
      .mocked(restoreArchivedContainerGitState)
      .mockRejectedValueOnce(new Error('Git apply failed'));

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('Git apply failed');

    expect(createSingleRepoWorktree).toHaveBeenCalledTimes(1);
    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: 'new-worktree',
      retainAsArchivedContainer: false,
      deleteBranch: false,
    });
    expect(commitArchivedContainer).not.toHaveBeenCalled();
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
  });

  it('restores attachments and re-bound tracked plans into the destination', async () => {
    const archivedAttachments = join(rootDir, 'archived-attachments');
    await mkdir(archivedAttachments, { recursive: true });
    await writeFile(join(archivedAttachments, 'notes.txt'), 'attached');
    const plan: TrackedPlanData = {
      id: 'plan-1',
      projectId: PROJECT_ID,
      worktreeId: CONTAINER_ID,
      source: 'claude',
      title: 'Captured plan',
      content: '# Captured plan',
      reviewStatus: 'approved',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
      latestRevisionNumber: 1,
      revisions: [],
      linkedExecutionIds: [],
    };
    jest.mocked(readArchivedContainerTrackedPlans).mockResolvedValue({
      version: 1,
      plans: [plan],
    });

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      kind: 'worktree',
      restoredWorktreeId: 'new-worktree',
    });

    await expect(
      readFile(
        join(rootDir, 'attachments', 'new-worktree', 'notes.txt'),
        'utf8',
      ),
    ).resolves.toBe('attached');
    expect(installRestoredTrackedPlans).toHaveBeenCalledWith(
      PROJECT_ID,
      'new-worktree',
      [plan],
    );
  });

  it('uses the effective multi-repo set for branch deduction and preserves the container on repair abort', async () => {
    currentManifest = manifest({
      workspaceType: 'multi-repo',
      branchName: 'feature/archive',
    });
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/workspace-source',
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
      ],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repo, branch) =>
        Promise.resolve(branch === 'feature/archive-2'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/archive-2',
      createdAt: '2026-10-15T00:00:00.000Z',
      trackedRepoBaseBranches: {},
      needsRepair: true,
      repairIssues: [
        {
          code: 'missing-root',
          message: 'Project root is missing',
        },
      ],
    });

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('Project root is missing');

    expect(isBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/workspace-source',
      'feature/archive-2',
    );
    expect(isBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/repo-a',
      'feature/archive-2',
    );
    expect(isBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/repo-b',
      'feature/archive-2',
    );
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        branchName: 'feature/archive-2',
        startPostCreateSetup: false,
        seedPanelLayoutMode: false,
      }),
    );
    expect(archiveMultiRepoWorktree).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: 'new-worktree',
      allowMissingRow: true,
      expectedCreatedAt: '2026-10-15T00:00:00.000Z',
      retainAsArchivedContainer: false,
      deleteBranch: false,
    });
    expect(startWorkspaceWorktreePostCreateSetup).not.toHaveBeenCalled();
    expect(writeChatTabsFile).not.toHaveBeenCalled();
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
  });

  it('restores a root-only multi-repo archive without child repositories', async () => {
    currentManifest = manifest({
      workspaceType: 'multi-repo',
      restoreScope: 'workspace-root-only',
      branchName: 'feature/root-archive',
    });
    jest.mocked(readWorkspaceConfig).mockResolvedValue({
      version: 1,
      type: 'multi-repo',
      repos: [],
    });
    jest.mocked(readEffectiveWorkspaceConfig).mockResolvedValue({
      localConfig: { version: 1, type: 'multi-repo', repos: [] },
      manifest: null,
      sourceRepoPath: '/repos/workspace-source',
      repos: [
        { id: 'repo-a', name: 'Repo A', repoPath: '/repos/repo-a' },
        { id: 'repo-b', name: 'Repo B', repoPath: '/repos/repo-b' },
      ],
      suppressedManifestRepos: [],
      unresolvedManifestRepoIds: [],
    });
    jest
      .mocked(isBranchNameAvailable)
      .mockImplementation((_repoPath, branchName) =>
        Promise.resolve(branchName === 'feature/root-archive-2'),
      );
    jest.mocked(createMultiRepoWorktree).mockResolvedValue({
      id: 'new-worktree',
      branchName: 'feature/root-archive-2',
      createdAt: '2026-07-22T00:00:00.000Z',
      trackedRepoBaseBranches: {},
    });

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({ restoredWorktreeId: 'new-worktree' });

    expect(isBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/workspace-source',
      'feature/root-archive',
    );
    expect(isBranchNameAvailable).toHaveBeenCalledWith(
      '/repos/workspace-source',
      'feature/root-archive-2',
    );
    expect(createMultiRepoWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        includedRepoIds: [],
        branchName: 'feature/root-archive-2',
      }),
    );
    expect(startWorkspaceWorktreePostCreateSetup).toHaveBeenCalledWith(
      expect.objectContaining({ repos: [] }),
    );
  });

  it('rebinds legacy plan chats even when a pipeline execution fails to restore', async () => {
    const archiveDir = getArchivedContainerExecutionsDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(archiveDir, { recursive: true });
    await writeFile(join(archiveDir, 'execution-retry.json'), '{bad json');

    const partial = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(partial.warnings.join(' ')).toContain('execution-retry');
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    // The partial archive outlives this call; its registry rows must already
    // name the restored worktree, or purging it would reclaim live chats.
    expect(mockTransferPlanExploreTargets).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: CONTAINER_ID },
      { projectId: PROJECT_ID, worktreeId: 'new-worktree' },
    );
    expect(
      mockTransferPlanExploreTargets.mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(removeArchivedContainerPayloadsAfterPartialRestore).mock
        .invocationCallOrder[0] ?? 0,
    );
  });

  it('preserves unknown execution fields and resumes a stamped partial restore without creating twice', async () => {
    const archiveDir = getArchivedContainerExecutionsDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(archiveDir, { recursive: true });
    await writeFile(
      join(archiveDir, 'execution-good.json'),
      JSON.stringify({
        id: 'execution-good',
        project_id: PROJECT_ID,
        worktree_id: CONTAINER_ID,
        cwd: '/old/cwd',
        status: 'success',
        future_field: { preserved: true },
        jobs: {
          build: {
            steps: {
              say: {
                log_file: join(archiveDir, 'execution-good', 'logs', 'say.log'),
              },
            },
          },
        },
        target: {
          scope: 'worktree',
          workspace_id: PROJECT_ID,
          worktree_id: CONTAINER_ID,
          path: '/old/cwd',
          unknown_target_field: 42,
        },
      }),
    );
    await writeFile(join(archiveDir, 'execution-retry.json'), '{bad json');

    const first = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(first.warnings.join(' ')).toContain('execution-retry');
    expect(
      jest.mocked(commitArchivedContainer).mock.calls[0]?.[0].restoredTo,
    ).toMatchObject({ id: 'new-worktree' });
    expect(
      removeArchivedContainerPayloadsAfterPartialRestore,
    ).toHaveBeenCalledWith(PROJECT_ID, CONTAINER_ID);
    expect(
      jest.mocked(commitArchivedContainer).mock.calls.at(-1)?.[0],
    ).toMatchObject({ executionRestorePending: true });
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    const restoredGood: unknown = JSON.parse(
      await readFile(
        join(rootDir, 'live-executions', 'execution-good.json'),
        'utf8',
      ),
    );
    expect(restoredGood).toMatchObject({
      project_id: PROJECT_ID,
      worktree_id: 'new-worktree',
      cwd: `/worktrees/${PROJECT_ID}/new-worktree`,
      future_field: { preserved: true },
      jobs: {
        build: {
          steps: {
            say: {
              log_file: join(
                rootDir,
                'live-executions',
                'execution-good',
                'logs',
                'say.log',
              ),
            },
          },
        },
      },
      target: {
        worktree_id: 'new-worktree',
        path: `/worktrees/${PROJECT_ID}/new-worktree`,
        unknown_target_field: 42,
      },
    });
    await expect(
      access(join(archiveDir, 'execution-good.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(createSingleRepoWorktree).toHaveBeenCalledTimes(1);
    expect(worktreeContainerRestored).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      'new-worktree',
    );

    await writeFile(
      join(archiveDir, 'execution-retry.json'),
      JSON.stringify({
        id: 'execution-retry',
        project_id: PROJECT_ID,
        worktree_id: CONTAINER_ID,
        cwd: '/old/cwd',
        status: 'success',
      }),
    );
    const second = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(second).toMatchObject({ restoredWorktreeId: 'new-worktree' });
    expect(restoreArchivedContainerWorkspaceRootFiles).toHaveBeenCalledTimes(1);
    expect(createSingleRepoWorktree).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFile).toHaveBeenCalledTimes(1);
    expect(purgeArchivedContainer).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
  });

  it('installs captured Claude transcripts and downgrades missing sessions to read-only', async () => {
    const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
    const claudeConfigDir = join(rootDir, 'isolated-claude-home');
    process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
    const providerRoot = join(rootDir, 'provider-sessions', 'claude');
    await mkdir(providerRoot, { recursive: true });
    await writeFile(join(providerRoot, 'session-present.jsonl'), 'transcript');
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-present',
      tabs: [
        {
          id: 'chat-present',
          title: 'Captured Claude chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'claude',
          sdkSessionId: 'session-present',
          selectedRepoId: 'repo-a',
        },
        {
          id: 'chat-missing',
          title: 'Missing Claude chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'claude',
          sdkSessionId: 'session-missing',
        },
      ],
    });

    const result = await restoreArchivedContainer(
      PROJECT_ID,
      CONTAINER_ID,
    ).finally(() => {
      if (originalClaudeConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR;
      } else {
        process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
      }
    });

    expect(
      await readFile(
        join(
          claudeConfigDir,
          'projects',
          'project-slug',
          'session-present.jsonl',
        ),
        'utf8',
      ),
    ).toBe('transcript');
    const restoredTabs = jest.mocked(writeChatTabsFile).mock.calls[0]?.[2].tabs;
    expect(restoredTabs?.[0]).toMatchObject({
      sdkSessionId: 'session-present',
      claudeForkSessionOnNextSend: true,
      readOnly: false,
    });
    expect(restoredTabs?.[0]?.pendingSystemInstructions?.[0]?.text).toContain(
      '/worktrees/workspace-1/old-worktree/repo-a',
    );
    expect(restoredTabs?.[0]?.pendingSystemInstructions?.[0]?.text).toContain(
      '/worktrees/workspace-1/new-worktree/repo-a',
    );
    expect(restoredTabs?.[1]).toMatchObject({ readOnly: true });
    expect(restoredTabs?.[1]).not.toHaveProperty('sdkSessionId');
    expect(result.warnings.join(' ')).toContain('chat-missing');
  });

  it('replaces stale relocation context while preserving other instructions across repeated restores', async () => {
    jest.mocked(readArchivedContainerChatArchives).mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'archived-chat',
            title: 'Archived chat',
            createdAt: new Date().toISOString(),
            messages: [],
            selectedRepoId: 'repo-b',
            pendingSystemInstructions: [
              { id: 'plan', text: 'Use the approved plan.' },
              {
                id: 'worktree-relocation',
                text: 'Previously moved from /worktrees/first-source to /worktrees/first-destination.',
              },
            ],
          },
          archivedAt: new Date().toISOString(),
          turnCount: 2,
        },
      ],
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    const restoredArchives = jest.mocked(writeChatArchivesFile).mock
      .calls[0]?.[2];
    const restoredTab = restoredArchives?.archived[0]?.tab;
    expect(restoredTab?.pendingSystemInstructions?.map(({ id }) => id)).toEqual(
      ['plan', 'worktree-relocation'],
    );
    expect(restoredTab?.pendingSystemInstructions?.[1]?.text).toContain(
      '/worktrees/workspace-1/old-worktree/repo-b',
    );
    expect(restoredTab?.pendingSystemInstructions?.[1]?.text).toContain(
      '/worktrees/workspace-1/new-worktree/repo-b',
    );
    expect(restoredTab?.pendingSystemInstructions?.[1]?.text).not.toContain(
      '/worktrees/first-source',
    );
    expect(restoredTab?.pendingSystemInstructions?.[1]?.text).not.toContain(
      '/worktrees/first-destination',
    );
  });

  it('installs captured Codex rollouts without clobbering local files and stores the forked thread id', async () => {
    const sessionId = 'thread-original';
    const capturedRoot = join(
      rootDir,
      'provider-sessions',
      'codex',
      'chat-codex',
      'sessions',
    );
    const source = join(capturedRoot, '2026', `${sessionId}.jsonl`);
    const codexHome = join(rootDir, 'codex-home');
    const destination = join(
      codexHome,
      'sessions',
      '2026',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(source), { recursive: true });
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(source, 'captured');
    await writeFile(destination, 'existing');
    jest
      .mocked(findCodexRolloutFiles)
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([destination]);
    jest
      .mocked(forkCodexThreadByIdViaOneShot)
      .mockResolvedValue('thread-forked');
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-codex',
      tabs: [
        {
          id: 'chat-codex',
          title: 'Codex chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'codex',
          sdkSessionId: sessionId,
        },
      ],
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(await readFile(destination, 'utf8')).toBe('existing');
    expect(forkCodexThreadByIdViaOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: 'new-worktree',
        chatId: 'chat-codex',
        sourceThreadId: sessionId,
      }),
    );
    expect(
      jest.mocked(writeChatTabsFile).mock.calls[0]?.[2].tabs[0],
    ).toMatchObject({
      sdkSessionId: 'thread-forked',
      readOnly: false,
    });
    expect(result.warnings).toEqual([]);
  });

  it('restores an Ollama-backed Codex chat from captured rollouts', async () => {
    const sessionId = 'thread-ollama';
    const source = join(
      rootDir,
      'provider-sessions',
      'codex',
      'chat-ollama',
      'sessions',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'captured');
    jest
      .mocked(findCodexRolloutFiles)
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([source]);
    jest
      .mocked(forkCodexThreadByIdViaOneShot)
      .mockResolvedValue('thread-ollama-forked');
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-ollama',
      tabs: [
        {
          id: 'chat-ollama',
          title: 'Ollama Codex chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'ollama',
          executionHarness: 'codex',
          sdkSessionId: sessionId,
        },
      ],
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(forkCodexThreadByIdViaOneShot).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceThreadId: sessionId,
        chatId: 'chat-ollama',
      }),
    );
    expect(
      jest.mocked(writeChatTabsFile).mock.calls[0]?.[2].tabs[0],
    ).toMatchObject({
      providerType: 'ollama',
      executionHarness: 'codex',
      sdkSessionId: 'thread-ollama-forked',
      readOnly: false,
    });
  });

  it('installs Codex provider data for an archived Ollama-backed Codex chat', async () => {
    const sessionId = 'thread-ollama-archived';
    const source = join(
      rootDir,
      'provider-sessions',
      'codex',
      'chat-ollama-archived',
      'sessions',
      `${sessionId}.jsonl`,
    );
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'captured');
    jest.mocked(findCodexRolloutFiles).mockResolvedValue([source]);
    jest.mocked(readArchivedContainerChatArchives).mockResolvedValue({
      version: 1,
      archived: [
        {
          tab: {
            id: 'chat-ollama-archived',
            title: 'Archived Ollama Codex chat',
            createdAt: new Date().toISOString(),
            messages: [],
            providerType: 'ollama',
            executionHarness: 'codex',
            sdkSessionId: sessionId,
          },
          archivedAt: new Date().toISOString(),
          turnCount: 1,
        },
      ],
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(resolveCodexHomeForTab).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: 'chat-ollama-archived',
        worktreeId: 'new-worktree',
      }),
    );
  });

  it('keeps the original Codex thread resumable when rollouts exist but forking fails', async () => {
    const source = join(
      rootDir,
      'provider-sessions',
      'codex',
      'chat-codex',
      'sessions',
      'thread-original.jsonl',
    );
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'captured');
    jest
      .mocked(findCodexRolloutFiles)
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([source]);
    jest
      .mocked(forkCodexThreadByIdViaOneShot)
      .mockRejectedValue(new Error('fork unavailable'));
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-codex',
      tabs: [
        {
          id: 'chat-codex',
          title: 'Codex chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'codex',
          sdkSessionId: 'thread-original',
        },
      ],
    });

    const result = await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(
      jest.mocked(writeChatTabsFile).mock.calls[0]?.[2].tabs[0],
    ).toMatchObject({
      sdkSessionId: 'thread-original',
      readOnly: false,
    });
    expect(result.warnings.join(' ')).toContain('fork unavailable');
  });

  it('restores a work entry under its archived title and retains a fresh Claude session id', async () => {
    currentManifest = manifest({
      kind: 'work-entry',
      name: 'Archived entry title',
      workspaceType: undefined,
    });
    jest.mocked(createWorkEntry).mockResolvedValue({
      entry: {
        id: 'new-entry',
        title: 'Archived entry title',
        createdAt: '2026-07-22T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-1',
      tabs: [
        {
          id: 'chat-1',
          title: 'Fresh chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'claude',
          sdkSessionId: 'session-fresh',
        },
      ],
    });

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      kind: 'work-entry',
      restoredEntryId: 'new-entry',
    });

    expect(createWorkEntry).toHaveBeenCalledWith(PROJECT_ID, {
      title: 'Archived entry title',
      seedPanelLayoutMode: false,
    });
    expect(writeChatTabsFile).toHaveBeenCalledWith(
      PROJECT_ID,
      'new-entry',
      expect.objectContaining({
        tabs: [expect.objectContaining({ sdkSessionId: 'session-fresh' })],
      }),
    );
    expect(writeChatArchivesFile).toHaveBeenCalledWith(
      PROJECT_ID,
      'new-entry',
      emptyArchives,
    );
    expect(
      jest.mocked(commitArchivedContainer).mock.calls[0]?.[0].restoredTo,
    ).toMatchObject({
      kind: 'work-entry',
      id: 'new-entry',
      createdAt: '2026-07-22T00:00:00.000Z',
    });
  });

  it('resumes worktree finalization after purge fails without creating twice', async () => {
    currentManifest = version2Manifest();
    jest
      .mocked(purgeArchivedContainer)
      .mockRejectedValueOnce(new Error('purge unavailable'))
      .mockResolvedValueOnce(true);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('purge unavailable');

    expect(currentManifest.restoredTo).toMatchObject({
      kind: 'worktree',
      id: 'new-worktree',
    });

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      kind: 'worktree',
      restoredWorktreeId: 'new-worktree',
    });

    expect(createSingleRepoWorktree).toHaveBeenCalledTimes(1);
    expect(restoreArchivedContainerGitState).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFile).toHaveBeenCalledTimes(1);
    expect(purgeArchivedContainer).toHaveBeenCalledTimes(2);
    expect(fetchArchivedPullRequestMetadata).not.toHaveBeenCalled();
    // Each purge attempt first makes the old → new mapping durable, and the
    // resumed restore tells the Ledger too: the first attempt's participant
    // may not have run before an exit. Repeats are harmless.
    const incarnations = worktreeRestoreIncarnations();
    expect(jest.mocked(recordLedgerRestoreIntent).mock.calls).toEqual([
      incarnations,
      incarnations,
    ]);
    const purges = callOrder(jest.mocked(purgeArchivedContainer));
    const intents = callOrder(jest.mocked(recordLedgerRestoreIntent));
    expect(intents[0]).toBeLessThan(purges[0] ?? 0);
    expect(intents[1]).toBeGreaterThan(purges[0] ?? 0);
    expect(intents[1]).toBeLessThan(purges[1] ?? 0);
    expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(3);
    expect(notifyLedgerContainerRestored).toHaveBeenLastCalledWith(
      ...incarnations,
    );
  });

  it('rebinds retained legacy plan chats to the restored worktree before discarding the archive', async () => {
    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({ restoredWorktreeId: 'new-worktree' });

    // Restore creates a fresh worktree id; the legacy plan chats the archive
    // kept must follow it, or later cleanup of the restored worktree leaks them.
    expect(mockTransferPlanExploreTargets).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: CONTAINER_ID },
      { projectId: PROJECT_ID, worktreeId: 'new-worktree' },
    );
    expect(
      mockTransferPlanExploreTargets.mock.invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(purgeArchivedContainer).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('keeps the archive when the legacy plan chat rebind fails and rebinds on retry', async () => {
    currentManifest = version2Manifest();
    mockTransferPlanExploreTargets
      .mockRejectedValueOnce(new Error('registry busy'))
      .mockResolvedValueOnce(['plan-1']);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('registry busy');
    expect(currentManifest.restoredTo).toMatchObject({ id: 'new-worktree' });
    expect(purgeArchivedContainer).not.toHaveBeenCalled();

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({ restoredWorktreeId: 'new-worktree' });
    expect(createSingleRepoWorktree).toHaveBeenCalledTimes(1);
    expect(mockTransferPlanExploreTargets).toHaveBeenCalledTimes(2);
    expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
  });

  it('preserves a partial archive when its restore destination was replaced', async () => {
    currentManifest = manifest({
      restoredTo: {
        kind: 'worktree',
        id: 'new-worktree',
        restoredAt: '2026-07-22T00:00:00.000Z',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    });
    jest.mocked(readWorkspaceWorktrees).mockResolvedValue([
      {
        id: 'new-worktree',
        branchName: 'reused-worktree',
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    ]);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('no longer matches the partial restore destination');

    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(createSingleRepoWorktree).not.toHaveBeenCalled();
  });

  it('resumes work-entry finalization after purge fails without creating twice', async () => {
    currentManifest = manifest({
      kind: 'work-entry',
      name: 'Archived entry title',
      workspaceType: undefined,
    });
    jest.mocked(createWorkEntry).mockResolvedValue({
      entry: {
        id: 'new-entry',
        title: 'Archived entry title',
        createdAt: '2026-07-22T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });
    jest
      .mocked(purgeArchivedContainer)
      .mockRejectedValueOnce(new Error('purge unavailable'))
      .mockResolvedValueOnce(true);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('purge unavailable');
    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toMatchObject({
      kind: 'work-entry',
      restoredEntryId: 'new-entry',
    });

    expect(createWorkEntry).toHaveBeenCalledTimes(1);
    expect(writeChatTabsFile).toHaveBeenCalledTimes(1);
    expect(purgeArchivedContainer).toHaveBeenCalledTimes(2);
    // Both purge attempts are preceded by the durable intent, and the
    // resumed restore notifies the participant again.
    expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(2);
    expect(recordLedgerRestoreIntent).toHaveBeenLastCalledWith(
      {
        container: {
          kind: 'cowork_entry',
          workspaceId: PROJECT_ID,
          entryId: CONTAINER_ID,
        },
        containerCreatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        container: {
          kind: 'cowork_entry',
          workspaceId: PROJECT_ID,
          entryId: 'new-entry',
        },
        containerCreatedAt: '2026-07-22T00:00:00.000Z',
      },
    );
    const purges = callOrder(jest.mocked(purgeArchivedContainer));
    const intents = callOrder(jest.mocked(recordLedgerRestoreIntent));
    expect(intents[1]).toBeGreaterThan(purges[0] ?? 0);
    expect(intents[1]).toBeLessThan(purges[1] ?? 0);
    expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(3);
  });

  it('preserves a partial work-entry archive when its destination was replaced', async () => {
    currentManifest = manifest({
      kind: 'work-entry',
      name: 'Archived entry title',
      workspaceType: undefined,
      restoredTo: {
        kind: 'work-entry',
        id: 'new-entry',
        restoredAt: '2026-07-22T00:00:00.000Z',
        createdAt: '2026-07-22T00:00:00.000Z',
      },
    });
    jest.mocked(listWorkEntries).mockResolvedValue([
      {
        id: 'new-entry',
        title: 'Replacement entry',
        createdAt: '2026-07-23T00:00:00.000Z',
        chatCount: 0,
      },
    ]);

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('no longer matches the partial restore destination');

    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(createWorkEntry).not.toHaveBeenCalled();
  });

  it('migrates plugin-selected Codex state into the restored work entry home', async () => {
    currentManifest = manifest({
      kind: 'work-entry',
      name: 'Plugin entry',
      workspaceType: undefined,
    });
    jest.mocked(createWorkEntry).mockResolvedValue({
      entry: {
        id: 'new-entry',
        title: 'Plugin entry',
        createdAt: '2026-07-22T00:00:00.000Z',
        chatCount: 0,
      },
      reusedExistingEmpty: false,
    });
    const source = join(
      rootDir,
      'provider-sessions',
      'codex',
      'chat-plugin',
      'sessions',
      'thread-plugin.jsonl',
    );
    await mkdir(dirname(source), { recursive: true });
    await writeFile(source, 'captured plugin rollout');
    jest
      .mocked(findCodexRolloutFiles)
      .mockResolvedValueOnce([source])
      .mockResolvedValueOnce([source]);
    jest
      .mocked(forkCodexThreadByIdViaOneShot)
      .mockResolvedValue('thread-plugin-fork');
    jest.mocked(readArchivedContainerChats).mockResolvedValue({
      version: 1,
      activeTabId: 'chat-plugin',
      tabs: [
        {
          id: 'chat-plugin',
          title: 'Plugin Codex chat',
          createdAt: new Date().toISOString(),
          messages: [],
          providerType: 'codex',
          sdkSessionId: 'thread-plugin',
          pluginSelections: {
            collectionIds: ['collection-1'],
            skillRefs: [],
            pluginRefs: [],
          },
        },
      ],
    });

    await restoreArchivedContainer(PROJECT_ID, CONTAINER_ID);

    expect(resolveCodexHomeForTab).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        worktreeId: 'new-entry',
        chatId: 'chat-plugin',
      }),
    );
    const forkArgs = jest.mocked(forkCodexThreadByIdViaOneShot).mock
      .calls[0]?.[0];
    expect(forkArgs).toMatchObject({
      worktreeId: 'new-entry',
      sourceThreadId: 'thread-plugin',
    });
    expect(forkArgs?.pluginSelections?.collectionIds).toEqual(['collection-1']);
    expect(
      jest.mocked(writeChatTabsFile).mock.calls[0]?.[2].tabs[0],
    ).toMatchObject({
      sdkSessionId: 'thread-plugin-fork',
      readOnly: false,
    });
  });

  it('rolls back a new worktree if required chat installation fails', async () => {
    jest
      .mocked(writeChatTabsFile)
      .mockRejectedValueOnce(new Error('chat install failed'));

    await expect(
      restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('chat install failed');

    expect(archiveSingleRepoWorktree).toHaveBeenCalledWith({
      workspaceId: PROJECT_ID,
      worktreeId: 'new-worktree',
      retainAsArchivedContainer: false,
      deleteBranch: false,
    });
    expect(startProjectWorktreePostCreateSetup).not.toHaveBeenCalled();
    expect(purgeArchivedContainer).not.toHaveBeenCalled();
    expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
  });

  describe('Ledger lifecycle participant', () => {
    it('rebinds the scope after a worktree restore commits, keeping the mapping durable until the archive is purged', async () => {
      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });

      // Once when the destination commits, and again once the intent is
      // durable, just before the purge; the repeat only clears the intent.
      expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(2);
      expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(1);
      expect(recordLedgerRestoreIntent).toHaveBeenCalledWith(
        ...worktreeRestoreIncarnations(),
      );
      expect(callOrder(jest.mocked(recordLedgerRestoreIntent))[0]).toBeLessThan(
        callOrder(jest.mocked(purgeArchivedContainer))[0] ?? 0,
      );
      expect(notifyLedgerContainerRestored).toHaveBeenCalledWith(
        {
          container: {
            kind: 'code_worktree',
            workspaceId: PROJECT_ID,
            worktreeId: CONTAINER_ID,
          },
          containerCreatedAt: '2026-07-01T00:00:00.000Z',
        },
        {
          container: {
            kind: 'code_worktree',
            workspaceId: PROJECT_ID,
            worktreeId: 'new-worktree',
          },
          containerCreatedAt: '2026-07-22T00:00:00.000Z',
        },
      );
      // Only after the commit that records the restore destination.
      expect(
        jest.mocked(commitArchivedContainer).mock.calls[0]?.[0].restoredTo,
      ).toMatchObject({ id: 'new-worktree' });
      expect(
        jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0],
      ).toBeLessThan(
        jest.mocked(notifyLedgerContainerRestored).mock
          .invocationCallOrder[0] ?? 0,
      );
      // Purging the restored archive is part of the restore: the scope was
      // rebound, so nothing retires.
      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        PROJECT_ID,
        CONTAINER_ID,
      );
      expect(notifyLedgerContainerPurged).not.toHaveBeenCalled();
    });

    it.each([
      [
        'Cowork',
        PROJECT_ID,
        {
          kind: 'cowork_entry',
          workspaceId: PROJECT_ID,
          entryId: CONTAINER_ID,
        },
        { kind: 'cowork_entry', workspaceId: PROJECT_ID, entryId: 'new-entry' },
      ],
      [
        'App Advisor',
        APP_ADVISOR_PROJECT_ID,
        {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: CONTAINER_ID,
        },
        {
          kind: 'advisor_entry',
          appWorkspaceId: APP_ADVISOR_PROJECT_ID,
          entryId: 'new-entry',
        },
      ],
    ] as const)(
      'rebinds the scope once after a %s Work Entry restore commits',
      async (_surface, projectId, archived, restored) => {
        currentManifest = manifest({
          kind: 'work-entry',
          projectId,
          name: 'Archived entry title',
          workspaceType: undefined,
        });
        jest.mocked(createWorkEntry).mockResolvedValue({
          entry: {
            id: 'new-entry',
            title: 'Archived entry title',
            createdAt: '2026-07-22T00:00:00.000Z',
            chatCount: 0,
          },
          reusedExistingEmpty: false,
        });

        await expect(
          restoreArchivedContainer(projectId, CONTAINER_ID),
        ).resolves.toMatchObject({
          kind: 'work-entry',
          restoredEntryId: 'new-entry',
        });

        expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(2);
        expect(recordLedgerRestoreIntent).toHaveBeenCalledWith(
          {
            container: archived,
            containerCreatedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            container: restored,
            containerCreatedAt: '2026-07-22T00:00:00.000Z',
          },
        );
        expect(
          callOrder(jest.mocked(recordLedgerRestoreIntent))[0],
        ).toBeLessThan(callOrder(jest.mocked(purgeArchivedContainer))[0] ?? 0);
        expect(notifyLedgerContainerRestored).toHaveBeenCalledWith(
          {
            container: archived,
            containerCreatedAt: '2026-07-01T00:00:00.000Z',
          },
          {
            container: restored,
            containerCreatedAt: '2026-07-22T00:00:00.000Z',
          },
        );
        expect(
          jest.mocked(commitArchivedContainer).mock.invocationCallOrder[0],
        ).toBeLessThan(
          jest.mocked(notifyLedgerContainerRestored).mock
            .invocationCallOrder[0] ?? 0,
        );
      },
    );

    it('does not rebind the scope when a Work Entry restore rolls back', async () => {
      currentManifest = manifest({
        kind: 'work-entry',
        name: 'Archived entry title',
        workspaceType: undefined,
      });
      jest.mocked(createWorkEntry).mockResolvedValue({
        entry: {
          id: 'new-entry',
          title: 'Archived entry title',
          createdAt: '2026-07-22T00:00:00.000Z',
          chatCount: 0,
        },
        reusedExistingEmpty: false,
      });
      jest
        .mocked(writeChatTabsFile)
        .mockRejectedValueOnce(new Error('chat install failed'));

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).rejects.toThrow('chat install failed');

      expect(removeWorkEntryRow).toHaveBeenCalledWith(PROJECT_ID, 'new-entry');
      expect(commitArchivedContainer).not.toHaveBeenCalled();
      expect(notifyLedgerContainerRestored).not.toHaveBeenCalled();
      expect(recordLedgerRestoreIntent).not.toHaveBeenCalled();
    });

    it('completes the restore when the Ledger participant throws', async () => {
      jest.mocked(notifyLedgerContainerRestored).mockImplementationOnce(() => {
        throw new Error('Ledger participant defect');
      });

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });

      expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(2);
      expect(archiveSingleRepoWorktree).not.toHaveBeenCalled();
      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        PROJECT_ID,
        CONTAINER_ID,
      );
    });

    it('keeps the archive when the durable intent cannot be written', async () => {
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockRejectedValueOnce(new Error('Ledger journal defect'));

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });

      expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(1);
      // The participant still rebinds the scope while the app runs, but the
      // archive's `restoredTo` stays the durable mapping.
      expect(notifyLedgerContainerRestored).toHaveBeenCalledTimes(2);
      expect(purgeArchivedContainer).not.toHaveBeenCalled();
    });

    it('keeps the archive while the intent is not durable, then purges it on a resumed restore', async () => {
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockResolvedValueOnce('not_durable');

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });
      expect(purgeArchivedContainer).not.toHaveBeenCalled();

      // The journal has room again: resuming records the intent and purges.
      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });
      expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(2);
      expect(purgeArchivedContainer).toHaveBeenCalledTimes(1);
      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        PROJECT_ID,
        CONTAINER_ID,
      );
      expect(callOrder(jest.mocked(recordLedgerRestoreIntent))[1]).toBeLessThan(
        callOrder(jest.mocked(purgeArchivedContainer))[0] ?? 0,
      );
    });

    it('purges the archive when no Ledger database needs the intent', async () => {
      jest
        .mocked(recordLedgerRestoreIntent)
        .mockResolvedValueOnce('not_needed');

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({
        kind: 'worktree',
        restoredWorktreeId: 'new-worktree',
      });

      expect(purgeArchivedContainer).toHaveBeenCalledWith(
        PROJECT_ID,
        CONTAINER_ID,
      );
    });

    it('makes the mapping durable before a purge attempt that then fails', async () => {
      jest
        .mocked(purgeArchivedContainer)
        .mockRejectedValueOnce(new Error('purge unavailable'));

      await expect(
        restoreArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).rejects.toThrow('purge unavailable');

      // The intent precedes the purge attempt; the archive, with its
      // restore destination, is still there for the resume and for startup.
      expect(recordLedgerRestoreIntent).toHaveBeenCalledTimes(1);
      expect(callOrder(jest.mocked(recordLedgerRestoreIntent))[0]).toBeLessThan(
        callOrder(jest.mocked(purgeArchivedContainer))[0] ?? 0,
      );
    });
  });
});
