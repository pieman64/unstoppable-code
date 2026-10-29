/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  chmod,
  lstat,
  symlink,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as ArchivedContainerContracts from '@canopy/desktop-shared/lib/archived-container-contracts';
import type * as CostLifecycle from '../cost-index/lifecycle';
import { ChatStateV2Repository } from '../services/chat-state-v2-repository';
import { type ChatStorageV2 } from '../lib/chat-storage-v2';
import * as legacyMigration from '../lib/legacy-chat-migration';
import type {
  ArchivedContainerManifest,
  ArchivedContainerRecoveryManifest,
  TrackedPlanData,
} from '@canopy/desktop-shared/types';

const mockRemoveLegacyReviewChats = jest.fn(
  (): Promise<string[]> => Promise.resolve([]),
);
jest.mock('../lib/code-review-cleanup', () => ({
  removeCodeReviewChatsForWorktree: (...args: unknown[]): Promise<string[]> =>
    mockRemoveLegacyReviewChats(...args),
}));
const mockRemoveLegacyPlanChats = jest.fn(
  (): Promise<string[]> => Promise.resolve([]),
);
jest.mock('../lib/plan-explore-cleanup', () => ({
  removePlanExploreChatsForWorktree: (...args: unknown[]): Promise<string[]> =>
    mockRemoveLegacyPlanChats(...args),
}));
const mockTransferLegacyPlanChats = jest.fn(
  (): Promise<string[]> => Promise.resolve([]),
);
jest.mock('../lib/plan-explore-registry', () => ({
  transferPlanExploreTargets: (...args: unknown[]): Promise<string[]> =>
    mockTransferLegacyPlanChats(...args),
}));

jest.mock('../lib/paths', () => ({
  getArchivedContainerAttachmentsDir: jest.fn(),
  getArchivedContainerChatArchivesPath: jest.fn(),
  getArchivedContainerChatsPath: jest.fn(),
  getArchivedContainerCostDir: jest.fn(),
  getArchivedContainerDir: jest.fn(),
  getArchivedContainerExecutionsDir: jest.fn(),
  getArchivedContainerGitStateStagedPath: jest.fn(),
  getArchivedContainerManifestPath: jest.fn(),
  getArchivedContainerSummaryPath: jest.fn(),
  getArchivedContainerTrackedPlansPath: jest.fn(),
  getArchivedContainerWorkspaceRootDir: jest.fn(),
  getArchivedContainersRootDir: jest.fn(),
  getChatArchivesFilePath: jest.fn(),
  getChatTabsFilePath: jest.fn(),
  getEntryCostDir: jest.fn(),
  getTrackedPlansFilePath: jest.fn(),
  getWorktreeAttachmentsDir: jest.fn(),
  getWorktreeDataDir: jest.fn(),
  getWorktreeSummaryFilePath: jest.fn(),
  getWorkspaceWorktreeDir: jest.fn(),
}));
jest.mock('../lib/window-send', () => ({ sendToAllWindows: jest.fn() }));
// The cost store has its own lifecycle suites; this one only needs its hooks
// to stay out of the way and its summary join to pass manifests through.
jest.mock('../cost-index/lifecycle', () => {
  const contracts = jest.requireActual<typeof ArchivedContainerContracts>(
    '@canopy/desktop-shared/lib/archived-container-contracts',
  );
  const lifecycle = jest.requireActual<typeof CostLifecycle>(
    '../cost-index/lifecycle',
  );
  return {
    prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
    finishEntryCostArchive: jest.fn(() => Promise.resolve()),
    captureEntryCostArchive: lifecycle.captureEntryCostArchive,
    archivedContainerSummaryWithCost: jest.fn(
      (manifest: ArchivedContainerManifest) =>
        Promise.resolve(contracts.toArchivedContainerSummary(manifest)),
    ),
  };
});
jest.mock('../chat-search/service', () => ({
  ChatSearchService: jest.fn().mockImplementation(() => ({
    archivedContainerUpdated: jest.fn(),
    worktreeContainerPurged: jest.fn(),
  })),
  getChatSearchService: jest.fn(),
}));
jest.mock('../lib/archived-container-retention', () => ({
  purgeExpiredArchivedContainersForWorkspace: jest.fn(),
}));
const captureChatScopeMock = jest.fn();
const runArchiveIoRequestMock = jest.fn<Promise<unknown>, [unknown]>();
jest.mock('../archive/archive-io-runner', () => ({
  runArchiveIoRequest: (...args: [unknown]): Promise<unknown> =>
    runArchiveIoRequestMock(...args),
}));
jest.mock('../lib/archived-container-disk-usage', () => ({
  scheduleArchivedContainerDiskUsage: jest.fn(),
}));
const cancelLocalScopeMock = jest.fn().mockResolvedValue(undefined);
const releaseLocalScopeFenceMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: () => ({
    cancelLocalScope: cancelLocalScopeMock,
    releaseLocalScopeFence: releaseLocalScopeFenceMock,
  }),
}));
jest.mock('../services/chat-state-service', () => ({
  getChatStateService: () => ({
    captureStorageScope: async (
      scope: { projectId: string; worktreeId: string },
      destination: ChatStorageV2,
      allowDuringDeletion: boolean,
    ) => {
      await captureChatScopeMock();
      const repository = new ChatStateV2Repository({
        resolvePaths: () => ({
          tabs: getChatTabsFilePath(scope.projectId, scope.worktreeId),
          archives: getChatArchivesFilePath(scope.projectId, scope.worktreeId),
          journal: join(
            liveRoot(scope.projectId),
            'chat-journals',
            `${scope.worktreeId}.jsonl`,
          ),
        }),
      });
      await repository.captureScope(scope, destination, allowDuringDeletion);
    },
  }),
}));
jest.mock('../lib/archived-container-git', () => ({
  assertArchivedGitStateManifestIdentity: jest.fn(),
  assertArchivedGitStatePurgeable: jest.fn(() => Promise.resolve()),
  discardIncompleteArchivedGitCapture: jest.fn(() => Promise.resolve(true)),
  completeArchivedContainerGitCapture: jest.fn(() => Promise.resolve()),
  readArchivedGitStagedDescriptor: jest.fn(() => Promise.resolve(null)),
  invalidateArchivedContainerChanges: jest.fn(() =>
    Promise.resolve(() => undefined),
  ),
  releaseArchivedGitState: jest.fn(() => Promise.resolve()),
  repinArchivedGitState: jest.fn(() => Promise.resolve()),
}));
jest.mock('../lib/archived-container-recovery', () => ({
  finishArchivedContainerRecovery: jest.fn(
    (manifest: ArchivedContainerRecoveryManifest) => {
      manifest.recovery = {
        ...manifest.recovery,
        gitCleanupPending: false,
      };
      return Promise.resolve([]);
    },
  ),
}));

import {
  beginArchivedContainerCapture,
  commitArchivedContainer,
  countArchivedContainerExecutions,
  countArchivedContainers,
  getArchivedContainerChatStorage,
  listArchivedContainerManifestsStrict,
  listArchivedContainers,
  purgeArchivedContainer,
  purgeArchivedContainerAfterRestore,
  readArchivedContainerManifest,
  readArchivedContainerTrackedPlans,
  restoreArchivedContainerWorkspaceRootFiles,
  removeArchivedContainerPayloadsAfterPartialRestore,
  removeIncompleteArchivedContainers,
  setArchivedContainerLocked,
  withArchivedContainerOperationLock,
  withArchivedWorkspaceOperationLock,
} from '../lib/archived-containers';
import { sendToAllWindows } from '../lib/window-send';
import {
  ChatSearchService,
  getChatSearchService,
} from '../chat-search/service';
import { purgeExpiredArchivedContainersForWorkspace } from '../lib/archived-container-retention';
import { scheduleArchivedContainerDiskUsage } from '../lib/archived-container-disk-usage';
import {
  assertArchivedGitStatePurgeable,
  completeArchivedContainerGitCapture,
  discardIncompleteArchivedGitCapture,
  invalidateArchivedContainerChanges,
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
  repinArchivedGitState,
} from '../lib/archived-container-git';
import {
  getArchivedContainerAttachmentsDir,
  getArchivedContainerChatArchivesPath,
  getArchivedContainerChatsPath,
  getArchivedContainerCostDir,
  getArchivedContainerDir,
  getArchivedContainerExecutionsDir,
  getArchivedContainerGitStateStagedPath,
  getArchivedContainerManifestPath,
  getArchivedContainerSummaryPath,
  getArchivedContainerTrackedPlansPath,
  getArchivedContainerWorkspaceRootDir,
  getArchivedContainersRootDir,
  getChatArchivesFilePath,
  getChatTabsFilePath,
  getEntryCostDir,
  getTrackedPlansFilePath,
  getWorktreeAttachmentsDir,
  getWorktreeDataDir,
  getWorktreeSummaryFilePath,
  getWorkspaceWorktreeDir,
} from '../lib/paths';
import { executeArchiveIoRequest } from '../archive/archive-io-engine';
import type { ArchiveIoOperationRequest } from '../archive/archive-io-protocol';

