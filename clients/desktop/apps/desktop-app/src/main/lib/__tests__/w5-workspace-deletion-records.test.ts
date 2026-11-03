// W6c2 (CAN-4961): the workspace deletion's X4 index removal decision, Cowork
// admission and characterization on the real commit-log worker and files.
// Record-seam evidence, not unmodified product lifecycle evidence.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as RecordDecisionPort from '../workspace-record-decision-port';
import { z } from 'zod';
import { LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL } from '@canopy/protocol/portal/lifecycle-journal';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
jest.mock('../workspace-record-decision-port', () => {
  const actual = jest.requireActual<typeof RecordDecisionPort>(
    '../workspace-record-decision-port',
  );
  return {
    ...actual,
    applyWorkspaceIndexRemoval: jest.fn(actual.applyWorkspaceIndexRemoval),
  };
});
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
  prepareWorkspaceBrowserRetirement: jest.fn(() => Promise.resolve([])),
  commitTaskBrowserRetirement: jest.fn(() => Promise.resolve(false)),
  abortTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
}));
jest.mock('../../app-advisor/watchers', () => ({
  getAppAdvisorWatcherService: jest.fn(() => ({
    cancelLocalScope: jest.fn(() => Promise.resolve()),
    commitLocalScopeCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalScopeFence: jest.fn(() => Promise.resolve()),
    cancelLocalWorkspace: jest.fn(() => Promise.resolve()),
    commitLocalWorkspaceCancellation: jest.fn(() => Promise.resolve()),
    releaseLocalWorkspaceFence: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
    interruptMatchingEntries: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
/** Runs before a worker request; a throw fails that request. */
let mockArchiveIoFault:
  | ((request: ArchiveIoOperationRequest) => void)
  | undefined;
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: async (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> => {
    mockArchiveIoFault?.(request);
    return jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      });
  },
}));
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_COWORK_WORKSPACE_ID,
  STANDALONE_CHAT_PROJECT_ID,
  type ArchivedContainerManifest,
  type WorktreeData,
} from '@canopy/desktop-shared/types';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  readW5Revisions,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import * as sidebarItems from '../sidebar-items';
import * as workspacePersistence from '../workspace-persistence';
import {
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceConfig,
} from '../workspace-persistence';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
import { cleanupPersistedWorktreeData } from '../worktree-data-cleanup';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import {
  BACKGROUND_WORK_REMOVAL_REFUSAL,
  setDelegationActivity,
} from '../../agents/delegation/activity';
import * as sessionManager from '../../agents/session-manager';
import { createLiveBackgroundTaskOwner } from '../../ipc/__tests__/background-work-removal-test-helpers';
import * as coworkWorkEntries from '../cowork-work-entries';
import { acquireWorkspaceDeletionLease } from '../../services/split-lock-service';
import * as atomicFile from '../atomic-file';
import {
  hasUnresolvedDestructiveRecovery,
  readDestructiveRecovery,
  reportDestructiveRecovery,
  type DestructiveRecoveryRecord,
} from '../w5-destructive-recovery';
import { reconcileGitPendingWorktrees } from '../worktree-boot-recovery';
import {
  archiveWorktree,
  checkWorktreeRemovalAdmission,
  deleteWorktree,
} from '../worktree-archive';
import {
  archiveSingleRepoWorktree,
  archiveMultiRepoWorktree,
} from '../worktree-service';
import { runAutoArchiveTeardown } from '../auto-archive-teardown';
import {
  prepareTaskBrowserRetirement,
  prepareWorkspaceBrowserRetirement,
} from '../../browser/browser-profile-lifecycle';
import {
  commitArchivedContainer,
  listArchivedContainerManifests,
  purgeArchivedContainer,
  removeIncompleteArchivedContainers,
} from '../archived-containers';
import {
  assertArchivedGitStateRestorable,
  captureArchivedContainerGitState,
  prepareArchivedContainerTeardown,
  readArchivedGitStagedDescriptor,
  releaseArchivedGitState,
  workspaceRootPayloadDigest,
} from '../archived-container-git';
import * as archivedContainerGit from '../archived-container-git';
import * as archivedContainerRecovery from '../archived-container-recovery';
import * as removeTree from '../remove-tree-without-asar';
import * as worktreeLiveCleanup from '../worktree-live-cleanup';
import * as providerState from '../archived-container-provider-state';
import * as gitExecutable from '../git-executable';
import * as archivedContainers from '../archived-containers';
import * as worktreeDataCleanup from '../worktree-data-cleanup';
import * as adhocMultiRepoWorkspaces from '../adhoc-multi-repo-workspaces';
import * as worktreeCreationDecisions from '../worktree-creation-decision-port';
import * as worktreePipelineCleanup from '../../pipelines/worktree-cleanup';
import {
  getArchivedContainerDir,
  getArchivedContainerGitStateStagedPath,
  getArchivedContainersRootDir,
  getW5DestructiveLifecycleDir,
  getWorkspaceDir,
  getWorktreeDataDir,
} from '../paths';
import { applyWorkspaceIndexRemoval } from '../workspace-record-decision-port';
import { getFingerprintStore } from '../../skill-suggestions/fingerprint-store';
import { getChatSearchService } from '../../chat-search/service';
import { logMainProcessWarn } from '../main-process-logging';
import { recordWorkspaceCrudTelemetry } from '../desktop-telemetry';
import {
  deleteWorkspace,
  retryWorkspaceDeletionSearchCleanup,
  type WorkspaceDeletionRequest,
} from '../workspace-deletion';
import { discardWorktree } from '../worktree-discard';
import type { ProjectDeletionDiscardDescription } from '@canopy/protocol/portal/project-deletion-discard';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();
const actualPort = jest.requireActual<typeof RecordDecisionPort>(
  '../workspace-record-decision-port',
);
const decisions = jest.mocked(applyWorkspaceIndexRemoval);
const DELETE_INDEX = { kind: 'workspace.delete.index' } as const;

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

interface IndexEntry {
  id: string;
  name: string;
  type: string;
  color: string;
  collapsed: boolean;
  order: number;
}
const indexFileSchema = z.object({
  version: z.number(),
  workspaces: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      type: z.string(),
      color: z.string(),
      collapsed: z.boolean(),
      order: z.number(),
    }),
  ),
});
function readIndex(): IndexEntry[] {
  return indexFileSchema.parse(
    JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')),
  ).workspaces;
}
function indexIds(): string[] {
  return readIndex().map((entry) => entry.id);
}

/** Adds a Cowork project with its own manifest; `a` and `b` stay indexed. */
function addCowork(id: string, config: Record<string, unknown> = {}): void {
  const entries = readIndex();
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        ...entries,
        {
          id,
          name: `Cowork ${id}`,
          type: 'cowork',
          color: '#7C3AED',
          collapsed: false,
          order: entries.length,
        },
      ],
    }),
  );
  mkdirSync(join(root, id), { recursive: true });
  writeFileSync(
    join(root, id, 'workspace.json'),
    JSON.stringify({ version: 1, type: 'cowork', repos: [], ...config }),
  );
  coworkWorkEntries.activateWorkEntryWorkspace(id);
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  mockArchiveIoFault = undefined;
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  decisions.mockImplementation(actualPort.applyWorkspaceIndexRemoval);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [
      { id: 'one', branchName: 'old', createdAt },
      { id: 'two', branchName: 'second', createdAt },
    ],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  startHost();
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    join(root, 'a', 'worktrees', 'one'),
  ]);
  addCowork('c');
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

function chatProjectRequest(
  workspaceId: string,
  idempotencyKey?: string,
): WorkspaceDeletionRequest {
  return {
    workspaceId,
    source: 'chat_project_delete',
    coworkProject: true,
    idempotencyKey,
  };
}
function decisionCalls(): unknown {
  return JSON.parse(JSON.stringify(decisions.mock.calls));
}
function indexCommits(commits: jest.SpyInstance): number {
  return commits.mock.calls.filter(
    ([request]: [{ files: { path: string }[] }]) =>
      request.files.some((file) => file.path.endsWith('index.json')),
  ).length;
}
function canonicalImages(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}
function watcherSpies(): {
  cancel: jest.SpyInstance;
  commit: jest.SpyInstance;
  release: jest.SpyInstance;
} {
  const watcher = getAppAdvisorWatcherService();
  const cancel = jest.spyOn(watcher, 'cancelLocalWorkspace');
  const commit = jest.spyOn(watcher, 'commitLocalWorkspaceCancellation');
  const release = jest.spyOn(watcher, 'releaseLocalWorkspaceFence');
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  return { cancel, commit, release };
}
/**
 * Models the watcher service's admission fences: a workspace release or
 * commit drops every scope fence in the project, as `watchers.ts` does.
 */
function trackWatcherFences(): Set<string> {
  const fenced = new Set<string>();
  const dropProject = (projectId: string): Promise<void> => {
    for (const key of Array.from(fenced))
      if (key === projectId || key.startsWith(`${projectId}/`))
        fenced.delete(key);
    return Promise.resolve();
  };
  const dropScope = (projectId: string, worktreeId: string): Promise<void> => {
    fenced.delete(`${projectId}/${worktreeId}`);
    return Promise.resolve();
  };
  const watcher = getAppAdvisorWatcherService();
  jest
    .spyOn(watcher, 'cancelLocalScope')
    .mockImplementation((projectId, worktreeId) => {
      fenced.add(`${projectId}/${worktreeId}`);
      return Promise.resolve();
    });
  jest
    .spyOn(watcher, 'cancelLocalWorkspace')
    .mockImplementation((projectId) => {
      fenced.add(projectId);
      return Promise.resolve();
    });
  jest.spyOn(watcher, 'releaseLocalScopeFence').mockImplementation(dropScope);
  jest
    .spyOn(watcher, 'commitLocalScopeCancellation')
    .mockImplementation(dropScope);
  jest
    .spyOn(watcher, 'releaseLocalWorkspaceFence')
    .mockImplementation(dropProject);
  jest
    .spyOn(watcher, 'commitLocalWorkspaceCancellation')
    .mockImplementation(dropProject);
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  return fenced;
}
function convertToCowork(id: string): void {
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: readIndex().map((entry) =>
        entry.id === id ? { ...entry, type: 'cowork' } : entry,
      ),
    }),
  );
  writeFileSync(
    join(root, id, 'workspace.json'),
    JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
  );
  __resetSidebarItemsStateForTests();
}

type SharedManifestFields = Pick<
  Extract<ArchivedContainerManifest, { version: 3 }>,
  | 'id'
  | 'projectId'
  | 'kind'
  | 'name'
  | 'createdAt'
  | 'archivedAt'
  | 'retentionDays'
  | 'expiresAt'
  | 'chatCount'
  | 'archivedChatCount'
  | 'executionCount'
  | 'workspaceType'
  | 'originalWorktree'
>;

/** The fields every worktree archive manifest version shares. */
function archivedManifestFields(
  workspaceId: string,
  containerId: string,
): SharedManifestFields {
  return {
    id: containerId,
    projectId: workspaceId,
    kind: 'worktree' as const,
    name: 'Archived worktree',
    createdAt: '2099-01-01T00:00:00.000Z',
    archivedAt: '2099-01-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2099-01-09T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: 'single-repo' as const,
    originalWorktree: {
      id: containerId,
      branchName: 'feature/archive',
      createdAt: '2099-01-01T00:00:00.000Z',
    },
  };
}

function archivedManifest(
  workspaceId: string,
  containerId: string,
): Extract<ArchivedContainerManifest, { version: 2 }> {
  return {
    ...archivedManifestFields(workspaceId, containerId),
    version: 2,
    gitState: { version: 1, diffFormatVersion: 1, repositories: [] },
    gitChanges: {
      status: 'complete',
      capturedAt: '2099-01-02T00:00:00.000Z',
      fileCount: 0,
      insertions: 0,
      deletions: 0,
      repositories: [],
    },
    pullRequestMetadata: {
      capturedAt: '2099-01-02T00:00:00.000Z',
      repositories: [],
    },
  };
}

/**
 * Plan §3.1: a version-3 archive whose Git registration cleanup still points
 * at a source repository that no longer exists. CAN-5338 points it at the
 * project's configured source instead.
 */
async function plantPendingVersion3Archive(
  referenceRepoPath = join(dir, 'missing-source'),
): Promise<void> {
  const containerId = 'pending';
  const payloadId = '00000000-0000-4000-8000-000000000003';
  const containerDir = getArchivedContainerDir('a', containerId);
  const payload = join(containerDir, 'recovery-files', payloadId);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'kept.txt'), 'retained');
  const digest = await workspaceRootPayloadDigest({ rootPath: payload });
  if (digest === null) throw new Error('Expected a payload digest');
  const recovery = {
    kind: 'files-only' as const,
    source: 'partial' as const,
    digest,
    payloadId,
    gitCleanupPending: true,
  };
  const base = archivedManifestFields('a', containerId);
  await commitArchivedContainer({ ...base, version: 3, recovery });
  writeFileSync(
    join(containerDir, 'recovery.staged.json'),
    JSON.stringify({
      version: 1,
      createdAt: base.createdAt,
      phase: 'removed',
      recovery,
      // Absent repositories clear the pending flag; a missing one keeps it.
      repositories: [
        {
          referenceRepoPath,
          repositoryIdentity: null,
          relativePath: '',
          worktreePaths: [],
        },
      ],
    }),
  );
}

const strictListingCases = [
  {
    name: 'a manifest-less container',
    plant: (): void => {
      mkdirSync(join(getArchivedContainersRootDir('a'), 'gone'), {
        recursive: true,
      });
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'gone'), {
        recursive: true,
      }),
    error: { code: 'ENOENT' },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a truncated manifest',
    plant: (): void => {
      const container = join(getArchivedContainersRootDir('a'), 'truncated');
      mkdirSync(container, { recursive: true });
      writeFileSync(join(container, 'container.json'), '{"version":');
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'truncated'), {
        recursive: true,
      }),
    error: { name: 'SyntaxError' },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a version-4 manifest',
    plant: (): void => {
      const container = join(getArchivedContainersRootDir('a'), 'future');
      mkdirSync(container, { recursive: true });
      writeFileSync(
        join(container, 'container.json'),
        JSON.stringify({ ...archivedManifest('a', 'future'), version: 4 }),
      );
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'future'), {
        recursive: true,
      }),
    error: {
      message: expect.stringContaining(
        'Invalid archived container manifest',
      ) as unknown,
    },
    keyedRetry: 'recovery-required' as const,
  },
  {
    name: 'a container with an invalid name',
    plant: (): void => {
      mkdirSync(join(getArchivedContainersRootDir('a'), 'Bad_Name'), {
        recursive: true,
      });
    },
    repair: (): void =>
      rmSync(join(getArchivedContainersRootDir('a'), 'Bad_Name'), {
        recursive: true,
      }),
    error: { name: 'IdentifierValidationError' },
    keyedRetry: 'succeeds' as const,
  },
];

/** An unreadable journal of some other operation in the shared directory. */
function plantUnreadableForeignJournal(): string {
  const journal = join(
    getW5DestructiveLifecycleDir(),
    `${'f'.repeat(64)}.json`,
  );
  mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
  writeFileSync(journal, '{truncated');
  return journal;
}

/** Project a's lifecycle journal, or one of its worktrees'. */
function journalFileOf(worktreeId?: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify(['a', worktreeId ?? null]))
    .digest('hex');
  return join(getW5DestructiveLifecycleDir(), `${key}.json`);
}

/**
 * CAN-5337: loaded per test, so only the tests of the project deletion
 * discard fail on a build without it.
 */
async function describeProjectDeletion(
  workspaceId = 'a',
  options?: { retainedArchives?: boolean },
): Promise<ProjectDeletionDiscardDescription> {
  const { describeProjectDeletionDiscard } =
    await import('../project-deletion-discard');
  return options
    ? describeProjectDeletionDiscard(workspaceId, options)
    : describeProjectDeletionDiscard(workspaceId);
}

/**
 * Discards each listed item with its own token, as a client does: with the
 * opt-in when its description lists a retained archive (CAN-5338).
 */
async function discardListedItems(
  description: ProjectDeletionDiscardDescription,
): Promise<void> {
  for (const item of description.items)
    await expect(
      discardWorktree({
        workspaceId: description.workspaceId,
        worktreeId: item.description.worktreeId,
        confirmation: item.description.confirmation,
        source: 'portal-ui',
        ...(item.description.targets.some(
          (target) => target.kind === 'retained-archive',
        )
          ? { retainedArchives: true }
          : {}),
      }),
    ).resolves.toMatchObject({ status: 'discarded' });
}

/** Every file under `path` with its bytes, for an unchanged-tree check. */
function treeImage(path: string): Record<string, string> {
  const image: Record<string, string> = {};
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) walk(child);
      else
        image[child.slice(path.length)] =
          readFileSync(child).toString('base64');
    }
  };
  walk(path);
  return image;
}

/** A manifest-less archive directory the janitor may remove by age alone. */
function plantAgedStagingDirectory(workspaceId: string): string {
  const staging = join(getArchivedContainersRootDir(workspaceId), 'staging');
  mkdirSync(staging, { recursive: true });
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  utimesSync(staging, old, old);
  return staging;
}

describe('W6c2 index removal decisions', () => {
  it('a code deletion applies one plain decision through the single index commit', async () => {
    const commits = jest.spyOn(host, 'commit');
    const other = readIndex().filter((entry) => entry.id !== 'a');

    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'code' });

    expect(decisionCalls()).toEqual([['a', DELETE_INDEX]]);
    await expect(decisions.mock.results[0]?.value).resolves.toBe(true);
    expect(indexCommits(commits)).toBe(1);
    expect(readIndex()).toEqual(
      other.map((entry, order) => ({ ...entry, order })),
    );
    expect(existsSync(join(root, 'a'))).toBe(false);
  });

  it('a Cowork deletion applies one decision after every session teardown, the sentinel keying included', async () => {
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    const commits = jest.spyOn(host, 'commit');
    const other = readFileSync(join(root, 'b', 'workspace.json'), 'utf8');

    await expect(deleteWorkspace(chatProjectRequest('c'))).resolves.toEqual({
      workspaceId: 'c',
      removed: 'cowork',
      cleanup: {
        archivedGitRefs: { status: 'done' },
        chatSearchRows: { status: 'done' },
        managedRepository: { status: 'skipped' },
        skillSuggestions: { status: 'done' },
      },
    });

    expect(decisionCalls()).toEqual([['c', DELETE_INDEX]]);
    expect(destroy.mock.calls).toEqual([
      ['c', 'home'],
      [STANDALONE_CHAT_PROJECT_ID, 'c'],
    ]);
    expect(Math.max(...destroy.mock.invocationCallOrder)).toBeLessThan(
      decisions.mock.invocationCallOrder[0] ?? 0,
    );
    expect(indexCommits(commits)).toBe(1);
    expect(indexIds()).toEqual(['a', 'b']);
    expect(readFileSync(join(root, 'b', 'workspace.json'), 'utf8')).toBe(other);
    expect(existsSync(join(root, 'c'))).toBe(false);
    const record = await readDestructiveRecovery('c');
    expect(record?.state).toBe('completed');
    expect(record?.steps.slice(0, 3)).toEqual([
      { phase: 'session-teardown', state: 'done' },
      { phase: 'session-teardown', state: 'done' },
      { phase: 'cowork-deletion', state: 'done' },
    ]);
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalledWith({
      action: 'delete',
      workspaceId: 'c',
      source: 'chat_project_delete',
    });
  });

  it('an unindexed id without the Cowork admission applies the decision, which finds no entry', async () => {
    await expect(
      deleteWorkspace({ workspaceId: 'zz', source: 'shared_container_fork' }),
    ).resolves.toMatchObject({ removed: 'unindexed' });

    expect(decisionCalls()).toEqual([['zz', DELETE_INDEX]]);
    await expect(decisions.mock.results[0]?.value).resolves.toBe(false);
    expect(indexIds()).toEqual(['a', 'b', 'c']);
  });

  describe('decides nothing when', () => {
    it.each([
      [
        'the project is protected',
        { workspaceId: DEFAULT_COWORK_WORKSPACE_ID, source: 'portal' } as const,
        { reason: 'protected' },
      ],
      [
        'the Cowork admission finds a code project',
        chatProjectRequest('a'),
        { reason: 'not-cowork', message: 'Chat project not found' },
      ],
      [
        'the Cowork admission finds an unindexed id',
        chatProjectRequest('zz'),
        { reason: 'not-cowork', message: 'Chat project not found' },
      ],
      [
        'a caller revision is stale',
        {
          workspaceId: 'a',
          source: 'shared_container_fork',
          expectedRevision: 99,
        } as const,
        { name: 'W5RevisionConflictError' },
      ],
    ])('%s', async (_label, request, refusal) => {
      const before = canonicalImages();
      await expect(deleteWorkspace(request)).rejects.toMatchObject(refusal);
      expect(decisions).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it.each([
      ['the workspace keying', 'c/home/chat-a'],
      ['the sentinel keying', `${STANDALONE_CHAT_PROJECT_ID}/c/chat-a`],
    ])('a chat under %s has live delegates', async (_label, sessionKey) => {
      setDelegationActivity('w6c2-owner', sessionKey, 1);
      try {
        await expect(
          deleteWorkspace(chatProjectRequest('c')),
        ).rejects.toMatchObject({ code: 'conflict' });
      } finally {
        setDelegationActivity('w6c2-owner', sessionKey, 0);
      }
      expect(decisions).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    });

    it('a split holds the deletion lease', async () => {
      const release = acquireWorkspaceDeletionLease('c');
      try {
        await expect(deleteWorkspace(chatProjectRequest('c'))).rejects.toThrow(
          'Cannot delete a project while one of its worktrees is being split.',
        );
      } finally {
        release();
      }
      expect(decisions).not.toHaveBeenCalled();
    });

    it.each(strictListingCases)(
      'strict archive listing finds $name',
      async ({ plant, error }) => {
        plant();
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).rejects.toMatchObject(error);
        expect(decisions).not.toHaveBeenCalled();
        expect(indexIds()).toEqual(['a', 'b', 'c']);
      },
    );

    it('a version-3 archive still has Git registration cleanup pending', async () => {
      await plantPendingVersion3Archive();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({ reason: 'git-cleanup-pending' });
      expect(decisions).not.toHaveBeenCalled();
    });

    it('an unreadable journal is in the lifecycle directory', async () => {
      plantUnreadableForeignJournal();
      await expect(
        deleteWorkspace(chatProjectRequest('c')),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(decisions).not.toHaveBeenCalled();
    });
  });
});

