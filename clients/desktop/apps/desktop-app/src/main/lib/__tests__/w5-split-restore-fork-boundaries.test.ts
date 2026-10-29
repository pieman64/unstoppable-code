import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('../../agents/session-manager', () => ({
  getActiveChatIds: jest.fn(() => []),
  subscribeGlobalPluginDefaultsRevision: jest.fn(() => jest.fn()),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
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
jest.mock('../../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5000,
  recordLedgerMoveIntent: jest.fn(() => Promise.resolve('recorded')),
  discardLedgerMoveIntent: jest.fn(),
  notifyLedgerContainerMoved: jest.fn(),
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
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
    worktreeContainerRestored: jest.fn(() => Promise.resolve()),
    worktreeContainerPurged: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../../ipc/worktree-discovery', () => ({
  triggerDiscovery: jest.fn(),
}));
jest.mock('../code-graph-scheduler', () => ({
  scheduleCodeGraphBuild: jest.fn(),
  deferCodeGraphRefreshUntilPostCreateSetup: jest.fn(() => jest.fn()),
}));
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  splitTemporaryWorkspaceWorktree,
  drainSplitTemporaryWorkspaceBackgroundPhases,
  isSplitTemporaryWorkspaceInFlight,
} from '../split-temporary-workspace';
import * as git from '../git';
import { ownsW5RepositoryLock } from '../w5-repository-locks';
import * as locks from '../w5-repository-locks';
import {
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import * as splitItems from '../split-temporary-workspace-items';
import * as provenance from '../../shared-containers/fork/provenance';
import { getWorkspaceIndexRepository } from '../sidebar-items';
import { recordLedgerMoveIntent } from '../../ledger/lifecycle';
import { restoreArchivedContainer } from '../archived-container-restore';
import { forkSharedContainer } from '../../shared-containers/fork';
import {
  getArchivedContainerManifestPath,
  getArchivedContainerExecutionsDir,
} from '../paths';
import * as readerModule from '../../shared-containers/read/reader';
import * as reconciliationModule from '../../shared-containers/reconciliation-service';
import { SharedContainerReplicaManager } from '../../shared-containers/replica/manager';
import type { SharedContainerReplicaTransport } from '../../shared-containers/transport';
import type { ArchiveIoOperationRequest } from '../../archive/archive-io-protocol';
import type {
  ArchiveIoOperationType,
  ArchiveIoResultMap,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import {
  getChatStateService,
  resetChatStateServiceForTests,
} from '../../services/chat-state-service';
jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, finished: () => {} },
      }),
}));

jest.setTimeout(60000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let releaseMove: () => void;

beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture(() => [], ['temp']));
  writeFileSync(
    join(root, 'temp/workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      temporary: true,
      repos: [{ id: 'a', name: 'A', repoPath: repo }],
    }),
  );
  writeFileSync(
    join(root, 'temp/worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [
        { id: 'one', branchName: 'topic', createdAt: new Date().toISOString() },
      ],
    }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ['a', 'temp'].map((id, order) => ({
        id,
        name: id,
        type: id === 'temp' ? 'multi-repo' : 'single-repo',
        color: '#7C3AED',
        order,
      })),
    }),
  );
  const source = join(root, 'temp/worktrees/one/repos/a');
  mkdirSync(join(root, 'temp/worktrees/one/repos'), { recursive: true });
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'topic',
    source,
  ]);
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5/commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  const gate = new Promise<void>((resolve) => {
    releaseMove = resolve;
  });
  const move = git.moveWorktree;
  jest.spyOn(git, 'moveWorktree').mockImplementation(async (...args) => {
    expect(ownsW5RepositoryLock()).toBe(false);
    await gate;
    return move(...args);
  });
  jest.clearAllMocks();
});
afterEach(async () => {
  releaseMove();
  await drainSplitTemporaryWorkspaceBackgroundPhases();
  await settleDetachedWork();
  await getChatStateService().drain();
  resetChatStateServiceForTests();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});