const PROJECT_ID = 'workspace-1';
const CONTAINER_ID = 'worktree-1';
let rootDir: string;
let archivedContainerUpdated: jest.Mock;

function archiveRoot(projectId: string): string {
  return join(rootDir, 'workspaces', projectId, 'archived-containers');
}

function archiveDir(projectId: string, containerId: string): string {
  return join(archiveRoot(projectId), containerId);
}

function liveRoot(projectId: string): string {
  return join(rootDir, 'live', projectId);
}

function manifest(
  overrides: Partial<ArchivedContainerManifest> = {},
): ArchivedContainerManifest {
  return {
    version: 1,
    id: CONTAINER_ID,
    kind: 'worktree',
    projectId: PROJECT_ID,
    name: 'Feature branch',
    createdAt: '2026-07-20T00:00:00.000Z',
    archivedAt: '2026-07-22T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2099-07-29T00:00:00.000Z',
    chatCount: 1,
    archivedChatCount: 1,
    executionCount: 0,
    ...overrides,
  };
}

function trackedPlan(id: string): TrackedPlanData {
  return {
    id,
    projectId: PROJECT_ID,
    worktreeId: CONTAINER_ID,
    source: 'claude',
    title: `Plan ${id}`,
    content: '# Plan',
    reviewStatus: 'pending',
    createdAt: '2026-07-21T00:00:00.000Z',
    updatedAt: '2026-07-21T00:00:00.000Z',
    latestRevisionNumber: 0,
    revisions: [],
    linkedExecutionIds: [],
  };
}

function version2Manifest(): Extract<
  ArchivedContainerManifest,
  { version: 2 }