describe('W6c2 Cowork admission (P1(a))', () => {
  it('refuses a code project before any effect and releases its key', async () => {
    const { cancel, release } = watcherSpies();
    const request = chatProjectRequest('a', 'chat-project-code');
    const before = canonicalImages();

    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      name: 'WorkspaceDeletionRefusedError',
      reason: 'not-cowork',
      message: 'Chat project not found',
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(canonicalImages()).toEqual(before);
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
    expect(await readDestructiveRecovery('a')).toBe(null);
    // The released key runs once the project is a Cowork project.
    convertToCowork('a');
    await expect(deleteWorkspace(request)).resolves.toMatchObject({
      removed: 'cowork',
    });
  });

  it('refuses an unindexed id before any effect and releases its key', async () => {
    const { cancel, release } = watcherSpies();
    const request = chatProjectRequest('zz', 'chat-project-unindexed');

    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'not-cowork',
      message: 'Chat project not found',
    });

    expect(cancel).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(await readDestructiveRecovery('zz')).toBe(null);
    addCowork('zz');
    await expect(deleteWorkspace(request)).resolves.toMatchObject({
      removed: 'cowork',
    });
  });

  it.each([
    {
      name: 'the Cowork admission of a code project',
      request: chatProjectRequest('a', 'fenced-code'),
      reason: 'not-cowork',
      holder: ['a', 'one'],
      makeCowork: (): void => convertToCowork('a'),
    },
    {
      name: 'the Cowork admission of an unindexed id',
      request: chatProjectRequest('zz', 'fenced-unindexed'),
      reason: 'not-cowork',
      holder: ['zz', 'entry'],
      makeCowork: (): void => addCowork('zz'),
    },
    {
      name: 'the single-repo admission',
      request: {
        workspaceId: 'c',
        source: 'single_repo_project_delete',
        singleRepoProject: true,
      } satisfies WorkspaceDeletionRequest,
      reason: 'not-single-repo',
      holder: ['c', 'home'],
      makeCowork: undefined,
    },
  ])(
    'a refusal by $name keeps the watcher fence of a concurrent worktree data cleanup',
    async ({
      request,
      reason,
      holder: [projectId, worktreeId],
      makeCowork,
    }) => {
      const scope = `${projectId}/${worktreeId}`;
      const fenced = trackWatcherFences();
      const chatState = getChatStateService();
      const runWithScopeDeletion =
        chatState.runWithScopeDeletion.bind(chatState);
      let fenceHeld = (): void => {};
      const cleanupFenced = new Promise<void>((resolve) => {
        fenceHeld = resolve;
      });
      let resumeCleanup = (): void => {};
      const cleanupGate = new Promise<void>((resolve) => {
        resumeCleanup = resolve;
      });
      jest
        .spyOn(chatState, 'runWithScopeDeletion')
        .mockImplementationOnce(
          async <T>(
            chatScope: Parameters<typeof runWithScopeDeletion>[0],
            operation: () => Promise<T>,
          ): Promise<T> => {
            fenceHeld();
            await cleanupGate;
            return runWithScopeDeletion(chatScope, operation);
          },
        );
      const cleanup = cleanupPersistedWorktreeData(projectId, worktreeId);
      await cleanupFenced;
      expect(fenced).toEqual(new Set([scope]));

      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        name: 'WorkspaceDeletionRefusedError',
        reason,
      });

      expect(fenced).toEqual(new Set([scope]));
      resumeCleanup();
      await cleanup;
      expect(fenced).toEqual(new Set());
      if (makeCowork) {
        // The refusal released its key while the other fence stayed held.
        makeCowork();
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'cowork',
        });
      }
    },
  );
});

describe('W6c2 sentinel sessions (B1(a))', () => {
  it('refuses while a sentinel-keyed chat has live delegates, before any effect, and releases its key', async () => {
    const { cancel } = watcherSpies();
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    const sessionKey = `${STANDALONE_CHAT_PROJECT_ID}/c/chat-a`;
    const request = chatProjectRequest('c', 'sentinel-delegates');
    setDelegationActivity('w6c2-sentinel', sessionKey, 1);
    try {
      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        name: 'LiveDelegationsError',
      });
    } finally {
      setDelegationActivity('w6c2-sentinel', sessionKey, 0);
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(await readDestructiveRecovery('c')).toBe(null);
    await expect(deleteWorkspace(request)).resolves.toMatchObject({
      removed: 'cowork',
    });
  });

  it('refuses while a sentinel-keyed chat runs a background agent, before any effect, and releases its key', async () => {
    const { cancel } = watcherSpies();
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    const owners = jest
      .spyOn(sessionManager, 'listLiveBackgroundTaskOwners')
      .mockReturnValue([
        createLiveBackgroundTaskOwner(
          STANDALONE_CHAT_PROJECT_ID,
          'c',
          'chat-a',
          'local_agent',
        ),
      ]);
    const request = chatProjectRequest('c', 'sentinel-background');
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      name: 'LiveDelegationsError',
      message: BACKGROUND_WORK_REMOVAL_REFUSAL,
    });
    expect(cancel).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(decisions).not.toHaveBeenCalled();
    expect(await readDestructiveRecovery('c')).toBe(null);
    owners.mockReturnValue([]);
    await expect(deleteWorkspace(request)).resolves.toMatchObject({
      removed: 'cowork',
    });
    expect(decisions).toHaveBeenCalledTimes(1);
  });

  it('journals the sentinel teardown for a Portal deletion as well', async () => {
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
    await deleteWorkspace({ workspaceId: 'c', source: 'portal' });
    expect(destroy).toHaveBeenLastCalledWith(STANDALONE_CHAT_PROJECT_ID, 'c');
    expect(
      (await readDestructiveRecovery('c'))?.steps.filter(
        (step) => step.phase === 'session-teardown',
      ),
    ).toHaveLength(2);
  });
});

describe('W6c2 post-effect conflict', () => {
  it('a revision advance at the Cowork index commit keeps the teardown and requires recovery', async () => {
    const [current] = await readW5Revisions([
      { kind: 'workspace', workspaceId: 'c' },
    ]);
    if (!current) throw new Error('Expected a workspace revision');
    const browser = jest.requireMock<{
      prepareWorkspaceBrowserRetirement: jest.Mock;
      abortTaskBrowserRetirement: jest.Mock;
      commitTaskBrowserRetirement: jest.Mock;
    }>('../../browser/browser-profile-lifecycle');
    browser.prepareWorkspaceBrowserRetirement.mockResolvedValueOnce([
      { worktreeId: 'home', operationId: 'retire-home' },
    ]);
    const activate = jest.spyOn(
      coworkWorkEntries,
      'activateWorkEntryWorkspace',
    );
    const { commit: commitWatchers } = watcherSpies();
    const releaseWatchers = jest.spyOn(
      getAppAdvisorWatcherService(),
      'releaseLocalWorkspaceFence',
    );
    // Removed by `cleanupPersistedWorktreeData` before the index commit.
    const homeData = getWorktreeDataDir('c', 'home');
    mkdirSync(homeData, { recursive: true });
    writeFileSync(join(homeData, 'marker.txt'), 'home data');
    const destroy = jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockImplementation(async (projectId) => {
        // A real manifest commit advances the project's revision after the
        // preflight, before the index commit.
        if (projectId === STANDALONE_CHAT_PROJECT_ID)
          await updateWorkspaceConfig('c', (config) => {
            config.defaultPluginSelections = {
              collectionIds: [],
              skillRefs: [],
              pluginRefs: [{ marketplaceId: 'm', pluginName: 'late' }],
            };
          });
      });
    const request = {
      ...chatProjectRequest('c', 'late-revision'),
      expectedRevision: current.revision,
    };

    await expect(deleteWorkspace(request)).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );

    expect(destroy).toHaveBeenCalledTimes(2);
    // Decided inside the commit scope, which then refuses to publish it.
    expect(decisionCalls()).toEqual([['c', DELETE_INDEX]]);
    expect(browser.abortTaskBrowserRetirement).toHaveBeenCalledWith(
      'retire-home',
    );
    expect(browser.commitTaskBrowserRetirement).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith('c');
    // The earlier effects stay; nothing restores them.
    expect(existsSync(homeData)).toBe(false);
    expect(jest.mocked(recordWorkspaceCrudTelemetry)).not.toHaveBeenCalled();
    expect(commitWatchers).not.toHaveBeenCalled();
    expect(releaseWatchers).toHaveBeenCalledWith('c');
    expect(indexIds()).toContain('c');
    expect(existsSync(join(root, 'c', 'workspace.json'))).toBe(true);
    const record = await readDestructiveRecovery('c');
    expect(record?.state).toBe('recovery-required');
    expect(record?.steps).toEqual(
      expect.arrayContaining([
        { phase: 'session-teardown', state: 'done' },
        { phase: 'cowork-deletion', state: 'pending' },
      ]),
    );
    expect(
      record?.steps.filter((step) => step.phase === 'session-teardown'),
    ).toHaveLength(2);
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  });
});