function split(
  expectedRevision?: number,
  idempotencyKey?: string,
  changed = false,
): Promise<unknown> {
  const request = {
    workspaceId: 'temp',
    worktreeId: 'one',
    selections: {},
    rootAction: changed ? ('archive' as const) : ('delete' as const),
    expectedRevision,
    idempotencyKey,
  };
  return splitTemporaryWorkspaceWorktree(request);
}
function images(): string[] {
  return [
    'index.json',
    'a/workspace.json',
    'a/worktrees.json',
    'temp/workspace.json',
    'temp/worktrees.json',
  ].map((file) => readFileSync(join(root, file), 'utf8'));
}

async function prepareFork(cowork = false, repositoryCount = 1): Promise<void> {
  const replicaRoot = join(dir, 'replicas');
  const revisionRoot = join(replicaRoot, 'container/revisions/revision');
  mkdirSync(join(revisionRoot, 'artifacts'), { recursive: true });
  for (let index = 0; index < repositoryCount; index++)
    cpSync(repo, join(revisionRoot, 'repos', `repo-${index}`), {
      recursive: true,
    });
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  writeFileSync(
    join(revisionRoot, 'artifacts/container.json'),
    JSON.stringify({
      schemaVersion: 4,
      containerType: cowork ? 'COWORK_WORK_ENTRY' : 'CODE_WORKTREE',
      title: 'Fork',
      repositories: cowork
        ? []
        : Array.from({ length: repositoryCount }, (_value, index) => ({
            repoId: `repo-${index}`,
            repoName: `Forked-${index}`,
            source: 'snapshot',
            baseCommitSha: head,
            snapshot: {
              bundleArtifactIds: ['bundle'],
              treeFileCount: 0,
              treeBytes: '0',
            },
            files: [],
          })),
      files: [],
      notes: [],
      prompts: [],
      attachmentPaths: {},
      startPage: { kind: 'url', url: 'https://example.test' },
      layout: {
        orientation: 0,
        root: {
          type: 'leaf',
          size: 1,
          tabs: [{ kind: 'chat', chatId: 'chat' }],
          activeTabIndex: 0,
        },
      },
    }),
  );
  const unavailable = (): Promise<never> =>
    Promise.reject(new Error('Unexpected network access'));
  const transport: SharedContainerReplicaTransport = {
    resolveLatest: unavailable,
    fetchRevision: unavailable,
    requestDownloadUrls: unavailable,
  };
  const manager = new SharedContainerReplicaManager({
    rootDir: replicaRoot,
    transport,
  });
  await manager.store.set({
    containerId: 'container',
    containerType: cowork ? 'COWORK_WORK_ENTRY' : 'CODE_WORKTREE',
    status: 'available',
    revisionId: 'revision',
    revision: 1,
    revisionCreatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  jest
    .spyOn(readerModule, 'getSharedContainerReader')
    .mockReturnValue(new readerModule.SharedContainerReader(manager.store));
  jest
    .spyOn(reconciliationModule, 'getSharedContainerReconciliationService')
    .mockReturnValue(
      new reconciliationModule.SharedContainerReconciliationService(
        manager,
        transport,
      ),
    );
}
function prepareRestore(): void {
  const manifestPath = getArchivedContainerManifestPath('a', 'archived');
  mkdirSync(join(manifestPath, '..'), { recursive: true });
  writeFileSync(
    manifestPath,
    JSON.stringify({
      version: 1,
      id: 'archived',
      kind: 'worktree',
      projectId: 'a',
      name: 'Restored',
      createdAt: new Date().toISOString(),
      archivedAt: new Date().toISOString(),
      retentionDays: 30,
      expiresAt: new Date(Date.now() + 30 * 86400000).toISOString(),
      chatCount: 0,
      archivedChatCount: 0,
      executionCount: 0,
      workspaceType: 'single-repo',
    }),
  );
}
function invoke(
  kind: 'restore' | 'fork',
  expectedRevision?: number,
  idempotencyKey?: string,
  changed = false,
): Promise<unknown> {
  if (kind === 'restore')
    return restoreArchivedContainer('a', changed ? 'other' : 'archived', {
      expectedRevision,
      idempotencyKey,
    });
  return forkSharedContainer({
    containerId: 'container',
    revisionId: 'revision',
    sourceOwnerDisplayName: changed ? 'Other' : 'Ada',
    destination: { kind: 'new-workspace', parentDirectory: join(dir, 'forks') },
    expectedRevision,
    idempotencyKey,
  });
}
async function prepare(kind: 'restore' | 'fork'): Promise<void> {
  if (kind === 'restore') prepareRestore();
  else await prepareFork();
}
it.each(['restore', 'fork'] as const)(
  '%s refuses stale admission without writes or effects and releases the key',
  async (kind) => {
    await prepare(kind);
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    await expect(invoke(kind, 99, 'key')).rejects.toBeInstanceOf(
      W5RevisionConflictError,
    );
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'forks'))).toBe(false);
    await expect(invoke(kind, 0, 'key')).resolves.toBeDefined();
  },
);
it.each(['restore', 'fork'] as const)(
  '%s replays exactly its portable final DTO and refuses parameter reuse',
  async (kind) => {
    await prepare(kind);
    const first = await invoke(kind, 0, 'key');
    expect(JSON.stringify(first)).not.toContain(dir);
    const before = images();
    const commits = jest.spyOn(host, 'commit');
    expect(await invoke(kind, 99, 'key')).toStrictEqual(first);
    expect(images()).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
    await expect(invoke(kind, undefined, 'key', true)).rejects.toMatchObject({
      reason: 'key-reused',
    });
  },
);
it.each(['restore', 'fork'] as const)(
  '%s marks uncertain failures recovery-required despite existing rollback',
  async (kind) => {
    await prepare(kind);
    jest
      .spyOn(host, 'commit')
      .mockRejectedValueOnce(new Error('decision failed'));
    await expect(invoke(kind, 0, 'failed')).rejects.toThrow('decision failed');
    await expect(invoke(kind, 0, 'failed')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);
it('split refuses a stale revision before any effect and releases its key', async () => {
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  await expect(split(99, 'key')).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();
  await expect(split(0, 'key')).resolves.toBeDefined();
});
it('split replays its portable foreground outcome without restarting background work', async () => {
  const first = await split(0, 'key');
  expect(JSON.stringify(first)).not.toContain(dir);
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  expect(await split(99, 'key')).toStrictEqual(first);
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();
  await expect(split(undefined, 'key', true)).rejects.toMatchObject({
    reason: 'key-reused',
  });
  releaseMove();
  await drainSplitTemporaryWorkspaceBackgroundPhases();
  expect(await split(99, 'key')).toStrictEqual(first);
});
it('split retains recovery-required after an uncertain reservation decision even when cleanup runs', async () => {
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('decision failed'));
  await expect(split(0, 'failed')).rejects.toThrow('decision failed');
  await expect(split(0, 'failed')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('split groups a new destination publication, keeps its reservation separate and saves the foreground receipt last', async () => {
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        {
          id: 'temp',
          name: 'temp',
          type: 'multi-repo',
          color: '#7C3AED',
          order: 0,
        },
      ],
    }),
  );
  const beforeA = readFileSync(join(root, 'a/workspace.json'), 'utf8');
  const commits = jest.spyOn(host, 'commit');
  await split(0, 'grouped');
  expect(commits).toHaveBeenCalledTimes(3);
  const decisions = commits.mock.calls.map(([request]) => request);
  expect(decisions[0]?.files).toHaveLength(4); // includes the readable index backup
  expect(
    decisions[0]?.files.some((file) => file.path.endsWith('/index.json')),
  ).toBe(true);
  expect(decisions[1]?.files).toHaveLength(1);
  expect(decisions[0]?.receipt).toBeUndefined();
  expect(decisions[1]?.receipt).toBeUndefined();
  expect(decisions[2]?.receipt?.idempotencyKey).toBe('grouped');
  expect(readFileSync(join(root, 'a/workspace.json'), 'utf8')).toBe(beforeA);
});
it('fork groups destination index, manifest and list publication and carries its own collection revision', async () => {
  await prepareFork();
  const commits = jest.spyOn(host, 'commit');
  await invoke('fork', 0, 'grouped');
  const writes = commits.mock.calls
    .map(([request]) => request)
    .filter((request) => request.files.length);
  expect(writes).toHaveLength(5); // creation, start page, reservation, Git phase, readiness
  expect(writes[0]?.files).toHaveLength(4); // includes the readable index backup
  expect(writes[0]?.files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      join(root, 'index.json'),
      join(root, 'fork/workspace.json'),
      join(root, 'fork/worktrees.json'),
    ]),
  );
  expect(writes.every((request) => request.receipt === undefined)).toBe(true);
  const receipt = commits.mock.calls.at(-1)?.[0];
  expect(receipt?.receipt?.idempotencyKey).toBe('grouped');
  expect(receipt?.expectedRevisions).toEqual([
    { resource: { kind: 'workspaces' }, revision: 1 },
  ]);
});
function addEmptyTemporaryWorkspace(): string {
  mkdirSync(join(root, 'empty'), { recursive: true });
  writeFileSync(
    join(root, 'empty/workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      temporary: true,
      repos: [{ id: 'a', name: 'A', repoPath: repo }],
    }),
  );
  writeFileSync(
    join(root, 'empty/worktrees.json'),
    JSON.stringify({ version: 1, worktrees: [] }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ['a', 'temp', 'empty'].map((id, order) => ({
        id,
        name: id,
        type: id === 'a' ? 'single-repo' : 'multi-repo',
        color: '#7C3AED',
        order,
      })),
    }),
  );
  __resetSidebarItemsStateForTests();
  return readFileSync(join(root, 'empty/workspace.json'), 'utf8');
}
it('new-destination publication reads no other workspace inside its scope', async () => {
  await prepareFork();
  const emptyManifest = addEmptyTemporaryWorkspace();
  const lockOrderErrors: unknown[] = [];
  const acquire = locks.withW5RepositoryLock;
  jest
    .spyOn(locks, 'withW5RepositoryLock')
    .mockImplementation(async (...args) => {
      try {
        return await acquire(...args);
      } catch (error) {
        if (error instanceof Error && error.message.includes('lock order'))
          lockOrderErrors.push(error);
        throw error;
      }
    });
  await invoke('fork');
  await split();
  expect(lockOrderErrors).toEqual([]);
  expect(readFileSync(join(root, 'empty/workspace.json'), 'utf8')).toBe(
    emptyManifest,
  );
});
it('split refuses a foreign source revision after migration without absorbing it into its carried precondition', async () => {
  const migrate = splitItems.migrateSplitChatsAndPlans;
  jest
    .spyOn(splitItems, 'migrateSplitChatsAndPlans')
    .mockImplementationOnce(async (...args) => {
      const result = await migrate(...args);
      await updateWorkspaceConfig('temp', (config) => {
        config.alwaysShow = true;
      });
      return result;
    });
  await expect(split(0, 'conflict')).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  expect(git.moveWorktree).not.toHaveBeenCalled();
  await expect(split(0, 'conflict')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('restore carries its reservation revision and refuses a foreign collection edit after Git', async () => {
  prepareRestore();
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementationOnce(async (...args) => {
    const result = await create(...args);
    await updateWorkspaceWorktrees('a', (rows) => [
      ...rows,
      {
        id: 'foreign',
        branchName: 'foreign',
        createdAt: new Date().toISOString(),
      },
    ]);
    return result;
  });
  await expect(invoke('restore', 0, 'conflict')).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  await expect(invoke('restore', 0, 'conflict')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('fork refuses a foreign collection edit after its own publication and before the final receipt', async () => {
  await prepareFork();
  const write = provenance.writeForkProvenanceForDestination;
  jest
    .spyOn(provenance, 'writeForkProvenanceForDestination')
    .mockImplementationOnce(async (...args) => {
      const result = await write(...args);
      await getWorkspaceIndexRepository().update((snapshot) => ({
        entries: snapshot.entries.filter((entry) => entry.id !== 'a'),
        result: undefined,
      }));
      return result;
    });
  await expect(invoke('fork', 0, 'conflict')).rejects.toBeInstanceOf(
    W5RevisionConflictError,
  );
  await expect(invoke('fork', 0, 'conflict')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});
it('split keeps its foreground receipt when background rollback reports failure', async () => {
  jest.mocked(recordLedgerMoveIntent).mockResolvedValueOnce('not_durable');
  const first = await split(0, 'background-failure');
  releaseMove();
  await drainSplitTemporaryWorkspaceBackgroundPhases();
  expect(await split(99, 'background-failure')).toStrictEqual(first);
});
it('a Cowork fork carries its grouped creation decision through settings and entry creation', async () => {
  await prepareFork(true);
  const commits = jest.spyOn(host, 'commit');
  const first = await invoke('fork', 0, 'cowork');
  expect(first).toMatchObject({ containerType: 'COWORK_WORK_ENTRY' });
  expect(commits.mock.calls[0]?.[0].files.map((file) => file.path)).toEqual(
    expect.arrayContaining([
      join(root, 'index.json'),
      join(root, 'fork/workspace.json'),
    ]),
  );
  expect(await invoke('fork', 99, 'cowork')).toStrictEqual(first);
});
it('restore saves the final partial outcome after execution migration changes the warnings', async () => {
  prepareRestore();
  const executions = getArchivedContainerExecutionsDir('a', 'archived');
  mkdirSync(executions, { recursive: true });
  writeFileSync(join(executions, 'broken.json'), '{');
  const first = await invoke('restore', 0, 'partial');
  expect(first).toMatchObject({
    warnings: ['Pipeline executions failed to restore: broken.'],
  });
  expect(await invoke('restore', 99, 'partial')).toStrictEqual(first);
  expect(JSON.stringify(first)).not.toContain(dir);
});

it('a multi-repo fork carries child creation and repository decisions without a lock across Git', async () => {
  await prepareFork(false, 2);
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
    expect(ownsW5RepositoryLock()).toBe(false);
    return create(...args);
  });
  const first = await invoke('fork', 0, 'multi');
  expect(first).toMatchObject({ containerType: 'CODE_WORKTREE' });
  expect(await invoke('fork', 99, 'multi')).toStrictEqual(first);
});
it('split starts no background lifecycle when its final receipt decision fails', async () => {
  const commit = host.commit.bind(host);
  jest.spyOn(host, 'commit').mockImplementation((request) => {
    if (request.receipt) return Promise.reject(new Error('receipt failed'));
    return commit(request);
  });
  await expect(split(0, 'receipt-failed')).rejects.toThrow('receipt failed');
  expect(git.moveWorktree).not.toHaveBeenCalled();
  expect(isSplitTemporaryWorkspaceInFlight('temp', 'one')).toBe(false);
  await expect(split(0, 'receipt-failed')).rejects.toMatchObject({
    reason: 'recovery-required',
  });
});

it('restore releases a read-only child refusal before worktree creation effects', async () => {
  prepareRestore();
  const config = join(root, 'a/workspace.json');
  const valid = readFileSync(config, 'utf8');
  writeFileSync(
    config,
    JSON.stringify({ version: 1, type: 'single-repo', repos: [] }),
  );
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  await expect(invoke('restore', 0, 'refused')).rejects.toMatchObject({
    reason: 'unsupported-workspace',
  });
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();
  writeFileSync(config, valid);
  await expect(invoke('restore', 0, 'refused')).resolves.toBeDefined();
});