> {
  const version2: ArchivedContainerManifest = {
    ...manifest(),
    version: 2,
    kind: 'worktree',
    workspaceType: 'single-repo',
    originalWorktree: {
      id: CONTAINER_ID,
      branchName: 'feature/archive',
      createdAt: '2026-07-20T00:00:00.000Z',
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
          comparisonBaseCommit: '1111111111111111111111111111111111111111',
          headCommit: '2222222222222222222222222222222222222222',
          indexSnapshotCommit: '3333333333333333333333333333333333333333',
          worktreeSnapshotCommit: '4444444444444444444444444444444444444444',
          snapshotRef:
            'refs/app/archived-containers/workspace-1/worktree-1/__single_repo__',
        },
      ],
    },
    gitChanges: {
      status: 'complete',
      capturedAt: '2026-07-22T00:00:00.000Z',
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
      capturedAt: '2026-07-22T00:00:01.000Z',
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

describe('archived container store', () => {
  it('reads committed sidebar counts during capture while authoritative counts wait', async () => {
    await mkdir(archiveDir(PROJECT_ID, 'already-committed'), {
      recursive: true,
    });
    await writeFile(
      join(archiveDir(PROJECT_ID, 'already-committed'), 'container.json'),
      JSON.stringify(manifest({ id: 'already-committed' })),
    );
    let releaseCapture = (): void => {};
    let captureEntered = (): void => {};
    const entered = new Promise<void>((resolve) => {
      captureEntered = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseCapture = resolve;
    });
    captureChatScopeMock.mockImplementationOnce(async () => {
      captureEntered();
      await barrier;
    });
    const capture = beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);
    await entered;
    let authoritativeFinished = false;
    const authoritative = countArchivedContainers(PROJECT_ID).then((count) => {
      authoritativeFinished = true;
      return count;
    });
    try {
      const visibleCount = await Promise.race([
        countArchivedContainers(PROJECT_ID, { waitForMutation: false }),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve('blocked'), 200),
        ),
      ]);
      expect(visibleCount).toBe(1);
      expect(authoritativeFinished).toBe(false);
    } finally {
      releaseCapture();
      await capture;
      await expect(authoritative).resolves.toBe(1);
    }
    await commitArchivedContainer(manifest());
    await expect(countArchivedContainers(PROJECT_ID)).resolves.toBe(2);
  }, 15_000);

  beforeEach(async () => {
    jest.clearAllMocks();
    captureChatScopeMock.mockReset();
    runArchiveIoRequestMock.mockImplementation(
      (request: ArchiveIoOperationRequest) =>
        executeArchiveIoRequest(request, new AbortController().signal, {
          progress: () => undefined,
          child: {
            started: () => undefined,
            exited: () => undefined,
          },
        }),
    );
    const searchService = new ChatSearchService();
    archivedContainerUpdated = jest.spyOn(
      searchService,
      'archivedContainerUpdated',
    );
    jest.mocked(getChatSearchService).mockReturnValue(searchService);
    rootDir = await mkdtemp(join(tmpdir(), 'canopy-archived-containers-'));
    jest.mocked(getArchivedContainersRootDir).mockImplementation(archiveRoot);
    jest.mocked(getArchivedContainerDir).mockImplementation(archiveDir);
    jest
      .mocked(getArchivedContainerManifestPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'container.json'),
      );
    jest
      .mocked(getArchivedContainerChatsPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'chats.json'),
      );
    jest
      .mocked(getArchivedContainerChatArchivesPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'chat-archives.json'),
      );
    jest
      .mocked(getArchivedContainerSummaryPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'summary.json'),
      );
    jest
      .mocked(getArchivedContainerCostDir)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'cost'),
      );
    jest
      .mocked(getEntryCostDir)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'cost', containerId),
      );
    jest
      .mocked(getArchivedContainerExecutionsDir)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'pipeline-executions'),
      );
    jest
      .mocked(getArchivedContainerGitStateStagedPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'git-state.staged.json'),
      );
    jest
      .mocked(getChatTabsFilePath)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'chats', `${containerId}.json`),
      );
    jest
      .mocked(getChatArchivesFilePath)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'chat-archives', `${containerId}.json`),
      );
    jest
      .mocked(getWorktreeSummaryFilePath)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'summaries', `${containerId}.json`),
      );
    jest
      .mocked(getArchivedContainerAttachmentsDir)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'attachments'),
      );
    jest
      .mocked(getArchivedContainerTrackedPlansPath)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'tracked-plans.json'),
      );
    jest
      .mocked(getArchivedContainerWorkspaceRootDir)
      .mockImplementation((projectId, containerId) =>
        join(archiveDir(projectId, containerId), 'workspace-root'),
      );
    jest
      .mocked(getWorktreeAttachmentsDir)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'attachments', containerId),
      );
    jest
      .mocked(getWorktreeDataDir)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'worktree-data', containerId),
      );
    jest
      .mocked(getTrackedPlansFilePath)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'plans', `${containerId}.json`),
      );
    jest
      .mocked(getWorkspaceWorktreeDir)
      .mockImplementation((projectId, containerId) =>
        join(liveRoot(projectId), 'worktrees', containerId),
      );
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('archives without cost when only the cost copy fails', async () => {
    const execute = runArchiveIoRequestMock.getMockImplementation();
    if (execute === undefined) throw new Error('archive IO runner missing');
    const costDestination = getArchivedContainerCostDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    runArchiveIoRequestMock.mockImplementation((request) => {
      const copiesCost =
        (request as ArchiveIoOperationRequest).type === 'copy-payload' &&
        JSON.stringify(request).includes(costDestination);
      return copiesCost
        ? Promise.reject(new Error('EACCES: cost directory unreadable'))
        : execute(request);
    });
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    await writeFile(
      liveChats,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [{ id: 'chat-1', title: 'Kept', messages: [], createdAt: 'now' }],
      }),
    );

    const capture = await beginArchivedContainerCapture(
      PROJECT_ID,
      CONTAINER_ID,
    );

    expect(capture.chats.tabs.map((tab) => tab.id)).toEqual(['chat-1']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[cost-index] archive copy failed'),
    );
    warn.mockRestore();
  });

  it('copies required payloads and exposes the archive only after manifest commit', async () => {
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    const liveArchives = getChatArchivesFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    await mkdir(join(liveRoot(PROJECT_ID), 'chat-archives'), {
      recursive: true,
    });
    await writeFile(
      liveChats,
      JSON.stringify({
        version: 1,
        activeTabId: 'chat-1',
        tabs: [
          {
            id: 'chat-1',
            title: 'Captured chat',
            createdAt: '2026-07-22T00:00:00.000Z',
            messages: [],
            pendingSystemInstructions: [
              { id: 'plan', text: 'Use the approved plan.' },
              {
                id: 'worktree-relocation',
                text: 'The current working directory is /worktrees/current.',
              },
            ],
          },
        ],
      }),
    );
    await writeFile(
      liveArchives,
      JSON.stringify({
        version: 1,
        archived: [
          {
            archivedAt: '2026-07-21T00:00:00.000Z',
            turnCount: 0,
            tab: {
              id: 'chat-2',
              title: 'Already archived',
              createdAt: '2026-07-20T00:00:00.000Z',
              messages: [],
            },
          },
        ],
      }),
    );

    const capture = await beginArchivedContainerCapture(
      PROJECT_ID,
      CONTAINER_ID,
    );

    expect(cancelLocalScopeMock).toHaveBeenCalledWith(PROJECT_ID, CONTAINER_ID);
    expect(cancelLocalScopeMock.mock.invocationCallOrder[0]).toBeLessThan(
      captureChatScopeMock.mock.invocationCallOrder[0],
    );
    expect(capture.chats.tabs).toHaveLength(1);
    expect(
      capture.chats.tabs[0]?.pendingSystemInstructions?.map(({ id }) => id),
    ).toEqual(['plan', 'worktree-relocation']);
    expect(capture.chatArchives.archived).toHaveLength(1);
    expect(existsSync(liveChats)).toBe(false);
    expect(existsSync(liveArchives)).toBe(false);
    await expect(countArchivedContainers(PROJECT_ID)).resolves.toBe(0);

    await commitArchivedContainer(manifest());

    await expect(countArchivedContainers(PROJECT_ID)).resolves.toBe(1);
    const summaries = await listArchivedContainers(PROJECT_ID);
    // Nothing is expired, so the list reuses its own manifest pass instead of
    // dispatching a redundant purge sweep.
    expect(purgeExpiredArchivedContainersForWorkspace).not.toHaveBeenCalled();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).not.toHaveProperty('originalWorktree');
    await expect(
      readFile(
        join(
          archiveDir(PROJECT_ID, CONTAINER_ID),
          'chat-storage-v2',
          CONTAINER_ID,
          'transcripts',
          'chat-1.jsonl',
        ),
        'utf8',
      ),
    ).resolves.toBe('');
  }, 15_000);

  it('captures attachments and tracked plans alongside the chat payloads', async () => {
    const liveAttachmentsDir = getWorktreeAttachmentsDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(liveAttachmentsDir, { recursive: true });
    await writeFile(join(liveAttachmentsDir, 'screenshot.png'), 'png-bytes');
    const livePlans = getTrackedPlansFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'plans'), { recursive: true });
    await writeFile(
      livePlans,
      JSON.stringify({
        version: 1,
        plans: [
          {
            id: 'plan-1',
            projectId: PROJECT_ID,
            worktreeId: CONTAINER_ID,
            source: 'claude',
            title: 'Captured plan',
            content: '# Captured plan\n\nBody.',
            reviewStatus: 'approved',
            createdAt: '2026-07-21T00:00:00.000Z',
            updatedAt: '2026-07-22T00:00:00.000Z',
            latestRevisionNumber: 1,
            revisions: [],
            linkedExecutionIds: [],
          },
        ],
      }),
    );

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);
    await commitArchivedContainer(manifest());

    await expect(
      readFile(
        join(
          archiveDir(PROJECT_ID, CONTAINER_ID),
          'attachments',
          'screenshot.png',
        ),
        'utf8',
      ),
    ).resolves.toBe('png-bytes');
    const plans = await readArchivedContainerTrackedPlans(
      PROJECT_ID,
      CONTAINER_ID,
    );
    expect(plans.plans).toHaveLength(1);
    expect(plans.plans[0].id).toBe('plan-1');
  }, 15_000);

  it('captures and restores physical workspace-root files without Git checkouts', async () => {
    const liveWorkspaceRoot = getWorkspaceWorktreeDir(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveWorkspaceRoot, 'notes'), { recursive: true });
    await mkdir(join(liveWorkspaceRoot, 'repos', 'repo-a'), {
      recursive: true,
    });
    await mkdir(join(liveWorkspaceRoot, 'repos', 'personal-notes'), {
      recursive: true,
    });
    await writeFile(join(liveWorkspaceRoot, 'README.md'), 'root readme');
    await writeFile(join(liveWorkspaceRoot, 'notes', 'todo.txt'), 'todo');
    await writeFile(join(liveWorkspaceRoot, '.git'), 'gitdir: elsewhere');
    await writeFile(
      join(liveWorkspaceRoot, 'repos', 'repo-a', 'tracked.txt'),
      'repo checkout',
    );
    await writeFile(
      join(liveWorkspaceRoot, 'repos', 'personal-notes', 'idea.txt'),
      'keep this',
    );

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID, {
      captureWorkspaceRootFiles: true,
      managedRepoIds: ['repo-a'],
    });

    const archivedWorkspaceRoot = getArchivedContainerWorkspaceRootDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await expect(
      readFile(join(archivedWorkspaceRoot, 'README.md'), 'utf8'),
    ).resolves.toBe('root readme');
    await expect(
      readFile(join(archivedWorkspaceRoot, 'notes', 'todo.txt'), 'utf8'),
    ).resolves.toBe('todo');
    expect(existsSync(join(archivedWorkspaceRoot, '.git'))).toBe(false);
    expect(existsSync(join(archivedWorkspaceRoot, 'repos', 'repo-a'))).toBe(
      false,
    );
    await expect(
      readFile(
        join(archivedWorkspaceRoot, 'repos', 'personal-notes', 'idea.txt'),
        'utf8',
      ),
    ).resolves.toBe('keep this');

    const restoredWorkspaceRoot = join(rootDir, 'restored-worktree');
    await restoreArchivedContainerWorkspaceRootFiles(
      PROJECT_ID,
      CONTAINER_ID,
      restoredWorkspaceRoot,
    );
    await expect(
      readFile(join(restoredWorkspaceRoot, 'README.md'), 'utf8'),
    ).resolves.toBe('root readme');
    await expect(
      readFile(join(restoredWorkspaceRoot, 'notes', 'todo.txt'), 'utf8'),
    ).resolves.toBe('todo');
    await expect(
      readFile(
        join(restoredWorkspaceRoot, 'repos', 'personal-notes', 'idea.txt'),
        'utf8',
      ),
    ).resolves.toBe('keep this');
  }, 15_000);

  it('preserves a configured checkout and relocates a colliding archived clone without stealing payload names', async () => {
    const archivedRoot = getArchivedContainerWorkspaceRootDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    const archivedClone = join(archivedRoot, 'repos', 'temporary');
    const restoredRoot = join(rootDir, 'restored-collision');
    const configuredRepo = join(restoredRoot, 'repos', 'temporary');
    const referenceRepo = join(rootDir, 'configured-reference');
    const git = (cwd: string, args: string[]): string =>
      execFileSync(
        'git',
        [
          '-c',
          'user.name=Archive Test',
          '-c',
          'user.email=archive@example.test',
          '-c',
          'commit.gpgsign=false',
          ...args,
        ],
        { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ).trim();
    await mkdir(archivedClone, { recursive: true });
    git(archivedClone, ['init', '-b', 'main']);
    await writeFile(join(archivedClone, 'local.txt'), 'committed clone work');
    await writeFile(join(archivedClone, '.gitignore'), 'ignored.txt\n');
    git(archivedClone, ['add', '.']);
    git(archivedClone, ['commit', '-m', 'local clone history']);
    await writeFile(join(archivedClone, 'local.txt'), 'staged clone work');
    git(archivedClone, ['add', 'local.txt']);
    await writeFile(join(archivedClone, 'local.txt'), 'dirty clone work');
    await writeFile(join(archivedClone, 'ignored.txt'), 'ignored clone work');
    const cloneHead = git(archivedClone, ['rev-parse', 'HEAD']);
    const cloneStatus = git(archivedClone, ['status', '--porcelain=v1']);
    await mkdir(join(archivedRoot, 'repos', 'temporary-archived'), {
      recursive: true,
    });
    await writeFile(
      join(archivedRoot, 'repos', 'temporary-archived', 'note.txt'),
      'other archived payload',
    );
    await mkdir(referenceRepo, { recursive: true });
    git(referenceRepo, ['init', '-b', 'main']);
    await writeFile(
      join(referenceRepo, 'configured.txt'),
      'configured repository',
    );
    git(referenceRepo, ['add', '.']);
    git(referenceRepo, ['commit', '-m', 'configured history']);
    git(referenceRepo, ['worktree', 'add', '-b', 'restored', configuredRepo]);
    await writeFile(
      join(restoredRoot, 'repos', 'temporary-archived-2'),
      'occupied file',
    );
    await symlink(
      'missing-target',
      join(restoredRoot, 'repos', 'temporary-archived-3'),
    );
    const relocations = await restoreArchivedContainerWorkspaceRootFiles(
      PROJECT_ID,
      CONTAINER_ID,
      restoredRoot,
    );
    expect(relocations).toEqual([
      { originalName: 'temporary', restoredName: 'temporary-archived-4' },
    ]);
    const restoredClone = join(restoredRoot, 'repos', 'temporary-archived-4');
    expect(git(restoredClone, ['rev-parse', 'HEAD'])).toBe(cloneHead);
    expect(git(restoredClone, ['status', '--porcelain=v1'])).toBe(cloneStatus);
    expect(await readFile(join(restoredClone, 'ignored.txt'), 'utf8')).toBe(
      'ignored clone work',
    );
    expect(await readFile(join(restoredClone, 'local.txt'), 'utf8')).toBe(
      'dirty clone work',
    );
    expect(git(configuredRepo, ['rev-parse', 'HEAD'])).toBe(
      git(referenceRepo, ['rev-parse', 'HEAD']),
    );
    expect((await lstat(join(configuredRepo, '.git'))).isFile()).toBe(true);
    expect(git(configuredRepo, ['status', '--porcelain=v1'])).toBe('');
    expect(
      await readFile(
        join(restoredRoot, 'repos', 'temporary-archived', 'note.txt'),
        'utf8',
      ),
    ).toBe('other archived payload');
    expect(
      await readFile(
        join(restoredRoot, 'repos', 'temporary-archived-2'),
        'utf8',
      ),
    ).toBe('occupied file');
    expect(
      (
        await lstat(join(restoredRoot, 'repos', 'temporary-archived-3'))
      ).isSymbolicLink(),
    ).toBe(true);
    expect(git(archivedClone, ['rev-parse', 'HEAD'])).toBe(cloneHead);
  }, 15_000);

  it.each(['source', 'destination'])(
    'preserves external files when the %s repository directory is a symlink',
    async (symlinkSide) => {
      const archivedRoot = getArchivedContainerWorkspaceRootDir(
        PROJECT_ID,
        CONTAINER_ID,
      );
      const restoredRoot = join(rootDir, 'restore-symlink');
      const externalRoot = join(rootDir, 'external-repositories');
      await mkdir(archivedRoot, { recursive: true });
      await mkdir(restoredRoot, { recursive: true });
      await mkdir(externalRoot, { recursive: true });
      await writeFile(join(externalRoot, 'untouched.txt'), 'external content');
      await writeFile(join(archivedRoot, 'README.md'), 'archived readme');
      await writeFile(join(restoredRoot, 'README.md'), 'existing readme');
      if (symlinkSide === 'source') {
        await symlink(externalRoot, join(archivedRoot, 'repos'));
      } else {
        await mkdir(join(archivedRoot, 'repos', 'temporary'), {
          recursive: true,
        });
        await writeFile(
          join(archivedRoot, 'repos', 'temporary', 'local.txt'),
          'clone work',
        );
        await symlink(externalRoot, join(restoredRoot, 'repos'));
      }
      await expect(
        restoreArchivedContainerWorkspaceRootFiles(
          PROJECT_ID,
          CONTAINER_ID,
          restoredRoot,
        ),
      ).rejects.toThrow();
      expect(await readFile(join(restoredRoot, 'README.md'), 'utf8')).toBe(
        'existing readme',
      );
      expect(await readFile(join(externalRoot, 'untouched.txt'), 'utf8')).toBe(
        'external content',
      );
      expect(existsSync(join(externalRoot, 'temporary'))).toBe(false);
    },
  );

  it('reads empty tracked plans when the capture is missing or corrupt', async () => {
    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);
    await commitArchivedContainer(manifest());

    await expect(
      readArchivedContainerTrackedPlans(PROJECT_ID, CONTAINER_ID),
    ).resolves.toEqual({ version: 1, plans: [] });

    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      '{invalid json',
    );
    await expect(
      readArchivedContainerTrackedPlans(PROJECT_ID, CONTAINER_ID),
    ).resolves.toEqual({ version: 1, plans: [] });

    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      JSON.stringify({
        version: 1,
        plans: [
          {
            id: 'incomplete-plan',
            updatedAt: '2026-07-22T00:00:00.000Z',
          },
        ],
      }),
    );
    await expect(
      readArchivedContainerTrackedPlans(PROJECT_ID, CONTAINER_ID),
    ).resolves.toEqual({ version: 1, plans: [] });
  });

  it('removes attachment and plan payloads after a partial restore', async () => {
    const containerDir = archiveDir(PROJECT_ID, CONTAINER_ID);
    await commitArchivedContainer(
      manifest({
        diskUsage: {
          filesBytes: 3,
          gitBytes: 5,
          totalBytes: 8,
          computedAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    );
    await mkdir(join(containerDir, 'attachments'), { recursive: true });
    await writeFile(join(containerDir, 'attachments', 'file.txt'), 'x');
    await writeFile(join(containerDir, 'tracked-plans.json'), '{}');
    await mkdir(join(containerDir, 'workspace-root'), { recursive: true });
    await writeFile(join(containerDir, 'workspace-root', 'README.md'), 'x');

    await removeArchivedContainerPayloadsAfterPartialRestore(
      PROJECT_ID,
      CONTAINER_ID,
    );

    expect(existsSync(join(containerDir, 'attachments'))).toBe(false);
    expect(existsSync(join(containerDir, 'tracked-plans.json'))).toBe(false);
    expect(existsSync(join(containerDir, 'workspace-root'))).toBe(false);
    await expect(
      readArchivedContainerManifest(PROJECT_ID, CONTAINER_ID),
    ).resolves.not.toHaveProperty('diskUsage');
    expect(scheduleArchivedContainerDiskUsage).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { forceAfterCurrent: true },
    );
  });

  it('refuses capture and preserves corrupt persisted chat files', async () => {
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    const liveArchives = getChatArchivesFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    await mkdir(join(liveRoot(PROJECT_ID), 'chat-archives'), {
      recursive: true,
    });
    await writeFile(liveChats, '{invalid json');
    await writeFile(liveArchives, JSON.stringify({ version: 99 }));

    await expect(
      beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('recover legacy');
    expect(await readFile(liveChats, 'utf8')).toBe('{invalid json');
    expect(await readFile(liveArchives, 'utf8')).toBe(
      JSON.stringify({ version: 99 }),
    );
    expect(await countArchivedContainers(PROJECT_ID)).toBe(0);
  });

  it('preserves malformed nested chat records and blocks but excludes them from capture', async () => {
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    const liveArchives = getChatArchivesFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    await mkdir(join(liveRoot(PROJECT_ID), 'chat-archives'), {
      recursive: true,
    });
    await writeFile(
      liveChats,
      JSON.stringify({
        version: 1,
        activeTabId: '',
        tabs: [
          null,
          {
            id: 'malformed-message-chat',
            title: 'Malformed message',
            messages: [null],
            createdAt: 'now',
          },
          {
            id: 'malformed-block-chat',
            title: 'Malformed block',
            messages: [
              {
                id: 'message-1',
                role: 'assistant',
                blocks: [null],
                timestamp: 1,
              },
            ],
            createdAt: 'now',
          },
        ],
      }),
    );
    await writeFile(
      liveArchives,
      JSON.stringify({
        version: 1,
        archived: [
          { tab: null, archivedAt: 'now', turnCount: 0 },
          {
            tab: {
              id: 'malformed-archived-message-chat',
              title: 'Malformed archived message',
              messages: [null],
              createdAt: 'now',
            },
            archivedAt: 'now',
            turnCount: 0,
          },
        ],
      }),
    );

    await expect(
      beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('recover legacy');
    const preservedChats = await readFile(liveChats, 'utf8');
    expect(preservedChats).toContain('"tabs":[null,');
    expect(preservedChats).toContain('"messages":[null]');
    expect(preservedChats).toContain('"blocks":[null]');
    const preservedArchives = await readFile(liveArchives, 'utf8');
    expect(preservedArchives).toContain('"tab":null');
    expect(preservedArchives).toContain('"messages":[null]');
  });

  it('preserves a committed capture when a delete retry finds the live files gone', async () => {
    // First attempt: live chats captured and the manifest committed, but the
    // delete failed AFTER cleanup removed the live files.
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    const chatsFile = {
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Kept', messages: [], createdAt: 'now' }],
    };
    await writeFile(liveChats, JSON.stringify(chatsFile));
    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);
    await commitArchivedContainer(manifest());
    await rm(liveChats, { force: true });
    await rm(join(liveRoot(PROJECT_ID), 'chat-storage-v2'), {
      recursive: true,
      force: true,
    });
    await rm(join(liveRoot(PROJECT_ID), 'chat-storage-manifests'), {
      recursive: true,
      force: true,
    });

    // Retry: the staged copies are the only surviving transcripts — the
    // capture must reuse them instead of wiping the directory.
    const retry = await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);

    expect(
      retry.chats.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        count: tab.transcript?.messageCount,
      })),
    ).toEqual([{ id: 'chat-1', title: 'Kept', count: 0 }]);
    expect(retry.chatFilePresent).toBe(true);
    await expect(
      readFile(
        join(archiveDir(PROJECT_ID, CONTAINER_ID), 'container.json'),
        'utf8',
      ),
    ).resolves.toContain(CONTAINER_ID);
  }, 15_000);

  it('preserves staged executions across a manifest-less capture retry', async () => {
    const directory = archiveDir(PROJECT_ID, CONTAINER_ID);
    const executionsDirectory = getArchivedContainerExecutionsDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(executionsDirectory, { recursive: true });
    await writeFile(
      join(executionsDirectory, 'execution-1.json'),
      '{"id":"execution-1"}',
    );
    await writeFile(join(directory, 'chats.json'), '{"stale":true}');

    const retry = await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);

    expect(retry.chats).toMatchObject({
      version: 1,
      tabs: [],
      activeTabId: '',
    });
    await expect(
      readFile(join(executionsDirectory, 'execution-1.json'), 'utf8'),
    ).resolves.toBe('{"id":"execution-1"}');
    await expect(
      countArchivedContainerExecutions(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(1);
    await expect(
      readFile(join(directory, 'chats.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const resetRequest = runArchiveIoRequestMock.mock.calls
      .map(([value]) => value)
      .find(
        (value) =>
          typeof value === 'object' &&
          value !== null &&
          'type' in value &&
          value.type === 'reset-directory',
      );
    if (
      typeof resetRequest !== 'object' ||
      resetRequest === null ||
      !('input' in resetRequest) ||
      typeof resetRequest.input !== 'object' ||
      resetRequest.input === null ||
      !('path' in resetRequest.input) ||
      !('allowedRoot' in resetRequest.input) ||
      !('preserveNames' in resetRequest.input) ||
      !Array.isArray(resetRequest.input.preserveNames)
    ) {
      throw new Error('Expected a valid reset-directory worker request.');
    }
    expect(resetRequest.input.path).toBe(directory);
    expect(resetRequest.input.allowedRoot).toBe(archiveRoot(PROJECT_ID));
    expect(resetRequest.input.preserveNames).toEqual(
      expect.arrayContaining([
        'pipeline-executions',
        'git-state.staged.json',
        'workspace-root',
      ]),
    );
  });

  it('preserves staged workspace-root files across a manifest-less capture retry', async () => {
    const directory = archiveDir(PROJECT_ID, CONTAINER_ID);
    const workspaceRootDirectory = getArchivedContainerWorkspaceRootDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(workspaceRootDirectory, { recursive: true });
    await writeFile(join(workspaceRootDirectory, 'README.md'), 'preserved');
    await writeFile(join(directory, 'chats.json'), '{"stale":true}');

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID, {
      captureWorkspaceRootFiles: true,
    });

    await expect(
      readFile(join(workspaceRootDirectory, 'README.md'), 'utf8'),
    ).resolves.toBe('preserved');
    await expect(
      readFile(join(directory, 'chats.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves staged recovery payloads across a manifest-less capture retry', async () => {
    const directory = archiveDir(PROJECT_ID, CONTAINER_ID);
    const recoveryPayload = join(
      directory,
      'recovery-files',
      '11111111-1111-4111-8111-111111111111',
    );
    const recoveryJournal = join(directory, 'recovery.staged.json');
    await mkdir(recoveryPayload, { recursive: true });
    await writeFile(join(recoveryPayload, 'only-copy.txt'), 'preserved');
    await writeFile(recoveryJournal, '{"phase":"removed"}');
    await writeFile(join(directory, 'chats.json'), '{"stale":true}');

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);

    await expect(
      readFile(join(recoveryPayload, 'only-copy.txt'), 'utf8'),
    ).resolves.toBe('preserved');
    await expect(readFile(recoveryJournal, 'utf8')).resolves.toBe(
      '{"phase":"removed"}',
    );
    await expect(
      readFile(join(directory, 'chats.json'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('replaces stale staged workspace-root files when the live root still exists', async () => {
    const liveWorkspaceRoot = getWorkspaceWorktreeDir(PROJECT_ID, CONTAINER_ID);
    await mkdir(liveWorkspaceRoot, { recursive: true });
    await writeFile(join(liveWorkspaceRoot, 'current.txt'), 'first');
    await writeFile(join(liveWorkspaceRoot, 'deleted.txt'), 'stale');

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID, {
      captureWorkspaceRootFiles: true,
    });
    await writeFile(join(liveWorkspaceRoot, 'current.txt'), 'second');
    await rm(join(liveWorkspaceRoot, 'deleted.txt'));

    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID, {
      captureWorkspaceRootFiles: true,
    });

    const workspaceRootDirectory = getArchivedContainerWorkspaceRootDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await expect(
      readFile(join(workspaceRootDirectory, 'current.txt'), 'utf8'),
    ).resolves.toBe('second');
    await expect(
      readFile(join(workspaceRootDirectory, 'deleted.txt'), 'utf8'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  }, 15_000);

  it('counts only staged execution state files', async () => {
    const executionsDirectory = getArchivedContainerExecutionsDir(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await mkdir(join(executionsDirectory, 'execution-1'), { recursive: true });
    await writeFile(
      join(executionsDirectory, 'execution-1.json'),
      '{"id":"execution-1"}',
    );
    await writeFile(join(executionsDirectory, 'notes.txt'), 'ignored');

    await expect(
      countArchivedContainerExecutions(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(1);
  });

  it('never overwrites a valid staged copy with a corrupt live source', async () => {
    const liveChats = getChatTabsFilePath(PROJECT_ID, CONTAINER_ID);
    await mkdir(join(liveRoot(PROJECT_ID), 'chats'), { recursive: true });
    const chatsFile = {
      version: 1,
      activeTabId: 'chat-1',
      tabs: [{ id: 'chat-1', title: 'Kept', messages: [], createdAt: 'now' }],
    };
    await writeFile(liveChats, JSON.stringify(chatsFile));
    await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);
    await commitArchivedContainer(manifest());
    await writeFile(liveChats, '{truncated');

    const retry = await beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID);

    expect(
      retry.chats.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        count: tab.transcript?.messageCount,
      })),
    ).toEqual([{ id: 'chat-1', title: 'Kept', count: 0 }]);
    await expect(
      readFile(
        join(
          archiveDir(PROJECT_ID, CONTAINER_ID),
          'chat-storage-v2',
          CONTAINER_ID,
          'transcripts',
          'chat-1.jsonl',
        ),
        'utf8',
      ),
    ).resolves.toBe('');
  }, 15_000);

  it('preserves staged payloads and rejects capture when the manifest is corrupt', async () => {
    const directory = archiveDir(PROJECT_ID, CONTAINER_ID);
    const chatsPath = getArchivedContainerChatsPath(PROJECT_ID, CONTAINER_ID);
    await mkdir(directory, { recursive: true });
    await writeFile(chatsPath, '{"recoverable":true}');
    await writeFile(
      getArchivedContainerManifestPath(PROJECT_ID, CONTAINER_ID),
      '{corrupt',
    );

    await expect(
      beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeDefined();
    await expect(readFile(chatsPath, 'utf8')).resolves.toBe(
      '{"recoverable":true}',
    );
  });

  it('rejects direct manifest reads after the retention deadline', async () => {
    await commitArchivedContainer(
      manifest({ expiresAt: '2026-07-29T00:00:00.000Z' }),
    );
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-07-29T00:00:00.000Z'));

    try {
      await expect(
        readArchivedContainerManifest(PROJECT_ID, CONTAINER_ID),
      ).rejects.toThrow(`Archived container ${CONTAINER_ID} was not found`);
    } finally {
      dateNow.mockRestore();
    }
  });

  it('drops expired rows from the list and dispatches the purge sweep once', async () => {
    await commitArchivedContainer(manifest());
    await commitArchivedContainer(
      manifest({
        id: 'worktree-expired',
        archivedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      }),
    );

    const summaries = await listArchivedContainers(PROJECT_ID);

    expect(summaries.map((entry) => entry.id)).toEqual([CONTAINER_ID]);
    // The sweep lists again under the archive operation lock rather than
    // trusting this unlocked pass, which a restore may have overtaken.
    expect(purgeExpiredArchivedContainersForWorkspace).toHaveBeenCalledTimes(1);
    expect(purgeExpiredArchivedContainersForWorkspace).toHaveBeenCalledWith(
      PROJECT_ID,
      expect.any(Number),
    );
  });

  it('schedules a background disk-usage measurement for listed archives that lack one', async () => {
    await commitArchivedContainer(manifest());
    await commitArchivedContainer(
      manifest({
        id: 'worktree-measured',
        diskUsage: {
          filesBytes: 1,
          gitBytes: 0,
          totalBytes: 1,
          computedAt: '2026-07-22T00:00:00.000Z',
        },
      }),
    );

    const summaries = await listArchivedContainers(PROJECT_ID);

    expect(summaries.map((entry) => entry.id).sort()).toEqual(
      [CONTAINER_ID, 'worktree-measured'].sort(),
    );
    expect(scheduleArchivedContainerDiskUsage).toHaveBeenCalledTimes(1);
    expect(scheduleArchivedContainerDiskUsage).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
    expect(
      summaries.find((entry) => entry.id === 'worktree-measured')?.diskUsage,
    ).toEqual({
      filesBytes: 1,
      gitBytes: 0,
      totalBytes: 1,
      computedAt: '2026-07-22T00:00:00.000Z',
    });
  });

  it('remeasures version-2 usage whose Git measurement was incomplete or legacy', async () => {
    const measured = version2Manifest();
    measured.diskUsage = {
      filesBytes: 10,
      gitBytes: 0,
      totalBytes: 10,
      computedAt: '2026-07-22T00:00:00.000Z',
    };
    await commitArchivedContainer(measured);

    await listArchivedContainers(PROJECT_ID);

    expect(scheduleArchivedContainerDiskUsage).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { retryIncomplete: true },
    );
  });

  it('locks a container so it survives expiry in reads, listings, and the sweep dispatch', async () => {
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-07-23T00:00:00.000Z'));
    try {
      await commitArchivedContainer(
        manifest({ expiresAt: '2026-07-29T00:00:00.000Z' }),
      );

      const locked = await setArchivedContainerLocked(
        PROJECT_ID,
        CONTAINER_ID,
        true,
        Date.parse('2026-07-23T00:00:00.000Z'),
      );

      expect(locked.lockedAt).toBe('2026-07-23T00:00:00.000Z');
      expect(locked.expiresAt).toBe('2026-07-29T00:00:00.000Z');
      expect(sendToAllWindows).toHaveBeenCalledWith(
        'archived-containers:changed',
        { workspaceId: PROJECT_ID },
      );
      expect(archivedContainerUpdated).toHaveBeenCalledWith(
        PROJECT_ID,
        CONTAINER_ID,
      );

      // Well past the original expiry, the locked container stays visible and
      // never triggers the purge sweep.
      dateNow.mockReturnValue(Date.parse('2026-09-15T00:00:00.000Z'));
      await expect(
        readArchivedContainerManifest(PROJECT_ID, CONTAINER_ID),
      ).resolves.toMatchObject({ lockedAt: '2026-07-23T00:00:00.000Z' });
      const summaries = await listArchivedContainers(PROJECT_ID);
      expect(summaries.map((entry) => entry.id)).toEqual([CONTAINER_ID]);
      expect(purgeExpiredArchivedContainersForWorkspace).not.toHaveBeenCalled();
    } finally {
      dateNow.mockRestore();
    }
  });

  it('unlocking restarts the retention window from the unlock time', async () => {
    await commitArchivedContainer(
      manifest({
        retentionDays: 7,
        expiresAt: '2026-07-29T00:00:00.000Z',
        lockedAt: '2026-07-23T00:00:00.000Z',
      }),
    );

    const unlocked = await setArchivedContainerLocked(
      PROJECT_ID,
      CONTAINER_ID,
      false,
      Date.parse('2026-09-01T00:00:00.000Z'),
    );

    expect(unlocked.lockedAt).toBeUndefined();
    expect(unlocked.expiresAt).toBe('2026-09-08T00:00:00.000Z');
    const persisted: unknown = JSON.parse(
      await readFile(
        getArchivedContainerManifestPath(PROJECT_ID, CONTAINER_ID),
        'utf8',
      ),
    );
    expect(persisted).not.toHaveProperty('lockedAt');
    expect(persisted).toMatchObject({
      expiresAt: '2026-09-08T00:00:00.000Z',
      archivedAt: '2026-07-22T00:00:00.000Z',
    });
    expect(archivedContainerUpdated).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
  });

  it('treats matching lock states as no-ops and rejects locking an expired container', async () => {
    await commitArchivedContainer(
      manifest({ lockedAt: '2026-07-23T00:00:00.000Z' }),
    );

    const unchanged = await setArchivedContainerLocked(
      PROJECT_ID,
      CONTAINER_ID,
      true,
      Date.parse('2026-07-25T00:00:00.000Z'),
    );
    expect(unchanged.lockedAt).toBe('2026-07-23T00:00:00.000Z');

    await commitArchivedContainer(
      manifest({
        id: 'worktree-expired',
        archivedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      }),
    );
    const dateNow = jest
      .spyOn(Date, 'now')
      .mockReturnValue(Date.parse('2026-07-25T00:00:00.000Z'));
    try {
      await expect(
        setArchivedContainerLocked(PROJECT_ID, 'worktree-expired', true),
      ).rejects.toThrow('was not found');
    } finally {
      dateNow.mockRestore();
    }
  });

  it('propagates non-missing summary copy failures', async () => {
    await mkdir(getWorktreeSummaryFilePath(PROJECT_ID, CONTAINER_ID), {
      recursive: true,
    });

    await expect(
      beginArchivedContainerCapture(PROJECT_ID, CONTAINER_ID),
    ).rejects.toBeDefined();
  }, 15_000);

  it('serializes operations for the same archived container', async () => {
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const first = withArchivedContainerOperationLock(
      PROJECT_ID,
      CONTAINER_ID,
      async () => {
        markFirstStarted();
        await new Promise<void>((resolveRelease) => {
          releaseFirst = resolveRelease;
        });
        return 'first';
      },
    );
    await firstStarted;
    const secondEntered = jest.fn();
    const second = withArchivedContainerOperationLock(
      PROJECT_ID,
      CONTAINER_ID,
      () => {
        secondEntered();
        return Promise.resolve('second');
      },
    );

    await Promise.resolve();
    expect(secondEntered).not.toHaveBeenCalled();
    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
    expect(secondEntered).toHaveBeenCalledTimes(1);
  });

  it('serializes archive lifecycle operations across a project', async () => {
    let releaseFirst: () => void = () => {};
    let markFirstStarted: () => void = () => {};
    const firstStarted = new Promise<void>((resolveStarted) => {
      markFirstStarted = resolveStarted;
    });
    const first = withArchivedWorkspaceOperationLock(PROJECT_ID, async () => {
      markFirstStarted();
      await new Promise<void>((resolveRelease) => {
        releaseFirst = resolveRelease;
      });
    });
    await firstStarted;
    const secondEntered = jest.fn();
    const second = withArchivedContainerOperationLock(
      PROJECT_ID,
      'worktree-2',
      () => {
        secondEntered();
        return Promise.resolve();
      },
    );

    await Promise.resolve();
    expect(secondEntered).not.toHaveBeenCalled();
    releaseFirst();
    await first;
    await second;
    expect(secondEntered).toHaveBeenCalledTimes(1);
  });

  it('allows a project lifecycle operation to enter a container lock', async () => {
    await expect(
      withArchivedWorkspaceOperationLock(PROJECT_ID, () =>
        withArchivedContainerOperationLock(PROJECT_ID, CONTAINER_ID, () =>
          Promise.resolve('nested'),
        ),
      ),
    ).resolves.toBe('nested');
  });

  it('does not treat a delayed descendant as owning a released archive lock', async () => {
    let startDescendant: () => void = () => {};
    let releaseCurrent: () => void = () => {};
    let markCurrentEntered: () => void = () => {};
    let descendant: Promise<void> = Promise.resolve();
    let descendantEntered = false;
    const start = new Promise<void>((resolve) => {
      startDescendant = resolve;
    });
    await withArchivedWorkspaceOperationLock(PROJECT_ID, () => {
      descendant = (async (): Promise<void> => {
        await start;
        await withArchivedWorkspaceOperationLock(PROJECT_ID, () => {
          descendantEntered = true;
          return Promise.resolve();
        });
      })();
      return Promise.resolve();
    });
    const entered = new Promise<void>((resolve) => {
      markCurrentEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const current = withArchivedWorkspaceOperationLock(PROJECT_ID, async () => {
      markCurrentEntered();
      await release;
    });
    await entered;
    startDescendant();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const enteredBeforeRelease = descendantEntered;
    releaseCurrent();
    await Promise.all([current, descendant]);
    expect(enteredBeforeRelease).toBe(false);
    expect(descendantEntered).toBe(true);
  });

  it('skips manifest-less directories and purges search documents before removal', async () => {
    const incomplete = archiveDir(PROJECT_ID, 'incomplete-1');
    await mkdir(incomplete, { recursive: true });
    await commitArchivedContainer(manifest());
    const committedDir = archiveDir(PROJECT_ID, CONTAINER_ID);
    let existedWhenSearchWasPurged = false;
    const searchService = new ChatSearchService();
    const worktreeContainerPurged = jest
      .spyOn(searchService, 'worktreeContainerPurged')
      .mockImplementation(() => {
        existedWhenSearchWasPurged = existsSync(committedDir);
      });
    jest.mocked(getChatSearchService).mockReturnValue(searchService);

    await expect(listArchivedContainers(PROJECT_ID)).resolves.toHaveLength(1);
    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(worktreeContainerPurged).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
    expect(existedWhenSearchWasPurged).toBe(true);
    expect(existsSync(committedDir)).toBe(false);
    expect(existsSync(incomplete)).toBe(true);
    expect(runArchiveIoRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'remove-directory',
        projectId: PROJECT_ID,
        containerId: CONTAINER_ID,
        expectedCreatedAt: '2026-07-20T00:00:00.000Z',
        input: {
          path: committedDir,
          allowedRoot: archiveRoot(PROJECT_ID),
        },
      }),
    );
    expect(discardIncompleteArchivedGitCapture).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { allowMissingWorktree: true },
    );
  });

  it('continues archive removal when derived search cleanup fails', async () => {
    await commitArchivedContainer(manifest());
    const committedDir = archiveDir(PROJECT_ID, CONTAINER_ID);
    const searchService = new ChatSearchService();
    jest
      .spyOn(searchService, 'worktreeContainerPurged')
      .mockRejectedValue(new Error('Search index worker is closing'));
    jest.mocked(getChatSearchService).mockReturnValue(searchService);
    const consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(existsSync(committedDir)).toBe(false);
    expect(consoleError).toHaveBeenCalledWith(
      'Failed to remove archived chat search rows:',
      expect.any(Error),
    );
    consoleError.mockRestore();
  });

  it('rejects strict inventory when an archive directory has no readable manifest', async () => {
    await mkdir(archiveDir(PROJECT_ID, 'incomplete-1'), { recursive: true });
    await commitArchivedContainer(manifest());

    await expect(
      listArchivedContainerManifestsStrict(PROJECT_ID),
    ).rejects.toThrow();
  });

  it('preserves a version-1 archive when its staged capture cannot be discarded', async () => {
    await commitArchivedContainer(manifest());
    const committedDir = archiveDir(PROJECT_ID, CONTAINER_ID);
    const worktreeContainerPurged = jest.spyOn(
      getChatSearchService(),
      'worktreeContainerPurged',
    );
    jest
      .mocked(discardIncompleteArchivedGitCapture)
      .mockResolvedValueOnce(false);

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('An incomplete archived Git capture requires recovery.');

    expect(existsSync(committedDir)).toBe(true);
    expect(worktreeContainerPurged).not.toHaveBeenCalled();
  });

  it('releases staged snapshot refs before purging a recovered version-3 archive', async () => {
    const captured = version2Manifest();
    jest.mocked(readArchivedGitStagedDescriptor).mockResolvedValueOnce({
      version: 1,
      status: 'capturing',
      repositories: captured.gitState.repositories,
    });
    await commitArchivedContainer({
      ...manifest(),
      version: 3,
      workspaceType: 'single-repo',
      originalWorktree: {
        id: CONTAINER_ID,
        branchName: 'feature/archive',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
        gitCleanupPending: true,
      },
    });

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(releaseArchivedGitState).toHaveBeenCalledWith({
      version: 1,
      diffFormatVersion: 1,
      repositories: captured.gitState.repositories,
    });
    expect(completeArchivedContainerGitCapture).not.toHaveBeenCalled();
    expect(discardIncompleteArchivedGitCapture).not.toHaveBeenCalled();
  });

  it('discards an empty staged recovery capture before purging its archive', async () => {
    jest.mocked(readArchivedGitStagedDescriptor).mockResolvedValueOnce({
      version: 1,
      status: 'capturing',
      repositories: [],
    });
    await commitArchivedContainer({
      ...manifest(),
      version: 3,
      workspaceType: 'single-repo',
      originalWorktree: {
        id: CONTAINER_ID,
        branchName: 'feature/archive',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
      },
    });

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(assertArchivedGitStatePurgeable).not.toHaveBeenCalled();
    expect(releaseArchivedGitState).not.toHaveBeenCalled();
    expect(discardIncompleteArchivedGitCapture).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { allowMissingWorktree: true },
    );
  });

  it('preserves a recovered version-3 archive when staged ref release fails', async () => {
    const captured = version2Manifest();
    jest.mocked(readArchivedGitStagedDescriptor).mockResolvedValueOnce({
      version: 1,
      status: 'capturing',
      repositories: captured.gitState.repositories,
    });
    jest
      .mocked(releaseArchivedGitState)
      .mockRejectedValueOnce(new Error('staged ref release failed'));
    await commitArchivedContainer({
      ...manifest(),
      version: 3,
      workspaceType: 'single-repo',
      originalWorktree: {
        id: CONTAINER_ID,
        branchName: 'feature/archive',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
        gitCleanupPending: false,
      },
    });

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('staged ref release failed');

    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(completeArchivedContainerGitCapture).not.toHaveBeenCalled();
  });

  it('validates staged snapshot ownership before purging a recovered version-3 archive', async () => {
    const captured = version2Manifest();
    jest.mocked(readArchivedGitStagedDescriptor).mockResolvedValueOnce({
      version: 1,
      status: 'capturing',
      repositories: captured.gitState.repositories,
    });
    jest
      .mocked(assertArchivedGitStatePurgeable)
      .mockRejectedValueOnce(new Error('staged snapshot ownership changed'));
    await commitArchivedContainer({
      ...manifest(),
      version: 3,
      workspaceType: 'single-repo',
      originalWorktree: {
        id: CONTAINER_ID,
        branchName: 'feature/archive',
        createdAt: '2026-07-20T00:00:00.000Z',
      },
      recovery: {
        kind: 'files-only',
        source: 'partial',
        digest: 'a'.repeat(64),
        payloadId: '11111111-1111-4111-8111-111111111111',
        gitCleanupPending: false,
      },
    });

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('staged snapshot ownership changed');

    expect(releaseArchivedGitState).not.toHaveBeenCalled();
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
  });

  it('settles legacy transcript migration before purging and rejects later reads', async () => {
    await commitArchivedContainer(manifest());
    await writeFile(
      getArchivedContainerChatsPath(PROJECT_ID, CONTAINER_ID),
      JSON.stringify({ version: 1, tabs: [], activeTabId: '' }),
    );
    let releaseMigration = (): void => undefined;
    let migrationEntered = (): void => undefined;
    const entered = new Promise<void>((resolve) => {
      migrationEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releaseMigration = resolve;
    });
    const migrate = legacyMigration.migrateLegacyChatScope;
    const migration = jest
      .spyOn(legacyMigration, 'migrateLegacyChatScope')
      .mockImplementationOnce(async (...args) => {
        migrationEntered();
        await gate;
        await migrate(...args);
      });
    const read = getArchivedContainerChatStorage(PROJECT_ID, CONTAINER_ID);
    await entered;
    const purge = purgeArchivedContainer(PROJECT_ID, CONTAINER_ID);
    try {
      const purgedBeforeMigrationFinished = await Promise.race([
        purge.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);
      expect(purgedBeforeMigrationFinished).toBe(false);
      releaseMigration();
      await read;
      await expect(purge).resolves.toBe(true);
      expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
      await expect(
        getArchivedContainerChatStorage(PROJECT_ID, CONTAINER_ID),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
    } finally {
      releaseMigration();
      await Promise.allSettled([read, purge]);
      migration.mockRestore();
    }
  });

  it('purges legacy review ownership with the archived worktree and keeps the archive retryable on cleanup failure', async () => {
    await commitArchivedContainer(manifest());
    mockRemoveLegacyReviewChats.mockResolvedValueOnce([
      'legacy writer still active',
    ]);
    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('legacy writer still active');
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(mockRemoveLegacyReviewChats).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
    );
    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('purges legacy plan chats owned by the archived worktree with its captured plan ids and stays retryable', async () => {
    await commitArchivedContainer(manifest());
    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      JSON.stringify({
        version: 1,
        plans: [trackedPlan('plan-a'), trackedPlan('plan-b')],
      }),
    );
    mockRemoveLegacyPlanChats.mockResolvedValueOnce([
      'Failed to remove plan-explore chat state for plan plan-b: busy',
    ]);

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('plan plan-b: busy');
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(mockRemoveLegacyPlanChats).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      ['plan-a', 'plan-b'],
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);
    expect(mockRemoveLegacyPlanChats).toHaveBeenCalledTimes(2);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('reclaims legacy plan chats when Auto Delete purges an expired archive', async () => {
    await commitArchivedContainer(
      manifest({
        archivedAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-08T00:00:00.000Z',
      }),
    );
    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      JSON.stringify({ version: 1, plans: [trackedPlan('plan-a')] }),
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(mockRemoveLegacyPlanChats).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      ['plan-a'],
    );
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('still sweeps registry-owned legacy plan chats when the captured plans are corrupt', async () => {
    await commitArchivedContainer(manifest());
    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      '{',
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(mockRemoveLegacyPlanChats).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      [],
    );
  });

  it('keeps legacy plan chats when permanently deleting an archive that was already restored', async () => {
    await commitArchivedContainer(
      manifest({
        restoredTo: {
          kind: 'worktree',
          id: 'restored-worktree',
          restoredAt: '2026-07-23T00:00:00.000Z',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      }),
    );
    await writeFile(
      join(archiveDir(PROJECT_ID, CONTAINER_ID), 'tracked-plans.json'),
      JSON.stringify({ version: 1, plans: [trackedPlan('plan-a')] }),
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    // The chats belong to the restored worktree: never reclaim them here, and
    // finish a rebind an interrupted restore may not have reached.
    expect(mockRemoveLegacyPlanChats).not.toHaveBeenCalled();
    expect(mockTransferLegacyPlanChats).toHaveBeenCalledWith(
      { projectId: PROJECT_ID, worktreeId: CONTAINER_ID },
      { projectId: PROJECT_ID, worktreeId: 'restored-worktree' },
    );
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('keeps a restored archive when finishing its legacy plan chat rebind fails', async () => {
    await commitArchivedContainer(
      manifest({
        restoredTo: {
          kind: 'worktree',
          id: 'restored-worktree',
          restoredAt: '2026-07-23T00:00:00.000Z',
          createdAt: '2026-07-23T00:00:00.000Z',
        },
      }),
    );
    mockTransferLegacyPlanChats.mockRejectedValueOnce(
      new Error('registry busy'),
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('registry busy');
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('preserves legacy review ownership when removing an archive after restore', async () => {
    await commitArchivedContainer(manifest());

    await expect(
      purgeArchivedContainerAfterRestore(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(mockRemoveLegacyReviewChats).not.toHaveBeenCalled();
    // The restored worktree owns its legacy plan chats again.
    expect(mockRemoveLegacyPlanChats).not.toHaveBeenCalled();
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('conditionally preserves a container that became Archived before purge', async () => {
    await commitArchivedContainer(
      manifest({ lockedAt: '2026-07-22T01:00:00.000Z' }),
    );

    const deleted = await Reflect.apply(purgeArchivedContainer, undefined, [
      PROJECT_ID,
      CONTAINER_ID,
      { onlyIfDeleted: true },
    ]);

    expect(deleted).toBe(false);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(releaseArchivedGitState).not.toHaveBeenCalled();
  });

  it('preserves a version-2 manifest when ref release fails', async () => {
    const captured = version2Manifest();
    await commitArchivedContainer(captured);
    jest
      .mocked(releaseArchivedGitState)
      .mockRejectedValueOnce(new Error('ref release failed'));

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('ref release failed');

    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(repinArchivedGitState).toHaveBeenCalledWith(captured.gitState);
    expect(invalidateArchivedContainerChanges).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { hold: true },
    );
  });

  it('preserves a version-2 archive and refs when project validation drifts', async () => {
    const captured = version2Manifest();
    await commitArchivedContainer(captured);
    jest
      .mocked(assertArchivedGitStatePurgeable)
      .mockRejectedValueOnce(new Error('project definitions changed'));

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).rejects.toThrow('project definitions changed');

    expect(releaseArchivedGitState).not.toHaveBeenCalled();
    expect(repinArchivedGitState).not.toHaveBeenCalled();
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(invalidateArchivedContainerChanges).not.toHaveBeenCalled();
  });

  it('awaits invalidation before releasing refs and removing a version-2 archive', async () => {
    const captured = version2Manifest();
    await commitArchivedContainer(captured);
    let finishInvalidation: (() => void) | undefined;
    const resumeInvalidation = jest.fn();
    jest.mocked(invalidateArchivedContainerChanges).mockImplementationOnce(
      () =>
        new Promise<() => void>((resolve) => {
          finishInvalidation = (): void => resolve(resumeInvalidation);
        }),
    );
    jest.mocked(releaseArchivedGitState).mockImplementationOnce(() => {
      expect(resumeInvalidation).not.toHaveBeenCalled();
      return Promise.resolve();
    });

    const purge = purgeArchivedContainer(PROJECT_ID, CONTAINER_ID);
    while (!finishInvalidation) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const listWhileInvalidating = listArchivedContainers(PROJECT_ID);
    const listCompletedBeforeInvalidation = await Promise.race([
      listWhileInvalidating.then(() => true),
      new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(releaseArchivedGitState).not.toHaveBeenCalled();
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    finishInvalidation();
    await expect(purge).resolves.toBe(true);
    await expect(listWhileInvalidating).resolves.toHaveLength(1);

    expect(listCompletedBeforeInvalidation).toBe(true);
    expect(releaseArchivedGitState).toHaveBeenCalledWith(captured.gitState);
    expect(resumeInvalidation).toHaveBeenCalledTimes(1);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
    expect(invalidateArchivedContainerChanges).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { hold: true },
    );
    expect(
      jest.mocked(invalidateArchivedContainerChanges).mock
        .invocationCallOrder[0],
    ).toBeLessThan(
      jest.mocked(releaseArchivedGitState).mock.invocationCallOrder[0],
    );
  });

  it('re-pins version-2 refs when archive directory removal fails', async () => {
    const captured = version2Manifest();
    await commitArchivedContainer(captured);
    await chmod(archiveRoot(PROJECT_ID), 0o555);
    try {
      await expect(
        purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
      ).rejects.toBeDefined();
    } finally {
      await chmod(archiveRoot(PROJECT_ID), 0o755);
    }

    expect(releaseArchivedGitState).toHaveBeenCalledWith(captured.gitState);
    expect(repinArchivedGitState).toHaveBeenCalledWith(captured.gitState);
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(true);
    expect(invalidateArchivedContainerChanges).toHaveBeenCalledWith(
      PROJECT_ID,
      CONTAINER_ID,
      { hold: true },
    );
  });

  it('does not re-pin refs when directory removal completed before its response was lost', async () => {
    const captured = version2Manifest();
    await commitArchivedContainer(captured);
    runArchiveIoRequestMock.mockImplementationOnce(
      async (request: ArchiveIoOperationRequest) => {
        await executeArchiveIoRequest(request, new AbortController().signal, {
          progress: jest.fn(),
          child: { started: jest.fn(), exited: jest.fn() },
        });
        throw new Error('archive worker response was lost');
      },
    );

    await expect(
      purgeArchivedContainer(PROJECT_ID, CONTAINER_ID),
    ).resolves.toBe(true);

    expect(releaseArchivedGitState).toHaveBeenCalledWith(captured.gitState);
    expect(repinArchivedGitState).not.toHaveBeenCalled();
    expect(existsSync(archiveDir(PROJECT_ID, CONTAINER_ID))).toBe(false);
  });

  it('does not remove manifest-less staging that contains executions', async () => {
    const incomplete = archiveDir(PROJECT_ID, 'incomplete-executions');
    const executionsDirectory = getArchivedContainerExecutionsDir(
      PROJECT_ID,
      'incomplete-executions',
    );
    await mkdir(executionsDirectory, { recursive: true });
    await writeFile(
      join(executionsDirectory, 'execution-1.json'),
      '{"id":"execution-1"}',
    );

    await expect(
      removeIncompleteArchivedContainers(PROJECT_ID, 0),
    ).resolves.toBe(0);
    expect(existsSync(incomplete)).toBe(true);
  });

  it('does not discard a fresh staged Git capture before the age gate', async () => {
    const containerId = 'incomplete-git-capture';
    const incomplete = archiveDir(PROJECT_ID, containerId);
    await mkdir(incomplete, { recursive: true });
    await writeFile(
      getArchivedContainerGitStateStagedPath(PROJECT_ID, containerId),
      '{"version":1,"status":"capturing","repositories":[]}',
    );
    const now = Date.now();

    await expect(
      removeIncompleteArchivedContainers(PROJECT_ID, 24 * 60 * 60 * 1_000, now),
    ).resolves.toBe(0);

    expect(discardIncompleteArchivedGitCapture).not.toHaveBeenCalled();
    expect(existsSync(incomplete)).toBe(true);
  });

  it('does not remove manifest-less staging that contains workspace-root files', async () => {
    const incomplete = archiveDir(PROJECT_ID, 'incomplete-workspace-root');
    const workspaceRootDirectory = getArchivedContainerWorkspaceRootDir(
      PROJECT_ID,
      'incomplete-workspace-root',
    );
    await mkdir(workspaceRootDirectory, { recursive: true });
    await writeFile(join(workspaceRootDirectory, 'README.md'), 'preserved');

    await expect(
      removeIncompleteArchivedContainers(PROJECT_ID, 0),
    ).resolves.toBe(0);
    expect(existsSync(incomplete)).toBe(true);
  });

  it('preserves manifest-less recovery bytes left by an interrupted physical capture', async () => {
    const incomplete = archiveDir(PROJECT_ID, 'incomplete-file-recovery');
    await mkdir(join(incomplete, 'recovery-files', 'partial'), {
      recursive: true,
    });
    await writeFile(
      join(incomplete, 'recovery-files', 'partial', 'only-copy.txt'),
      'preserved',
    );
    await expect(
      removeIncompleteArchivedContainers(PROJECT_ID, 0),
    ).resolves.toBe(0);
    expect(existsSync(incomplete)).toBe(true);
  });
});