describe('W6c2 characterization (plan §3)', () => {
  describe('§3.1 a version-3 archive with a missing source (R-V3(ii), CAN-4963)', () => {
    const worktree = {
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo' as const,
      deleteWithoutRetentionIfMissing: true,
    };
    const stepFreeRefusal = {
      name: 'WorkspaceDeletionRefusedError',
      reason: 'git-cleanup-pending',
      message:
        'Git registration cleanup is still pending. Retry after the source repository is available.',
    };
    function pendingManifestImage(): string {
      return readFileSync(
        join(getArchivedContainerDir('a', 'pending'), 'container.json'),
        'utf8',
      );
    }
    function pendingJournalImage(): string {
      return readFileSync(
        join(getArchivedContainerDir('a', 'pending'), 'recovery.staged.json'),
        'utf8',
      );
    }
    function restoreSource(): void {
      execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
    }

    it.each([
      ['a rollback', 'shared_container_fork'],
      ['a user deletion', 'portal'],
    ] as const)(
      '%s refuses before any effect, releases its key and leaves the project usable',
      async (_label, source) => {
        await plantPendingVersion3Archive();
        const { cancel } = watcherSpies();
        const finish = jest.spyOn(
          archivedContainerRecovery,
          'finishArchivedContainerRecovery',
        );
        const manifest = pendingManifestImage();
        const journal = pendingJournalImage();
        const before = canonicalImages();
        const request = {
          workspaceId: 'a',
          source,
          idempotencyKey: `version-3-${source}`,
        };

        await expect(deleteWorkspace(request)).rejects.toMatchObject(
          stepFreeRefusal,
        );

        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(cancel).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
        expect(decisions).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(pendingManifestImage()).toBe(manifest);
        expect(pendingJournalImage()).toBe(journal);
        // A user deletion refuses before it archives the live worktrees.
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
        // An unkeyed retry refuses the same way, still without a journal.
        await expect(
          deleteWorkspace({ workspaceId: 'a', source }),
        ).rejects.toMatchObject(stepFreeRefusal);
        expect(await readDestructiveRecovery('a')).toBe(null);
        // Worktree archive and delete in the project stay available.
        await archiveWorktree(worktree);
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
        // The released key runs once the source repository is available.
        restoreSource();
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it('a Git failure while inspecting an available source refuses before any effect, because the Git step would fail the same way', async () => {
      await plantPendingVersion3Archive();
      restoreSource();
      const { cancel } = watcherSpies();
      const finish = jest.spyOn(
        archivedContainerRecovery,
        'finishArchivedContainerRecovery',
      );
      const lookup = jest
        .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
        .mockRejectedValue(new Error('Git executable lookup failed'));
      const manifest = pendingManifestImage();
      const journal = pendingJournalImage();
      const before = canonicalImages();
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'version-3-git-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toMatchObject(
        stepFreeRefusal,
      );

      expect(lookup).toHaveBeenCalled();
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(cancel).not.toHaveBeenCalled();
      expect(finish).not.toHaveBeenCalled();
      expect(decisions).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(pendingManifestImage()).toBe(manifest);
      expect(pendingJournalImage()).toBe(journal);
      expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
      // The released key runs once Git works again.
      lookup.mockRestore();
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
    });

    it.each([
      ['a rollback', 'shared_container_fork'],
      ['a user deletion, after its worktree archives', 'portal'],
    ] as const)(
      'for %s, a cleanup that still cannot finish after admission refuses step-free and releases its key (CAN-5011)',
      async (_label, source) => {
        await plantPendingVersion3Archive();
        // Models a source that disappears between admission and the Git step.
        const blocked = jest
          .spyOn(
            archivedContainerRecovery,
            'isArchivedContainerGitCleanupBlocked',
          )
          .mockResolvedValue(false);
        const request = {
          workspaceId: 'a',
          source,
          idempotencyKey: `version-3-after-admission-${source}`,
        };

        // Before, the refusal followed the step and journaled a lockout.
        await expect(deleteWorkspace(request)).rejects.toMatchObject(
          stepFreeRefusal,
        );

        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(await reportDestructiveRecovery()).toEqual([]);
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        expect(JSON.parse(pendingManifestImage())).toMatchObject({
          recovery: { gitCleanupPending: true },
        });
        // A user deletion archived the live worktrees first; they stay archived.
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(
          source === 'shared_container_fork',
        );
        if (source === 'shared_container_fork') {
          // Worktree archive and delete in the project stay available.
          await archiveWorktree(worktree);
          await deleteWorktree({ ...worktree, worktreeId: 'two' });
        }
        // The released key runs once the source repository is available.
        blocked.mockRestore();
        restoreSource();
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    /** A deletion journal as builds before CAN-5011 kept it: no `resumable` marker. */
    function plantPreUpgradeDeletionJournal(
      operationId: string,
      state: 'recovery-required' | 'active',
      steps: { phase: string; state: 'pending' | 'done' | 'failed' }[],
      ownedPaths: { path: string; identity: string | null }[] = [],
    ): void {
      const workspace = lstatSync(getWorkspaceDir('a'));
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      writeFileSync(
        journalFileOf(),
        JSON.stringify({
          version: 1,
          operationId,
          operation: 'workspace-delete',
          workspaceId: 'a',
          directoryIdentity: `${workspace.dev}:${workspace.ino}:${workspace.birthtimeMs}`,
          state,
          steps,
          ownedPaths,
        }),
      );
    }

    it.each([
      ['a failed finish', 'pending', 'recovery-required'],
      ['a finish that left the cleanup pending', 'done', 'recovery-required'],
      ['a crash during the finish', 'pending', 'active'],
    ] as const)(
      'a rollback journal an earlier version kept after %s in its Git cleanup step refuses no operation, and the next deletion supersedes it (CAN-5011)',
      async (_label, stepState, state) => {
        await plantPendingVersion3Archive();
        const operationId = '00000000-0000-4000-8000-0000000050c1';
        plantPreUpgradeDeletionJournal(operationId, state, [
          { phase: 'retained-git-cleanup', state: stepState },
        ]);

        // Before, it required recovery and refused every operation below.
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(await reportDestructiveRecovery()).toEqual([]);
        await archiveWorktree(worktree);
        await deleteWorktree({ ...worktree, worktreeId: 'two' });
        // A deletion still refuses step-free while the cleanup cannot finish.
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).rejects.toMatchObject(stepFreeRefusal);
        restoreSource();

        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).resolves.toMatchObject({ removed: 'code' });

        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'W5 destructive lifecycle supersedes an interrupted deletion',
          expect.objectContaining({ operationId }),
        );
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
        expect(await readDestructiveRecovery('a')).toMatchObject({
          state: 'completed',
        });
      },
    );

    it.each([
      ['pending', 'recovery-required'],
      ['done', 'recovery-required'],
      ['pending', 'active'],
    ] as const)(
      'a user deletion journal an earlier version kept after its worktree archives and a %s Git cleanup step, %s, is superseded by the same request (CAN-5011)',
      async (stepState, state) => {
        await plantPendingVersion3Archive();
        // Models a source that disappears between admission and the Git step.
        const blocked = jest
          .spyOn(
            archivedContainerRecovery,
            'isArchivedContainerGitCleanupBlocked',
          )
          .mockResolvedValue(false);
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: `pre-upgrade-${stepState}-${state}`,
        };
        await expect(deleteWorkspace(request)).rejects.toMatchObject(
          stepFreeRefusal,
        );
        const children = (
          await Promise.all(
            ['one', 'two'].map((worktreeId) =>
              readDestructiveRecovery('a', worktreeId),
            ),
          )
        ).flatMap((record) => (record ? [record] : []));
        expect(children).not.toEqual([]);
        const operationId = '00000000-0000-4000-8000-0000000050c2';
        plantPreUpgradeDeletionJournal(operationId, state, [
          ...children.map((child) => ({
            phase: `child:${child.operationId}`,
            state: 'done' as const,
          })),
          { phase: 'retained-git-cleanup', state: stepState },
        ]);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        blocked.mockRestore();
        restoreSource();

        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });

        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'W5 destructive lifecycle supersedes an interrupted deletion',
          expect.objectContaining({ operationId }),
        );
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it.each([
      ['a failed step', [{ phase: 'retained-git-cleanup', state: 'failed' }]],
      [
        'a later effect',
        [
          { phase: 'retained-git-cleanup', state: 'done' },
          { phase: 'canonical-index-removal', state: 'pending' },
        ],
      ],
    ] as const)(
      'a pre-upgrade Git cleanup journal with %s still refuses (CAN-5011)',
      async (_label, steps) => {
        await plantPendingVersion3Archive();
        restoreSource();
        const operationId = '00000000-0000-4000-8000-0000000050c3';
        plantPreUpgradeDeletionJournal(operationId, 'recovery-required', [
          ...steps,
        ]);

        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(true);
        await expect(
          deleteWorkspace({
            workspaceId: 'a',
            source: 'shared_container_fork',
          }),
        ).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId },
        });
        expect(indexIds()).toEqual(['a', 'b', 'c']);
      },
    );

    it('a pre-upgrade Git cleanup journal over a replaced project directory still refuses (CAN-5011)', async () => {
      await plantPendingVersion3Archive();
      restoreSource();
      const operationId = '00000000-0000-4000-8000-0000000050c4';
      plantPreUpgradeDeletionJournal(operationId, 'recovery-required', [
        { phase: 'retained-git-cleanup', state: 'pending' },
      ]);
      const journal = z
        .object({ directoryIdentity: z.string() })
        .passthrough()
        .parse(JSON.parse(readFileSync(journalFileOf(), 'utf8')));
      writeFileSync(
        journalFileOf(),
        JSON.stringify({ ...journal, directoryIdentity: '1:2:3' }),
      );

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { operationId },
      });
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    // A managed single-repo project's deletion protected its repository.
    it.each([
      ['unchanged', (): void => undefined, true],
      ['gone', (path: string): void => rmSync(path, { recursive: true }), true],
      ['replaced', (): void => undefined, false],
    ] as const)(
      'a pre-upgrade Git cleanup journal whose protected path is %s is superseded only while it is not replaced (CAN-5011)',
      async (label, change, supersedes) => {
        await plantPendingVersion3Archive();
        restoreSource();
        const protectedPath = join(dir, 'protected-repository');
        mkdirSync(protectedPath);
        const stat = lstatSync(protectedPath);
        const operationId = '00000000-0000-4000-8000-0000000050c5';
        plantPreUpgradeDeletionJournal(
          operationId,
          'recovery-required',
          [{ phase: 'retained-git-cleanup', state: 'pending' }],
          [
            {
              path: protectedPath,
              identity:
                label === 'replaced'
                  ? '1:2:3'
                  : `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`,
            },
          ],
        );
        change(protectedPath);

        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(!supersedes);
        const deletion = deleteWorkspace({
          workspaceId: 'a',
          source: 'shared_container_fork',
        });
        if (supersedes) {
          await expect(deletion).resolves.toMatchObject({ removed: 'code' });
          expect(indexIds()).toEqual(['b', 'c']);
        } else {
          await expect(deletion).rejects.toMatchObject({
            reason: 'recovery-required',
            details: { operationId },
          });
          expect(indexIds()).toEqual(['a', 'b', 'c']);
        }
      },
    );
  });

  describe('a live worktree with a missing source (CAN-4985)', () => {
    const sourceRefusal = {
      name: 'WorkspaceDeletionRefusedError',
      reason: 'source-unavailable',
      message:
        "A source repository for this project's worktrees is unavailable. Retry after it is available.",
    };
    const interruptedArchiveRefusal = {
      name: 'W5CommitRefusedError',
      reason: 'recovery-required',
      message:
        'An interrupted archive needs manual recovery. Preserve its remaining checkout, retained payload and journals.',
    };
    const checkout = (): string => join(root, 'a', 'worktrees', 'one');
    const movedSource = (): string => `${repo}-unavailable`;
    function hideSource(): void {
      renameSync(repo, movedSource());
    }
    function restoreSource(): void {
      renameSync(movedSource(), repo);
    }
    async function expectNoJournal(): Promise<void> {
      expect(await readDestructiveRecovery('a')).toBe(null);
      for (const worktreeId of ['one', 'two'])
        expect(await readDestructiveRecovery('a', worktreeId)).toBe(null);
    }

    it.each([
      [
        'its checkout present, whose Git capture would fail',
        (): void => undefined,
      ],
      [
        'its checkout gone, whose files-only recovery would leave Git cleanup pending',
        (): void => rmSync(checkout(), { recursive: true, force: true }),
      ],
    ])(
      'a Portal deletion with %s refuses before any effect and releases its key',
      async (_label, plant) => {
        plant();
        hideSource();
        const { cancel } = watcherSpies();
        const before = canonicalImages();
        const checkoutPresent = existsSync(checkout());
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: 'missing-source',
        };

        await expect(deleteWorkspace(request)).rejects.toMatchObject(
          sourceRefusal,
        );

        await expectNoJournal();
        expect(cancel).not.toHaveBeenCalled();
        expect(decisions).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(existsSync(checkout())).toBe(checkoutPresent);
        expect(existsSync(getArchivedContainersRootDir('a'))).toBe(false);
        // An unkeyed retry refuses the same way, still without a journal.
        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).rejects.toMatchObject(sourceRefusal);
        await expectNoJournal();
        // The released key runs once the source repository is available.
        restoreSource();
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it.each([
      ['archive', false],
      ['archive', true],
      ['delete', false],
      ['delete', true],
    ] as const)(
      'CAN-5158 %s (missing checkout: %s) refuses before lifecycle effects and can retry',
      async (operation, missingCheckout) => {
        if (missingCheckout) rmSync(checkout(), { recursive: true });
        hideSource();
        const watcher = getAppAdvisorWatcherService();
        const cancel = jest.spyOn(watcher, 'cancelLocalScope');
        jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
        const cleanup = jest.spyOn(
          worktreeLiveCleanup,
          'cleanupLiveWorktreeState',
        );
        const before = canonicalImages();
        const request = {
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo' as const,
          teardownOperation: 'delete',
          idempotencyKey: 'source-admission-delete',
        };
        const run = (): Promise<unknown> =>
          operation === 'delete'
            ? deleteWorktree(request)
            : archiveWorktree({
                ...request,
                deleteWithoutRetentionIfMissing: missingCheckout,
              });

        await expect(run()).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'source-unavailable',
        });
        await expectNoJournal();
        expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
        expect(prepareTaskBrowserRetirement).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(existsSync(checkout())).toBe(!missingCheckout);
        expect(existsSync(getArchivedContainersRootDir('a'))).toBe(false);

        restoreSource();
        await expect(run()).resolves.toMatchObject({ success: true });
        expect(existsSync(checkout())).toBe(false);
      },
    );

    it.each([false, true])(
      'CAN-5333 the read-only check (missing checkout: %s) names the first refused worktree without effects',
      async (missingCheckout) => {
        if (missingCheckout) rmSync(checkout(), { recursive: true });
        hideSource();
        const watcher = getAppAdvisorWatcherService();
        const cancel = jest.spyOn(watcher, 'cancelLocalScope');
        jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
        const cleanup = jest.spyOn(
          worktreeLiveCleanup,
          'cleanupLiveWorktreeState',
        );
        const before = canonicalImages();
        const refused = (worktreeId: string): unknown => ({
          status: 'refused',
          worktreeId,
          reason: 'source-unavailable',
          message:
            "Couldn't verify the worktree's source repositories. Check repository access and retry.",
        });

        await expect(
          checkWorktreeRemovalAdmission({
            workspaceId: 'a',
            worktreeIds: ['one', 'two'],
          }),
        ).resolves.toEqual(refused('one'));
        // A row absent from a readable list is left to the archive; the
        // later files-only worktree is still checked.
        await expect(
          checkWorktreeRemovalAdmission({
            workspaceId: 'a',
            worktreeIds: ['gone', 'two'],
          }),
        ).resolves.toEqual(refused('two'));

        await expectNoJournal();
        expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
        expect(prepareTaskBrowserRetirement).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(existsSync(checkout())).toBe(!missingCheckout);
        expect(existsSync(getArchivedContainersRootDir('a'))).toBe(false);

        restoreSource();
        await expect(
          checkWorktreeRemovalAdmission({
            workspaceId: 'a',
            worktreeIds: ['one', 'two'],
          }),
        ).resolves.toEqual({ status: 'admitted' });
        // The check reserved nothing; the archive admits on its own.
        await expect(
          archiveWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            source: 'single_repo',
            deleteWithoutRetentionIfMissing: missingCheckout,
          }),
        ).resolves.toMatchObject({ success: true });
      },
    );

    it('CAN-5333 the read-only check admits a Cowork project and an empty list', async () => {
      hideSource();
      await expect(
        checkWorktreeRemovalAdmission({ workspaceId: 'c', worktreeIds: ['e'] }),
      ).resolves.toEqual({ status: 'admitted' });
      await expect(
        checkWorktreeRemovalAdmission({ workspaceId: 'a', worktreeIds: [] }),
      ).resolves.toEqual({ status: 'admitted' });
      await expect(
        checkWorktreeRemovalAdmission({
          workspaceId: '../a',
          worktreeIds: ['one'],
        }),
      ).rejects.toThrow();
    });

    it('a refusal leaves a legacy ready descriptor unwritten', async () => {
      const { worktrees } = z
        .object({
          worktrees: z.array(
            z.object({
              id: z.string(),
              branchName: z.string(),
              createdAt: z.string(),
            }),
          ),
        })
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
        );
      const one = worktrees.find((worktree) => worktree.id === 'one');
      if (!one) throw new Error('Expected worktree one');
      const capture = await captureArchivedContainerGitState({
        workspaceId: 'a',
        containerId: 'one',
        workspaceType: 'single-repo',
        worktreePath: checkout(),
        persistedWorktree: one,
      });
      await prepareArchivedContainerTeardown({
        workspaceId: 'a',
        containerId: 'one',
        workspaceType: 'single-repo',
        gitState: capture.gitState,
      });
      // A ready descriptor written before pull-request metadata existed.
      const stagedPath = getArchivedContainerGitStateStagedPath('a', 'one');
      const staged = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(stagedPath, 'utf8')));
      delete staged.pullRequestMetadata;
      const legacy = JSON.stringify(staged);
      writeFileSync(stagedPath, legacy);
      // Worktree two's earlier capture staged a repository that is gone; the
      // archive check on worktree one refuses first.
      const laterPath = getArchivedContainerGitStateStagedPath('a', 'two');
      mkdirSync(dirname(laterPath), { recursive: true });
      writeFileSync(
        laterPath,
        JSON.stringify({
          version: 1,
          status: 'capturing',
          repositories: capture.gitState.repositories.map((repository) => ({
            ...repository,
            referenceRepoPath: join(dir, 'gone'),
          })),
        }),
      );
      const { cancel } = watcherSpies();
      const before = canonicalImages();
      const checkoutPresent = existsSync(checkout());

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(interruptedArchiveRefusal);

      // Before admission read descriptors read-only, it rewrote this one.
      expect(readFileSync(stagedPath, 'utf8')).toBe(legacy);
      await expectNoJournal();
      expect(cancel).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(existsSync(checkout())).toBe(checkoutPresent);
    });

    it('a source that Git cannot open refuses as well', async () => {
      // The directory is there, but it no longer holds a repository.
      rmSync(join(repo, '.git'), { recursive: true, force: true });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      await expectNoJournal();
      expect(existsSync(checkout())).toBe(true);
    });

    it('a Git failure while inspecting an available source refuses, because the archive would fail the same way', async () => {
      const lookup = jest
        .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
        .mockRejectedValue(new Error('Git executable lookup failed'));
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'source-git-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toMatchObject(
        sourceRefusal,
      );

      expect(lookup).toHaveBeenCalled();
      await expectNoJournal();
      lookup.mockRestore();
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
    });

    it('a rollback archives no worktree, so a missing source does not refuse it', async () => {
      hideSource();

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(indexIds()).toEqual(['b', 'c']);
    });

    it("a rollback unregisters the live checkout its directory removal takes, so the checkout's branch can be checked out again (CAN-5011)", async () => {
      const branch = execFileSync(
        'git',
        ['-C', checkout(), 'branch', '--show-current'],
        { encoding: 'utf8' },
      ).trim();

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'code' });

      // Before, the registration outlived the project and held the branch.
      expect(existsSync(checkout())).toBe(false);
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).not.toContain(join('a', 'worktrees'));
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-q',
        join(dir, 'branch-again'),
        branch,
      ]);
    });

    it('a source that disappears after admission fails the child archive, and the same request deletes the project once it returns (CAN-4993)', async () => {
      // Models a source that disappears between admission and the archive.
      const admission = jest
        .spyOn(archivedContainerRecovery, 'isWorktreeArchiveSourceUnavailable')
        .mockResolvedValue(false);
      hideSource();
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'source-after-admission',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow('ENOENT');

      // Before, a pending `child:` step left the deletion journal requiring
      // recovery, which refused every archive and delete in the project, and
      // the failed archive's own journal kept refusing the deletion.
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        state: 'recovery-required',
        parentOperation: 'workspace-delete',
        steps: expect.arrayContaining([
          { phase: 'git-capture', state: 'pending' },
        ]) as unknown,
      });
      expect(existsSync(checkout())).toBe(true);
      admission.mockRestore();
      restoreSource();
      // The other worktree's archive stays available meanwhile.
      await archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        source: 'single_repo',
      });

      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
    });

    it('a corrupt single-repo configuration refuses before any effect, as the archive cannot find its repository', async () => {
      writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      await expectNoJournal();
      expect(existsSync(checkout())).toBe(true);
    });

    /**
     * Turns project a into a multi-repo project whose worktree one has a
     * checkout of `present` only; `gone` is configured but its source is
     * missing. Returns worktree one's record.
     */
    function useMultiRepoWithUnmaterializedMissingSource(
      extra: Pick<WorktreeData, 'restoredFromFilesOnlyArchiveId'> = {},
    ): WorktreeData {
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: readIndex().map((entry) =>
            entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
          ),
        }),
      );
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'multi-repo',
          repos: [
            { id: 'present', name: 'present', repoPath: repo },
            { id: 'gone', name: 'gone', repoPath: join(dir, 'gone') },
          ],
        }),
      );
      const { worktrees } = z
        .object({ worktrees: z.array(z.object({ createdAt: z.string() })) })
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
        );
      const one = {
        id: 'one',
        branchName: 'multi',
        createdAt: worktrees[0].createdAt,
        ...extra,
      };
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({ version: 1, worktrees: [one] }),
      );
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'remove',
        '--force',
        checkout(),
      ]);
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-q',
        '-b',
        'multi',
        join(checkout(), 'repos', 'present'),
      ]);
      __resetSidebarItemsStateForTests();
      return one;
    }

    it.each(['single-repo', 'multi-repo'] as const)(
      'CAN-5158 direct %s removal refuses before Auto Delete or automation teardown',
      async (kind) => {
        if (kind === 'multi-repo')
          useMultiRepoWithUnmaterializedMissingSource();
        hideSource();
        const teardown = jest.fn<Promise<void>, []>();
        const cleanup = jest.fn<Promise<void>, [string, string]>();
        const options = {
          workspaceId: 'a',
          worktreeId: 'one',
          sourceAdmission: 'required' as const,
          retainAsArchivedContainer: false,
          runAutoArchiveTeardown: teardown,
          observabilityMode: 'live-service' as const,
          liveServices: {
            cleanupLiveState: cleanup,
            purgeObservabilityData: jest.fn(),
          },
        };
        const archive =
          kind === 'single-repo'
            ? archiveSingleRepoWorktree
            : archiveMultiRepoWorktree;
        await expect(archive(options)).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'source-unavailable',
        });
        expect(teardown).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        await expectNoJournal();
        expect(existsSync(checkout())).toBe(true);
      },
    );

    it('CAN-5337 of two worktrees only the blocked one is listed; the other takes the ordinary archive and the project deletes', async () => {
      const one = useMultiRepoWithUnmaterializedMissingSource();
      execFileSync('git', [
        '-C',
        repo,
        'worktree',
        'add',
        '-q',
        '-b',
        'healthy',
        join(root, 'a', 'worktrees', 'two', 'repos', 'present'),
      ]);
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            { ...one, includedRepoIds: ['present', 'gone'] },
            {
              id: 'two',
              branchName: 'healthy',
              createdAt: one.createdAt,
              includedRepoIds: ['present'],
            },
          ],
        }),
      );
      __resetSidebarItemsStateForTests();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      const description = await describeProjectDeletion();

      expect(description.status).toBe('discardable');
      expect(
        description.items.map((item) => [
          item.description.worktreeId,
          item.description.causes,
        ]),
      ).toEqual([['one', ['source-gone']]]);
      await discardListedItems(description);
      expect(await readDestructiveRecovery('a', 'two')).toBe(null);
      expect(existsSync(join(root, 'a', 'worktrees', 'two'))).toBe(true);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        operation: 'worktree-delete',
        state: 'completed',
      });
      expect(await readDestructiveRecovery('a', 'two')).toMatchObject({
        operation: 'worktree-archive',
        parentOperation: 'workspace-delete',
        state: 'completed',
      });
    });

    it('CAN-5158 ordinary multi-repo archive ignores unrelated configured sources', async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'multi_repo',
        }),
      ).resolves.toMatchObject({ success: true });
    });

    it('CAN-5158 missing multi-repo checkout checks included sources without retention', async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      rmSync(checkout(), { recursive: true });
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'multi_repo',
          deleteWithoutRetentionIfMissing: true,
        }),
      ).rejects.toMatchObject({ reason: 'source-unavailable' });
      await expectNoJournal();
    });

    it.each([
      ['archive', false],
      ['archive', true],
      ['delete', false],
      ['delete', true],
    ] as const)(
      'CAN-5158 multi-repo %s respects explicit inclusion (missing checkout: %s)',
      async (operation, missingCheckout) => {
        const one = useMultiRepoWithUnmaterializedMissingSource();
        if (missingCheckout) rmSync(checkout(), { recursive: true });
        const rowsPath = join(root, 'a', 'worktrees.json');
        writeFileSync(
          rowsPath,
          JSON.stringify({
            version: 1,
            worktrees: [{ ...one, includedRepoIds: ['present', 'gone'] }],
          }),
        );
        const request = {
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'multi_repo' as const,
          teardownOperation: 'delete',
          deleteBranch: false,
        };
        const remove = (): Promise<unknown> =>
          operation === 'delete'
            ? deleteWorktree(request)
            : archiveWorktree({
                ...request,
                deleteWithoutRetentionIfMissing: missingCheckout,
              });

        await expect(remove()).rejects.toMatchObject({
          reason: 'source-unavailable',
        });
        await expectNoJournal();
        expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
        expect(existsSync(checkout())).toBe(!missingCheckout);

        // A configured source excluded from this worktree must not block it.
        writeFileSync(
          rowsPath,
          JSON.stringify({
            version: 1,
            worktrees: [{ ...one, includedRepoIds: ['present'] }],
          }),
        );
        await expect(remove()).resolves.toMatchObject({
          success: true,
        });
      },
    );

    it.each([
      [false, true, true],
      [true, false, true],
      [true, true, true],
      [false, true, false],
    ] as const)(
      'CAN-5158 non-retained cleanup preserves selection (missing: %s, explicit: %s, child present: %s)',
      async (missingCheckout, explicitInclusion, childPresent) => {
        const one = useMultiRepoWithUnmaterializedMissingSource();
        const otherRepo = join(dir, 'gone');
        const otherCheckout = join(checkout(), 'repos', 'gone');
        execFileSync('git', ['clone', '-q', repo, otherRepo]);
        execFileSync('git', [
          '-C',
          otherRepo,
          'worktree',
          'add',
          '-q',
          '-b',
          'excluded',
          otherCheckout,
        ]);
        if (explicitInclusion) {
          writeFileSync(
            join(root, 'a', 'worktrees.json'),
            JSON.stringify({
              version: 1,
              worktrees: [{ ...one, includedRepoIds: ['present'] }],
            }),
          );
        }
        if (missingCheckout) rmSync(checkout(), { recursive: true });
        else if (!childPresent) rmSync(otherCheckout, { recursive: true });

        await expect(
          archiveMultiRepoWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            sourceAdmission: 'required',
            retainAsArchivedContainer: false,
            deleteBranch: false,
          }),
        ).resolves.toMatchObject({ success: true });
        const registrations = execFileSync(
          'git',
          ['-C', otherRepo, 'worktree', 'list', '--porcelain'],
          { encoding: 'utf8' },
        );
        // Only an absent, explicitly excluded checkout is outside cleanup.
        // A materialized checkout and legacy rows keep their existing handling.
        expect(registrations.includes(otherCheckout)).toBe(
          (missingCheckout || !childPresent) && explicitInclusion,
        );
        expect(
          execFileSync(
            'git',
            ['-C', otherRepo, 'rev-parse', '--verify', 'refs/heads/excluded'],
            { encoding: 'utf8' },
          ).trim(),
        ).toMatch(/^[0-9a-f]{40}$/);
        expect(existsSync(checkout())).toBe(false);
      },
    );

    it('CAN-5158 an empty explicit inclusion does not clean unrelated registrations', async () => {
      const one = useMultiRepoWithUnmaterializedMissingSource();
      rmSync(checkout(), { recursive: true });
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [{ ...one, includedRepoIds: [] }],
        }),
      );
      const registrations = (): string =>
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        });
      const before = registrations();
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'multi_repo',
          deleteWithoutRetentionIfMissing: true,
        }),
      ).resolves.toMatchObject({ success: true });
      expect(registrations()).toBe(before);
    });

    it('CAN-5158 Git lookup failure is retryable, not evidence of permanent source loss', async () => {
      const lookup = jest
        .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
        .mockRejectedValue(new Error('Git lookup temporarily unavailable'));
      const request = {
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'single_repo' as const,
      };
      await expect(archiveWorktree(request)).rejects.toMatchObject({
        reason: 'source-unavailable',
      });
      await expectNoJournal();
      expect(existsSync(repo)).toBe(true);
      lookup.mockRestore();
      await expect(archiveWorktree(request)).resolves.toMatchObject({
        success: true,
      });
    });

    it('CAN-5158 unreadable configuration refuses before teardown', async () => {
      writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
          expectedKind: 'single-repo',
          teardownOperation: 'delete',
        }),
      ).rejects.toMatchObject({ reason: 'source-unavailable' });
      expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
      await expectNoJournal();
    });

    /**
     * Leaves the list unreadable, or one row in it unreadable while the others
     * stay intact; returns the list to restore.
     */
    function corruptWorktreeList(
      read: 'unreadable' | 'partial',
      unreadableRowId = 'one',
    ): string {
      const rowsPath = join(root, 'a', 'worktrees.json');
      const original = readFileSync(rowsPath, 'utf8');
      if (read === 'unreadable') writeFileSync(rowsPath, '{truncated');
      else {
        const list = z
          .object({
            worktrees: z.array(z.object({ id: z.string() }).passthrough()),
          })
          .passthrough()
          .parse(JSON.parse(original));
        // A row without createdAt is one this version cannot read.
        writeFileSync(
          rowsPath,
          JSON.stringify({
            ...list,
            worktrees: list.worktrees.map((row) =>
              row.id === unreadableRowId
                ? { id: unreadableRowId, branchName: unreadableRowId }
                : row,
            ),
          }),
        );
      }
      __resetSidebarItemsStateForTests();
      return original;
    }

    it.each(['available', 'missing'] as const)(
      "CAN-5158 a partial worktree list still checks a readable target's source (source %s)",
      async (source) => {
        corruptWorktreeList('partial', 'two');
        const unreadableSibling = (): unknown =>
          z
            .object({
              worktrees: z.array(z.object({ id: z.string() }).passthrough()),
            })
            .parse(
              JSON.parse(
                readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
              ),
            )
            .worktrees.find((row) => row.id === 'two');
        if (source === 'missing') hideSource();
        const request = {
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo' as const,
          teardownOperation: 'delete',
        };

        if (source === 'available') {
          await expect(archiveWorktree(request)).resolves.toMatchObject({
            success: true,
          });
          expect(existsSync(checkout())).toBe(false);
          // The row this version cannot read is kept, not rewritten.
          expect(unreadableSibling()).toEqual({ id: 'two', branchName: 'two' });
          return;
        }
        await expect(archiveWorktree(request)).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'source-unavailable',
          message:
            "Couldn't verify the worktree's source repositories. Check repository access and retry.",
        });
        await expectNoJournal();
        expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
        expect(existsSync(checkout())).toBe(true);
      },
    );

    it.each([
      ['unreadable', 'archive'],
      ['unreadable', 'delete'],
      ['partial', 'archive'],
      ['partial', 'delete'],
    ] as const)(
      'CAN-5158 a worktree list read as %s refuses %s before lifecycle effects, though the source is available',
      async (read, operation) => {
        const original = corruptWorktreeList(read);
        const { cancel } = watcherSpies();
        const cleanup = jest.spyOn(
          worktreeLiveCleanup,
          'cleanupLiveWorktreeState',
        );
        const before = canonicalImages();
        const request = {
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo' as const,
          teardownOperation: 'delete',
          idempotencyKey: `unreadable-list-${operation}`,
        };
        const run = (): Promise<unknown> =>
          operation === 'delete'
            ? deleteWorktree(request)
            : archiveWorktree(request);

        // Before, an unreadable list read as empty, so admission passed.
        await expect(run()).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'source-unavailable',
          message:
            "Couldn't verify the worktree's source repositories. Check repository access and retry.",
        });
        await expectNoJournal();
        expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
        expect(prepareTaskBrowserRetirement).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(cancel).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(existsSync(checkout())).toBe(true);

        // The released key runs once the list is readable again.
        writeFileSync(join(root, 'a', 'worktrees.json'), original);
        __resetSidebarItemsStateForTests();
        await expect(run()).resolves.toMatchObject({ success: true });
        expect(existsSync(checkout())).toBe(false);
      },
    );

    it.each(['single-repo', 'multi-repo'] as const)(
      'CAN-5158 direct %s removal refuses an unreadable worktree list before Auto Delete or automation teardown',
      async (kind) => {
        if (kind === 'multi-repo')
          useMultiRepoWithUnmaterializedMissingSource();
        corruptWorktreeList('unreadable');
        const teardown = jest.fn<Promise<void>, []>();
        const cleanup = jest.fn<Promise<void>, [string, string]>();
        const archive =
          kind === 'single-repo'
            ? archiveSingleRepoWorktree
            : archiveMultiRepoWorktree;
        await expect(
          archive({
            workspaceId: 'a',
            worktreeId: 'one',
            sourceAdmission: 'required',
            retainAsArchivedContainer: false,
            runAutoArchiveTeardown: teardown,
            observabilityMode: 'live-service',
            liveServices: {
              cleanupLiveState: cleanup,
              purgeObservabilityData: jest.fn(),
            },
          }),
        ).rejects.toMatchObject({
          name: 'WorktreeArchiveRefusedError',
          reason: 'source-unavailable',
          message:
            "Couldn't verify the worktree's source repositories. Check repository access and retry.",
        });
        expect(teardown).not.toHaveBeenCalled();
        expect(cleanup).not.toHaveBeenCalled();
        expect(prepareTaskBrowserRetirement).not.toHaveBeenCalled();
        await expectNoJournal();
        expect(existsSync(checkout())).toBe(true);
      },
    );

    it('a multi-repo source with no checkout in a live worktree does not refuse, because its Git capture skips it', async () => {
      useMultiRepoWithUnmaterializedMissingSource();

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('a failing teardown script in a multi-repo child refuses step-free (CAN-4993), and the same request then deletes the project', async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      const error = new Error('Project deletion teardown failed: exit 1');
      jest.mocked(runAutoArchiveTeardown).mockRejectedValueOnce(error);
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'multi-repo-teardown-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toBe(error);

      expect(jest.mocked(runAutoArchiveTeardown)).toHaveBeenCalledWith(
        'a',
        'one',
        true,
        'Project deletion',
      );
      await expectNoJournal();
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
      expect(existsSync(join(checkout(), 'repos', 'present'))).toBe(true);
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('a failed `git worktree remove` in a multi-repo child refuses step-free (CAN-4993), and the same request resumes it and deletes the project', async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      writeFileSync(join(checkout(), 'repos', 'present', 'notes.txt'), 'kept');
      let failed = false;
      mockArchiveIoFault = (request): void => {
        if (failed || request.type !== 'remove-worktree') return;
        failed = true;
        rmSync(join(request.input.worktreePath, 'notes.txt'));
        throw new Error('git worktree remove failed');
      };
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'multi-repo-remove-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'git worktree remove failed',
      );

      expect(await readDestructiveRecovery('a')).toBe(null);
      const journal = await readDestructiveRecovery('a', 'one');
      expect(journal?.steps.at(-1)).toEqual({
        phase: 'git-worktree-removal',
        state: 'pending',
      });
      const staged = await readArchivedGitStagedDescriptor('a', 'one');
      expect(staged).toMatchObject({
        status: 'ready',
        teardown: { phase: 'verified' },
      });
      const snapshot = staged?.repositories.find(
        (repository) => repository.repoId === 'present',
      )?.worktreeSnapshotCommit;
      expect(
        execFileSync('git', ['-C', repo, 'show', `${snapshot}:notes.txt`], {
          encoding: 'utf8',
        }),
      ).toBe('kept');
      expect(existsSync(checkout())).toBe(false);

      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).not.toContain('archive-quarantine');
    });

    it.each([
      ['fails', false],
      ['crashes, leaving its journal active,', true],
    ])(
      'a multi-repo child that %s after its checkout quarantine move resumes on the same request (CAN-5011)',
      async (_label, crashed) => {
        useMultiRepoWithUnmaterializedMissingSource();
        writeFileSync(
          join(checkout(), 'repos', 'present', 'notes.txt'),
          'kept',
        );
        writeFileSync(join(checkout(), 'root-notes.txt'), 'root');
        const quarantine = join(
          root,
          'a',
          'worktrees',
          '.one.archive-quarantine',
        );
        let interrupted = false;
        mockArchiveIoFault = (request): void => {
          if (interrupted || request.type !== 'prepare-teardown') return;
          interrupted = true;
          // The move lands; the archive stops before it records it.
          renameSync(checkout(), quarantine);
          throw new Error('Archive stopped after the move');
        };
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: `multi-repo-moved-quarantine-${String(crashed)}`,
        };

        await expect(deleteWorkspace(request)).rejects.toThrow(
          'Archive stopped after the move',
        );

        expect(await readDestructiveRecovery('a')).toBe(null);
        const failed = await readDestructiveRecovery('a', 'one');
        if (!failed) throw new Error('Expected the failed archive journal');
        expect(failed.steps.at(-1)).toEqual({
          phase: 'checkout-quarantine',
          state: 'pending',
        });
        expect(existsSync(checkout())).toBe(false);
        expect(
          readFileSync(
            join(quarantine, 'repos', 'present', 'notes.txt'),
            'utf8',
          ),
        ).toBe('kept');
        if (crashed)
          writeFileSync(
            journalFileOf('one'),
            JSON.stringify({ ...failed, state: 'active' }),
          );

        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });

        expect(indexIds()).toEqual(['b', 'c']);
        // Only the child's best-effort turn diff cleanup of `gone` is left.
        expect(await readDestructiveRecovery('a')).toMatchObject({
          state: 'completed',
        });
        // The redo verified the moved checkout and removed it through Git.
        const resumed = await readDestructiveRecovery('a', 'one');
        expect(resumed?.state).toBe('completed');
        expect(resumed?.steps).toEqual(
          expect.arrayContaining([
            { phase: 'checkout-quarantine', state: 'done' },
            { phase: 'git-worktree-removal', state: 'done' },
          ]),
        );
        expect(
          execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
            encoding: 'utf8',
          }),
        ).not.toContain(join('a', 'worktrees'));
      },
    );

    it("a sidecar cleanup failure after a multi-repo child's manifest commits resumes on the same request (CAN-5011)", async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
      let failed = false;
      jest
        .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
        .mockImplementation((...args) => {
          if (failed || args[1] !== 'one') return cleanup(...args);
          failed = true;
          return Promise.reject(new Error('Sidecar cleanup failed'));
        });
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'multi-repo-sidecar-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'Sidecar cleanup failed',
      );

      // Before, this journal refused every later deletion of the project.
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        state: 'recovery-required',
        parentOperation: 'workspace-delete',
      });
      expect(
        existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
      ).toBe(true);
      expect(existsSync(checkout())).toBe(false);

      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
      // The redo reused the committed manifest: no second capture or teardown.
      const resumed = await readDestructiveRecovery('a', 'one');
      expect(resumed?.state).toBe('completed');
      expect(resumed?.steps.map((step) => step.phase)).not.toContain(
        'checkout-quarantine',
      );
      expect(
        execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
          encoding: 'utf8',
        }),
      ).not.toContain('archive-quarantine');
    });

    it("a failed `git worktree remove` of a multi-repo child's second repository, after its first was removed, resumes on the same request (CAN-4993)", async () => {
      useMultiRepoWithUnmaterializedMissingSource();
      const secondRepo = join(dir, 'second-repo');
      execFileSync('git', ['init', '-q', '-b', 'main', secondRepo]);
      execFileSync('git', [
        '-C',
        secondRepo,
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '-q',
        '--allow-empty',
        '-m',
        'base',
      ]);
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'multi-repo',
          repos: [
            { id: 'present', name: 'present', repoPath: repo },
            { id: 'second', name: 'second', repoPath: secondRepo },
          ],
        }),
      );
      execFileSync('git', [
        '-C',
        secondRepo,
        'worktree',
        'add',
        '-q',
        '-b',
        'multi',
        join(checkout(), 'repos', 'second'),
      ]);
      writeFileSync(join(checkout(), 'repos', 'second', 'notes.txt'), 'kept');
      __resetSidebarItemsStateForTests();
      const removals: string[] = [];
      mockArchiveIoFault = (request): void => {
        if (request.type !== 'remove-worktree') return;
        removals.push(request.input.worktreePath);
        if (removals.length !== 2) return;
        throw new Error('git worktree remove failed');
      };
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'multi-repo-second-remove-failure',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'git worktree remove failed',
      );

      expect(await readDestructiveRecovery('a')).toBe(null);
      const journal = await readDestructiveRecovery('a', 'one');
      expect(
        journal?.steps.filter((step) => step.phase === 'git-worktree-removal'),
      ).toEqual([
        { phase: 'git-worktree-removal', state: 'done' },
        { phase: 'git-worktree-removal', state: 'pending' },
      ]);
      expect(existsSync(checkout())).toBe(false);

      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
      for (const source of [repo, secondRepo])
        expect(
          execFileSync(
            'git',
            ['-C', source, 'worktree', 'list', '--porcelain'],
            {
              encoding: 'utf8',
            },
          ),
        ).not.toContain('archive-quarantine');
    });

    it('a files-only restore whose checkout has Git again does not refuse for a source it never checked out, as its Git capture skips it', async () => {
      useMultiRepoWithUnmaterializedMissingSource({
        restoredFromFilesOnlyArchiveId: 'files-only-archive',
      });

      // Before admission modeled the archive's Git pointer check, this refused
      // as source-unavailable, blaming `gone`.
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('a files-only restore whose checkout has Git again refuses an unreadable configuration before any effect, as its Git capture finds no repository', async () => {
      useMultiRepoWithUnmaterializedMissingSource({
        restoredFromFilesOnlyArchiveId: 'files-only-archive',
      });
      writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');
      __resetSidebarItemsStateForTests();

      // Before, admission took the files-only path and admitted; the child
      // archive then threw "The worktree has no configured repositories to
      // archive." after its teardown and froze the project.
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      await expectNoJournal();
      expect(existsSync(join(checkout(), 'repos', 'present'))).toBe(true);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it('a later worktree whose archive would refuse its staged capture refuses the deletion before any worktree is archived', async () => {
      const { worktrees } = z
        .object({
          worktrees: z.array(
            z.object({
              id: z.string(),
              branchName: z.string(),
              createdAt: z.string(),
            }),
          ),
        })
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
        );
      const one = worktrees.find((worktree) => worktree.id === 'one');
      if (!one) throw new Error('Expected worktree one');
      // Worktree two holds a ready capture of available repositories, made
      // from one's, whose own capture is then released.
      const capture = await captureArchivedContainerGitState({
        workspaceId: 'a',
        containerId: 'one',
        workspaceType: 'single-repo',
        worktreePath: checkout(),
        persistedWorktree: one,
      });
      const onePath = getArchivedContainerGitStateStagedPath('a', 'one');
      const twoPath = getArchivedContainerGitStateStagedPath('a', 'two');
      mkdirSync(dirname(twoPath), { recursive: true });
      writeFileSync(
        twoPath,
        readFileSync(onePath, 'utf8').replaceAll('/a/one/', '/a/two/'),
      );
      await releaseArchivedGitState(capture.gitState);
      rmSync(onePath);
      const staged = readFileSync(twoPath, 'utf8');
      const { cancel } = watcherSpies();
      const before = canonicalImages();
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'later-staged-capture',
      };

      // Before this admission, worktree one archived, then two's archive
      // refused and left the deletion's journal requiring recovery.
      await expect(deleteWorkspace(request)).rejects.toMatchObject(
        interruptedArchiveRefusal,
      );

      await expectNoJournal();
      expect(cancel).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(existsSync(checkout())).toBe(true);
      expect(readFileSync(twoPath, 'utf8')).toBe(staged);
      // After a manual repair, the released key deletes the project.
      rmSync(twoPath);
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('a ready capture is not refused for a configured source it never captured, only as its archive would refuse it', async () => {
      const one = useMultiRepoWithUnmaterializedMissingSource();
      // An earlier archive attempt captured the worktree's one checkout.
      await captureArchivedContainerGitState({
        workspaceId: 'a',
        containerId: 'one',
        workspaceType: 'multi-repo',
        worktreePath: checkout(),
        persistedWorktree: one,
      });
      expect(await readArchivedGitStagedDescriptor('a', 'one')).toMatchObject({
        status: 'ready',
        repositories: [expect.objectContaining({ repoId: 'present' })],
      });

      // Before admission followed the archive's captured repositories, this
      // refused as source-unavailable, blaming `gone`.
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(interruptedArchiveRefusal);

      await expectNoJournal();
      expect(existsSync(checkout())).toBe(true);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it('residual: a source directory inside another repository passes admission and leaves its worktree needing recovery (characterization)', async () => {
      // Git resolves the enclosing repository, so the source looks available.
      execFileSync('git', ['init', '-q', dir]);
      rmSync(join(repo, '.git'), { recursive: true, force: true });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toThrow(
        'The damaged worktree has no unique Git registration; its files were preserved.',
      );

      // CAN-4993: the deletion journal no longer freezes the whole project.
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        state: 'recovery-required',
      });
    });

    it('a corrupt multi-repo configuration with a live checkout refuses before any effect, as the Git capture finds no repository', async () => {
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          version: 1,
          workspaces: readIndex().map((entry) =>
            entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
          ),
        }),
      );
      writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');
      __resetSidebarItemsStateForTests();

      // Before CAN-4985's capture-path check, the child archive threw "The
      // worktree has no configured repositories to archive." and froze it.
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      await expectNoJournal();
      expect(existsSync(checkout())).toBe(true);
    });

    it('CAN-5158 an intervening archive refusal does not strand project deletion, and both retry when the source returns', async () => {
      hideSource();
      const before = canonicalImages();
      const { cancel } = watcherSpies();

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toMatchObject({
        name: 'WorktreeArchiveRefusedError',
        reason: 'source-unavailable',
      });

      await expectNoJournal();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);
      await expectNoJournal();
      expect(runAutoArchiveTeardown).not.toHaveBeenCalled();
      expect(cancel).not.toHaveBeenCalled();
      expect(canonicalImages()).toEqual(before);
      expect(existsSync(checkout())).toBe(true);
      expect(indexIds()).toEqual(['a', 'b', 'c']);

      restoreSource();
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).resolves.toMatchObject({ success: true });
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('CAN-5337 a source that stays gone: one confirmation lists each blocked worktree, and after their discards the project deletes without touching the source', async () => {
      hideSource();
      const sourceTree = treeImage(movedSource());
      const branches = (): string =>
        execFileSync(
          'git',
          [
            '-C',
            movedSource(),
            'for-each-ref',
            '--format=%(refname) %(objectname)',
          ],
          { encoding: 'utf8' },
        );
      const branchesBefore = branches();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject(sourceRefusal);

      const description = await describeProjectDeletion();

      expect(description).toMatchObject({
        status: 'discardable',
        workspaceId: 'a',
      });
      expect(description.interruptedDeletion).toBeUndefined();
      expect(
        description.items.map((item) => [
          item.worktreeName,
          item.description.worktreeId,
          item.description.causes,
          item.description.targets.map((target) => target.kind),
        ]),
      ).toEqual([
        ['old', 'one', ['source-gone'], ['live-checkout']],
        // No checkout: its files-only archive would leave Git cleanup pending.
        ['second', 'two', ['source-gone'], []],
      ]);
      // The Portal's own deletion points at the discard instead of a retry.
      const { handlePortalWorkspaceDelete, PROJECT_DELETION_DISCARD_POINTER } =
        await import('../../portal/adapters/workspace-adapter');
      const failures: string[] = [];
      await handlePortalWorkspaceDelete(
        {
          id: 'cmd-1',
          sequence: 1,
          type: 'portal.workspace.delete',
          payload: { workspaceId: 'a' },
          createdAt: new Date().toISOString(),
          expiresAt: null,
        },
        {
          getWindow: () => null,
          enqueueEvent: () => undefined,
          complete: () => {
            throw new Error('Expected the Portal deletion to refuse');
          },
          fail: (_command, _code, message) => {
            failures.push(message);
          },
        },
      );
      expect(failures).toEqual([PROJECT_DELETION_DISCARD_POINTER]);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
      await discardListedItems(description);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
      expect(treeImage(movedSource())).toEqual(sourceTree);
      expect(branches()).toBe(branchesBefore);
    });

    it.each(strictListingCases)(
      'CAN-5337 a source that stays gone beside $name offers no discard, since the deletion would still refuse after it',
      async ({ plant, repair }) => {
        hideSource();
        plant();
        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).rejects.toMatchObject(sourceRefusal);

        expect(await describeProjectDeletion()).toEqual({
          version: 1,
          workspaceId: 'a',
          status: 'refused',
          items: [],
        });
        // The ordinary deletion keeps its refusal; the checkout stays.
        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).rejects.toMatchObject(sourceRefusal);
        expect(existsSync(checkout())).toBe(true);

        repair();
        expect((await describeProjectDeletion()).status).toBe('discardable');
      },
    );

    it('CAN-5337 a retained version-3 archive whose staged Git capture is unreadable offers no discard', async () => {
      hideSource();
      const base = archivedManifestFields('a', 'kept');
      const payloadId = '00000000-0000-4000-8000-000000000004';
      const payload = join(
        getArchivedContainerDir('a', 'kept'),
        'recovery-files',
        payloadId,
      );
      mkdirSync(payload, { recursive: true });
      writeFileSync(join(payload, 'kept.txt'), 'retained');
      const digest = await workspaceRootPayloadDigest({ rootPath: payload });
      if (digest === null) throw new Error('Expected a payload digest');
      await commitArchivedContainer({
        ...base,
        version: 3,
        recovery: {
          kind: 'files-only',
          source: 'partial',
          digest,
          payloadId,
          gitCleanupPending: false,
        },
      });
      expect((await describeProjectDeletion()).status).toBe('discardable');
      const staged = getArchivedContainerGitStateStagedPath('a', 'kept');
      writeFileSync(staged, '{truncated');

      expect((await describeProjectDeletion()).status).toBe('refused');
      rmSync(staged);
      expect((await describeProjectDeletion()).status).toBe('discardable');
    });

    it('CAN-5338 a source that stays gone with a retained archive: the opted-in confirmation lists the archive beside the worktrees, and after their discards the project deletes', async () => {
      await plantPendingVersion3Archive(repo);
      hideSource();
      const sourceTree = treeImage(movedSource());
      const branches = (): string =>
        execFileSync(
          'git',
          [
            '-C',
            movedSource(),
            'for-each-ref',
            '--format=%(refname) %(objectname)',
          ],
          { encoding: 'utf8' },
        );
      const branchesBefore = branches();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({ reason: 'git-cleanup-pending' });
      // Older clients send no opt-in and get E's answer.
      expect(await describeProjectDeletion()).toEqual({
        version: 1,
        workspaceId: 'a',
        status: 'refused',
        items: [],
      });

      const description = await describeProjectDeletion('a', {
        retainedArchives: true,
      });

      expect(description.status).toBe('discardable');
      expect(
        description.items.map((item) => [
          item.worktreeName,
          item.description.worktreeId,
          item.description.causes,
          item.description.targets.map((target) => target.kind),
        ]),
      ).toEqual([
        ['old', 'one', ['source-gone'], ['live-checkout']],
        ['second', 'two', ['source-gone'], []],
        ['Archived worktree', 'pending', ['source-gone'], ['retained-archive']],
      ]);
      await discardListedItems(description);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
      expect(treeImage(movedSource())).toEqual(sourceTree);
      expect(branches()).toBe(branchesBefore);
    });

    it('CAN-5338 a retained archive beside another archive whose staged Git capture is unreadable offers no discard', async () => {
      await plantPendingVersion3Archive(repo);
      hideSource();
      const payloadId = '00000000-0000-4000-8000-000000000004';
      const payload = join(
        getArchivedContainerDir('a', 'kept'),
        'recovery-files',
        payloadId,
      );
      mkdirSync(payload, { recursive: true });
      writeFileSync(join(payload, 'kept.txt'), 'retained');
      const digest = await workspaceRootPayloadDigest({ rootPath: payload });
      if (digest === null) throw new Error('Expected a payload digest');
      await commitArchivedContainer({
        ...archivedManifestFields('a', 'kept'),
        version: 3,
        recovery: {
          kind: 'files-only',
          source: 'partial',
          digest,
          payloadId,
          gitCleanupPending: false,
        },
      });
      const retained = { retainedArchives: true };
      expect((await describeProjectDeletion('a', retained)).status).toBe(
        'discardable',
      );
      const staged = getArchivedContainerGitStateStagedPath('a', 'kept');
      writeFileSync(staged, '{truncated');

      expect((await describeProjectDeletion('a', retained)).status).toBe(
        'refused',
      );
      rmSync(staged);
      expect((await describeProjectDeletion('a', retained)).status).toBe(
        'discardable',
      );
    });

    it('CAN-5337 a source that comes back lists nothing to discard, so the ordinary deletion stands', async () => {
      hideSource();
      restoreSource();
      expect(await describeProjectDeletion()).toEqual({
        version: 1,
        workspaceId: 'a',
        status: 'refused',
        items: [],
      });
    });
  });

  describe('a child archive failure (CAN-4993)', () => {
    const teardownError = (): Error =>
      new Error('Project deletion teardown failed: exit 1');
    function worktreeIds(): string[] {
      return z
        .object({ worktrees: z.array(z.object({ id: z.string() })) })
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
        )
        .worktrees.map((worktree) => worktree.id);
    }

    it.each([
      ['the first worktree', 0],
      ['a later worktree, after an earlier one archived', 1],
    ])(
      'a failing teardown script in %s refuses step-free, and the same request then deletes the project',
      async (_label, failingCall) => {
        const error = teardownError();
        const teardown = jest.mocked(runAutoArchiveTeardown);
        if (failingCall === 1) teardown.mockResolvedValueOnce(undefined);
        teardown.mockRejectedValueOnce(error);
        const { release } = watcherSpies();
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: `teardown-failure-${failingCall}`,
        };

        // Before, the deletion journal and the failed archive's journal
        // required recovery and refused every deletion, archive and delete in
        // the project, though the script would pass on a retry.
        await expect(deleteWorkspace(request)).rejects.toBe(error);

        expect(await readDestructiveRecovery('a')).toBe(null);
        const failed = failingCall === 0 ? 'one' : 'two';
        expect(await readDestructiveRecovery('a', failed)).toBe(null);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(await reportDestructiveRecovery()).toEqual([]);
        expect(logMainProcessWarn).not.toHaveBeenCalledWith(
          'W5 destructive lifecycle requires manual recovery',
          expect.anything(),
        );
        expect(release).toHaveBeenCalledWith('a');
        expect(decisions).not.toHaveBeenCalled();
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        if (failingCall === 1) {
          // The earlier worktree stays archived and restorable.
          expect(worktreeIds()).toEqual(['two']);
          expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
            state: 'completed',
          });
          expect(
            existsSync(
              join(getArchivedContainerDir('a', 'one'), 'container.json'),
            ),
          ).toBe(true);
        } else {
          expect(worktreeIds()).toEqual(['one', 'two']);
          expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
        }

        // The released key runs once the script passes.
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it('a failing teardown script leaves the other worktrees archivable before any retry', async () => {
      jest
        .mocked(runAutoArchiveTeardown)
        .mockRejectedValueOnce(teardownError());

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toThrow('Project deletion teardown failed: exit 1');

      await archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        source: 'single_repo',
      });
      await archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'single_repo',
      });
      expect(worktreeIds()).toEqual([]);
      expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
    });

    describe('after its own effects, a retry resumes the failed archive', () => {
      const checkoutOf = (worktreeId: string): string =>
        join(root, 'a', 'worktrees', worktreeId);
      const quarantineOf = (worktreeId: string): string =>
        join(root, 'a', 'worktrees', `.${worktreeId}.archive-quarantine`);
      const unavailableSource = (): string => `${repo}-unavailable`;
      const NOTES = 'kept in the archived snapshot';

      /** Worktree two gets a checkout, with a file only its snapshot keeps. */
      function addSecondCheckout(): void {
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '-q',
          '-b',
          'second',
          checkoutOf('two'),
        ]);
        writeFileSync(join(checkoutOf('two'), 'notes.txt'), NOTES);
      }

      async function expectRestorableArchive(
        worktreeId: string,
      ): Promise<void> {
        expect(await readDestructiveRecovery('a', worktreeId)).toMatchObject({
          state: 'completed',
        });
        const manifest = (await listArchivedContainerManifests('a')).find(
          (candidate) => candidate.id === worktreeId,
        );
        if (manifest?.version !== 2)
          throw new Error(`Expected a Git archive of ${worktreeId}`);
        await assertArchivedGitStateRestorable(manifest);
      }

      /** Fails worktree two's archive once; returns the expected message. */
      const triggers: {
        name: string;
        phase: string;
        arm: () => string;
        clear?: () => void;
        checkoutMoved?: true;
        /** The quarantine is gone too; the pinned snapshot keeps the files. */
        quarantineRemoved?: true;
      }[] = [
        {
          name: 'a live-state teardown failure (CAN-5011)',
          phase: 'live-state-teardown',
          arm: (): string => {
            const actual = worktreeLiveCleanup.cleanupLiveWorktreeState;
            let failed = false;
            jest
              .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
              .mockImplementation((workspaceId, worktreeId, onDestroyed) => {
                if (failed || worktreeId !== 'two')
                  return actual(workspaceId, worktreeId, onDestroyed);
                failed = true;
                return Promise.reject(new Error('Live-state teardown failed'));
              });
            return 'Live-state teardown failed';
          },
        },
        {
          name: 'a failed quarantine removal (CAN-5011)',
          phase: 'quarantine-directory-removal',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.type !== 'remove-directory' ||
                request.containerId !== 'two' ||
                request.input.path !== quarantineOf('two')
              )
                return;
              failed = true;
              throw new Error('Quarantine removal failed');
            };
            return 'Quarantine removal failed';
          },
          checkoutMoved: true,
          // `git worktree remove` already removed it; this step clears residue.
          quarantineRemoved: true,
        },
        {
          name: 'a failure after the branch is deleted (CAN-5011)',
          phase: 'branch-deletion',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.type !== 'delete-branches' ||
                request.containerId !== 'two'
              )
                return;
              failed = true;
              execFileSync('git', ['-C', repo, 'branch', '-D', 'second']);
              throw new Error('Branch deletion failed');
            };
            return 'Branch deletion failed';
          },
          checkoutMoved: true,
          quarantineRemoved: true,
        },
        {
          name: 'a failed checkout quarantine move (CAN-5011)',
          phase: 'checkout-quarantine',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.type !== 'prepare-teardown' ||
                request.containerId !== 'two'
              )
                return;
              failed = true;
              throw new Error('Quarantine move failed');
            };
            return 'Quarantine move failed';
          },
        },
        {
          name: 'a Git capture failure',
          phase: 'git-capture',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.type !== 'complete-git-capture' ||
                request.containerId !== 'two'
              )
                return;
              failed = true;
              throw new Error('Git capture failed');
            };
            return 'Git capture failed';
          },
        },
        {
          name: 'a payload capture failure',
          phase: 'retained-payload-capture',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.operationId !== 'archive:a:two:copy-managed-payload'
              )
                return;
              failed = true;
              throw new Error('Payload capture failed');
            };
            return 'Payload capture failed';
          },
        },
        {
          name: 'a provider capture failure',
          phase: 'provider-capture',
          arm: (): string => {
            const actual = providerState.captureArchivedContainerProviderState;
            let failed = false;
            jest
              .spyOn(providerState, 'captureArchivedContainerProviderState')
              .mockImplementation((args): ReturnType<typeof actual> => {
                if (failed || args.containerId !== 'two') return actual(args);
                failed = true;
                return Promise.reject(new Error('Provider capture failed'));
              });
            return 'Provider capture failed';
          },
        },
        {
          name: 'a source that disappears after admission and returns',
          phase: 'git-capture',
          arm: (): string => {
            let hidden = false;
            mockArchiveIoFault = (request): void => {
              if (
                hidden ||
                request.type !== 'capture-git' ||
                request.containerId !== 'two'
              )
                return;
              hidden = true;
              renameSync(repo, unavailableSource());
            };
            return 'ENOENT';
          },
          clear: (): void => {
            renameSync(unavailableSource(), repo);
          },
        },
        {
          name: 'a failed `git worktree remove` that removed part of the checkout',
          phase: 'git-worktree-removal',
          arm: (): string => {
            let failed = false;
            mockArchiveIoFault = (request): void => {
              if (
                failed ||
                request.type !== 'remove-worktree' ||
                request.containerId !== 'two'
              )
                return;
              failed = true;
              rmSync(join(request.input.worktreePath, 'notes.txt'));
              throw new Error('git worktree remove failed');
            };
            return 'git worktree remove failed';
          },
          checkoutMoved: true,
        },
      ];

      it.each(triggers)(
        '$name in a later worktree: the earlier archive stays restorable, and the same request then deletes the project',
        async ({ phase, arm, clear, checkoutMoved, quarantineRemoved }) => {
          addSecondCheckout();
          const message = arm();
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: `child-failure-${phase}`,
          };

          await expect(deleteWorkspace(request)).rejects.toThrow(message);

          // Before, the failed archive's recovery-required journal refused
          // this retry, and every later one, until edited by hand.
          expect(await readDestructiveRecovery('a')).toBe(null);
          const failed = await readDestructiveRecovery('a', 'two');
          expect(failed).toMatchObject({
            state: 'recovery-required',
            parentOperation: 'workspace-delete',
          });
          expect(failed?.steps.at(-1)).toEqual({ phase, state: 'pending' });
          // The cause clears; the earlier archive's refs live in the source.
          clear?.();
          await expectRestorableArchive('one');
          expect(worktreeIds()).toEqual(['two']);
          if (checkoutMoved) {
            // The verified quarantine and the pinned snapshot keep the files.
            expect(existsSync(checkoutOf('two'))).toBe(false);
            expect(existsSync(quarantineOf('two'))).toBe(!quarantineRemoved);
            const staged = await readArchivedGitStagedDescriptor('a', 'two');
            expect(staged).toMatchObject({
              status: 'ready',
              teardown: { phase: 'verified' },
            });
            const snapshot = staged?.repositories[0]?.worktreeSnapshotCommit;
            expect(
              execFileSync(
                'git',
                ['-C', repo, 'show', `${snapshot}:notes.txt`],
                { encoding: 'utf8' },
              ),
            ).toBe(NOTES);
          } else {
            expect(
              readFileSync(join(checkoutOf('two'), 'notes.txt'), 'utf8'),
            ).toBe(NOTES);
          }
          // A standalone archive still refuses it (CAN-4995 scope).
          await expect(
            archiveWorktree({
              workspaceId: 'a',
              worktreeId: 'two',
              source: 'single_repo',
            }),
          ).rejects.toMatchObject({ reason: 'recovery-required' });

          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'code',
          });
          // The scripts rerun; the script runner skips a teardown script whose
          // checkout has left.
          expect(
            jest
              .mocked(runAutoArchiveTeardown)
              .mock.calls.filter(([, worktreeId]) => worktreeId === 'two'),
          ).toHaveLength(2);
          expect(logMainProcessWarn).toHaveBeenCalledWith(
            'W5 destructive lifecycle resumes a failed archive',
            expect.objectContaining({
              operationId: failed?.operationId,
              worktreeId: 'two',
            }),
          );
          expect(indexIds()).toEqual(['b', 'c']);
          expect(existsSync(join(root, 'a'))).toBe(false);
          expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        },
      );

      it('a checkout replaced since the failure is never resumed or removed', async () => {
        let failed = false;
        mockArchiveIoFault = (request): void => {
          if (failed || request.type !== 'complete-git-capture') return;
          failed = true;
          throw new Error('Git capture failed');
        };
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: 'replaced-checkout',
        };
        await expect(deleteWorkspace(request)).rejects.toThrow(
          'Git capture failed',
        );
        const journal = await readDestructiveRecovery('a', 'one');
        renameSync(checkoutOf('one'), `${checkoutOf('one')}-moved`);
        mkdirSync(checkoutOf('one'));
        writeFileSync(join(checkoutOf('one'), 'later.txt'), 'later occupant');

        await expect(deleteWorkspace(request)).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: journal?.operationId },
        });

        // Refused step-free: the key is released and nothing else changed.
        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(await readDestructiveRecovery('a', 'one')).toEqual(journal);
        expect(readFileSync(join(checkoutOf('one'), 'later.txt'), 'utf8')).toBe(
          'later occupant',
        );
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        // The released key meets the same journal again.
        await expect(deleteWorkspace(request)).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: journal?.operationId },
        });
      });

      it('a failed child archive whose row left the list refuses step-free and keeps its checkout', async () => {
        addSecondCheckout();
        mockArchiveIoFault = (request): void => {
          if (
            request.type === 'complete-git-capture' &&
            request.containerId === 'two'
          )
            throw new Error('Git capture failed');
        };
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: 'failed-child-row-gone',
        };
        await expect(deleteWorkspace(request)).rejects.toThrow(
          'Git capture failed',
        );
        mockArchiveIoFault = undefined;
        const journal = await readDestructiveRecovery('a', 'two');
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          JSON.stringify({ version: 1, worktrees: [] }),
        );
        __resetSidebarItemsStateForTests();

        for (let attempt = 0; attempt < 2; attempt++)
          await expect(deleteWorkspace(request)).rejects.toMatchObject({
            reason: 'recovery-required',
            details: { operationId: journal?.operationId },
          });

        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(await readDestructiveRecovery('a', 'two')).toEqual(journal);
        expect(readFileSync(join(checkoutOf('two'), 'notes.txt'), 'utf8')).toBe(
          NOTES,
        );
        await expectRestorableArchive('one');
        expect(indexIds()).toEqual(['a', 'b', 'c']);
      });

      it('a user deletion that archives no worktree refuses a failed child archive it cannot resume, and releases its key', async () => {
        mockArchiveIoFault = (request): void => {
          if (request.type === 'complete-git-capture')
            throw new Error('Git capture failed');
        };
        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).rejects.toThrow('Git capture failed');
        mockArchiveIoFault = undefined;
        const journal = await readDestructiveRecovery('a', 'one');
        expect(journal).toMatchObject({ parentOperation: 'workspace-delete' });
        convertToCowork('a');
        const request = chatProjectRequest('a', 'cowork-with-failed-child');

        await expect(deleteWorkspace(request)).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: journal?.operationId },
        });

        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        // A manual repair, then the released key runs.
        for (const name of readdirSync(getW5DestructiveLifecycleDir())) {
          const path = join(getW5DestructiveLifecycleDir(), name);
          if (readFileSync(path, 'utf8').includes(String(journal?.operationId)))
            rmSync(path);
        }
        rmSync(getArchivedContainerDir('a', 'one'), { recursive: true });
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'cowork',
        });
      });

      it('a resumed archive that fails again resumes on the next retry', async () => {
        addSecondCheckout();
        const failures: string[] = [];
        mockArchiveIoFault = (request): void => {
          if (request.containerId !== 'two') return;
          if (request.type === 'remove-worktree' && failures.length === 0) {
            failures.push(request.type);
            rmSync(join(request.input.worktreePath, 'notes.txt'));
            throw new Error('git worktree remove failed');
          }
          if (
            request.operationId === 'archive:a:two:copy-managed-payload' &&
            failures.length === 1
          ) {
            failures.push(request.type);
            throw new Error('Payload capture failed');
          }
        };
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: 'repeated-child-failure',
        };

        await expect(deleteWorkspace(request)).rejects.toThrow(
          'git worktree remove failed',
        );
        // The resumed archive fails before its checkout quarantine step.
        await expect(deleteWorkspace(request)).rejects.toThrow(
          'Payload capture failed',
        );

        expect(await readDestructiveRecovery('a')).toBe(null);
        const failed = await readDestructiveRecovery('a', 'two');
        expect(failed).toMatchObject({
          state: 'recovery-required',
          parentOperation: 'workspace-delete',
        });
        expect(failed?.steps.at(-1)).toEqual({
          phase: 'retained-payload-capture',
          state: 'pending',
        });
        expect(existsSync(checkoutOf('two'))).toBe(false);
        expect(existsSync(quarantineOf('two'))).toBe(true);
        const staged = await readArchivedGitStagedDescriptor('a', 'two');
        const snapshot = staged?.repositories[0]?.worktreeSnapshotCommit;
        expect(
          execFileSync('git', ['-C', repo, 'show', `${snapshot}:notes.txt`], {
            encoding: 'utf8',
          }),
        ).toBe(NOTES);
        await expectRestorableArchive('one');

        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(
          execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
            encoding: 'utf8',
          }),
        ).not.toContain('archive-quarantine');
      });

      describe('in its checkout quarantine move (CAN-5011)', () => {
        it.each([
          ['fails', false],
          ['crashes, leaving its journal active,', true],
        ])(
          'an archive that %s after the rename is resumed by the next deletion',
          async (_label, crashed) => {
            addSecondCheckout();
            let interrupted = false;
            mockArchiveIoFault = (request): void => {
              if (
                interrupted ||
                request.type !== 'prepare-teardown' ||
                request.containerId !== 'two'
              )
                return;
              interrupted = true;
              // The move lands; the archive stops before it records it.
              renameSync(checkoutOf('two'), quarantineOf('two'));
              throw new Error('Archive stopped after the move');
            };
            const request = {
              workspaceId: 'a',
              source: 'portal' as const,
              idempotencyKey: `moved-quarantine-${String(crashed)}`,
            };
            await expect(deleteWorkspace(request)).rejects.toThrow(
              'Archive stopped after the move',
            );
            const failed = await readDestructiveRecovery('a', 'two');
            if (!failed) throw new Error('Expected the failed archive journal');
            expect(failed.steps.at(-1)).toEqual({
              phase: 'checkout-quarantine',
              state: 'pending',
            });
            expect(
              await readArchivedGitStagedDescriptor('a', 'two'),
            ).toMatchObject({ teardown: { phase: 'quarantine-pending' } });
            expect(existsSync(checkoutOf('two'))).toBe(false);
            expect(
              readFileSync(join(quarantineOf('two'), 'notes.txt'), 'utf8'),
            ).toBe(NOTES);
            if (crashed)
              writeFileSync(
                journalFileOf('two'),
                JSON.stringify({ ...failed, state: 'active' }),
              );

            // Before, its journal refused this deletion and every later one.
            await expect(deleteWorkspace(request)).resolves.toMatchObject({
              removed: 'code',
            });

            expect(logMainProcessWarn).toHaveBeenCalledWith(
              'W5 destructive lifecycle resumes a failed archive',
              expect.objectContaining({ operationId: failed.operationId }),
            );
            expect(indexIds()).toEqual(['b', 'c']);
            expect(existsSync(join(root, 'a'))).toBe(false);
            expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
            expect(
              execFileSync(
                'git',
                ['-C', repo, 'worktree', 'list', '--porcelain'],
                { encoding: 'utf8' },
              ),
            ).not.toContain(join('a', 'worktrees'));
          },
        );

        it('a checkout edited after a move that failed before the rename is captured again by the retry', async () => {
          addSecondCheckout();
          let failed = false;
          mockArchiveIoFault = (request): void => {
            if (
              failed ||
              request.type !== 'prepare-teardown' ||
              request.containerId !== 'two'
            )
              return;
            failed = true;
            throw new Error('Quarantine move failed');
          };
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: 'edited-after-failed-move',
          };
          await expect(deleteWorkspace(request)).rejects.toThrow(
            'Quarantine move failed',
          );
          const EDITED = 'edited before the retry';
          writeFileSync(join(checkoutOf('two'), 'notes.txt'), EDITED);

          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'code',
          });

          expect(indexIds()).toEqual(['b', 'c']);
          expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        });

        it('a checkout that changed during the move refuses each retry step-free and keeps its files', async () => {
          addSecondCheckout();
          const CHANGED = 'changed during the move';
          mockArchiveIoFault = (request): void => {
            if (
              request.type === 'prepare-teardown' &&
              request.containerId === 'two'
            )
              writeFileSync(join(checkoutOf('two'), 'notes.txt'), CHANGED);
          };
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: 'changed-during-move',
          };
          const refusal =
            'Archive quarantine requires manual recovery; preserve both paths.';
          await expect(deleteWorkspace(request)).rejects.toThrow(refusal);
          mockArchiveIoFault = undefined;

          // The redo verifies the moved checkout again and refuses the same
          // way, moving nothing back; CAN-5337 discards it below.
          await expect(deleteWorkspace(request)).rejects.toThrow(refusal);

          expect(await readDestructiveRecovery('a')).toBe(null);
          expect(
            (await readDestructiveRecovery('a', 'two'))?.steps.at(-1),
          ).toEqual({ phase: 'checkout-quarantine', state: 'pending' });
          expect(existsSync(checkoutOf('two'))).toBe(false);
          expect(
            readFileSync(join(quarantineOf('two'), 'notes.txt'), 'utf8'),
          ).toBe(CHANGED);
          await expectRestorableArchive('one');
          expect(indexIds()).toEqual(['a', 'b', 'c']);

          // CAN-5337: the project-level confirmation lists only worktree two.
          const description = await describeProjectDeletion();
          expect(
            description.items.map((item) => [
              item.description.worktreeId,
              item.description.targets.map((target) => target.kind).sort(),
            ]),
          ).toEqual([['two', ['files-only-recovery', 'git-quarantine']]]);
          expect(description.status).toBe('discardable');
          await discardListedItems(description);
          await expect(
            deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
          ).resolves.toMatchObject({ removed: 'code' });
          expect(indexIds()).toEqual(['b', 'c']);
          expect(existsSync(quarantineOf('two'))).toBe(false);
          expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        });

        it('a checkout path recreated after the move refuses each retry step-free and keeps both', async () => {
          addSecondCheckout();
          let interrupted = false;
          mockArchiveIoFault = (request): void => {
            if (
              interrupted ||
              request.type !== 'prepare-teardown' ||
              request.containerId !== 'two'
            )
              return;
            interrupted = true;
            renameSync(checkoutOf('two'), quarantineOf('two'));
            throw new Error('Archive stopped after the move');
          };
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: 'recreated-after-move',
          };
          await expect(deleteWorkspace(request)).rejects.toThrow(
            'Archive stopped after the move',
          );
          // A tool still writing to the old path recreates it.
          mkdirSync(checkoutOf('two'));
          writeFileSync(join(checkoutOf('two'), 'later.txt'), 'later');

          // The new occupant fails the redo's identity check; like a checkout
          // changed during the move, CAN-5337 discards it below.
          await expect(deleteWorkspace(request)).rejects.toMatchObject({
            reason: 'recovery-required',
          });

          expect(await readDestructiveRecovery('a')).toBe(null);
          expect(
            readFileSync(join(checkoutOf('two'), 'later.txt'), 'utf8'),
          ).toBe('later');
          expect(
            readFileSync(join(quarantineOf('two'), 'notes.txt'), 'utf8'),
          ).toBe(NOTES);
          await expectRestorableArchive('one');
          expect(indexIds()).toEqual(['a', 'b', 'c']);

          // CAN-5337: both paths are listed under the one blocked worktree.
          const description = await describeProjectDeletion();
          expect(
            description.items.map((item) => [
              item.description.worktreeId,
              item.description.targets.map((target) => target.kind).sort(),
            ]),
          ).toEqual([
            [
              'two',
              [
                'files-only-recovery',
                'git-quarantine',
                'recreated-checkout-path',
              ],
            ],
          ]);
          await discardListedItems(description);
          await expect(
            deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
          ).resolves.toMatchObject({ removed: 'code' });
          expect(indexIds()).toEqual(['b', 'c']);
        });
      });

      describe('in its pipeline cleanup or after its retained manifest commits (CAN-5011)', () => {
        /** Fails worktree two's call of `name` once with `message`. */
        function failOnceForTwo<
          M extends object,
          K extends jest.FunctionPropertyNames<Required<M>> &
            {
              [P in keyof M]: M[P] extends (
                ...args: never[]
              ) => Promise<unknown>
                ? P
                : never;
            }[keyof M],
        >(
          module: M,
          name: K,
          message: string,
          isTwo: (args: unknown[]) => boolean,
        ): string {
          const actual = module[name];
          if (typeof actual !== 'function') throw new Error('Not a function');
          let failed = false;
          const spy = jest.spyOn(module, name) as jest.SpyInstance<
            Promise<unknown>,
            unknown[]
          >;
          spy.mockImplementation((...args: unknown[]): Promise<unknown> => {
            if (failed || !isTwo(args))
              return Reflect.apply(actual, module, args) as Promise<unknown>;
            failed = true;
            return Promise.reject(new Error(message));
          });
          return message;
        }
        const secondArgIsTwo = (args: unknown[]): boolean => args[1] === 'two';
        const triggers: {
          name: string;
          arm: () => string;
          /** The retained manifest committed before the failure. */
          committed?: true;
          /** The worktree row left the list before the failure. */
          rowRemoved?: true;
        }[] = [
          {
            name: 'a pipeline cleanup failure',
            arm: () =>
              failOnceForTwo(
                worktreePipelineCleanup,
                'cleanupWorktreePipelines',
                'Pipeline cleanup failed',
                secondArgIsTwo,
              ),
          },
          {
            name: 'a pipeline artifact relocation failure',
            arm: (): string => {
              const actual = worktreePipelineCleanup.cleanupWorktreePipelines;
              let failed = false;
              jest
                .spyOn(worktreePipelineCleanup, 'cleanupWorktreePipelines')
                .mockImplementation((...args) => {
                  if (failed || args[1] !== 'two') return actual(...args);
                  failed = true;
                  return Promise.resolve({
                    warnings: [],
                    relocatedCount: 0,
                    failedRelocationIds: ['execution-1'],
                  });
                });
              return 'Failed to archive workflow execution artifacts: execution-1';
            },
          },
          {
            name: 'a retained manifest commit failure',
            arm: () =>
              failOnceForTwo(
                archivedContainers,
                'commitArchivedContainer',
                'Manifest commit failed',
                ([manifest]) =>
                  typeof manifest === 'object' &&
                  manifest !== null &&
                  Reflect.get(manifest, 'id') === 'two',
              ),
          },
          {
            name: 'a Git capture completion failure',
            arm: () =>
              failOnceForTwo(
                archivedContainerGit,
                'completeArchivedContainerGitCapture',
                'Git capture completion failed',
                secondArgIsTwo,
              ),
            committed: true,
          },
          {
            name: 'a sidecar cleanup failure',
            arm: () =>
              failOnceForTwo(
                worktreeDataCleanup,
                'cleanupPersistedWorktreeData',
                'Sidecar cleanup failed',
                secondArgIsTwo,
              ),
            committed: true,
          },
          {
            name: 'a compatibility symlink cleanup failure',
            arm: () =>
              failOnceForTwo(
                adhocMultiRepoWorkspaces,
                'cleanupCompatibilitySymlinks',
                'Symlink cleanup failed',
                ([worktree]) =>
                  typeof worktree === 'object' &&
                  worktree !== null &&
                  Reflect.get(worktree, 'id') === 'two',
              ),
            committed: true,
          },
          {
            name: 'a row removal failure',
            arm: () =>
              failOnceForTwo(
                worktreeCreationDecisions,
                'applyReservedWorktreeRemoval',
                'Row removal failed',
                ([target]) =>
                  typeof target === 'object' &&
                  target !== null &&
                  Reflect.get(target, 'worktreeId') === 'two',
              ),
            committed: true,
          },
          {
            name: 'a watcher commit failure after the row is removed',
            arm: (): string => {
              const watcher = getAppAdvisorWatcherService();
              let failed = false;
              jest
                .spyOn(watcher, 'commitLocalScopeCancellation')
                .mockImplementation((_projectId, worktreeId) => {
                  if (failed || worktreeId !== 'two') return Promise.resolve();
                  failed = true;
                  return Promise.reject(new Error('Watcher commit failed'));
                });
              jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
              return 'Watcher commit failed';
            },
            committed: true,
            rowRemoved: true,
          },
        ];

        it.each(triggers)(
          '$name in a later worktree leaves the project usable, and the same request then deletes it',
          async ({ name, arm, committed, rowRemoved }) => {
            addSecondCheckout();
            const message = arm();
            const request = {
              workspaceId: 'a',
              source: 'portal' as const,
              idempotencyKey: `late-child-failure-${name}`,
            };

            await expect(deleteWorkspace(request)).rejects.toThrow(message);

            // Before, the failed archive's journal refused this retry, and
            // every later deletion of the project, until edited by hand.
            expect(await readDestructiveRecovery('a')).toBe(null);
            expect(await readDestructiveRecovery('a', 'two')).toMatchObject({
              state: 'recovery-required',
              parentOperation: 'workspace-delete',
            });
            await expectRestorableArchive('one');
            expect(worktreeIds()).toEqual(rowRemoved ? [] : ['two']);
            expect(
              existsSync(
                join(getArchivedContainerDir('a', 'two'), 'container.json'),
              ),
            ).toBe(committed === true);
            expect(existsSync(checkoutOf('two'))).toBe(false);

            await expect(deleteWorkspace(request)).resolves.toMatchObject({
              removed: 'code',
            });
            expect(indexIds()).toEqual(['b', 'c']);
            expect(existsSync(join(root, 'a'))).toBe(false);
            expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
            expect(
              execFileSync(
                'git',
                ['-C', repo, 'worktree', 'list', '--porcelain'],
                { encoding: 'utf8' },
              ),
            ).not.toContain(join('a', 'worktrees'));
          },
        );

        it('a crash during the turn diff cleanup, after the pipeline cleanup, still lets the next deletion resume it', async () => {
          addSecondCheckout();
          const message = failOnceForTwo(
            worktreePipelineCleanup,
            'cleanupWorktreePipelines',
            'Pipeline cleanup failed',
            secondArgIsTwo,
          );
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: 'crash-in-turn-diff-cleanup',
          };
          await expect(deleteWorkspace(request)).rejects.toThrow(message);
          const failed = await readDestructiveRecovery('a', 'two');
          if (!failed) throw new Error('Expected a failed child journal');
          expect(failed.steps.slice(-2)).toEqual([
            { phase: 'pipeline-cleanup', state: 'pending' },
            { phase: 'turn-diff-cleanup', state: 'done' },
          ]);
          // The journal as a crash in the turn diff cleanup leaves it, once
          // the concurrent pipeline cleanup is done.
          writeFileSync(
            journalFileOf('two'),
            JSON.stringify({
              ...failed,
              state: 'active',
              steps: [
                ...failed.steps.slice(0, -2),
                { phase: 'pipeline-cleanup', state: 'done' },
                { phase: 'turn-diff-cleanup', state: 'pending' },
              ],
            }),
          );

          // Before, the active journal refused this retry recovery-required.
          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'code',
          });
          expect(logMainProcessWarn).toHaveBeenCalledWith(
            'W5 destructive lifecycle resumes a failed archive',
            expect.objectContaining({ operationId: failed.operationId }),
          );
          expect(indexIds()).toEqual(['b', 'c']);
          expect(existsSync(join(root, 'a'))).toBe(false);
          expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        });

        it.each([
          ['', false],
          [', with its source repository gone', true],
        ])(
          'a committed archive whose retention lapsed before the retry still resumes%s',
          async (_label, sourceGone) => {
            addSecondCheckout();
            const message = failOnceForTwo(
              worktreeDataCleanup,
              'cleanupPersistedWorktreeData',
              'Sidecar cleanup failed',
              secondArgIsTwo,
            );
            const request = {
              workspaceId: 'a',
              source: 'portal' as const,
              idempotencyKey: `expired-committed-child-${String(sourceGone)}`,
            };
            await expect(deleteWorkspace(request)).rejects.toThrow(message);
            const manifestPath = join(
              getArchivedContainerDir('a', 'two'),
              'container.json',
            );
            writeFileSync(
              manifestPath,
              JSON.stringify({
                ...z
                  .record(z.string(), z.unknown())
                  .parse(JSON.parse(readFileSync(manifestPath, 'utf8'))),
                expiresAt: '2000-01-01T00:00:00.000Z',
              }),
            );
            if (sourceGone) renameSync(repo, unavailableSource());

            // Before, the redo no longer found the expired manifest and failed
            // every retry; with the source gone, admission refused first.
            await expect(deleteWorkspace(request)).resolves.toMatchObject({
              removed: 'code',
            });

            expect(indexIds()).toEqual(['b', 'c']);
            expect(existsSync(join(root, 'a'))).toBe(false);
            expect(await readDestructiveRecovery('a', 'two')).toMatchObject({
              state: 'completed',
            });
            // Without the source, releasing the archived refs after the
            // deletion fails and is recorded as cleanup.
            expect(await hasUnresolvedDestructiveRecovery('a')).toBe(
              sourceGone,
            );
          },
        );

        it('a committed archive resumes without its source repository, which its redo never opens', async () => {
          addSecondCheckout();
          const message = failOnceForTwo(
            worktreeDataCleanup,
            'cleanupPersistedWorktreeData',
            'Sidecar cleanup failed',
            secondArgIsTwo,
          );
          const request = {
            workspaceId: 'a',
            source: 'portal' as const,
            idempotencyKey: 'committed-child-without-source',
          };
          await expect(deleteWorkspace(request)).rejects.toThrow(message);
          renameSync(repo, unavailableSource());

          // Before, admission asked its source repository for a Git capture
          // the redo skips, and refused source-unavailable (CAN-4985).
          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'code',
          });

          expect(indexIds()).toEqual(['b', 'c']);
          expect(existsSync(join(root, 'a'))).toBe(false);
          expect(await readDestructiveRecovery('a', 'two')).toMatchObject({
            state: 'completed',
          });
        });
      });

      describe('the files-only recovery path (CAN-5011)', () => {
        const KEPT = 'retained without Git';
        /** Worktree one is a still Git-less files-only restore. */
        function plantGitlessRestore(): void {
          const { worktrees } = z
            .object({
              worktrees: z.array(z.object({ id: z.string() }).passthrough()),
            })
            .parse(
              JSON.parse(
                readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
              ),
            );
          writeFileSync(
            join(root, 'a', 'worktrees.json'),
            JSON.stringify({
              version: 1,
              worktrees: worktrees.map((row) =>
                row.id === 'one'
                  ? { ...row, restoredFromFilesOnlyArchiveId: 'earlier' }
                  : row,
              ),
            }),
          );
          __resetSidebarItemsStateForTests();
          rmSync(join(checkoutOf('one'), '.git'));
          writeFileSync(join(checkoutOf('one'), 'work.txt'), KEPT);
        }

        it.each([
          [
            'its payload capture',
            'file-quarantine',
            (): string => {
              jest
                .spyOn(
                  archivedContainerRecovery,
                  'prepareArchivedContainerRecovery',
                )
                .mockRejectedValueOnce(new Error('Recovery capture failed'));
              return 'Recovery capture failed';
            },
          ],
          [
            'its finish step',
            'retained-git-cleanup',
            (): string => {
              const remove = removeTree.removeTreeWithoutAsar;
              let failed = false;
              jest
                .spyOn(removeTree, 'removeTreeWithoutAsar')
                .mockImplementation((path, options) => {
                  if (failed || path !== quarantineOf('one'))
                    return remove(path, options);
                  failed = true;
                  return Promise.reject(new Error('Quarantine removal failed'));
                });
              return 'Quarantine removal failed';
            },
          ],
        ] as const)(
          'a failure in %s refuses step-free, and the same request then deletes the project',
          async (_label, phase, arm) => {
            plantGitlessRestore();
            const message = arm();
            const request = {
              workspaceId: 'a',
              source: 'portal' as const,
              idempotencyKey: `files-only-${phase}`,
            };

            await expect(deleteWorkspace(request)).rejects.toThrow(message);

            // Before, this journal refused every later deletion of the project.
            expect(await readDestructiveRecovery('a')).toBe(null);
            const failed = await readDestructiveRecovery('a', 'one');
            expect(failed).toMatchObject({
              state: 'recovery-required',
              parentOperation: 'workspace-delete',
            });
            expect(failed?.steps.at(-1)).toEqual({ phase, state: 'pending' });
            // The checkout, or the retained payload of its capture, keeps the files.
            const retained = existsSync(checkoutOf('one'))
              ? [join(checkoutOf('one'), 'work.txt')]
              : readdirSync(
                  join(getArchivedContainerDir('a', 'one'), 'recovery-files'),
                ).map((payload) =>
                  join(
                    getArchivedContainerDir('a', 'one'),
                    'recovery-files',
                    payload,
                    'work.txt',
                  ),
                );
            expect(retained.map((path) => readFileSync(path, 'utf8'))).toEqual([
              KEPT,
            ]);

            await expect(deleteWorkspace(request)).resolves.toMatchObject({
              removed: 'code',
            });
            expect(indexIds()).toEqual(['b', 'c']);
            expect(existsSync(join(root, 'a'))).toBe(false);
            expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
            expect(
              execFileSync(
                'git',
                ['-C', repo, 'worktree', 'list', '--porcelain'],
                { encoding: 'utf8' },
              ),
            ).not.toContain(join('a', 'worktrees'));
          },
        );
      });

      it.each([
        ['the child archive', false],
        ['the child archive and the deletion', true],
      ])(
        'a crash in a child archive that leaves %s journal active still lets the next deletion resume it (CAN-5011)',
        async (_label, parentCrashed) => {
          addSecondCheckout();
          let failed = false;
          mockArchiveIoFault = (request): void => {
            if (
              failed ||
              request.type !== 'complete-git-capture' ||
              request.containerId !== 'two'
            )
              return;
            failed = true;
            throw new Error('Git capture failed');
          };
          await expect(
            deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
          ).rejects.toThrow('Git capture failed');
          // The journals as a crash during that step leaves them: active, and
          // the deletion's not withdrawn.
          const child = await readDestructiveRecovery('a', 'two');
          const archived = await readDestructiveRecovery('a', 'one');
          if (!child || !archived) throw new Error('Expected child journals');
          writeFileSync(
            journalFileOf('two'),
            JSON.stringify({ ...child, state: 'active' }),
          );
          const workspace = lstatSync(getWorkspaceDir('a'));
          const parentOperationId = '00000000-0000-4000-8000-0000000050a1';
          if (parentCrashed)
            writeFileSync(
              journalFileOf(),
              JSON.stringify({
                version: 1,
                operationId: parentOperationId,
                operation: 'workspace-delete',
                workspaceId: 'a',
                directoryIdentity: `${workspace.dev}:${workspace.ino}:${workspace.birthtimeMs}`,
                state: 'active',
                steps: [
                  { phase: `child:${archived.operationId}`, state: 'done' },
                  { phase: `child:${child.operationId}`, state: 'pending' },
                ],
                ownedPaths: [],
              }),
            );
          // Neither journal refuses worktree operations elsewhere in the project.
          await expect(
            deleteWorktree({
              workspaceId: 'a',
              worktreeId: 'one',
              source: 'single_repo',
            }),
          ).resolves.toMatchObject({ status: 'already-archived' });

          // Before, the active journals refused every later deletion.
          await expect(
            deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
          ).resolves.toMatchObject({ removed: 'code' });

          expect(logMainProcessWarn).toHaveBeenCalledWith(
            'W5 destructive lifecycle resumes a failed archive',
            expect.objectContaining({ operationId: child.operationId }),
          );
          if (parentCrashed)
            expect(logMainProcessWarn).toHaveBeenCalledWith(
              'W5 destructive lifecycle supersedes an interrupted deletion',
              expect.objectContaining({ operationId: parentOperationId }),
            );
          expect(indexIds()).toEqual(['b', 'c']);
          expect(existsSync(join(root, 'a'))).toBe(false);
          expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        },
      );
    });
  });

  describe('a retained recovery the finish step would refuse (CAN-4994)', () => {
    const pendingDir = (): string => getArchivedContainerDir('a', 'pending');
    const journalPath = (): string =>
      join(pendingDir(), 'recovery.staged.json');
    const keptPath = (): string =>
      join(
        pendingDir(),
        'recovery-files',
        '00000000-0000-4000-8000-000000000003',
        'kept.txt',
      );
    const pendingCheckout = (): string =>
      join(root, 'a', 'worktrees', 'pending');
    const unverifiedRefusal = {
      name: 'WorkspaceDeletionRefusedError',
      reason: 'archive-recovery-unverified',
      message:
        "An archived worktree's recovery files couldn't be verified. Preserve its archive and recovery journal, and retry after repair.",
    };
    function updateJournal(update: Record<string, unknown>): void {
      const journal: unknown = JSON.parse(readFileSync(journalPath(), 'utf8'));
      writeFileSync(
        journalPath(),
        JSON.stringify({
          ...z.record(z.string(), z.unknown()).parse(journal),
          ...update,
        }),
      );
    }
    /**
     * A captured-phase journal whose checkout is still in place, as the
     * finish step finds it before it moves the checkout. No product path is
     * known to pair this phase with a pending manifest; it is planted.
     */
    async function plantCapturedCheckout(): Promise<void> {
      mkdirSync(pendingCheckout(), { recursive: true });
      writeFileSync(join(pendingCheckout(), 'kept.txt'), 'retained');
      const sourceDigest = await workspaceRootPayloadDigest({
        rootPath: pendingCheckout(),
      });
      const checkout = lstatSync(pendingCheckout());
      updateJournal({
        phase: 'captured',
        sourceDigest,
        identity: {
          dev: checkout.dev,
          ino: checkout.ino,
          birthtimeMs: checkout.birthtimeMs,
        },
      });
    }
    /** Recovery journals no repair in the app can make usable again. */
    const unusableJournals = [
      {
        name: 'an invalid recovery journal',
        corrupt: (): void => writeFileSync(journalPath(), '{truncated'),
        cause: { name: 'SyntaxError' },
      },
      {
        name: 'a recovery journal of the wrong shape',
        corrupt: (): void =>
          writeFileSync(journalPath(), JSON.stringify({ version: 1 })),
        cause: {
          message:
            'Invalid archive recovery journal; retained files were preserved.',
        },
      },
      {
        name: 'a recovery journal of another archive generation',
        corrupt: (): void =>
          updateJournal({ createdAt: '2000-01-01T00:00:00.000Z' }),
        cause: { message: 'Archive recovery identity changed.' },
      },
      {
        name: 'a deleted recovery journal',
        corrupt: (): void => rmSync(journalPath()),
        cause: { message: 'Archive recovery identity changed.' },
      },
    ];

    it.each(
      unusableJournals.flatMap((trigger) =>
        (['shared_container_fork', 'portal'] as const).map((source) => ({
          ...trigger,
          source,
        })),
      ),
    )(
      'with $name, a $source deletion discards the archive and deletes the project (CAN-5011)',
      async ({ corrupt, cause, source }) => {
        await plantPendingVersion3Archive();
        corrupt();
        // A restore still refuses it.
        await expect(
          archivedContainerRecovery.verifyArchivedContainerRecoveryFinish(
            await listedPendingManifest(),
          ),
        ).rejects.toMatchObject(cause);
        const request = {
          workspaceId: 'a',
          source,
          idempotencyKey: `unusable-journal-${source}`,
        };

        // Before, admission refused it with archive-recovery-unverified until
        // the journal was repaired by hand.
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });

        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
        expect(await readDestructiveRecovery('a')).toMatchObject({
          state: 'completed',
        });
        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'The archive recovery journal is missing or invalid, so any remaining checkout and its Git registrations were left in place.',
          { projectId: 'a', containerId: 'pending' },
        );
      },
    );

    it.each(unusableJournals)(
      'with $name, the archive can be purged without touching a remaining checkout, and its project stays usable (CAN-5011)',
      async ({ corrupt }) => {
        await plantPendingVersion3Archive();
        mkdirSync(pendingCheckout(), { recursive: true });
        writeFileSync(join(pendingCheckout(), 'kept.txt'), 'later occupant');
        corrupt();

        // Before, the purge's finish step threw, so the archive could not be
        // deleted in the app.
        await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(
          true,
        );

        expect(existsSync(pendingDir())).toBe(false);
        // Without its journal, nothing proves the checkout is the archive's.
        expect(readFileSync(join(pendingCheckout(), 'kept.txt'), 'utf8')).toBe(
          'later occupant',
        );
        await expectProjectUsable();
      },
    );

    describe('the Git registration an unusable journal leaves (CAN-5011)', () => {
      const BRANCH = 'pending-branch';
      /** The project's repository registers a checkout at the archive's path. */
      function registerPendingCheckout(): void {
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '-q',
          '-b',
          BRANCH,
          pendingCheckout(),
        ]);
      }
      function isPendingRegistered(): boolean {
        return execFileSync(
          'git',
          ['-C', repo, 'worktree', 'list', '--porcelain'],
          { encoding: 'utf8' },
        )
          .split('\n')
          .some((line) => line.endsWith(join('a', 'worktrees', 'pending')));
      }
      /** A registration that holds the branch refuses this. */
      function checkOutBranchElsewhere(): void {
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '-q',
          join(dir, 'branch-again'),
          BRANCH,
        ]);
      }

      it.each(unusableJournals)(
        'with $name, a purge removes it once its checkout is gone, so the branch can be checked out again',
        async ({ corrupt }) => {
          await plantPendingVersion3Archive();
          registerPendingCheckout();
          rmSync(pendingCheckout(), { recursive: true });
          corrupt();

          await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(
            true,
          );

          // Before, it stayed and held the branch, and the archive's path.
          expect(isPendingRegistered()).toBe(false);
          checkOutBranchElsewhere();
          await expectProjectUsable();
        },
      );

      it("in a multi-repo project, a purge removes the one at a repository's path", async () => {
        writeFileSync(
          join(root, 'index.json'),
          JSON.stringify({
            version: 1,
            workspaces: readIndex().map((entry) =>
              entry.id === 'a' ? { ...entry, type: 'multi-repo' } : entry,
            ),
          }),
        );
        writeFileSync(
          join(root, 'a', 'workspace.json'),
          JSON.stringify({
            version: 1,
            type: 'multi-repo',
            repos: [{ id: 'present', name: 'present', repoPath: repo }],
          }),
        );
        await plantPendingVersion3Archive();
        const repositoryPath = join(pendingCheckout(), 'repos', 'present');
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'add',
          '-q',
          '-b',
          BRANCH,
          repositoryPath,
        ]);
        rmSync(pendingCheckout(), { recursive: true });
        rmSync(journalPath());

        await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(
          true,
        );

        expect(
          execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], {
            encoding: 'utf8',
          }),
        ).not.toContain(join('pending', 'repos', 'present'));
        checkOutBranchElsewhere();
      });

      it('a purge keeps it with a checkout left in place', async () => {
        await plantPendingVersion3Archive();
        registerPendingCheckout();
        rmSync(journalPath());

        await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(
          true,
        );

        expect(isPendingRegistered()).toBe(true);
        expect(existsSync(join(pendingCheckout(), '.git'))).toBe(true);
        expect(() => checkOutBranchElsewhere()).toThrow();
      });

      it("a purge's checkout left in place is unregistered once the project's deletion takes it", async () => {
        await plantPendingVersion3Archive();
        registerPendingCheckout();
        rmSync(journalPath());
        await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(
          true,
        );

        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).resolves.toMatchObject({ removed: 'code' });

        // Before, no archive was left to name it, so it outlived the project
        // and held the branch.
        expect(existsSync(join(root, 'a'))).toBe(false);
        expect(isPendingRegistered()).toBe(false);
        checkOutBranchElsewhere();
      });

      it.each(['shared_container_fork', 'portal'] as const)(
        'a %s deletion removes it after the project directory took its checkout',
        async (source) => {
          await plantPendingVersion3Archive();
          registerPendingCheckout();
          rmSync(journalPath());

          await expect(
            deleteWorkspace({ workspaceId: 'a', source }),
          ).resolves.toMatchObject({ removed: 'code' });

          // Before, it outlived the project and held the branch.
          expect(existsSync(join(root, 'a'))).toBe(false);
          expect(isPendingRegistered()).toBe(false);
          checkOutBranchElsewhere();
        },
      );
    });

    const triggers = [
      {
        name: 'a captured checkout that changed identity',
        corrupt: async (): Promise<() => void> => {
          await plantCapturedCheckout();
          const captured = `${pendingCheckout()}-captured`;
          renameSync(pendingCheckout(), captured);
          mkdirSync(pendingCheckout());
          writeFileSync(join(pendingCheckout(), 'kept.txt'), 'retained');
          return () => {
            rmSync(pendingCheckout(), { recursive: true });
            renameSync(captured, pendingCheckout());
          };
        },
        cause: { message: 'The worktree changed identity during recovery.' },
      },
    ];

    it.each(
      triggers.flatMap((trigger) =>
        (['shared_container_fork', 'portal'] as const).map((source) => ({
          ...trigger,
          source,
        })),
      ),
    )(
      'with $name, a $source deletion refuses before any effect, releases its key and leaves the project usable',
      async ({ corrupt, cause, source }) => {
        await plantPendingVersion3Archive();
        // With the source available, the Git cleanup itself could finish.
        execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
        const repair = await corrupt();
        const { cancel } = watcherSpies();
        const finish = jest.spyOn(
          archivedContainerRecovery,
          'finishArchivedContainerRecovery',
        );
        const manifest = readFileSync(
          join(pendingDir(), 'container.json'),
          'utf8',
        );
        const journal = readFileSync(journalPath(), 'utf8');
        const before = canonicalImages();
        const request = {
          workspaceId: 'a',
          source,
          idempotencyKey: `unverified-${source}`,
        };

        // Before, admission let it through: the finish step threw under the
        // archive lock and left a recovery-required journal.
        await expect(deleteWorkspace(request)).rejects.toMatchObject({
          ...unverifiedRefusal,
          cause: expect.objectContaining(cause) as unknown,
        });

        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(cancel).not.toHaveBeenCalled();
        expect(finish).not.toHaveBeenCalled();
        expect(decisions).not.toHaveBeenCalled();
        expect(canonicalImages()).toEqual(before);
        expect(readFileSync(join(pendingDir(), 'container.json'), 'utf8')).toBe(
          manifest,
        );
        expect(readFileSync(journalPath(), 'utf8')).toBe(journal);
        // A user deletion refuses before it archives the live worktrees.
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
        // An unkeyed retry refuses the same way, still without a journal.
        await expect(
          deleteWorkspace({ workspaceId: 'a', source }),
        ).rejects.toMatchObject(unverifiedRefusal);
        expect(await readDestructiveRecovery('a')).toBe(null);
        // Worktree archive and delete in the project stay available.
        await archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
          deleteWithoutRetentionIfMissing: true,
        });
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
        await deleteWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          source: 'single_repo',
        });
        // The released key runs once the archive is repaired.
        repair();
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(finish).toHaveBeenCalledTimes(1);
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    /** The project survives a step-free refusal with every operation open. */
    async function expectProjectUsable(): Promise<void> {
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
      expect(await reportDestructiveRecovery()).toEqual([]);
      expect(indexIds()).toEqual(['a', 'b', 'c']);
      await archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'single_repo',
        deleteWithoutRetentionIfMissing: true,
      });
      await deleteWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        source: 'single_repo',
      });
    }
    async function listedPendingManifest(): Promise<
      Extract<ArchivedContainerManifest, { version: 3 }>
    > {
      const manifest = (await listArchivedContainerManifests('a')).find(
        (listed) => listed.id === 'pending',
      );
      if (manifest?.version !== 3)
        throw new Error('Expected the pending version-3 archive');
      return manifest;
    }

    it.each([
      [
        'changed',
        (): void => writeFileSync(keptPath(), 'changed'),
        'The retained recovery files failed verification; cleanup was stopped.',
      ],
      [
        'deleted',
        (): void =>
          rmSync(join(pendingDir(), 'recovery-files'), {
            recursive: true,
          }),
        'ENOENT',
      ],
    ] as const)(
      'retained files that were %s no longer keep a deletion from discarding the archive (CAN-5011)',
      async (_label, damage, verificationError) => {
        await plantPendingVersion3Archive();
        execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
        damage();
        const finish = jest.spyOn(
          archivedContainerRecovery,
          'finishArchivedContainerRecovery',
        );
        // A restore still verifies them.
        await expect(
          archivedContainerRecovery.verifyArchivedContainerRecoveryFinish(
            await listedPendingManifest(),
          ),
        ).rejects.toThrow(verificationError);

        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).resolves.toMatchObject({ removed: 'code' });

        expect(finish).toHaveBeenLastCalledWith(
          expect.objectContaining({ id: 'pending' }),
          { discardingArchive: true },
        );
        expect(indexIds()).toEqual(['b', 'c']);
        expect(existsSync(join(root, 'a'))).toBe(false);
        expect(await readDestructiveRecovery('a')).toMatchObject({
          state: 'completed',
        });
      },
    );

    it('changed retained files still refuse the deletion step-free while a captured checkout remains for the finish step to remove', async () => {
      await plantPendingVersion3Archive();
      execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
      await plantCapturedCheckout();
      writeFileSync(keptPath(), 'changed');

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({
        ...unverifiedRefusal,
        cause: expect.objectContaining({
          message:
            'The retained recovery files failed verification; cleanup was stopped.',
        }) as unknown,
      });

      expect(readFileSync(join(pendingCheckout(), 'kept.txt'), 'utf8')).toBe(
        'retained',
      );
      await expectProjectUsable();
    });

    it('an archive whose retained files were deleted can be purged, and its project then deleted (CAN-5011)', async () => {
      await plantPendingVersion3Archive();
      execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
      rmSync(join(pendingDir(), 'recovery-files'), { recursive: true });

      // Before, the purge's finish step refused the missing payload.
      await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(true);

      expect(existsSync(pendingDir())).toBe(false);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(indexIds()).toEqual(['b', 'c']);
    });

    it('a purge still refuses an archive whose Git cleanup cannot finish, and leaves its project usable', async () => {
      await plantPendingVersion3Archive();
      rmSync(join(pendingDir(), 'recovery-files'), { recursive: true });

      await expect(purgeArchivedContainer('a', 'pending')).rejects.toThrow(
        'Git registration cleanup is still pending. Retry after the source repository is available.',
      );

      expect(existsSync(pendingDir())).toBe(true);
      await expectProjectUsable();
    });

    it.each(['shared_container_fork', 'portal'] as const)(
      'a captured checkout that changes after admission refuses a %s deletion step-free, and a retry deletes the project once it is restored (CAN-5011)',
      async (source) => {
        await plantPendingVersion3Archive();
        execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
        await plantCapturedCheckout();
        const captured = `${pendingCheckout()}-captured`;
        const verify =
          archivedContainerRecovery.verifyArchivedContainerRecoveryFinish;
        // Models a checkout replaced between admission and the finish step.
        const admitted = jest
          .spyOn(
            archivedContainerRecovery,
            'verifyArchivedContainerRecoveryFinish',
          )
          .mockImplementationOnce(async (manifest, options) => {
            await verify(manifest, options);
            renameSync(pendingCheckout(), captured);
            mkdirSync(pendingCheckout());
            writeFileSync(join(pendingCheckout(), 'kept.txt'), 'retained');
          });
        const request = {
          workspaceId: 'a',
          source,
          idempotencyKey: `changed-after-admission-${source}`,
        };

        // Before, the finish step threw under the archive lock and left a
        // recovery-required journal that refused every later operation.
        await expect(deleteWorkspace(request)).rejects.toThrow(
          'The worktree changed identity during recovery.',
        );

        expect(admitted).toHaveBeenCalledTimes(1);
        expect(readFileSync(join(pendingCheckout(), 'kept.txt'), 'utf8')).toBe(
          'retained',
        );
        await expectProjectUsable();
        rmSync(pendingCheckout(), { recursive: true });
        renameSync(captured, pendingCheckout());
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it('a recovery journal damaged after admission no longer keeps the deletion from discarding the archive (CAN-5011)', async () => {
      await plantPendingVersion3Archive();
      const verify =
        archivedContainerRecovery.verifyArchivedContainerRecoveryFinish;
      jest
        .spyOn(
          archivedContainerRecovery,
          'verifyArchivedContainerRecoveryFinish',
        )
        .mockImplementationOnce(async (manifest, options) => {
          await verify(manifest, options);
          writeFileSync(journalPath(), '{truncated');
        });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(existsSync(join(root, 'a'))).toBe(false);
    });

    const quarantinePath = (): string =>
      join(root, 'a', 'worktrees', '.pending.archive-quarantine');
    it.each([
      [
        'its journal write',
        (): jest.SpyInstance => {
          const write = archivedContainerGit.writeJsonDurably;
          let failed = false;
          return jest
            .spyOn(archivedContainerGit, 'writeJsonDurably')
            .mockImplementation((path, value) => {
              if (failed || path !== journalPath()) return write(path, value);
              failed = true;
              return Promise.reject(new Error('journal write failed'));
            });
        },
        'journal write failed',
        'captured',
      ],
      [
        'its quarantine removal',
        (): jest.SpyInstance => {
          const remove = removeTree.removeTreeWithoutAsar;
          let failed = false;
          return jest
            .spyOn(removeTree, 'removeTreeWithoutAsar')
            .mockImplementation((path, options) => {
              if (failed || path !== quarantinePath())
                return remove(path, options);
              failed = true;
              return Promise.reject(new Error('quarantine removal failed'));
            });
        },
        'quarantine removal failed',
        'verified',
      ],
    ] as const)(
      'a finish step whose %s fails refuses step-free, and a retry resumes the recovery (CAN-5011)',
      async (_label, fault, message, phaseAfterFailure) => {
        await plantPendingVersion3Archive();
        execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
        await plantCapturedCheckout();
        const injected = fault();
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: `finish-effect-${phaseAfterFailure}`,
        };

        await expect(deleteWorkspace(request)).rejects.toThrow(message);

        expect(injected).toHaveBeenCalled();
        // The checkout moved into the quarantine the recovery journal owns.
        expect(existsSync(pendingCheckout())).toBe(false);
        expect(existsSync(quarantinePath())).toBe(true);
        expect(JSON.parse(readFileSync(journalPath(), 'utf8'))).toMatchObject({
          phase: phaseAfterFailure,
        });
        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(await reportDestructiveRecovery()).toEqual([]);
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(existsSync(join(root, 'a'))).toBe(false);
      },
    );

    it('an archive purged during admission leaves the deletion to the locked listing', async () => {
      await plantPendingVersion3Archive();
      execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
      const verify =
        archivedContainerRecovery.verifyArchivedContainerRecoveryFinish;
      // Models a concurrent purge between the unlocked listing and its check.
      const spy = jest
        .spyOn(
          archivedContainerRecovery,
          'verifyArchivedContainerRecoveryFinish',
        )
        .mockImplementationOnce((manifest) => {
          rmSync(pendingDir(), { recursive: true });
          return verify(manifest);
        });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(spy).toHaveBeenCalledTimes(1);
      const record = await readDestructiveRecovery('a');
      expect(record).toMatchObject({ state: 'completed' });
      expect(record?.steps.map((step) => step.phase)).not.toContain(
        'retained-git-cleanup',
      );
      expect(indexIds()).toEqual(['b', 'c']);
      expect(existsSync(join(root, 'a'))).toBe(false);
    });

    it('an unlocked failure that clears under the archive lock admits the deletion', async () => {
      await plantPendingVersion3Archive();
      execFileSync('git', ['init', '-q', join(dir, 'missing-source')]);
      const journal = readFileSync(journalPath(), 'utf8');
      const verify =
        archivedContainerRecovery.verifyArchivedContainerRecoveryFinish;
      // Models a concurrent archive operation that rewrites the journal.
      const spy = jest
        .spyOn(
          archivedContainerRecovery,
          'verifyArchivedContainerRecoveryFinish',
        )
        .mockImplementationOnce(async (manifest) => {
          writeFileSync(journalPath(), '{truncated');
          try {
            return await verify(manifest);
          } finally {
            writeFileSync(journalPath(), journal);
          }
        });

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });

      expect(spy).toHaveBeenCalledTimes(2);
      expect(await readDestructiveRecovery('a')).toMatchObject({
        state: 'completed',
        steps: expect.arrayContaining([
          { phase: 'retained-git-cleanup', state: 'done', resumable: true },
        ]) as unknown,
      });
      expect(indexIds()).toEqual(['b', 'c']);
    });
  });

  describe('§3.2 strict archive listing', () => {
    it.each(strictListingCases)(
      'step-free route: $name writes no journal, and a retry succeeds after repair',
      async ({ plant, repair, error, keyedRetry }) => {
        plant();
        const request = {
          workspaceId: 'a',
          source: 'shared_container_fork' as const,
        };
        await expect(deleteWorkspace(request)).rejects.toMatchObject(error);
        expect(await readDestructiveRecovery('a')).toBe(null);
        const keyed = { ...request, idempotencyKey: 'strict-listing' };
        await expect(deleteWorkspace(keyed)).rejects.toMatchObject(error);
        repair();
        if (keyedRetry === 'succeeds')
          await expect(deleteWorkspace(keyed)).resolves.toMatchObject({
            removed: 'code',
          });
        else {
          await expect(deleteWorkspace(keyed)).rejects.toMatchObject({
            reason: 'recovery-required',
          });
          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'code',
          });
        }
      },
    );

    it.each(strictListingCases)(
      'journaled route: $name after a user deletion archived the worktrees refuses step-free, and the same request deletes the project after repair (CAN-5011)',
      async ({ plant, repair, error }) => {
        plant();
        const request = {
          workspaceId: 'a',
          source: 'portal' as const,
          idempotencyKey: 'journaled-listing',
        };

        await expect(deleteWorkspace(request)).rejects.toMatchObject(error);

        // The worktree archives run before the strict listing (correction 3)
        // and stay restorable.
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
        expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
          state: 'completed',
        });
        // Before, the deletion journal, holding only those archives, required
        // recovery and refused every later deletion of the project.
        expect(await readDestructiveRecovery('a')).toBe(null);
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(indexIds()).toEqual(['a', 'b', 'c']);
        repair();
        // The released key runs.
        await expect(deleteWorkspace(request)).resolves.toMatchObject({
          removed: 'code',
        });
        expect(indexIds()).toEqual(['b', 'c']);
      },
    );

    it.each([
      ['an earlier version kept after this failure', 'recovery-required'],
      ['a crash left before its withdrawal', 'active'],
    ] as const)(
      'a deletion journal of only child archives that %s is superseded by the next deletion (CAN-5011)',
      async (_label, state) => {
        const [{ plant, repair }] = strictListingCases;
        plant();
        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        const archived = await readDestructiveRecovery('a', 'one');
        if (!archived) throw new Error('Expected the child archive journal');
        const workspace = lstatSync(getWorkspaceDir('a'));
        const operationId = '00000000-0000-4000-8000-0000000050b2';
        writeFileSync(
          journalFileOf(),
          JSON.stringify({
            version: 1,
            operationId,
            operation: 'workspace-delete',
            workspaceId: 'a',
            directoryIdentity: `${workspace.dev}:${workspace.ino}:${workspace.birthtimeMs}`,
            state,
            steps: [{ phase: `child:${archived.operationId}`, state: 'done' }],
            ownedPaths: [],
          }),
        );
        repair();
        // It holds no janitor and is not reported at launch; before, both
        // treated it as unresolved until the next deletion.
        expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
        expect(await reportDestructiveRecovery()).toEqual([]);
        // It refuses no worktree operation in the project.
        await expect(
          deleteWorktree({
            workspaceId: 'a',
            worktreeId: 'two',
            source: 'single_repo',
          }),
        ).resolves.toMatchObject({ success: true });

        await expect(
          deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
        ).resolves.toMatchObject({ removed: 'code' });

        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'W5 destructive lifecycle supersedes an interrupted deletion',
          expect.objectContaining({ operationId }),
        );
        expect(indexIds()).toEqual(['b', 'c']);
        expect(await readDestructiveRecovery('a')).toMatchObject({
          state: 'completed',
        });
      },
    );

    it('a deletion journal of only child archives over a replaced project directory still refuses (CAN-5011)', async () => {
      const [{ plant, repair }] = strictListingCases;
      plant();
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const archived = await readDestructiveRecovery('a', 'one');
      if (!archived) throw new Error('Expected the child archive journal');
      const operationId = '00000000-0000-4000-8000-0000000050b3';
      writeFileSync(
        journalFileOf(),
        JSON.stringify({
          version: 1,
          operationId,
          operation: 'workspace-delete',
          workspaceId: 'a',
          directoryIdentity: '1:2:3',
          state: 'recovery-required',
          steps: [{ phase: `child:${archived.operationId}`, state: 'done' }],
          ownedPaths: [],
        }),
      );
      repair();

      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { operationId },
      });
      expect(indexIds()).toEqual(['a', 'b', 'c']);
    });

    it('janitor removes only an aged manifest-less directory and keeps corrupt and badly named ones', async () => {
      for (const { plant } of strictListingCases) plant();
      const staging = plantAgedStagingDirectory('a');
      const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      for (const name of ['gone', 'truncated', 'future', 'Bad_Name'])
        utimesSync(join(getArchivedContainersRootDir('a'), name), old, old);
      // A young one is kept by age alone.
      mkdirSync(join(getArchivedContainersRootDir('a'), 'young'));

      await expect(
        removeIncompleteArchivedContainers('a', 24 * 60 * 60 * 1000),
      ).resolves.toBe(2);

      expect(existsSync(staging)).toBe(false);
      for (const name of ['truncated', 'future', 'Bad_Name', 'young'])
        expect(existsSync(join(getArchivedContainersRootDir('a'), name))).toBe(
          true,
        );
    });
  });

  it('§3.3 an external folder overlapping the metadata refuses after the session teardown', async () => {
    addCowork('o', { externalPath: getWorkspaceDir('o') });
    const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');

    await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
      'Refusing to delete cowork project: its metadata directory and external folder overlap.',
    );

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(decisions).not.toHaveBeenCalled();
    expect(indexIds()).toContain('o');
    expect(existsSync(join(root, 'o', 'workspace.json'))).toBe(true);
    expect(await readDestructiveRecovery('o')).toMatchObject({
      state: 'recovery-required',
      steps: [
        { phase: 'session-teardown', state: 'done' },
        { phase: 'session-teardown', state: 'done' },
        { phase: 'cowork-deletion', state: 'pending' },
      ],
    });
  });

  // CAN-4975: its unreadable `externalPath` leaves the overlap guard nothing
  // to check, so every route refuses before anything changes.
  describe.each([
    ['the chat project deletion', chatProjectRequest('o', 'unreadable-chat')],
    [
      'a Portal deletion',
      {
        workspaceId: 'o',
        source: 'portal',
        idempotencyKey: 'unreadable-portal',
      } satisfies WorkspaceDeletionRequest,
    ],
  ])(
    '§3.3 an unreadable Cowork configuration refuses %s before any effect and releases its key',
    (_label, request) => {
      it.each([
        ['truncated JSON', '{truncated'],
        ['empty file', ''],
        ['null document', 'null'],
        ['array document', '[]'],
        ['unsupported version', '{"version":2,"type":"cowork","repos":[]}'],
        ['filesystem read error', null],
      ])(
        '%s',
        async (_failure, raw) => {
          addCowork('o', { externalPath: getWorkspaceDir('o') });
          const configPath = join(root, 'o', 'workspace.json');
          if (raw === null) {
            rmSync(configPath);
            mkdirSync(configPath);
          } else writeFileSync(configPath, raw);
          __resetSidebarItemsStateForTests();
          const before = canonicalImages();
          const { cancel, commit, release } = watcherSpies();
          const destroy = jest.spyOn(sessionManager, 'destroyWorktreeSessions');
          // Fail at the first forbidden effect, not in unrelated downstream cleanup.
          cancel.mockRejectedValue(
            new Error('Unexpected watcher cancellation'),
          );

          await expect(deleteWorkspace(request)).rejects.toMatchObject({
            name: 'WorkspaceDeletionRefusedError',
            reason: 'configuration-unavailable',
            message:
              'Cannot delete this project while its configuration is unavailable. Reload and try again.',
          });

          expect(cancel).not.toHaveBeenCalled();
          expect(commit).not.toHaveBeenCalled();
          expect(release).not.toHaveBeenCalled();
          expect(destroy).not.toHaveBeenCalled();
          expect(decisions).not.toHaveBeenCalled();
          expect(recordWorkspaceCrudTelemetry).not.toHaveBeenCalled();
          expect(canonicalImages()).toEqual(before);
          expect(indexIds()).toEqual(['a', 'b', 'c', 'o']);
          if (raw === null)
            expect(lstatSync(configPath).isDirectory()).toBe(true);
          else expect(readFileSync(configPath, 'utf8')).toBe(raw);
          expect(await readDestructiveRecovery('o')).toBe(null);
          // Once repaired, the released key deletes the project.
          cancel.mockResolvedValue(undefined);
          if (raw === null) rmSync(configPath, { recursive: true });
          writeFileSync(
            configPath,
            JSON.stringify({ version: 1, type: 'cowork', repos: [] }),
          );
          __resetSidebarItemsStateForTests();
          await expect(deleteWorkspace(request)).resolves.toMatchObject({
            removed: 'cowork',
          });
          expect(decisionCalls()).toEqual([['o', DELETE_INDEX]]);
          expect(existsSync(join(root, 'o'))).toBe(false);
        },
        15_000,
      );
    },
  );

  it('§3.3 a Cowork configuration that becomes unreadable during the session teardown refuses before the Cowork deletion removes anything', async () => {
    addCowork('o', { externalPath: getWorkspaceDir('o') });
    const destroy = jest
      .spyOn(sessionManager, 'destroyWorktreeSessions')
      .mockImplementationOnce(() => {
        writeFileSync(join(root, 'o', 'workspace.json'), '{truncated');
        __resetSidebarItemsStateForTests();
        return Promise.resolve();
      });
    const prepareBrowserRetirement = jest.mocked(
      prepareWorkspaceBrowserRetirement,
    );
    prepareBrowserRetirement.mockRejectedValueOnce(
      new Error('Unexpected browser retirement'),
    );

    try {
      await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
        'Refusing to delete cowork project: its configuration could not be read, so its external folder is unknown.',
      );
      expect(prepareBrowserRetirement).not.toHaveBeenCalled();
    } finally {
      prepareBrowserRetirement.mockReset().mockResolvedValue([]);
    }

    expect(destroy).toHaveBeenCalledTimes(2);
    expect(decisions).not.toHaveBeenCalled();
    expect(indexIds()).toContain('o');
    expect(readFileSync(join(root, 'o', 'workspace.json'), 'utf8')).toBe(
      '{truncated',
    );
    expect(await readDestructiveRecovery('o')).toMatchObject({
      state: 'recovery-required',
      steps: [
        { phase: 'session-teardown', state: 'done' },
        { phase: 'session-teardown', state: 'done' },
        { phase: 'cowork-deletion', state: 'pending' },
      ],
    });
  }, 15_000);

  it.each(['same', 'child', 'parent'] as const)(
    '§3.3 the guarded config protects an overlapping %s folder when the sidebar reads an unreadable config',
    async (relationship) => {
      const metadataDir = getWorkspaceDir('o');
      const externalPath =
        relationship === 'child'
          ? join(metadataDir, 'external')
          : relationship === 'parent'
            ? root
            : metadataDir;
      addCowork('o', { externalPath });
      mkdirSync(externalPath, { recursive: true });
      // A sibling of metadata would survive its deletion in the parent case.
      const sentinel = join(
        relationship === 'parent' ? metadataDir : externalPath,
        'keep.txt',
      );
      writeFileSync(sentinel, 'user data');
      const configPath = join(metadataDir, 'workspace.json');
      const readConfig = workspacePersistence.readWorkspaceConfigDetailed;
      const readSidebar = sidebarItems.readAllSidebarItems;
      const projectionRead = jest.fn();
      jest
        .spyOn(sessionManager, 'destroyWorktreeSessions')
        .mockImplementationOnce(() => {
          let releaseProjection = (): void => {};
          const configRead = new Promise<void>((resolve) => {
            releaseProjection = resolve;
          });
          jest
            .spyOn(sidebarItems, 'readAllSidebarItems')
            .mockImplementationOnce(async (options) => {
              await configRead;
              const projection = await readSidebar(options);
              projectionRead(projection.items.find((item) => item.id === 'o'));
              return projection;
            });
          jest
            .spyOn(workspacePersistence, 'readWorkspaceConfigDetailed')
            .mockImplementationOnce(async (id) => {
              try {
                const config = await readConfig(id);
                expect(config.authority).toBe('ok');
                expect(config.config.externalPath).toBe(externalPath);
                writeFileSync(configPath, '{truncated');
                __resetSidebarItemsStateForTests();
                return config;
              } finally {
                releaseProjection();
              }
            });
          return Promise.resolve();
        });
      const prepareBrowserRetirement = jest.mocked(
        prepareWorkspaceBrowserRetirement,
      );
      prepareBrowserRetirement.mockRejectedValueOnce(
        new Error('Unexpected browser retirement'),
      );

      try {
        await expect(deleteWorkspace(chatProjectRequest('o'))).rejects.toThrow(
          'Refusing to delete cowork project: its metadata directory and external folder overlap.',
        );
        expect(projectionRead).toHaveBeenCalledWith(
          expect.objectContaining({ id: 'o', externalPath: undefined }),
        );
        expect(prepareBrowserRetirement).not.toHaveBeenCalled();
      } finally {
        prepareBrowserRetirement.mockReset().mockResolvedValue([]);
      }
      expect(decisions).not.toHaveBeenCalled();
      expect(indexIds()).toContain('o');
      expect(readFileSync(sentinel, 'utf8')).toBe('user data');
      expect(readFileSync(configPath, 'utf8')).toBe('{truncated');
      expect(await readDestructiveRecovery('o')).toMatchObject({
        state: 'recovery-required',
        steps: [
          { phase: 'session-teardown', state: 'done' },
          { phase: 'session-teardown', state: 'done' },
          { phase: 'cowork-deletion', state: 'pending' },
        ],
      });
    },
    15_000,
  );

  it('§3.3 a Cowork project without a configuration file still deletes', async () => {
    addCowork('o');
    rmSync(join(root, 'o', 'workspace.json'));
    __resetSidebarItemsStateForTests();

    await expect(deleteWorkspace(chatProjectRequest('o'))).resolves.toEqual(
      expect.objectContaining({ removed: 'cowork' }),
    );
    expect(decisionCalls()).toEqual([['o', DELETE_INDEX]]);
    expect(indexIds()).toEqual(['a', 'b', 'c']);
    expect(existsSync(join(root, 'o'))).toBe(false);
  });

  describe('§3.4 one unreadable foreign journal', () => {
    it('refuses deletion before any effect and releases a new keyed reservation (CAN-5377)', async () => {
      const journal = plantUnreadableForeignJournal();
      const { cancel } = watcherSpies();
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: 'foreign-journal',
      };
      // CAN-5335: the unattributable refusal names the entry to quarantine.
      const journalRefusal = {
        reason: 'recovery-required',
        message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
        details: {
          phase: 'lifecycle-journal',
          check: 'unreadable-entry',
          entryName: basename(journal),
        },
      };

      await expect(deleteWorkspace(request)).rejects.toMatchObject(
        journalRefusal,
      );
      await expect(deleteWorkspace(request)).rejects.toMatchObject(
        journalRefusal,
      );

      expect(cancel).not.toHaveBeenCalled();
      expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
      expect(readFileSync(journal, 'utf8')).toBe('{truncated');
      rmSync(journal);
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
    });

    it('a stranded journal refuses a keyed deletion before any effect, releases its key and stays in place (CAN-5377)', async () => {
      const stranded: DestructiveRecoveryRecord = {
        version: 1,
        operationId: '00000000-0000-4000-8000-000000005377',
        operation: 'worktree-delete',
        workspaceId: 'a',
        worktreeId: 'gone',
        createdAt: '2026-01-01T00:00:00.000Z',
        directoryIdentity: null,
        state: 'recovery-required',
        steps: [{ phase: 'checkout-removal', state: 'pending' }],
        ownedPaths: [],
      };
      const journal = journalFileOf('gone');
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      writeFileSync(journal, JSON.stringify(stranded));
      const { cancel } = watcherSpies();
      const request = {
        workspaceId: 'a',
        source: 'shared_container_fork' as const,
        idempotencyKey: 'stranded-journal',
      };

      for (let attempt = 0; attempt < 2; attempt += 1)
        await expect(deleteWorkspace(request)).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: stranded.operationId },
        });

      expect(cancel).not.toHaveBeenCalled();
      expect(decisions).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(journal, 'utf8'))).toEqual(stranded);
      expect(await readDestructiveRecovery('a')).toBe(null);
      rmSync(journal);
      await expect(deleteWorkspace(request)).resolves.toMatchObject({
        removed: 'code',
      });
    });

    it('keeps an aged staging directory from the janitor', async () => {
      const journal = plantUnreadableForeignJournal();
      const staging = plantAgedStagingDirectory('a');

      await expect(
        removeIncompleteArchivedContainers('a', 24 * 60 * 60 * 1000),
      ).resolves.toBe(0);
      expect(existsSync(staging)).toBe(true);

      rmSync(journal);
      await expect(
        removeIncompleteArchivedContainers('a', 24 * 60 * 60 * 1000),
      ).resolves.toBe(1);
    });

    it('rejects the boot reconciliation', async () => {
      const journal = plantUnreadableForeignJournal();
      await expect(reconcileGitPendingWorktrees()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      rmSync(journal);
      await expect(reconcileGitPendingWorktrees()).resolves.toBeUndefined();
    });
  });

  describe('§3.5 and §3.7 a skill-purge-only failure (CAN-4962)', () => {
    it('completes without cleanup required, replays the decoded first response and reports nothing at launch', async () => {
      const failure = new Error('EIO');
      const purge = jest
        .spyOn(getFingerprintStore(), 'purgeWorkspace')
        .mockRejectedValueOnce(failure);
      const request = {
        workspaceId: 'a',
        source: 'shared_container_fork' as const,
        idempotencyKey: 'skill-only',
      };

      const first = await deleteWorkspace(request);

      expect(first).toEqual({
        workspaceId: 'a',
        removed: 'code',
        cleanup: {
          archivedGitRefs: { status: 'done' },
          chatSearchRows: { status: 'done' },
          managedRepository: { status: 'skipped' },
          skillSuggestions: { status: 'failed', error: { name: 'Error' } },
        },
      });
      const record = await readDestructiveRecovery('a');
      if (!record) throw new Error('Expected deletion evidence');
      // The purge is rebuildable and unjournaled: it never needs manual recovery.
      expect(record.state).toBe('completed');
      expect(record.cleanupRequired).toBeUndefined();
      expect(record.steps.some((step) => step.state === 'failed')).toBe(false);
      const commits = jest.spyOn(host, 'commit');
      expect(await deleteWorkspace(request)).toEqual(first);
      expect(commits).not.toHaveBeenCalled();
      expect(purge).toHaveBeenCalledTimes(1);
      await expect(
        deleteWorkspace({ ...request, singleRepoProject: true }),
      ).rejects.toMatchObject({ reason: 'key-reused' });

      jest.mocked(logMainProcessWarn).mockClear();
      await expect(reportDestructiveRecovery()).resolves.toEqual([]);
      expect(jest.mocked(logMainProcessWarn)).not.toHaveBeenCalledWith(
        'W5 destructive lifecycle requires manual recovery',
        expect.anything(),
      );
    });

    it('the unkeyed first response carries the raw error, and a recreated project with the same id is not fenced', async () => {
      const failure = new Error('EIO');
      jest
        .spyOn(getFingerprintStore(), 'purgeWorkspace')
        .mockRejectedValueOnce(failure);

      const outcome = await deleteWorkspace({
        workspaceId: 'a',
        source: 'shared_container_fork',
      });

      expect(outcome.cleanup.skillSuggestions).toEqual({
        status: 'failed',
        error: failure,
      });
      // Correction 1: the id is a name slug, so a project with the same name
      // matches the completed journal; it must not inherit a recovery fence.
      addCowork('a');
      expect(await hasUnresolvedDestructiveRecovery('a', 'any-worktree')).toBe(
        false,
      );
      const staging = plantAgedStagingDirectory('a');
      await expect(
        removeIncompleteArchivedContainers('a', 24 * 60 * 60 * 1000),
      ).resolves.toBe(1);
      expect(existsSync(staging)).toBe(false);
      await expect(
        deleteWorkspace(chatProjectRequest('a')),
      ).resolves.toMatchObject({ removed: 'cowork' });
    });

    it('a journaled cleanup failure alongside it still requires cleanup', async () => {
      jest
        .spyOn(getFingerprintStore(), 'purgeWorkspace')
        .mockRejectedValueOnce(new Error('EIO'));
      const search = getChatSearchService();
      jest
        .spyOn(search, 'deleteWorkspaceDocs')
        .mockRejectedValueOnce(new Error('index unavailable'));
      jest.mocked(getChatSearchService).mockReturnValueOnce(search);

      const outcome = await deleteWorkspace({
        workspaceId: 'a',
        source: 'shared_container_fork',
      });

      expect(outcome.cleanup).toMatchObject({
        chatSearchRows: { status: 'failed' },
        skillSuggestions: { status: 'failed' },
      });
      const record = await readDestructiveRecovery('a');
      if (!record) throw new Error('Expected deletion evidence');
      expect(record).toMatchObject({
        state: 'completed',
        cleanupRequired: true,
      });
      addCowork('a');
      expect(await hasUnresolvedDestructiveRecovery('a', 'any-worktree')).toBe(
        true,
      );
      jest.mocked(logMainProcessWarn).mockClear();
      expect(
        (await reportDestructiveRecovery()).map((found) => found.operationId),
      ).toEqual([record.operationId]);
      expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
        'W5 destructive lifecycle requires manual recovery',
        expect.objectContaining({
          operationId: record.operationId,
          reason: 'subordinate-cleanup',
        }),
      );
    });

    it('§3.8 the search repair clears the whole flag, since the purge is not a step', async () => {
      const purge = jest
        .spyOn(getFingerprintStore(), 'purgeWorkspace')
        .mockRejectedValueOnce(new Error('EIO'));
      const search = getChatSearchService();
      jest
        .spyOn(search, 'deleteWorkspaceDocs')
        .mockRejectedValueOnce(new Error('index unavailable'));
      jest.mocked(getChatSearchService).mockReturnValueOnce(search);
      await deleteWorkspace({
        workspaceId: 'a',
        source: 'shared_container_fork',
      });
      const record = await readDestructiveRecovery('a');
      if (!record) throw new Error('Expected deletion evidence');
      expect(record.cleanupRequired).toBe(true);

      await retryWorkspaceDeletionSearchCleanup({
        source: 'manual_repair',
        workspaceId: 'a',
        operationId: record.operationId,
      });

      expect((await readDestructiveRecovery('a'))?.cleanupRequired).toBe(false);
      expect(purge).toHaveBeenCalledTimes(1);
      addCowork('a');
      expect(await hasUnresolvedDestructiveRecovery('a', 'any-worktree')).toBe(
        false,
      );
    });
  });

  describe('§3.6 a failed completion save', () => {
    function failCompletionSave(point: 'before' | 'after'): () => boolean {
      const write = atomicFile.writeFileAtomically;
      let fired = false;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation(async (file, contents, options) => {
          const completion =
            !fired &&
            file.includes('destructive-lifecycles') &&
            typeof contents === 'string' &&
            contents.includes('"operation":"workspace-delete"') &&
            contents.includes('"state":"completed"');
          if (completion && point === 'before') {
            fired = true;
            throw new Error('completion save failed');
          }
          await write(file, contents, options);
          if (completion) {
            fired = true;
            throw new Error('completion save failed');
          }
        });
      return () => fired;
    }

    it('a save that rejects without writing leaves an active journal that refuses every retry', async () => {
      const { commit } = watcherSpies();
      const fired = failCompletionSave('before');
      const request = {
        workspaceId: 'a',
        source: 'shared_container_fork' as const,
        idempotencyKey: 'completion-before',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'completion save failed',
      );

      expect(fired()).toBe(true);
      // Every effect ran, including telemetry and the watcher commit.
      expect(existsSync(join(root, 'a'))).toBe(false);
      expect(indexIds()).toEqual(['b', 'c']);
      expect(jest.mocked(recordWorkspaceCrudTelemetry)).toHaveBeenCalled();
      expect(commit).toHaveBeenCalledWith('a');
      const record = await readDestructiveRecovery('a');
      expect(record?.state).toBe('active');
      expect(record?.steps.every((step) => step.state === 'done')).toBe(true);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).rejects.toMatchObject({
        reason: 'recovery-required',
        message:
          'An interrupted destructive operation needs manual recovery. Preserve remaining files and inspect the lifecycle journal.',
      });
      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        reason: 'recovery-required',
        message:
          'An earlier attempt of this request was interrupted and needs recovery.',
      });
      jest.mocked(logMainProcessWarn).mockClear();
      expect(
        (await reportDestructiveRecovery()).map((found) => found.state),
      ).toEqual(['recovery-required']);
      expect(jest.mocked(logMainProcessWarn)).toHaveBeenCalledWith(
        'W5 destructive lifecycle requires manual recovery',
        expect.objectContaining({ reason: 'interrupted-destructive-effect' }),
      );
    });

    it('a save that writes, then throws, leaves a completed journal: an unkeyed retry is an unindexed no-op', async () => {
      const fired = failCompletionSave('after');
      const request = {
        workspaceId: 'a',
        source: 'shared_container_fork' as const,
        idempotencyKey: 'completion-after',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'completion save failed',
      );

      expect(fired()).toBe(true);
      expect((await readDestructiveRecovery('a'))?.state).toBe('completed');
      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        deleteWorkspace(chatProjectRequest('a')),
      ).rejects.toMatchObject({
        reason: 'not-cowork',
        message: 'Chat project not found',
      });
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'shared_container_fork' }),
      ).resolves.toMatchObject({ removed: 'unindexed' });
    });

    it('a failed keyed receipt decision keeps that key for recovery while a new key runs as unindexed', async () => {
      const commit = host.commit.bind(host);
      let fired = false;
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        if (request.receipt && !fired) {
          fired = true;
          throw new Error('receipt decision failed');
        }
        return commit(request);
      });
      const request = {
        workspaceId: 'a',
        source: 'shared_container_fork' as const,
        idempotencyKey: 'receipt-decision',
      };

      await expect(deleteWorkspace(request)).rejects.toThrow(
        'receipt decision failed',
      );

      expect(fired).toBe(true);
      expect((await readDestructiveRecovery('a'))?.state).toBe('completed');
      await expect(deleteWorkspace(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        deleteWorkspace(chatProjectRequest('a', 'receipt-decision-cowork')),
      ).rejects.toMatchObject({ reason: 'not-cowork' });
      await expect(
        deleteWorkspace({ ...request, idempotencyKey: 'receipt-decision-new' }),
      ).resolves.toMatchObject({ removed: 'unindexed' });
    });
  });
});

describe("CAN-5337 an interrupted deletion's journal", () => {
  const supersedeLog =
    'W5 destructive lifecycle supersedes an interrupted deletion';

  /** The index commit fails after both worktrees' archives finished. */
  async function interruptIndexRemoval(): Promise<DestructiveRecoveryRecord> {
    decisions.mockRejectedValueOnce(new Error('Index write failed'));
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
    ).rejects.toThrow('Index write failed');
    const journal = await readDestructiveRecovery('a');
    if (!journal) throw new Error('Expected the deletion journal');
    expect(journal.state).toBe('recovery-required');
    expect(journal.steps[journal.steps.length - 1]).toEqual({
      phase: 'canonical-index-removal',
      state: 'pending',
    });
    // Before, every later deletion refused, and so did every discard.
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    return journal;
  }

  it('is listed, and the confirmed deletion supersedes it and deletes the project', async () => {
    const journal = await interruptIndexRemoval();

    expect(await describeProjectDeletion()).toEqual({
      version: 1,
      workspaceId: 'a',
      status: 'discardable',
      items: [],
      interruptedDeletion: { operationId: journal.operationId },
    });
    // Neither a keyed request nor another operation's id supersedes it.
    for (const request of [
      {
        supersedeInterruptedDeletion: journal.operationId,
        idempotencyKey: 'k',
      },
      { supersedeInterruptedDeletion: '00000000-0000-4000-8000-000000000000' },
      { supersedeInterruptedDeletion: 'not-an-operation-id' },
    ])
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal', ...request }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await readDestructiveRecovery('a')).toEqual(journal);

    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        supersedeInterruptedDeletion: journal.operationId,
      }),
    ).resolves.toMatchObject({ removed: 'code' });

    expect(indexIds()).toEqual(['b', 'c']);
    expect(existsSync(join(root, 'a'))).toBe(false);
    expect(logMainProcessWarn).toHaveBeenCalledWith(
      supersedeLog,
      expect.objectContaining({ operationId: journal.operationId }),
    );
    expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
  });

  it('is superseded first, so the discards that follow it can run', async () => {
    const journal = await interruptIndexRemoval();
    // A worktree added since, whose source then went missing.
    const three = join(root, 'a', 'worktrees', 'three');
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'third',
      three,
    ]);
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({
        version: 1,
        worktrees: [
          {
            id: 'three',
            branchName: 'third',
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    );
    __resetSidebarItemsStateForTests();
    renameSync(repo, `${repo}-unavailable`);

    const description = await describeProjectDeletion();
    expect(description).toMatchObject({
      status: 'discardable',
      interruptedDeletion: { operationId: journal.operationId },
    });
    expect(
      description.items.map((item) => item.description.worktreeId),
    ).toEqual(['three']);
    // A discard refuses while the interrupted deletion is in place.
    await expect(
      discardWorktree({
        workspaceId: 'a',
        worktreeId: 'three',
        confirmation: description.items[0].description.confirmation,
        source: 'portal-ui',
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'project-deletion-pending',
    });

    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'portal',
        supersedeInterruptedDeletion: journal.operationId,
      }),
    ).rejects.toMatchObject({ reason: 'source-unavailable' });
    expect(await readDestructiveRecovery('a')).toBe(null);
    // The listed token still binds: superseding changed nothing it covers.
    await discardListedItems(description);
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
    ).resolves.toMatchObject({ removed: 'code' });
    expect(indexIds()).toEqual(['b', 'c']);
    expect(existsSync(`${repo}-unavailable`)).toBe(true);
  });

  it('lists nothing while any lifecycle journal is unreadable, so its own refusal and review stand', async () => {
    renameSync(repo, `${repo}-unavailable`);
    expect((await describeProjectDeletion()).status).toBe('discardable');
    plantUnreadableForeignJournal();

    expect(await describeProjectDeletion()).toMatchObject({
      status: 'refused',
      items: [],
    });
  });

  it.each([
    [
      'over a replaced project directory',
      (): void => {
        const moved = join(dir, 'a-moved');
        renameSync(join(root, 'a'), moved);
        cpSync(moved, join(root, 'a'), { recursive: true });
      },
    ],
    [
      'of a project the index no longer lists (CAN-5316)',
      (): void => {
        writeFileSync(
          join(root, 'index.json'),
          JSON.stringify({
            version: 1,
            workspaces: readIndex().filter((entry) => entry.id !== 'a'),
          }),
        );
        __resetSidebarItemsStateForTests();
      },
    ],
  ])(
    'is refused %s, and the deletion still refuses it',
    async (_label, plant) => {
      const journal = await interruptIndexRemoval();
      plant();

      expect(await describeProjectDeletion()).toMatchObject({
        status: 'refused',
        items: [],
      });
      await expect(
        deleteWorkspace({
          workspaceId: 'a',
          source: 'portal',
          supersedeInterruptedDeletion: journal.operationId,
        }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await readDestructiveRecovery('a')).toEqual(journal);
      expect(logMainProcessWarn).not.toHaveBeenCalledWith(
        supersedeLog,
        expect.anything(),
      );
    },
  );
});
