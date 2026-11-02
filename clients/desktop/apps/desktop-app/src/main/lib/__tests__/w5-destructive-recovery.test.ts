import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL } from '@canopy/protocol/portal/lifecycle-journal';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
import {
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import type * as FsPromises from 'node:fs/promises';
import { archiveWorktree, deleteWorktree } from '../worktree-archive';
import {
  deleteWorkspace,
  retryWorkspaceDeletionSearchCleanup,
} from '../workspace-deletion';
jest.mock('../auto-archive-teardown', () => ({
  runAutoArchiveTeardown: jest.fn(() => Promise.resolve()),
}));
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
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
// Same real worker/filesystem harness as part 4, with production command callers.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
import type * as CoreStorage from '@canopy/core-runtime/storage';
// W6g: the same rows every checked writer reads, daemon-owned on the daemon side.
jest.mock('@canopy/core-runtime/storage', () => {
  const actual = jest.requireActual<typeof CoreStorage>(
    '@canopy/core-runtime/storage',
  );
  const rows: CoreStorage.StorageOwnershipRow[] = [...actual.STORAGE_OWNERSHIP];
  return {
    ...actual,
    STORAGE_OWNERSHIP: rows,
    setDaemonOwnedForTest: (namespaceIds: readonly string[]): void => {
      actual.STORAGE_OWNERSHIP.forEach((row, index) => {
        rows[index] = namespaceIds.includes(row.id)
          ? { ...row, transitionOwner: 'daemon', currentWriters: [] }
          : row;
      });
    },
  };
});
const { setDaemonOwnedForTest } = jest.requireMock<{
  setDaemonOwnedForTest: (namespaceIds: readonly string[]) => void;
}>('@canopy/core-runtime/storage');
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
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

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  readW5Revisions,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  installW5StoreSide,
  W5_STORE_SIDES,
  type W5StoreSide,
} from './fixtures/w5-store-sides';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceWorktree,
} from '../workspace-persistence';
import {
  destructiveStep,
  destructiveCleanup,
  assertFailedChildArchivesResumed,
  assertNoDestructiveRecovery,
  assertNoLegacyArchiveRecovery,
  completeSupersededChildArchives,
  hasUnresolvedDestructiveRecovery,
  isStepFreeDestructiveFailure,
  protectDestructivePath,
  acknowledgeArchiveCaptureRefusal,
  readInFlightWorktreeDestructiveOperations,
  resumableDestructiveStep,
  runStepFreeChildLifecycles,
  withDestructiveLifecycle,
  type DestructivePhase,
  type DestructiveRecoveryRecord,
} from '../w5-destructive-recovery';
import * as sharedAtomicFile from '@canopy/desktop-shared/node/lib/atomic-file';
import { logMainProcessWarn } from '../main-process-logging';
import * as gitModule from '../git';
import {
  getArchivedContainerDir,
  getArchivedContainersRootDir,
  getW5DestructiveLifecycleDir,
  getWorkspaceDir,
  getWorkspaceWorktreeDir,
  getWorktreeDataDir,
} from '../paths';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import { workspaceRootPayloadDigest } from '../archived-container-git';

jest.mock('../../archive/archive-io-runner', () => ({
  // Replace Electron utility-process transport with the real filesystem engine.
  runArchiveIoRequest: (
    request: ArchiveIoOperationRequest,
  ): Promise<ArchiveIoResultMap[ArchiveIoOperationType]> =>
    jest
      .requireActual<typeof ArchiveEngine>('../../archive/archive-io-engine')
      .executeArchiveIoRequest(request, new AbortController().signal, {
        progress: () => {},
        child: { started: () => {}, exited: () => {} },
      }),
}));

import type {
  ArchiveIoOperationRequest,
  ArchiveIoResultMap,
  ArchiveIoOperationType,
} from '../../archive/archive-io-protocol';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));

jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));
jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();

beforeEach(() => {
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
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
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
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
  jest.clearAllMocks();
});
afterEach(async () => {
  // An archive's background disk-usage commit resolves the manifest path when
  // it writes; finish it before CANOPY_DATA_DIR moves to the next test, or it
  // plants this test's manifest (and createdAt) in the next test's archive.
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const archiveRequest = {
  workspaceId: 'a',
  worktreeId: 'one',
  source: 'single_repo' as const,
  deleteWithoutRetentionIfMissing: true,
};

/**
 * W6g PR B (CAN-5506): installs `side`'s store over the current host in each
 * test, so the keyed cases below also run over the daemon record port.
 */
function useStoreSide(side: W5StoreSide): {
  reinstall: () => Promise<void>;
  uncertain: (message: string) => string;
} {
  let teardown = (): Promise<void> => Promise.resolve();
  const reinstall = async (): Promise<void> => {
    await teardown();
    teardown = await installW5StoreSide(side, {
      host,
      root,
      setDaemonOwned: setDaemonOwnedForTest,
    });
  };
  beforeEach(reinstall);
  afterEach(() => teardown());
  return {
    reinstall,
    // A failed decision call: the daemon reports it uncertain, with fixed text.
    uncertain: (message) =>
      side === 'daemon' ? 'The W5 record port call failed.' : message,
  };
}

describe.each(W5_STORE_SIDES)('over the %s store', (side) => {
  const { reinstall: reinstallStoreSide, uncertain } = useStoreSide(side);

  it('interrupted unkeyed deletion cannot resume destructive cleanup on retry', async () => {
    jest
      .spyOn(host, 'commit')
      .mockRejectedValueOnce(new Error('decision unavailable'));
    await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
      uncertain('decision unavailable'),
    );
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
    await expect(deleteWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  });

  it('interrupted unkeyed deletion preserves manual recovery across worker restart', async () => {
    jest
      .spyOn(host, 'commit')
      .mockRejectedValueOnce(new Error('decision unavailable'));
    await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
      uncertain('decision unavailable'),
    );
    await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
    __resetSidebarItemsStateForTests();
    host = new W5CommitLogHost({
      dbPath: join(dir, 'w5', 'commit-log.sqlite'),
      root,
      workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
    });
    await reinstallStoreSide();
    await expect(deleteWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(
      (await readWorkspaceWorktrees('a')).some((row) => row.id === 'one'),
    ).toBe(true);
  });

  it('workspace deletion never removes a replacement directory after the index commit', async () => {
    const commit = host.commit.bind(host);
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      const result = await commit(request);
      if (
        request.operation === 'core.workspace.delete' &&
        request.files.length
      ) {
        renameSync(join(root, 'a'), join(root, 'old-a'));
        mkdirSync(join(root, 'a'));
        writeFileSync(join(root, 'a', 'replacement'), 'keep');
      }
      return result;
    });
    await expect(
      deleteWorkspace({
        workspaceId: 'a',
        source: 'shared_container_fork',
        idempotencyKey: 'delete',
      }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(readFileSync(join(root, 'a', 'replacement'), 'utf8')).toBe('keep');
  });
});

import * as atomicFile from '../atomic-file';
import {
  findCompletedDestructiveArchive,
  readDestructiveRecovery,
  reportDestructiveRecovery,
} from '../w5-destructive-recovery';
import { getChatSearchService } from '../../chat-search/service';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { reconcileGitPendingWorktrees } from '../worktree-boot-recovery';
import {
  reconcileArchivedGitRefsForWorkspace,
  recoverArchivedGitTeardownsForWorkspace,
} from '../archived-container-git';

function interrupt(
  phase: string,
  state: 'pending' | 'done',
  reached: () => void | Promise<void> = () => {
    throw new Error('controlled interruption');
  },
): () => boolean {
  const write = atomicFile.writeFileAtomically;
  let fired = false;
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (file, contents, options) => {
      await write(file, contents, options);
      if (
        !fired &&
        file.includes('destructive-lifecycles') &&
        typeof contents === 'string'
      ) {
        const record = z
          .object({
            state: z.string(),
            steps: z.array(z.object({ phase: z.string(), state: z.string() })),
          })
          .parse(JSON.parse(contents));
        if (
          record.state === 'active' &&
          record.steps.some(
            (step: { phase: string; state: string }) =>
              step.phase === phase && step.state === state,
          )
        ) {
          fired = true;
          await reached();
        }
      }
    });
  return () => fired;
}
async function restart(): Promise<void> {
  await settleDetachedWork();
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  __resetSidebarItemsStateForTests();
  resetChatStateServiceForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  await host.recoveryReport();
}
// Jest reports a rejection by its message alone; keep the refusal's check and
// call site so a merge-queue failure names the condition that refused.
function withRefusalDetails<T>(work: Promise<T>): Promise<T> {
  return work.catch((error: unknown) => {
    if (!(error instanceof Error) || !('details' in error)) throw error;
    throw new Error(
      `${String(error.stack)}\ndetails: ${JSON.stringify(error.details)}`,
    );
  });
}
function multiRepo(): void {
  const child = join(dir, 'child');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, child]);
  const checkout = join(root, 'a', 'worktrees', 'one');
  writeFileSync(join(checkout, '.gitignore'), 'repos/\n');
  execFileSync('git', ['-C', checkout, 'add', '.gitignore']);
  execFileSync('git', [
    '-C',
    checkout,
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    'ignore children',
  ]);
  execFileSync('git', [
    '-C',
    child,
    'worktree',
    'add',
    '-q',
    '-b',
    'child-old',
    join(checkout, 'repos', 'child'),
  ]);
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos: [{ id: 'child', name: 'child', repoPath: child }],
    }),
  );
  const index = z
    .object({
      version: z.number(),
      workspaces: z.array(z.object({ type: z.string() }).passthrough()),
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')));
  index.workspaces[0].type = 'multi-repo';
  writeFileSync(join(root, 'index.json'), JSON.stringify(index));
  __resetSidebarItemsStateForTests();
}

const deletionPhases = [
  'live-state-teardown',
  'checkout-removal',
  'branch-deletion',
  'pipeline-cleanup',
  'turn-diff-cleanup',
  'sidecar:chat state',
  'sidecar:attachments',
  'sidecar:browser tab state',
  'sidecar:tracked plans',
  'sidecar:worktree metadata',
  'canonical-row-removal',
  'browser-retirement',
  'deferred-browser-retirement',
  'watcher-commit',
  'temporary-workspace-cleanup',
];
it.each(
  (['single-repo', 'multi-repo'] as const).flatMap((kind) =>
    deletionPhases.flatMap((phase) =>
      (['pending', 'done'] as const).map((state) => ({ kind, phase, state })),
    ),
  ),
)(
  '$kind delete preserves evidence at $phase / $state',
  async ({ kind, phase, state }) => {
    if (kind === 'multi-repo') multiRepo();
    const fired = interrupt(phase, state);
    const request = {
      ...archiveRequest,
      source:
        kind === 'multi-repo'
          ? ('multi_repo' as const)
          : ('single_repo' as const),
      idempotencyKey: 'fault',
      deleteBranch: true,
    };
    await expect(deleteWorktree(request)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    const record = await readDestructiveRecovery('a', 'one');
    expect(record).toMatchObject({
      state: 'recovery-required',
    });
    expect(record?.steps).toContainEqual({ phase, state });
    await expect(deleteWorktree(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect((await reportDestructiveRecovery())[0]?.operationId).toBe(
      record?.operationId,
    );
  },
);

it.each(
  ['canonical-index-removal', 'workspace-directory-removal'].flatMap((phase) =>
    (['pending', 'done'] as const).map((state) => ({ phase, state })),
  ),
)(
  'workspace delete preserves evidence at $phase / $state',
  async ({ phase, state }) => {
    const fired = interrupt(phase, state);
    const request = {
      workspaceId: 'a',
      source: 'shared_container_fork' as const,
      idempotencyKey: 'fault',
    };
    await expect(deleteWorkspace(request)).rejects.toThrow(
      'controlled interruption',
    );
    expect(fired()).toBe(true);
    const record = await readDestructiveRecovery('a');
    expect(record?.steps).toContainEqual({ phase, state });
    await restart();
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect((await reportDestructiveRecovery())[0]).toMatchObject({
      operationId: record?.operationId,
      state: 'recovery-required',
    });
  },
);

const retainedPhases = [
  'retained-payload-capture',
  'git-capture',
  'provider-capture',
  'checkout-quarantine',
  'git-worktree-removal',
  'quarantine-directory-removal',
  'retained-manifest-commit',
  'git-capture-completion',
];
it.each(
  (['single-repo', 'multi-repo'] as const).flatMap((kind) =>
    retainedPhases.flatMap((phase) =>
      (['pending', 'done'] as const).map((state) => ({ kind, phase, state })),
    ),
  ),
)(
  'retained $kind archive preserves evidence at $phase / $state',
  async ({ kind, phase, state }) => {
    if (kind === 'multi-repo') multiRepo();
    const fired = interrupt(phase, state);
    const request = {
      ...archiveRequest,
      source:
        kind === 'multi-repo'
          ? ('multi_repo' as const)
          : ('single_repo' as const),
    };
    await expect(archiveWorktree(request)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    const record = await readDestructiveRecovery('a', 'one');
    expect(record?.steps).toContainEqual({ phase, state });
    await recoverArchivedGitTeardownsForWorkspace('a');
    if (phase === 'git-capture-completion' && state === 'done') {
      await restart();
      await expect(archiveWorktree(request)).resolves.toMatchObject({
        success: true,
      });
    } else {
      await expect(archiveWorktree(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    }
    expect((await readDestructiveRecovery('a', 'one'))?.operationId).toBe(
      record?.operationId,
    );
  },
);

it.each(['single-repo', 'multi-repo'] as const)(
  'retry finishes a committed %s archive after a crash during sidecar cleanup',
  async (kind) => {
    if (kind === 'multi-repo') multiRepo();
    mkdirSync(join(root, 'a', 'worktree-data', 'one'), { recursive: true });
    const request = {
      ...archiveRequest,
      source:
        kind === 'multi-repo'
          ? ('multi_repo' as const)
          : ('single_repo' as const),
    };
    const fired = interrupt('sidecar:chat plugin state', 'pending');
    await expect(archiveWorktree(request)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    const before = await readDestructiveRecovery('a', 'one');
    expect(before?.steps).toContainEqual({
      phase: 'git-capture-completion',
      state: 'done',
    });
    const manifestPath = join(
      getArchivedContainerDir('a', 'one'),
      'container.json',
    );
    const manifest = readFileSync(manifestPath);
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
    await restart();

    expect(await archiveWorktree(request)).toMatchObject({ success: true });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject(
      JSON.parse(manifest.toString()),
    );
    const after = await readDestructiveRecovery('a', 'one');
    expect(after).toMatchObject({
      operationId: before?.operationId,
      state: 'completed',
    });
    expect(after?.steps.some((step) => step.state === 'pending')).toBe(false);
    expect(await archiveWorktree(request)).toMatchObject({
      status: 'already-archived',
    });
  },
);

it.each(['active', 'recovery-required'] as const)(
  'retry finishes the original operation from a persisted %s journal',
  async (state) => {
    interrupt('sidecar:chat plugin state', 'pending');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    const record = await readDestructiveRecovery('a', 'one');
    const directory = join(dir, 'data', 'w5', 'destructive-lifecycles');
    const name = readdirSync(directory).find((name) => name.endsWith('.json'));
    if (!name || !record) throw new Error('Missing recovery evidence');
    writeFileSync(join(directory, name), JSON.stringify({ ...record, state }));
    await restart();
    expect(await archiveWorktree(archiveRequest)).toMatchObject({
      success: true,
    });
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      operationId: record.operationId,
      state: 'completed',
    });
  },
);

it('refuses cleanup recovery from a partial worktree list without rewriting any rows', async () => {
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  const listPath = join(root, 'a', 'worktrees.json');
  const parsed = z
    .object({ worktrees: z.array(z.unknown()) })
    .passthrough()
    .parse(JSON.parse(readFileSync(listPath, 'utf8')));
  parsed.worktrees.push({
    id: 'unreadable',
    branchName: 123,
    createdAt: 'invalid',
  });
  writeFileSync(listPath, JSON.stringify(parsed));
  const list = readFileSync(listPath);
  const journal = await readDestructiveRecovery('a', 'one');
  await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(readFileSync(listPath)).toEqual(list);
  expect(await readDestructiveRecovery('a', 'one')).toEqual(journal);
});

it('refuses a partial list introduced immediately before the canonical recovery write', async () => {
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  jest.spyOn(atomicFile, 'writeFileAtomically').mockRestore();
  const listPath = join(root, 'a', 'worktrees.json');
  let changed: Buffer | undefined;
  const fired = interrupt('canonical-row-removal', 'pending', () => {
    const parsed = z
      .object({ worktrees: z.array(z.unknown()) })
      .passthrough()
      .parse(JSON.parse(readFileSync(listPath, 'utf8')));
    parsed.worktrees.push({
      id: 'unreadable',
      branchName: 123,
      createdAt: 'invalid',
    });
    writeFileSync(listPath, JSON.stringify(parsed));
    changed = readFileSync(listPath);
  });
  await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(fired()).toBe(true);
  expect(readFileSync(listPath)).toEqual(changed);
});

it('finishes committed cleanup after the retained manifest expires', async () => {
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  const file = join(getArchivedContainerDir('a', 'one'), 'container.json');
  const manifest = z
    .object({ expiresAt: z.string() })
    .passthrough()
    .parse(JSON.parse(readFileSync(file, 'utf8')));
  writeFileSync(
    file,
    JSON.stringify({
      ...manifest,
      archivedAt: '2000-01-01T00:00:00.000Z',
      expiresAt: '2000-04-01T00:00:00.000Z',
    }),
  );
  expect(
    await withRefusalDetails(archiveWorktree(archiveRequest)),
  ).toMatchObject({ success: true });
  expect(
    z
      .object({ expiresAt: z.string() })
      .parse(JSON.parse(readFileSync(file, 'utf8'))).expiresAt,
  ).toBe('2000-04-01T00:00:00.000Z');
});

it('finishes committed cleanup with a stale caller revision after the row advances', async () => {
  const [before] = await readW5Revisions([
    { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
  ]);
  if (!before) throw new Error('Missing initial revision');
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  await updateWorkspaceWorktree('a', 'one', (row) => ({
    ...row,
    label: 'Interrupted archive',
  }));
  await expect(
    deleteWorktree({ ...archiveRequest, expectedRevision: before.revision }),
  ).resolves.toMatchObject({ success: true });
});

it('a second crash during cleanup can be retried without changing the operation or archive', async () => {
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  const original = await readDestructiveRecovery('a', 'one');
  await restart();
  jest.spyOn(atomicFile, 'writeFileAtomically').mockRestore();
  const fired = interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  expect(fired()).toBe(true);
  expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
    operationId: original?.operationId,
    state: 'recovery-required',
  });
  await restart();
  expect(await archiveWorktree(archiveRequest)).toMatchObject({
    success: true,
  });
  expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
    operationId: original?.operationId,
    state: 'completed',
  });
});

it.each(['pending', 'done'] as const)(
  'Delete finishes a retained archive interrupted at canonical row removal / %s',
  async (state) => {
    const fired = interrupt('canonical-row-removal', state);
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    const record = await readDestructiveRecovery('a', 'one');
    await restart();
    expect(await deleteWorktree(archiveRequest)).toMatchObject({
      success: true,
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(
      existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
    ).toBe(true);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      operationId: record?.operationId,
      state: 'completed',
    });
  },
);

it.each(['checkout', 'metadata', 'workspace', 'row', 'manifest'] as const)(
  'archive cleanup retry preserves a changed %s identity',
  async (changed) => {
    mkdirSync(join(root, 'a', 'worktree-data', 'one'), { recursive: true });
    interrupt('sidecar:chat plugin state', 'pending');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    await restart();
    const checkout = join(root, 'a', 'worktrees', 'one');
    const metadata = join(root, 'a', 'worktree-data', 'one');
    if (changed === 'checkout') mkdirSync(checkout, { recursive: true });
    if (changed === 'metadata') {
      if (existsSync(metadata)) renameSync(metadata, metadata + '-old');
      mkdirSync(metadata, { recursive: true });
    }
    if (changed === 'workspace') {
      renameSync(join(root, 'a'), join(root, 'old-a'));
      mkdirSync(join(root, 'a'), { recursive: true });
    }
    if (changed === 'row') {
      const file = join(root, 'a', 'worktrees.json');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replaceAll(
          (await readWorkspaceWorktrees('a'))[0].createdAt,
          '2099-01-01T00:00:00.000Z',
        ),
      );
    }
    if (changed === 'manifest') {
      const file = join(getArchivedContainerDir('a', 'one'), 'container.json');
      writeFileSync(
        file,
        readFileSync(file, 'utf8').replaceAll(
          (await readWorkspaceWorktrees('a'))[0].createdAt,
          '2099-01-01T00:00:00.000Z',
        ),
      );
    }
    const journal = await readDestructiveRecovery('a', 'one');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(await readDestructiveRecovery('a', 'one')).toEqual(journal);
    if (changed === 'checkout') expect(existsSync(checkout)).toBe(true);
    if (changed === 'metadata') expect(existsSync(metadata)).toBe(true);
  },
);

it('completed archive replays its saved result after restart and protects a replacement incarnation', async () => {
  const createdAt = (await readWorkspaceWorktrees('a'))[0].createdAt;
  const first = await archiveWorktree(archiveRequest);
  await restart();
  const commits = jest.spyOn(host, 'commit');
  expect(
    await archiveWorktree({ ...archiveRequest, expectedRevision: 999 }),
  ).toEqual({ ...first, status: 'already-archived' });
  const rows = z
    .object({
      version: z.number(),
      worktrees: z.array(
        z
          .object({
            id: z.string(),
            createdAt: z.string(),
            branchName: z.string(),
          })
          .passthrough(),
      ),
    })
    .passthrough()
    .parse(JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')));
  rows.worktrees.push({
    id: 'one',
    branchName: 'replacement',
    createdAt: '2099-01-01T00:00:00.000Z',
  });
  writeFileSync(join(root, 'a', 'worktrees.json'), JSON.stringify(rows));
  mkdirSync(join(root, 'a', 'worktrees', 'one'), { recursive: true });
  writeFileSync(join(root, 'a', 'worktrees', 'one', 'keep'), 'replacement');
  expect(
    await archiveWorktree({
      ...archiveRequest,
      expectedCreatedAt: createdAt,
      expectedRevision: 999,
    }),
  ).toEqual({ ...first, status: 'already-archived' });
  expect(commits).not.toHaveBeenCalled();
  expect(
    readFileSync(join(root, 'a', 'worktrees', 'one', 'keep'), 'utf8'),
  ).toBe('replacement');
});

it('launch preserves an interrupted destructive row while keeping ordinary reconciliation', async () => {
  interrupt('checkout-removal', 'done');
  await expect(deleteWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  await reconcileGitPendingWorktrees();
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'one',
  ]);
  expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
    'recovery-required',
  );
});

it('committed workspace deletion keeps failed cleanup in its receipt and repairs only search rows', async () => {
  const search = getChatSearchService();
  const deleteDocs = jest
    .spyOn(search, 'deleteWorkspaceDocs')
    .mockRejectedValueOnce(new Error('index unavailable'));
  jest.mocked(getChatSearchService).mockReturnValue(search);
  const request = {
    workspaceId: 'a',
    source: 'shared_container_fork' as const,
    idempotencyKey: 'cleanup',
  };
  const first = await deleteWorkspace(request);
  expect(first.cleanup.chatSearchRows.status).toBe('failed');
  const record = await readDestructiveRecovery('a');
  if (!record) throw new Error('missing deletion evidence');
  expect(record).toMatchObject({ state: 'completed', cleanupRequired: true });
  const commits = jest.spyOn(host, 'commit');
  expect(await deleteWorkspace(request)).toEqual(first);
  const indexPath = join(root, 'index.json');
  const indexBefore = readFileSync(indexPath, 'utf8');
  writeFileSync(indexPath, '{unreadable');
  await expect(
    retryWorkspaceDeletionSearchCleanup({
      source: 'manual_repair',
      workspaceId: 'a',
      operationId: record.operationId,
    }),
  ).rejects.toBeDefined();
  expect(deleteDocs).toHaveBeenCalledTimes(1);
  writeFileSync(indexPath, indexBefore);
  await retryWorkspaceDeletionSearchCleanup({
    source: 'manual_repair',
    workspaceId: 'a',
    operationId: record.operationId,
  });
  expect(commits).not.toHaveBeenCalled();
  expect(deleteDocs).toHaveBeenCalledTimes(2);
  expect(await deleteWorkspace(request)).toEqual(first);
  expect((await readDestructiveRecovery('a'))?.cleanupRequired).toBe(false);
});

it('blocks workspace deletion on an unresolved child journal after its row is gone', async () => {
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-delete',
        workspaceId: 'a',
        worktreeId: 'removed-child',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      async () => {
        await expect(
          destructiveStep('checkout-removal', () =>
            Promise.reject(new Error('interrupted')),
          ),
        ).rejects.toThrow('interrupted');
        throw new Error('interrupted');
      },
    ),
  ).rejects.toThrow('interrupted');
  expect(await readDestructiveRecovery('a', 'removed-child')).toMatchObject({
    state: 'recovery-required',
  });

  await expect(
    deleteWorkspace({
      workspaceId: 'a',
      source: 'shared_container_fork',
      idempotencyKey: 'child-journal',
    }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(existsSync(join(root, 'a'))).toBe(true);
});

describe('step-free child lifecycles (CAN-4993)', () => {
  const child = {
    operation: 'worktree-archive' as const,
    workspaceId: 'q',
    worktreeId: 'w',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const parent = (
    beforeEffects?: () => void,
  ): {
    operation: 'workspace-delete';
    workspaceId: string;
    beforeEffects?: () => void;
  } => ({
    operation: 'workspace-delete',
    workspaceId: 'q',
    ...(beforeEffects ? { beforeEffects } : {}),
  });
  const fail = (message: string) => (): Promise<never> =>
    Promise.reject(new Error(message));
  const succeed = (): Promise<void> => Promise.resolve();

  it('a failing first script step withdraws both journals and restores an earlier completed one', async () => {
    await withDestructiveLifecycle(parent(), () =>
      destructiveStep('session-teardown', succeed),
    );
    const earlier = await readDestructiveRecovery('q');
    expect(earlier).toMatchObject({ state: 'completed' });
    const beforeEffects = jest.fn();
    let thrown: unknown;

    await withDestructiveLifecycle(parent(beforeEffects), () =>
      runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('teardown-script', fail('script failed'), {
            stepFreeAsFirstChildStep: true,
          }),
        ),
      ),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(thrown).toMatchObject({ message: 'script failed' });
    expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
    expect(beforeEffects).not.toHaveBeenCalled();
    expect(await readDestructiveRecovery('q')).toEqual(earlier);
    expect(await readDestructiveRecovery('q', 'w')).toBe(null);
    expect(await reportDestructiveRecovery()).toEqual([]);
  });

  it('a later child failure keeps that child journal, withdraws the parent and leaves the earlier child completed', async () => {
    const beforeEffects = jest.fn();
    let thrown: unknown;

    await withDestructiveLifecycle(parent(beforeEffects), () =>
      runStepFreeChildLifecycles(async () => {
        await withDestructiveLifecycle({ ...child, worktreeId: 'done' }, () =>
          destructiveStep('teardown-script', succeed, {
            stepFreeAsFirstChildStep: true,
          }),
        );
        await withDestructiveLifecycle(child, async () => {
          await destructiveStep('live-state-teardown', succeed);
          // A script step that is not the child's first keeps its journal.
          await destructiveStep('teardown-script', fail('later failure'), {
            stepFreeAsFirstChildStep: true,
          });
        });
      }),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
    expect(beforeEffects).not.toHaveBeenCalled();
    expect(await readDestructiveRecovery('q')).toBe(null);
    expect(await readDestructiveRecovery('q', 'done')).toMatchObject({
      state: 'completed',
    });
    expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
      state: 'recovery-required',
      steps: [
        { phase: 'live-state-teardown', state: 'done' },
        { phase: 'teardown-script', state: 'pending' },
      ],
    });
  });

  it('children count as the parent effects once it takes an ordinary step', async () => {
    const beforeEffects = jest.fn();

    await withDestructiveLifecycle(parent(beforeEffects), async () => {
      await runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('live-state-teardown', succeed),
        ),
      );
      // A resumable step keeps deferring them (CAN-5011).
      await resumableDestructiveStep('retained-git-cleanup', succeed);
      expect(beforeEffects).not.toHaveBeenCalled();
      await destructiveStep('session-teardown', succeed);
      expect(beforeEffects).toHaveBeenCalled();
    });

    expect(await readDestructiveRecovery('q')).toMatchObject({
      state: 'completed',
      steps: [
        { phase: expect.stringMatching(/^child:/) as unknown },
        { phase: 'retained-git-cleanup', state: 'done' },
        { phase: 'session-teardown', state: 'done' },
      ],
    });
  });

  it('children count as the parent effects when it completes with its journal', async () => {
    const beforeEffects = jest.fn();
    let effectsWhenSettled: number | undefined;

    await withDestructiveLifecycle(parent(beforeEffects), async () => {
      await runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('live-state-teardown', succeed),
        ),
      );
      expect(beforeEffects).not.toHaveBeenCalled();
    }).finally(() => {
      effectsWhenSettled = beforeEffects.mock.calls.length;
    });

    expect(effectsWhenSettled).toBeGreaterThan(0);
    expect((await readDestructiveRecovery('q'))?.steps).toHaveLength(1);
  });

  it.each([
    ['the child archives', false],
    ['the child archives and a resumable step', true],
  ])(
    'a parent failure outside its steps after %s withdraws its journal and is step-free (CAN-5011)',
    async (_label, resumable) => {
      await withDestructiveLifecycle(parent(), () =>
        destructiveStep('session-teardown', succeed),
      );
      const earlier = await readDestructiveRecovery('q');
      const beforeEffects = jest.fn();
      let thrown: unknown;

      await withDestructiveLifecycle(parent(beforeEffects), async () => {
        await runStepFreeChildLifecycles(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('live-state-teardown', succeed),
          ),
        );
        if (resumable)
          await resumableDestructiveStep('retained-git-cleanup', succeed);
        throw new Error('later read failed');
      }).catch((error: unknown) => {
        thrown = error;
      });

      // Before, the journal required recovery and refused every later
      // deletion, archive and delete in the project.
      expect(thrown).toMatchObject({ message: 'later read failed' });
      expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
      expect(beforeEffects).not.toHaveBeenCalled();
      expect(await readDestructiveRecovery('q')).toEqual(earlier);
      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
      expect(await reportDestructiveRecovery()).toEqual([]);
    },
  );

  it('a parent failure outside its steps over a replaced project directory keeps the journaled lockout', async () => {
    let thrown: unknown;

    await withDestructiveLifecycle(parent(), async () => {
      await runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('live-state-teardown', succeed),
        ),
      );
      // The parent admitted no directory; one appears before the failure.
      mkdirSync(getWorkspaceDir('q'), { recursive: true });
      throw new Error('later read failed');
    }).catch((error: unknown) => {
      thrown = error;
    });

    expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
    expect(await readDestructiveRecovery('q')).toMatchObject({
      state: 'recovery-required',
    });
  });

  describe('a resumable step (CAN-5011)', () => {
    it('that fails after the children withdraws the parent journal and is step-free', async () => {
      await withDestructiveLifecycle(parent(), () =>
        destructiveStep('session-teardown', succeed),
      );
      const earlier = await readDestructiveRecovery('q');
      const beforeEffects = jest.fn();
      let thrown: unknown;

      await withDestructiveLifecycle(parent(beforeEffects), async () => {
        await runStepFreeChildLifecycles(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('live-state-teardown', succeed),
          ),
        );
        await resumableDestructiveStep('retained-git-cleanup', succeed);
        await resumableDestructiveStep(
          'retained-git-cleanup',
          fail('finish failed'),
        );
      }).catch((error: unknown) => {
        thrown = error;
      });

      expect(thrown).toMatchObject({ message: 'finish failed' });
      expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
      expect(beforeEffects).not.toHaveBeenCalled();
      expect(await readDestructiveRecovery('q')).toEqual(earlier);
      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
      expect(await reportDestructiveRecovery()).toEqual([]);
    });

    it('that fails as the first step removes the journal', async () => {
      let thrown: unknown;

      await withDestructiveLifecycle(parent(), () =>
        resumableDestructiveStep('retained-git-cleanup', fail('finish failed')),
      ).catch((error: unknown) => {
        thrown = error;
      });

      expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
      expect(await readDestructiveRecovery('q')).toBe(null);
    });

    it('after an ordinary step is an ordinary step and keeps the journaled lockout', async () => {
      const beforeEffects = jest.fn();
      let thrown: unknown;

      await withDestructiveLifecycle(parent(beforeEffects), async () => {
        await destructiveStep('session-teardown', succeed);
        await resumableDestructiveStep(
          'retained-git-cleanup',
          fail('finish failed'),
        );
      }).catch((error: unknown) => {
        thrown = error;
      });

      expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
      expect(beforeEffects).toHaveBeenCalled();
      expect(await readDestructiveRecovery('q')).toMatchObject({
        state: 'recovery-required',
        steps: [
          { phase: 'session-teardown', state: 'done' },
          { phase: 'retained-git-cleanup', state: 'pending' },
        ],
      });
    });

    it('a later ordinary failure keeps the journal and records the effects', async () => {
      const beforeEffects = jest.fn();
      let thrown: unknown;

      await withDestructiveLifecycle(parent(beforeEffects), async () => {
        await resumableDestructiveStep('retained-git-cleanup', succeed);
        await destructiveStep('session-teardown', fail('own effect failed'));
      }).catch((error: unknown) => {
        thrown = error;
      });

      expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
      expect(beforeEffects).toHaveBeenCalled();
      expect(await readDestructiveRecovery('q')).toMatchObject({
        state: 'recovery-required',
      });
    });

    it('over a replaced project directory keeps the journaled lockout', async () => {
      let thrown: unknown;

      await withDestructiveLifecycle(parent(), async () => {
        await resumableDestructiveStep('retained-git-cleanup', succeed);
        // The parent admitted no directory; one appears before the next step.
        await resumableDestructiveStep('retained-git-cleanup', () => {
          mkdirSync(getWorkspaceDir('q'), { recursive: true });
          return Promise.reject(new Error('finish failed'));
        });
      }).catch((error: unknown) => {
        thrown = error;
      });

      expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
      expect(await readDestructiveRecovery('q')).toMatchObject({
        state: 'recovery-required',
      });
    });

    it('whose withdrawal fails keeps the journal requiring recovery', async () => {
      let thrown: unknown;
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });

      await withDestructiveLifecycle(parent(), async () => {
        await resumableDestructiveStep('retained-git-cleanup', succeed);
        // With the directory in place, the withdrawal's sync is the only one.
        jest
          .spyOn(sharedAtomicFile, 'syncDirectory')
          .mockRejectedValueOnce(new Error('sync failed'));
        await resumableDestructiveStep(
          'retained-git-cleanup',
          fail('finish failed'),
        );
      }).catch((error: unknown) => {
        thrown = error;
      });

      expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
      expect(await readDestructiveRecovery('q')).toMatchObject({
        state: 'recovery-required',
      });
    });
  });

  it('a parent with an effect of its own keeps the journaled lockout', async () => {
    let thrown: unknown;

    await withDestructiveLifecycle(parent(), async () => {
      await destructiveStep('session-teardown', succeed);
      await runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('teardown-script', fail('script failed'), {
            stepFreeAsFirstChildStep: true,
          }),
        ),
      );
    }).catch((error: unknown) => {
      thrown = error;
    });

    expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
    expect(await readDestructiveRecovery('q')).toMatchObject({
      state: 'recovery-required',
    });
  });

  it('a failing script outside step-free children keeps its journal, as Auto Delete does', async () => {
    let thrown: unknown;

    await withDestructiveLifecycle(child, () =>
      destructiveStep('teardown-script', fail('script failed'), {
        stepFreeAsFirstChildStep: true,
      }),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
    expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
      state: 'recovery-required',
      steps: [{ phase: 'teardown-script', state: 'pending' }],
    });
  });

  it('a failing first script step restores the archive of an earlier incarnation, and a retry runs', async () => {
    const earlierCreatedAt = '2025-01-01T00:00:00.000Z';
    await withDestructiveLifecycle(
      { ...child, createdAt: earlierCreatedAt },
      () => destructiveStep('live-state-teardown', succeed),
    );
    const earlier = await readDestructiveRecovery('q', 'w');
    let thrown: unknown;

    await withDestructiveLifecycle(parent(), () =>
      runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('teardown-script', fail('script failed'), {
            stepFreeAsFirstChildStep: true,
          }),
        ),
      ),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(isStepFreeDestructiveFailure(thrown)).toBe(true);
    expect(await readDestructiveRecovery('q', 'w')).toEqual(earlier);
    expect(
      await findCompletedDestructiveArchive('q', 'w', earlierCreatedAt),
    ).toEqual(earlier);
    expect(
      await findCompletedDestructiveArchive('q', 'w', child.createdAt),
    ).toBe(null);
    expect(await reportDestructiveRecovery()).toEqual([]);
    await withDestructiveLifecycle(parent(), () =>
      runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('teardown-script', succeed, {
            stepFreeAsFirstChildStep: true,
          }),
        ),
      ),
    );
    expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
      state: 'completed',
      createdAt: child.createdAt,
    });
    expect(
      await findCompletedDestructiveArchive('q', 'w', earlierCreatedAt),
    ).toEqual(earlier);
  });

  it('a parent directory replaced during its children keeps the journaled lockout', async () => {
    let thrown: unknown;

    await withDestructiveLifecycle(parent(), () =>
      runStepFreeChildLifecycles(async () => {
        await withDestructiveLifecycle({ ...child, worktreeId: 'done' }, () =>
          destructiveStep('live-state-teardown', succeed),
        );
        // The parent admitted no directory; one appears before the next child.
        mkdirSync(getWorkspaceDir('q'), { recursive: true });
        await withDestructiveLifecycle(child, () =>
          destructiveStep('live-state-teardown', succeed),
        );
      }),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(thrown).toMatchObject({ reason: 'recovery-required' });
    expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
    expect(await readDestructiveRecovery('q')).toMatchObject({
      state: 'recovery-required',
      steps: [{ phase: expect.stringMatching(/^child:/) as unknown }],
    });
    expect(await readDestructiveRecovery('q', 'done')).toMatchObject({
      state: 'completed',
    });
  });

  describe('a retry of the parent resumes a failed child archive it can redo', () => {
    /** Runs the work inside a parent's step-free children. */
    function inParent<T>(work: () => Promise<T>): Promise<T> {
      return withDestructiveLifecycle(parent(), () =>
        runStepFreeChildLifecycles(work),
      );
    }
    function journalFile(worktreeId?: string): string {
      const key = createHash('sha256')
        .update(JSON.stringify(['q', worktreeId ?? null]))
        .digest('hex');
      return join(getW5DestructiveLifecycleDir(), `${key}.json`);
    }
    async function failChild(
      done: readonly DestructivePhase[],
      failing: DestructivePhase,
    ): Promise<DestructiveRecoveryRecord> {
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          for (const phase of done) await destructiveStep(phase, succeed);
          await destructiveStep(failing, fail(`${failing} failed`));
        }),
      ).catch(() => undefined);
      const record = await readDestructiveRecovery('q', 'w');
      if (!record) throw new Error('Expected a failed child journal');
      expect(record).toMatchObject({
        state: 'recovery-required',
        parentOperation: 'workspace-delete',
      });
      return record;
    }

    it('supersedes the failed journal and completes', async () => {
      const failed = await failChild(
        ['teardown-script', 'live-state-teardown', 'git-capture'],
        'provider-capture',
      );

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('provider-capture', succeed),
        ),
      );

      const record = await readDestructiveRecovery('q', 'w');
      expect(record).toMatchObject({ state: 'completed' });
      expect(record?.operationId).not.toBe(failed.operationId);
      // The failed attempt is superseded, never kept as an outcome copy.
      expect(readdirSync(getW5DestructiveLifecycleDir())).not.toContain(
        `${failed.operationId}.json`,
      );
      expect(await reportDestructiveRecovery()).toEqual([]);
    });

    it('restores the failed journal when the resumed first step fails', async () => {
      const failed = await failChild(['live-state-teardown'], 'git-capture');

      await expect(
        inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('teardown-script', fail('script failed'), {
              stepFreeAsFirstChildStep: true,
            }),
          ),
        ),
      ).rejects.toThrow('script failed');

      expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      expect(await readDestructiveRecovery('q')).toBe(null);
    });

    it('is admitted only for the parent that resumes it', async () => {
      await failChild(['git-capture'], 'git-worktree-removal');

      await expect(
        readInFlightWorktreeDestructiveOperations('q'),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      await expect(
        readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
      ).resolves.toEqual([]);
      await expect(assertNoDestructiveRecovery('q', 'w')).rejects.toMatchObject(
        { reason: 'recovery-required' },
      );
      await expect(
        withDestructiveLifecycle(child, () =>
          destructiveStep('git-capture', succeed),
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      await expect(
        inParent(() =>
          assertFailedChildArchivesResumed('q', 'workspace-delete'),
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      // Inside the parent's children, only this worktree's check admits it.
      await inParent(() => assertNoDestructiveRecovery('q', 'w'));
      await expect(
        inParent(() => assertNoDestructiveRecovery('q')),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
    });

    it.each([
      [
        'a branch deletion',
        ['git-capture', 'branch-deletion'],
        'git-worktree-removal',
      ],
      [
        'a quarantine removal',
        ['checkout-quarantine', 'git-worktree-removal'],
        'quarantine-directory-removal',
      ],
      [
        'a branch deletion after the quarantine removal',
        ['git-worktree-removal', 'quarantine-directory-removal'],
        'branch-deletion',
      ],
      ['a live-state teardown', ['teardown-script'], 'live-state-teardown'],
      [
        'the files-only payload capture',
        ['live-state-teardown', 'retained-payload-capture'],
        'file-quarantine',
      ],
      [
        'the files-only recovery finish',
        ['retained-payload-capture', 'file-quarantine', 'provider-capture'],
        'retained-git-cleanup',
      ],
      [
        'the pipeline cleanup',
        ['quarantine-directory-removal', 'branch-deletion'],
        'pipeline-cleanup',
      ],
      [
        'the turn diff cleanup',
        ['branch-deletion', 'pipeline-cleanup'],
        'turn-diff-cleanup',
      ],
      [
        'the retained manifest commit',
        ['branch-deletion', 'pipeline-cleanup', 'turn-diff-cleanup'],
        'retained-manifest-commit',
      ],
      [
        'the sidecar cleanup after the commit point',
        [
          'retained-manifest-commit',
          'browser-retirement',
          'sidecar:chat state',
        ],
        'sidecar-cleanup',
      ],
      [
        'the row removal after the commit point',
        [
          'retained-manifest-commit',
          'sidecar-cleanup',
          'compatibility-symlinks',
        ],
        'canonical-row-removal',
      ],
      // Before, these two refused the retry recovery-required.
      ['the checkout quarantine move', ['git-capture'], 'checkout-quarantine'],
      [
        'a teardown script after a step',
        ['live-state-teardown'],
        'teardown-script',
      ],
    ] as const)(
      'is resumed after a failure in %s (CAN-5011)',
      async (_label, done, failing) => {
        const failed = await failChild(done, failing);

        await inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep(failing, succeed),
          ),
        );

        const record = await readDestructiveRecovery('q', 'w');
        expect(record).toMatchObject({ state: 'completed' });
        expect(record?.operationId).not.toBe(failed.operationId);
      },
    );

    it('is resumed after a Git capture refusal it tolerated, and a failure between steps (CAN-5011)', async () => {
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          await destructiveStep('git-capture', fail('capture refused')).catch(
            () => acknowledgeArchiveCaptureRefusal(),
          );
          await destructiveStep('file-quarantine', succeed);
          throw new Error('failed between steps');
        }),
      ).catch(() => undefined);
      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'recovery-required',
        steps: [
          { phase: 'git-capture', state: 'failed' },
          { phase: 'file-quarantine', state: 'done' },
        ],
      });

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('file-quarantine', succeed),
        ),
      );

      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
    });

    describe('a journal a crash left active (CAN-5011)', () => {
      async function markActive(
        worktreeId: string,
      ): Promise<DestructiveRecoveryRecord> {
        const record = await readDestructiveRecovery('q', worktreeId);
        if (!record) throw new Error('Expected a journal');
        const crashed = { ...record, state: 'active' as const };
        writeFileSync(journalFile(worktreeId), JSON.stringify(crashed));
        return crashed;
      }

      it.each([
        ['in a resumable step', ['teardown-script'], 'git-capture'],
        ['in its first step, the teardown script', [], 'teardown-script'],
        [
          'in its checkout quarantine move',
          ['git-capture'],
          'checkout-quarantine',
        ],
      ] as const)(
        'resumes a child archive that crashed %s',
        async (_label, done, crashing) => {
          await failChild(done, crashing);
          const crashed = await markActive('w');

          await expect(
            readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
          ).resolves.toEqual([]);
          await inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep(crashing, succeed),
            ),
          );

          const record = await readDestructiveRecovery('q', 'w');
          expect(record).toMatchObject({ state: 'completed' });
          expect(record?.operationId).not.toBe(crashed.operationId);
        },
      );

      // Pipeline and turn diff cleanup run together, one turn diff cleanup per
      // repository, so a crash can leave any of them pending.
      it.each([
        [
          'its turn diff cleanup after its pipeline cleanup',
          [
            ['pipeline-cleanup', 'done'],
            ['turn-diff-cleanup', 'pending'],
          ],
        ],
        [
          'both cleanups',
          [
            ['pipeline-cleanup', 'pending'],
            ['turn-diff-cleanup', 'pending'],
          ],
        ],
        [
          'the turn diff cleanup of a second repository',
          [
            ['pipeline-cleanup', 'done'],
            ['turn-diff-cleanup', 'done'],
            ['turn-diff-cleanup', 'pending'],
          ],
        ],
        [
          'the turn diff cleanup of a second repository, after the first one failed',
          [
            ['pipeline-cleanup', 'pending'],
            ['turn-diff-cleanup', 'failed'],
            ['turn-diff-cleanup', 'pending'],
          ],
        ],
      ] as const)(
        'resumes a child archive that crashed during %s',
        async (_label, cleanups) => {
          await failChild(['branch-deletion'], 'pipeline-cleanup');
          const failed = await readDestructiveRecovery('q', 'w');
          if (!failed) throw new Error('Expected a failed child journal');
          const crashed = {
            ...failed,
            state: 'active' as const,
            steps: [
              { phase: 'branch-deletion', state: 'done' as const },
              ...cleanups.map(([phase, state]) => ({ phase, state })),
            ],
          };
          writeFileSync(journalFile('w'), JSON.stringify(crashed));

          await expect(
            readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
          ).resolves.toEqual([]);
          await inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('turn-diff-cleanup', succeed),
            ),
          );

          const record = await readDestructiveRecovery('q', 'w');
          expect(record).toMatchObject({ state: 'completed' });
          expect(record?.operationId).not.toBe(crashed.operationId);
        },
      );

      it('still refuses a crashed child outside a resumable step', async () => {
        await failChild(['git-capture'], 'checkout-removal');
        await markActive('w');

        await expect(
          inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('checkout-removal', succeed),
            ),
          ),
        ).rejects.toMatchObject({ reason: 'recovery-required' });
      });

      it('never takes over a child archive this process still runs', async () => {
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        let reached!: () => void;
        const started = new Promise<void>((resolve) => {
          reached = resolve;
        });
        const running = inParent(() =>
          withDestructiveLifecycle(child, async () => {
            await destructiveStep('git-capture', succeed);
            reached();
            await held;
          }),
        );
        await started;

        // A crashed one would be refused here as not resumed.
        await expect(
          assertFailedChildArchivesResumed('q', 'workspace-delete'),
        ).resolves.toBeUndefined();
        release();
        await running;
      });

      it('withdraws a parent with only child steps, which the next one supersedes', async () => {
        await inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('teardown-script', succeed),
          ),
        );
        // A crash left the parent journal active, as a child step began.
        const record = await readDestructiveRecovery('q');
        if (!record) throw new Error('Expected a parent journal');
        writeFileSync(
          journalFile(),
          JSON.stringify({
            ...record,
            state: 'active',
            steps: [
              ...record.steps,
              { phase: `child:${randomUUID()}`, state: 'pending' },
            ],
          }),
        );

        // It refuses nothing: neither a worktree operation nor the deletion.
        await assertNoDestructiveRecovery('q', 'other');
        await expect(
          readInFlightWorktreeDestructiveOperations('q'),
        ).resolves.toEqual([]);
        // Nor does it hold janitors or the launch report (before, both did).
        await expect(hasUnresolvedDestructiveRecovery('q')).resolves.toBe(
          false,
        );
        await expect(reportDestructiveRecovery()).resolves.toEqual([]);
        await inParent(() =>
          withDestructiveLifecycle({ ...child, worktreeId: 'next' }, () =>
            destructiveStep('teardown-script', succeed),
          ),
        );

        const superseding = await readDestructiveRecovery('q');
        expect(superseding).toMatchObject({ state: 'completed' });
        expect(superseding?.operationId).not.toBe(record.operationId);
        expect(readdirSync(getW5DestructiveLifecycleDir())).not.toContain(
          `${record.operationId}.json`,
        );
        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'W5 destructive lifecycle supersedes an interrupted deletion',
          expect.objectContaining({ operationId: record.operationId }),
        );
      });

      it.each([
        [
          'a step of its own',
          (record: DestructiveRecoveryRecord): DestructiveRecoveryRecord => ({
            ...record,
            steps: [
              ...record.steps,
              { phase: 'canonical-index-removal', state: 'pending' },
            ],
          }),
          (): void => undefined,
        ],
        [
          'a replaced project directory',
          (record: DestructiveRecoveryRecord): DestructiveRecoveryRecord =>
            record,
          (): void => {
            mkdirSync(getWorkspaceDir('q'), { recursive: true });
          },
        ],
      ])(
        'keeps refusing a crashed parent with %s',
        async (_label, edit, replace) => {
          await inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('teardown-script', succeed),
            ),
          );
          const record = await readDestructiveRecovery('q');
          if (!record) throw new Error('Expected a parent journal');
          writeFileSync(
            journalFile(),
            JSON.stringify({ ...edit(record), state: 'active' }),
          );
          replace();

          await expect(
            assertNoDestructiveRecovery('q', 'other'),
          ).rejects.toMatchObject({ reason: 'recovery-required' });
          await expect(hasUnresolvedDestructiveRecovery('q')).resolves.toBe(
            true,
          );
          expect(
            (await reportDestructiveRecovery()).map(
              (reported) => reported.operationId,
            ),
          ).toEqual([record.operationId]);
          await expect(inParent(() => Promise.resolve())).rejects.toMatchObject(
            { reason: 'recovery-required' },
          );
        },
      );
    });

    it('is resumed after a pipeline cleanup failure the turn diff cleanup outlasted (CAN-5011)', async () => {
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          await destructiveStep('branch-deletion', succeed);
          await Promise.allSettled([
            destructiveStep(
              'pipeline-cleanup',
              fail('pipeline cleanup failed'),
            ),
            destructiveStep('turn-diff-cleanup', succeed),
          ]);
          throw new Error('pipeline cleanup failed');
        }),
      ).catch(() => undefined);
      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'recovery-required',
        steps: [
          { phase: 'branch-deletion', state: 'done' },
          { phase: 'pipeline-cleanup', state: 'pending' },
          { phase: 'turn-diff-cleanup', state: 'done' },
        ],
      });

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('pipeline-cleanup', succeed),
        ),
      );

      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
    });

    describe('a failure after its row removal (CAN-5011)', () => {
      const tail: readonly DestructivePhase[] = [
        'retained-manifest-commit',
        'sidecar-cleanup',
        'canonical-row-removal',
        'deferred-browser-retirement',
      ];

      it('is superseded: admitted and left for the parent, which completes it', async () => {
        const failed = await failChild(tail, 'watcher-commit');

        await expect(
          readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
        ).resolves.toEqual([]);
        await expect(
          readInFlightWorktreeDestructiveOperations('q'),
        ).rejects.toMatchObject({ reason: 'recovery-required' });
        await inParent(() =>
          assertFailedChildArchivesResumed('q', 'workspace-delete'),
        );
        // No archive resumes it: its worktree left the list.
        await expect(
          inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('watcher-commit', succeed),
            ),
          ),
        ).rejects.toMatchObject({ reason: 'recovery-required' });

        await completeSupersededChildArchives('q', 'workspace-delete');

        expect(await readDestructiveRecovery('q', 'w')).toEqual({
          ...failed,
          state: 'completed',
          outcome: { success: true, warnings: [] },
        });
        expect(await hasUnresolvedDestructiveRecovery('q')).toBe(false);
        expect(logMainProcessWarn).toHaveBeenCalledWith(
          'W5 destructive lifecycle completes a superseded archive',
          expect.objectContaining({ operationId: failed.operationId }),
        );
      });

      it('is superseded once a failed row removal is left unresumed', async () => {
        await failChild(
          ['retained-manifest-commit', 'sidecar-cleanup'],
          'canonical-row-removal',
        );

        await inParent(() =>
          assertFailedChildArchivesResumed('q', 'workspace-delete'),
        );
        await completeSupersededChildArchives('q', 'workspace-delete');

        expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
          state: 'completed',
        });
      });

      it.each([
        [
          'before its manifest commits',
          ['sidecar-cleanup', 'canonical-row-removal'],
          'watcher-commit',
        ],
        [
          'outside the cleanup its parent covers',
          ['retained-manifest-commit', 'canonical-row-removal'],
          'checkout-removal',
        ],
      ] as const)('is not superseded %s', async (_label, done, failing) => {
        const failed = await failChild(done, failing);

        await expect(
          readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
        ).rejects.toMatchObject({ reason: 'recovery-required' });
        await completeSupersededChildArchives('q', 'workspace-delete');
        expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      });

      it('is not superseded from a standalone archive', async () => {
        await withDestructiveLifecycle(child, async () => {
          for (const phase of tail) await destructiveStep(phase, succeed);
          await destructiveStep('watcher-commit', fail('watcher failed'));
        }).catch(() => undefined);
        const failed = await readDestructiveRecovery('q', 'w');

        await expect(
          readInFlightWorktreeDestructiveOperations('q', 'workspace-delete'),
        ).rejects.toMatchObject({ reason: 'recovery-required' });
        await completeSupersededChildArchives('q', 'workspace-delete');
        expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      });
    });

    it.each([
      ['an unretained checkout removal', ['git-capture'], 'checkout-removal'],
      ['an unknown step', ['live-state-teardown'], 'unknown-step'],
    ] as const)('is not resumed after %s', async (_label, done, failing) => {
      // A journal from another build may name a step this build doesn't.
      const failed =
        failing === 'unknown-step'
          ? await withUnknownLastStep(
              await failChild(done, 'live-state-teardown'),
              failing,
            )
          : await failChild(done, failing);
      const retried =
        failing === 'unknown-step' ? 'live-state-teardown' : failing;

      await expect(
        inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep(retried, succeed),
          ),
        ),
      ).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { operationId: failed.operationId },
      });
      expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
    });

    async function withUnknownLastStep(
      record: DestructiveRecoveryRecord,
      phase: string,
    ): Promise<DestructiveRecoveryRecord> {
      const renamed = {
        ...record,
        steps: record.steps.map((step, index) =>
          index === record.steps.length - 1 ? { ...step, phase } : step,
        ),
      };
      writeFileSync(journalFile('w'), JSON.stringify(renamed));
      const read = await readDestructiveRecovery('q', 'w');
      if (!read) throw new Error('Expected the rewritten child journal');
      return read;
    }

    it('is not resumed from a standalone archive', async () => {
      await withDestructiveLifecycle(child, () =>
        destructiveStep('git-capture', fail('git-capture failed')),
      ).catch(() => undefined);
      const failed = await readDestructiveRecovery('q', 'w');
      expect(failed).toMatchObject({ state: 'recovery-required' });
      expect(failed?.parentOperation).toBeUndefined();

      await expect(
        inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('git-capture', succeed),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
    });

    // Each original is renamed aside, keeping its inode, so the stat identity
    // alone refuses; the delete-and-recreate cases follow (CAN-5024).
    it.each([
      [
        'a replaced project directory',
        (): void => {
          renameSync(getWorkspaceDir('q'), join(dir, 'replaced-q'));
          mkdirSync(getWorkspaceWorktreeDir('q', 'w'), { recursive: true });
        },
      ],
      [
        'a replaced checkout',
        (): void => {
          renameSync(
            getWorkspaceWorktreeDir('q', 'w'),
            join(dir, 'replaced-w'),
          );
          mkdirSync(getWorkspaceWorktreeDir('q', 'w'));
        },
      ],
    ])('is not resumed over %s', async (_label, replace) => {
      const checkout = getWorkspaceWorktreeDir('q', 'w');
      mkdirSync(checkout, { recursive: true });
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          await protectDestructivePath(checkout);
          await destructiveStep('git-capture', fail('git-capture failed'));
        }),
      ).catch(() => undefined);
      const failed = await readDestructiveRecovery('q', 'w');
      expect(failed).toMatchObject({ state: 'recovery-required' });
      replace();

      await expect(
        inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('git-capture', succeed),
          ),
        ),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      expect(existsSync(checkout)).toBe(true);
    });

    it('is resumed over a checkout that left, as a verified quarantine does', async () => {
      const checkout = getWorkspaceWorktreeDir('q', 'w');
      mkdirSync(checkout, { recursive: true });
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          await protectDestructivePath(checkout);
          await destructiveStep('checkout-quarantine', succeed);
          await destructiveStep(
            'git-worktree-removal',
            fail('git worktree remove failed'),
          );
        }),
      ).catch(() => undefined);
      rmSync(checkout, { recursive: true });

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('git-worktree-removal', succeed),
        ),
      );

      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
    });

    describe('a directory deleted and recreated with its identity (CAN-5024)', () => {
      /**
       * Linux ext4 can give the next directory a removed one's inode, and
       * stamps birth times from a coarse clock. Here that clock never ticks
       * after `path` is born: every later directory reports its birth time,
       * and the one recreated at `path` its inode too.
       */
      async function freezeDirectoryClockAt(path: string): Promise<void> {
        const fsPromises =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const realLstat = fsPromises.lstat;
        const born = await realLstat(path);
        jest
          .spyOn(fsPromises, 'lstat')
          .mockImplementation(async (target, options) => {
            if (options?.bigint) return realLstat(target, options);
            const stats = await realLstat(target);
            if (stats.isDirectory() && stats.birthtimeMs >= born.birthtimeMs) {
              stats.birthtimeMs = born.birthtimeMs;
              if (String(target) === path) {
                stats.dev = born.dev;
                stats.ino = born.ino;
              }
            }
            return stats;
          });
      }
      function retry(): Promise<void> {
        return inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('git-capture', succeed),
          ),
        );
      }
      function recreate(path: string): void {
        rmSync(path, { recursive: true });
        mkdirSync(path);
      }

      it('syncs an existing marker before adopting it after a failed directory sync', async () => {
        const project = getWorkspaceDir('q');
        mkdirSync(project, { recursive: true });
        const work = jest.fn(succeed);
        const sync = jest
          .spyOn(sharedAtomicFile, 'syncDirectory')
          .mockRejectedValue(new Error('marker directory sync failed'));

        await expect(withDestructiveLifecycle(parent(), work)).rejects.toThrow(
          'marker directory sync failed',
        );
        expect(existsSync(join(project, '.w5-incarnation'))).toBe(true);
        await expect(withDestructiveLifecycle(parent(), work)).rejects.toThrow(
          'marker directory sync failed',
        );
        expect(work).not.toHaveBeenCalled();

        sync.mockRestore();
        await withDestructiveLifecycle(parent(), work);
        expect(work).toHaveBeenCalledTimes(1);
      });

      it.each([0, 1])(
        'samples the checkout after the proving probe when it is recreated during the wait (birth tick +%i)',
        async (replacementTick) => {
          jest
            .spyOn(performance, 'now')
            .mockReturnValueOnce(0)
            .mockReturnValueOnce(0)
            .mockReturnValue(1_000);
          const checkout = getWorkspaceWorktreeDir('q', 'w');
          mkdirSync(checkout, { recursive: true });
          const fsPromises =
            jest.requireActual<typeof FsPromises>('node:fs/promises');
          const realLstat = fsPromises.lstat;
          const original = await realLstat(checkout);
          let probes = 0;
          let sampledReplacement = false;
          let checkoutBirth = original.birthtimeMs;
          jest
            .spyOn(fsPromises, 'lstat')
            .mockImplementation(async (path, options) => {
              if (options?.bigint) return realLstat(path, options);
              const stat = await realLstat(path);
              if (String(path).includes('.w5-birth-order-')) {
                probes += 1;
                stat.dev = original.dev;
                stat.birthtimeMs = original.birthtimeMs + (probes > 1 ? 2 : 0);
              } else if (String(path) === checkout) {
                stat.dev = original.dev;
                stat.ino = original.ino;
                stat.birthtimeMs = checkoutBirth;
                if (probes > 1) sampledReplacement = true;
              }
              return stat;
            });
          const realMkdir = fsPromises.mkdir;
          jest
            .spyOn(fsPromises, 'mkdir')
            .mockImplementation(async (path, options) => {
              if (String(path).includes('.w5-birth-order-') && probes === 1) {
                // Tick 0 reuses all three fields before the next probe's tick.
                recreate(checkout);
                checkoutBirth = original.birthtimeMs + replacementTick;
              }
              return realMkdir(path, options);
            });

          await expect(
            inParent(() =>
              withDestructiveLifecycle(child, async () => {
                await protectDestructivePath(checkout);
                expect(probes).toBe(2);
                expect(sampledReplacement).toBe(true);
                await destructiveStep(
                  'git-capture',
                  fail('git-capture failed'),
                );
              }),
            ),
          ).rejects.toThrow('git-capture failed');
          const failed = await readDestructiveRecovery('q', 'w');
          expect(failed?.ownedPaths).toContainEqual({
            path: checkout,
            identity: `${original.dev}:${original.ino}:${checkoutBirth}`,
          });

          // A directory created after recording is at least as new as the probe.
          recreate(checkout);
          checkoutBirth = original.birthtimeMs + 2;
          const effect = jest.fn(succeed);
          await expect(
            inParent(() =>
              withDestructiveLifecycle(child, () =>
                destructiveStep('checkout-removal', effect),
              ),
            ),
          ).rejects.toMatchObject({ reason: 'recovery-required' });
          expect(effect).not.toHaveBeenCalled();
          expect(existsSync(checkout)).toBe(true);
          expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
        },
      );

      it('bounds the probe wait even when the wall clock stops', async () => {
        const checkout = getWorkspaceWorktreeDir('q', 'w');
        mkdirSync(checkout, { recursive: true });
        await freezeDirectoryClockAt(checkout);
        jest.spyOn(Date, 'now').mockReturnValue(0);
        jest
          .spyOn(performance, 'now')
          .mockReturnValueOnce(0)
          .mockReturnValue(1_000);
        const fsPromises =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const realMkdir = fsPromises.mkdir;
        let probes = 0;
        jest
          .spyOn(fsPromises, 'mkdir')
          .mockImplementation(async (path, options) => {
            if (String(path).includes('.w5-birth-order-') && ++probes > 1) {
              // Stop a broken deadline without leaving a test hung forever.
              throw new Error('probe exceeded its monotonic deadline');
            }
            return realMkdir(path, options);
          });

        await inParent(() =>
          withDestructiveLifecycle(child, async () => {
            await protectDestructivePath(checkout);
            await destructiveStep('git-capture', fail('git-capture failed'));
          }),
        ).catch(() => undefined);

        expect(probes).toBe(1);
        const failed = await readDestructiveRecovery('q', 'w');
        expect(failed?.ownedPaths[0]?.identity).toMatch(/^unverifiable:/);
        expect(
          readdirSync(getWorkspaceDir('q')).filter((name) =>
            name.includes('birth-order'),
          ),
        ).toEqual([]);
      });

      it('does not authorize effects when its probe cannot be removed', async () => {
        const checkout = getWorkspaceWorktreeDir('q', 'w');
        mkdirSync(checkout, { recursive: true });
        const fsPromises =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const remove = jest.spyOn(fsPromises, 'rmdir').mockRejectedValueOnce(
          Object.assign(new Error('probe removal failed'), {
            code: 'EACCES',
          }),
        );
        const effect = jest.fn(succeed);

        await expect(
          withDestructiveLifecycle(parent(), async () => {
            await protectDestructivePath(checkout);
            await destructiveStep('checkout-removal', effect);
          }),
        ).rejects.toThrow('probe removal failed');
        expect(effect).not.toHaveBeenCalled();
        expect(await readDestructiveRecovery('q')).toBeNull();
        expect(remove).toHaveBeenCalledTimes(1);
      });

      it('does not remove a probe path created by someone else', async () => {
        const checkout = getWorkspaceWorktreeDir('q', 'w');
        mkdirSync(checkout, { recursive: true });
        const fsPromises =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const realMkdir = fsPromises.mkdir;
        let contendedProbe: string | undefined;
        jest
          .spyOn(fsPromises, 'mkdir')
          .mockImplementation(async (path, options) => {
            if (String(path).includes('.w5-birth-order-')) {
              // Another creator won the name before our mkdir.
              await realMkdir(path, options);
              contendedProbe = String(path);
              throw Object.assign(new Error('already exists'), {
                code: 'EEXIST',
              });
            }
            return realMkdir(path, options);
          });

        await withDestructiveLifecycle(parent(), () =>
          protectDestructivePath(checkout),
        );

        if (!contendedProbe) throw new Error('Expected a probe attempt');
        expect(existsSync(contendedProbe)).toBe(true);
        expect(readdirSync(checkout)).toEqual([]);
      });

      it.each(['another device', 'a failed stat'])(
        'refuses retry and cleans the probe on %s',
        async (failure) => {
          const checkout = getWorkspaceWorktreeDir('q', 'w');
          mkdirSync(checkout, { recursive: true });
          const fsPromises =
            jest.requireActual<typeof FsPromises>('node:fs/promises');
          const realLstat = fsPromises.lstat;
          jest
            .spyOn(fsPromises, 'lstat')
            .mockImplementation(async (path, options) => {
              if (options?.bigint) return realLstat(path, options);
              const stat = await realLstat(path);
              if (String(path).includes('.w5-birth-order-')) {
                if (failure === 'a failed stat') throw new Error('stat failed');
                stat.dev += 1;
              }
              return stat;
            });
          await inParent(() =>
            withDestructiveLifecycle(child, async () => {
              await protectDestructivePath(checkout);
              await destructiveStep('git-capture', fail('git-capture failed'));
            }),
          ).catch(() => undefined);

          const failed = await readDestructiveRecovery('q', 'w');
          expect(failed?.ownedPaths[0]?.identity).toMatch(/^unverifiable:/);
          expect(
            readdirSync(getWorkspaceDir('q')).filter((name) =>
              name.includes('birth-order'),
            ),
          ).toEqual([]);
          expect(readdirSync(checkout)).toEqual([]);
          await expect(retry()).rejects.toMatchObject({
            reason: 'recovery-required',
          });
          expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
        },
      );

      it.each(['project directory', 'checkout'] as const)(
        'refuses its %s replaced before journal writes on the real filesystem',
        async (target) => {
          const project = getWorkspaceDir('q');
          const checkout = getWorkspaceWorktreeDir('q', 'w');
          const path = target === 'project directory' ? project : checkout;

          const marker = randomUUID();
          const effect = jest.fn(succeed);
          for (let attempt = 0; attempt < 50; attempt += 1) {
            rmSync(project, { recursive: true, force: true });
            rmSync(journalFile(), { force: true });
            rmSync(journalFile('w'), { force: true });
            mkdirSync(target === 'checkout' ? dirname(checkout) : project, {
              recursive: true,
            });
            writeFileSync(join(project, '.w5-incarnation'), marker);
            let replaced = false;
            const failure = await inParent(() =>
              withDestructiveLifecycle(
                {
                  ...child,
                  beforeEffects: () => {
                    // Replace before journal fsyncs advance ext4's coarse birth clock.
                    recreate(path);
                    replaced = true;
                  },
                },
                async () => {
                  if (target === 'checkout') {
                    mkdirSync(checkout);
                    await protectDestructivePath(checkout);
                  }
                  await destructiveStep(
                    'git-capture',
                    fail('git-capture failed'),
                  );
                },
              ),
            ).then(
              () => {
                throw new Error('Expected the initial lifecycle to fail');
              },
              (error: unknown) => error,
            );
            expect(replaced).toBe(true);
            if (
              typeof failure === 'object' &&
              failure !== null &&
              'reason' in failure &&
              failure.reason === 'recovery-required'
            ) {
              // The parent's identity check can refuse before writing a child journal.
              expect(existsSync(path)).toBe(true);
              expect(effect).not.toHaveBeenCalled();
              continue;
            }
            expect(failure).toMatchObject({ message: 'git-capture failed' });
            const failed = await readDestructiveRecovery('q', 'w');
            expect(failed).toMatchObject({ state: 'recovery-required' });
            await expect(
              inParent(() =>
                withDestructiveLifecycle(child, () =>
                  destructiveStep('git-capture', effect),
                ),
              ),
            ).rejects.toMatchObject({ reason: 'recovery-required' });
            expect(effect).not.toHaveBeenCalled();
            expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
            expect(existsSync(path)).toBe(true);
          }
        },
      );

      // These cover durable retry, but journal fsyncs can prevent same-tick reuse.
      it.each([
        ['project directory', (): string => getWorkspaceDir('q')],
        ['checkout', (): string => getWorkspaceWorktreeDir('q', 'w')],
      ])(
        'is not resumed over its %s on the real filesystem',
        async (_label, target) => {
          const checkout = getWorkspaceWorktreeDir('q', 'w');
          mkdirSync(checkout, { recursive: true });
          await inParent(() =>
            withDestructiveLifecycle(child, async () => {
              await protectDestructivePath(checkout);
              await destructiveStep('git-capture', fail('git-capture failed'));
            }),
          ).catch(() => undefined);
          const failed = await readDestructiveRecovery('q', 'w');
          expect(failed).toMatchObject({ state: 'recovery-required' });
          recreate(target());
          mkdirSync(checkout, { recursive: true });

          await expect(retry()).rejects.toMatchObject({
            reason: 'recovery-required',
          });
          expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
          expect(existsSync(checkout)).toBe(true);
        },
      );

      it('is not resumed over its project directory', async () => {
        const project = getWorkspaceDir('q');
        mkdirSync(project, { recursive: true });
        await freezeDirectoryClockAt(project);
        const failed = await failChild([], 'git-capture');
        recreate(project);

        await expect(retry()).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: failed.operationId },
        });
        expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      });

      it('is not resumed over its checkout', async () => {
        const checkout = getWorkspaceWorktreeDir('q', 'w');
        mkdirSync(checkout, { recursive: true });
        await freezeDirectoryClockAt(checkout);
        await inParent(() =>
          withDestructiveLifecycle(child, async () => {
            await protectDestructivePath(checkout);
            await destructiveStep('git-capture', fail('git-capture failed'));
          }),
        ).catch(() => undefined);
        const failed = await readDestructiveRecovery('q', 'w');
        expect(failed).toMatchObject({ state: 'recovery-required' });
        recreate(checkout);

        await expect(retry()).rejects.toMatchObject({
          reason: 'recovery-required',
        });
        expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
        expect(existsSync(checkout)).toBe(true);
      });

      it('does not supersede an interrupted deletion over its managed clone', async () => {
        const clone = join(dir, 'data', 'repos', 'clone');
        mkdirSync(getWorkspaceDir('q'), { recursive: true });
        mkdirSync(clone, { recursive: true });
        await freezeDirectoryClockAt(clone);
        await withDestructiveLifecycle(parent(), async () => {
          await protectDestructivePath(clone);
          await runStepFreeChildLifecycles(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('teardown-script', succeed),
            ),
          );
        });
        // A crash left the deletion active, as a child step began.
        const record = await readDestructiveRecovery('q');
        if (!record) throw new Error('Expected a parent journal');
        const crashed = {
          ...record,
          state: 'active' as const,
          steps: [
            ...record.steps,
            { phase: `child:${randomUUID()}`, state: 'pending' as const },
          ],
        };
        writeFileSync(journalFile(), JSON.stringify(crashed));
        recreate(clone);

        await expect(hasUnresolvedDestructiveRecovery('q')).resolves.toBe(true);
        await expect(
          withDestructiveLifecycle(parent(), () => Promise.resolve()),
        ).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: record.operationId },
        });
        expect(await readDestructiveRecovery('q')).toEqual(crashed);
        expect(existsSync(clone)).toBe(true);
      });
    });

    describe('a checkout whose birth time is unknown (CAN-5024)', () => {
      function reportUnknownBirthTime(path: string): void {
        const fsPromises =
          jest.requireActual<typeof FsPromises>('node:fs/promises');
        const realLstat = fsPromises.lstat;
        jest
          .spyOn(fsPromises, 'lstat')
          .mockImplementation(async (target, options) => {
            if (options?.bigint) return realLstat(target, options);
            const stats = await realLstat(target);
            if (String(target) === path) stats.birthtimeMs = 0;
            return stats;
          });
      }
      async function failWithCheckout(): Promise<DestructiveRecoveryRecord> {
        const checkout = getWorkspaceWorktreeDir('q', 'w');
        mkdirSync(checkout, { recursive: true });
        reportUnknownBirthTime(checkout);
        await inParent(() =>
          withDestructiveLifecycle(child, async () => {
            await protectDestructivePath(checkout);
            await destructiveStep('teardown-script', succeed);
            await destructiveStep('git-capture', fail('git-capture failed'));
          }),
        ).catch(() => undefined);
        const failed = await readDestructiveRecovery('q', 'w');
        if (!failed) throw new Error('Expected a failed child journal');
        // Its own lifecycle compared the stat identity and kept going.
        expect(failed).toMatchObject({
          state: 'recovery-required',
          steps: [
            { phase: 'teardown-script', state: 'done' },
            { phase: 'git-capture', state: 'pending' },
          ],
        });
        return failed;
      }

      it('is not resumed while the checkout is present', async () => {
        const failed = await failWithCheckout();

        await expect(
          inParent(() =>
            withDestructiveLifecycle(child, () =>
              destructiveStep('git-capture', succeed),
            ),
          ),
        ).rejects.toMatchObject({
          reason: 'recovery-required',
          details: { operationId: failed.operationId },
        });
        expect(await readDestructiveRecovery('q', 'w')).toEqual(failed);
      });

      it('is resumed once the checkout left', async () => {
        await failWithCheckout();
        rmSync(getWorkspaceWorktreeDir('q', 'w'), { recursive: true });

        await inParent(() =>
          withDestructiveLifecycle(child, () =>
            destructiveStep('git-capture', succeed),
          ),
        );

        expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
          state: 'completed',
        });
      });
    });

    it('is resumed over its unchanged checkout, born before every later directory (CAN-5024)', async () => {
      const checkout = getWorkspaceWorktreeDir('q', 'w');
      mkdirSync(checkout, { recursive: true });
      await inParent(() =>
        withDestructiveLifecycle(child, async () => {
          await protectDestructivePath(checkout);
          await destructiveStep('git-capture', fail('git-capture failed'));
        }),
      ).catch(() => undefined);
      const failed = await readDestructiveRecovery('q', 'w');
      expect(failed?.ownedPaths.map((owned) => owned.path)).toEqual([checkout]);
      expect(failed?.ownedPaths[0]?.identity).toMatch(/^\d+:\d+:[\d.]+$/);
      expect(readdirSync(checkout)).toEqual([]);
      // Each birth-order probe is removed.
      expect(
        readdirSync(getWorkspaceDir('q')).filter((name) =>
          name.includes('birth-order'),
        ),
      ).toEqual([]);

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('git-capture', succeed),
        ),
      );

      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
    });

    it('compares a project directory identity recorded before CAN-5024 on stat alone', async () => {
      mkdirSync(getWorkspaceDir('q'), { recursive: true });
      const failed = await failChild([], 'git-capture');
      const recorded = failed.directoryIdentity;
      if (!recorded) throw new Error('Expected a project directory identity');
      expect(recorded).toMatch(/^\d+:\d+:[\d.]+:[0-9a-f-]{36}$/);
      writeFileSync(
        journalFile('w'),
        JSON.stringify({
          ...failed,
          directoryIdentity: recorded.split(':').slice(0, 3).join(':'),
        }),
      );

      await inParent(() =>
        withDestructiveLifecycle(child, () =>
          destructiveStep('git-capture', succeed),
        ),
      );

      expect(await readDestructiveRecovery('q', 'w')).toMatchObject({
        state: 'completed',
      });
    });
  });

  it('a failed withdrawal keeps the parent journal requiring recovery', async () => {
    let thrown: unknown;
    // With the directory in place, the withdrawal's sync is the only one.
    mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
    const sync = jest
      .spyOn(sharedAtomicFile, 'syncDirectory')
      .mockRejectedValueOnce(new Error('sync failed'));

    await withDestructiveLifecycle(parent(), () =>
      runStepFreeChildLifecycles(() =>
        withDestructiveLifecycle(child, async () => {
          await destructiveStep('live-state-teardown', succeed);
          throw new Error('child failure');
        }),
      ),
    ).catch((error: unknown) => {
      thrown = error;
    });

    expect(sync).toHaveBeenCalledTimes(1);
    expect(isStepFreeDestructiveFailure(thrown)).toBe(false);
    expect(await readDestructiveRecovery('q')).toMatchObject({
      state: 'recovery-required',
    });
  });
});

it('allows only an internal needs-repair archive to prove a removed row identity', async () => {
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-delete',
        workspaceId: 'a',
        worktreeId: 'repair-child',
        createdAt: '2026-01-01T00:00:00.000Z',
        allowMissingRow: true,
        readCreatedAt: () => Promise.resolve(null),
      },
      () =>
        destructiveStep('checkout-removal', () => Promise.resolve(undefined)),
    ),
  ).resolves.toBeUndefined();
});

it('refuses legacy recovery evidence without rewriting its staged payload', async () => {
  const payloadId = '00000000-0000-4000-8000-000000000002';
  const archiveDir = getArchivedContainerDir('a', 'one');
  const payload = join(archiveDir, 'recovery-files', payloadId);
  await mkdir(payload, { recursive: true });
  writeFileSync(join(payload, 'kept.txt'), 'original');
  const payloadDigest = await workspaceRootPayloadDigest({
    rootPath: payload,
  });
  writeFileSync(
    join(archiveDir, 'recovery.staged.json'),
    JSON.stringify({
      version: 1,
      createdAt: '2026-01-01T00:00:00.000Z',
      phase: 'captured',
      recovery: {
        kind: 'files-only',
        source: 'retained',
        digest: payloadDigest,
        payloadId,
      },
    }),
  );
  const before = await readFile(join(payload, 'kept.txt'));
  await expect(assertNoLegacyArchiveRecovery('a', 'one')).rejects.toMatchObject(
    { reason: 'recovery-required' },
  );
  await expect(readFile(join(payload, 'kept.txt'))).resolves.toEqual(before);
});

it('records a best-effort rejection without failing the lifecycle', async () => {
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-delete',
        workspaceId: 'a',
        worktreeId: 'one',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      async () => {
        await expect(
          destructiveStep(
            'chat-search-rows',
            () => Promise.reject(new Error('tolerated')),
            { bestEffort: true },
          ),
        ).rejects.toThrow('tolerated');
        return 'completed';
      },
    ),
  ).resolves.toBe('completed');
  const record = await readDestructiveRecovery('a', 'one');
  expect(record?.state).toBe('completed');
  expect(record?.cleanupRequired ?? false).toBe(false);
});

it('completes an archive with cleanup required when turn-diff ref cleanup fails', async () => {
  jest
    .spyOn(gitModule, 'cleanupPersistedTurnDiffTreeRefs')
    .mockRejectedValueOnce(new Error('ref lock'));
  await expect(archiveWorktree(archiveRequest)).resolves.toBeDefined();
  expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
    state: 'completed',
    cleanupRequired: true,
  });
});

it.each([
  ['succeeds', false],
  ['fails', true],
] as const)(
  'records cleanup required only when the deferred browser retirement %s',
  async (outcome, cleanupRequired) => {
    const browser = jest.requireMock<{
      commitTaskBrowserRetirement: jest.Mock;
      retireRemovedBrowserTask: jest.Mock;
    }>('../../browser/browser-profile-lifecycle');
    browser.commitTaskBrowserRetirement.mockRejectedValueOnce(
      new Error('profile metadata unavailable'),
    );
    // Sidecar cleanup retires the profile first; the deferred retirement is
    // the archive's final attempt.
    if (outcome === 'fails') {
      browser.retireRemovedBrowserTask.mockImplementation(() =>
        Promise.reject(new Error('profile still busy')),
      );
    }
    try {
      await expect(deleteWorktree(archiveRequest)).resolves.toBeDefined();
    } finally {
      browser.retireRemovedBrowserTask.mockImplementation(() =>
        Promise.resolve(),
      );
    }
    const record = await readDestructiveRecovery('a', 'one');
    expect(record?.state).toBe('completed');
    expect(record?.cleanupRequired ?? false).toBe(cleanupRequired);
  },
);

it('keeps a concurrent fatal step failure after a tolerated cleanup rejects', async () => {
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-archive',
        workspaceId: 'a',
        worktreeId: 'one',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      async () => {
        let started!: () => void;
        const entered = new Promise<void>((resolve) => {
          started = resolve;
        });
        let rejectCleanup!: (error: Error) => void;
        const cleanup = destructiveCleanup(
          'turn-diff-cleanup',
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectCleanup = reject;
              started();
            }),
        );
        await entered;
        await expect(
          destructiveStep('pipeline-cleanup', () =>
            Promise.reject(new Error('pipeline cleanup failed')),
          ),
        ).rejects.toThrow('pipeline cleanup failed');
        rejectCleanup(new Error('turn diff unavailable'));
        await expect(cleanup).rejects.toThrow('turn diff unavailable');
        // A later destructive step must still be refused.
        await destructiveStep('sidecar-cleanup', () => Promise.resolve());
        return 'archived';
      },
    ),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect((await readDestructiveRecovery('a', 'one'))?.state).not.toBe(
    'completed',
  );
});

it.each(['before', 'after'] as const)(
  'reservation interruption %s durable admission never starts deletion',
  async (point) => {
    const reserve = host.reserve.bind(host);
    jest.spyOn(host, 'reserve').mockImplementationOnce(async (request) => {
      if (point === 'after') await reserve(request);
      throw new Error('reservation interruption');
    });
    const request = { ...archiveRequest, idempotencyKey: 'reserve' };
    await expect(deleteWorktree(request)).rejects.toThrow(
      'reservation interruption',
    );
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
    expect(await readDestructiveRecovery('a', 'one')).toBe(null);
    if (point === 'after') {
      await restart();
      await expect(deleteWorktree(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    } else
      expect(await deleteWorktree(request)).toMatchObject({ success: true });
  },
);

describe.each(W5_STORE_SIDES)(
  'CAN-5377 keyed worktree deletion journal admission over the %s store',
  (side) => {
    const { uncertain } = useStoreSide(side);
    function lifecycleJournal(worktreeId?: string): string {
      const key = createHash('sha256')
        .update(JSON.stringify(['a', worktreeId ?? null]))
        .digest('hex');
      return join(getW5DestructiveLifecycleDir(), `${key}.json`);
    }
    const strandedProjectDeletion: DestructiveRecoveryRecord = {
      version: 1,
      operationId: randomUUID(),
      operation: 'workspace-delete',
      workspaceId: 'a',
      directoryIdentity: null,
      state: 'recovery-required',
      steps: [{ phase: 'workspace-directory-removal', state: 'pending' }],
      ownedPaths: [],
    };
    // CAN-5335: an unparseable entry refuses distinguishably, naming the entry.
    const unreadableEntry = (journal: string): object => ({
      reason: 'recovery-required',
      message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
      details: {
        phase: 'lifecycle-journal',
        check: 'unreadable-entry',
        entryName: basename(journal),
      },
    });

    it.each([
      [
        'an unreadable foreign journal',
        (): string =>
          join(getW5DestructiveLifecycleDir(), `${'f'.repeat(64)}.json`),
        '{truncated',
        unreadableEntry,
      ],
      [
        'an unreadable journal of this worktree',
        (): string => lifecycleJournal('one'),
        '{truncated',
        unreadableEntry,
      ],
      [
        'a stranded project deletion journal',
        (): string => lifecycleJournal(),
        JSON.stringify(strandedProjectDeletion),
        (): object => ({
          reason: 'recovery-required',
          message:
            'An interrupted destructive operation needs manual recovery. Preserve remaining files and inspect the lifecycle journal.',
        }),
      ],
    ])(
      '%s refuses before any effect and releases the new key',
      async (_label, journalPath, contents, expectedRefusal) => {
        const journal = journalPath();
        mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
        writeFileSync(journal, contents);
        const request = {
          ...archiveRequest,
          idempotencyKey: 'journal-refusal',
        };

        for (let attempt = 0; attempt < 2; attempt += 1)
          await expect(deleteWorktree(request)).rejects.toMatchObject(
            expectedRefusal(journal),
          );

        // The refusal neither clears nor rewrites the evidence.
        expect(readFileSync(journal, 'utf8')).toBe(contents);
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
        rmSync(journal);
        expect(await deleteWorktree(request)).toMatchObject({
          status: 'archived',
          success: true,
        });
        expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
      },
    );

    it("keeps the new key when the locked archive refuses this worktree's interrupted journal", async () => {
      jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(new Error('decision unavailable'));
      await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
        uncertain('decision unavailable'),
      );
      const request = { ...archiveRequest, idempotencyKey: 'locked-refusal' };
      await expect(deleteWorktree(request)).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { phase: 'archive-journal' },
      });

      // Repairing the journal does not repair a key refused after the archive's fences.
      rmSync(lifecycleJournal('one'));
      await expect(deleteWorktree(request)).rejects.toThrow(
        'An earlier attempt of this request was interrupted and needs recovery.',
      );
    });

    it('keeps a key interrupted after effects through a later journal refusal and repair', async () => {
      jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(new Error('decision unavailable'));
      const request = { ...archiveRequest, idempotencyKey: 'interrupted' };
      await expect(deleteWorktree(request)).rejects.toThrow(
        uncertain('decision unavailable'),
      );
      const foreign = join(
        getW5DestructiveLifecycleDir(),
        `${'f'.repeat(64)}.json`,
      );
      writeFileSync(foreign, '{truncated');
      const interrupted =
        'An earlier attempt of this request was interrupted and needs recovery.';

      await expect(deleteWorktree(request)).rejects.toThrow(interrupted);
      rmSync(foreign);
      rmSync(lifecycleJournal('one'));
      await expect(deleteWorktree(request)).rejects.toThrow(interrupted);
    });

    it("releases the new key when the completed-archive search refuses beside this worktree's interrupted journal", async () => {
      jest
        .spyOn(host, 'commit')
        .mockRejectedValueOnce(new Error('decision unavailable'));
      await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
        uncertain('decision unavailable'),
      );
      const foreign = join(
        getW5DestructiveLifecycleDir(),
        `${'f'.repeat(64)}.json`,
      );
      writeFileSync(foreign, '{truncated');
      const request = { ...archiveRequest, idempotencyKey: 'search-refusal' };

      for (let attempt = 0; attempt < 2; attempt += 1) {
        const refusal: unknown = await deleteWorktree(request).catch(
          (error: unknown) => error,
        );
        // The search's own refusal, not the locked archive's 'archive-journal'.
        expect(refusal).toMatchObject(unreadableEntry(foreign));
      }

      // The released key then reaches the locked archive, whose refusal keeps it.
      rmSync(foreign);
      await expect(deleteWorktree(request)).rejects.toMatchObject({
        details: { phase: 'archive-journal' },
      });
      await expect(deleteWorktree(request)).rejects.toThrow(
        'An earlier attempt of this request was interrupted and needs recovery.',
      );
    });
  },
);

it.each(['before', 'after'] as const)(
  'final receipt interruption %s decision does not repeat canonical removal',
  async (point) => {
    const commit = host.commit.bind(host);
    let fired = false;
    jest.spyOn(host, 'commit').mockImplementation(async (request) => {
      if (request.receipt && !fired) {
        fired = true;
        if (point === 'after') await commit(request);
        throw new Error('receipt response interruption');
      }
      return commit(request);
    });
    const request = { ...archiveRequest, idempotencyKey: 'receipt' };
    await expect(deleteWorktree(request)).rejects.toThrow(
      'receipt response interruption',
    );
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    await restart();
    const commits = jest.spyOn(host, 'commit');
    if (point === 'after')
      expect(await deleteWorktree(request)).toMatchObject({
        status: 'archived',
        success: true,
      });
    else
      await expect(deleteWorktree(request)).rejects.toMatchObject({
        reason: 'recovery-required',
      });
    expect(commits).not.toHaveBeenCalled();
  },
);

it('worktree replacement between checkout removal and sidecar cleanup retains its files', async () => {
  const checkout = join(root, 'a', 'worktrees', 'one');
  interrupt('checkout-removal', 'done', async () => {
    const rows = (await readWorkspaceWorktrees('a')).map((row) =>
      row.id === 'one'
        ? { ...row, createdAt: '2099-01-01T00:00:00.000Z' }
        : row,
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: rows }),
    );
    mkdirSync(checkout, { recursive: true });
    writeFileSync(join(checkout, 'replacement'), 'keep');
  });
  await expect(
    deleteWorktree({ ...archiveRequest, deleteBranch: true }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(readFileSync(join(checkout, 'replacement'), 'utf8')).toBe('keep');
  expect(
    execFileSync(
      'git',
      ['-C', repo, 'show-ref', '--verify', 'refs/heads/old'],
      { encoding: 'utf8' },
    ),
  ).toContain('refs/heads/old');
});

it('a proven workspace kind refusal releases its key before cancelling watchers', async () => {
  multiRepo();
  const request = {
    workspaceId: 'a',
    source: 'shared_container_fork' as const,
    singleRepoProject: true,
    idempotencyKey: 'kind',
  };
  const watcher = getAppAdvisorWatcherService();
  const cancel = jest.spyOn(watcher, 'cancelLocalWorkspace');
  jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
  await expect(deleteWorkspace(request)).rejects.toMatchObject({
    reason: 'not-single-repo',
  });
  expect(cancel).not.toHaveBeenCalled();
  expect(await readDestructiveRecovery('a')).toBe(null);
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'single-repo',
      repoPath: repo,
      repos: [],
    }),
  );
  const indexPath = join(root, 'index.json');
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      '"type":"multi-repo"',
      '"type":"single-repo"',
    ),
  );
  __resetSidebarItemsStateForTests();
  expect(await deleteWorkspace(request)).toMatchObject({ removed: 'code' });
});

/** Pause a worktree archive inside its journaled lifecycle until released. */
function pauseArchiveAt(
  phase: string,
  state: 'pending' | 'done' = 'done',
): {
  reached: Promise<void>;
  release: () => void;
} {
  let reachedResolve!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  interrupt(phase, state, async () => {
    reachedResolve();
    await released;
  });
  return { reached, release };
}

it.each([
  ['archive', 'pending'],
  ['archive', 'done'],
  ['delete', 'pending'],
  ['delete', 'done'],
] as const)(
  'workspace deletion during an in-flight worktree %s (live-state teardown %s) refuses retryably and keeps its key',
  async (kind, state) => {
    // `pending` is the archive's first journal save.
    const pause = pauseArchiveAt('live-state-teardown', state);
    const archive = (kind === 'archive' ? archiveWorktree : deleteWorktree)(
      archiveRequest,
    );
    let settled = false;
    try {
      await pause.reached;
      expect((await readDestructiveRecovery('a', 'one'))?.state).toBe('active');
      const watcher = getAppAdvisorWatcherService();
      const cancel = jest.spyOn(watcher, 'cancelLocalWorkspace');
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
      const request = {
        workspaceId: 'a',
        source: 'portal' as const,
        idempotencyKey: `in-flight-${kind}-${state}`,
      };
      const refusal = {
        name: 'WorkspaceDeletionRefusedError',
        reason: 'archive-in-progress',
        message: `A worktree in this project is still being ${
          kind === 'archive' ? 'archived' : 'deleted'
        }. Retry after it finishes.`,
      };
      await expect(deleteWorkspace(request)).rejects.toMatchObject(refusal);
      // Not "An earlier attempt of this request was interrupted…".
      await expect(deleteWorkspace(request)).rejects.toMatchObject(refusal);
      expect(cancel).not.toHaveBeenCalled();
      expect(await readDestructiveRecovery('a')).toBe(null);
      expect(existsSync(join(root, 'a'))).toBe(true);
      pause.release();
      await expect(archive).resolves.toMatchObject({ success: true });
      settled = true;
      expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
        'completed',
      );
      // The released key admits the same request once the archive finishes.
      expect(await deleteWorkspace(request)).toMatchObject({ removed: 'code' });
      expect(existsSync(join(root, 'a'))).toBe(false);
    } finally {
      pause.release();
      if (!settled) await archive.catch(() => undefined);
    }
  },
);

it('an active archive journal no lifecycle is running still requires recovery', async () => {
  const pause = pauseArchiveAt('live-state-teardown');
  const archive = archiveWorktree(archiveRequest);
  const journalDir = getW5DestructiveLifecycleDir();
  const snapshot: { name: string; contents: string }[] = [];
  try {
    await pause.reached;
    // A journal left `active` by an earlier session that stopped mid-archive.
    for (const name of readdirSync(journalDir))
      snapshot.push({
        name,
        contents: readFileSync(join(journalDir, name), 'utf8'),
      });
  } finally {
    pause.release();
  }
  await expect(archive).resolves.toMatchObject({ success: true });
  for (const { name, contents } of snapshot)
    writeFileSync(join(journalDir, name), contents);
  expect((await readDestructiveRecovery('a', 'one'))?.state).toBe('active');
  const deletion = deleteWorkspace({
    workspaceId: 'a',
    source: 'portal',
    idempotencyKey: 'stranded',
  });
  await expect(deletion).rejects.toMatchObject({ reason: 'recovery-required' });
  await expect(deletion).rejects.toThrow('needs manual recovery');
  expect(existsSync(join(root, 'a'))).toBe(true);
});

it('a stranded journal outranks an in-flight archive in workspace deletion admission', async () => {
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-delete',
        workspaceId: 'a',
        worktreeId: 'stranded-child',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      async () => {
        await expect(
          destructiveStep('checkout-removal', () =>
            Promise.reject(new Error('interrupted')),
          ),
        ).rejects.toThrow('interrupted');
        throw new Error('interrupted');
      },
    ),
  ).rejects.toThrow('interrupted');
  const pause = pauseArchiveAt('live-state-teardown');
  const archive = archiveWorktree(archiveRequest);
  try {
    await pause.reached;
    await expect(
      deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
  } finally {
    pause.release();
  }
  await expect(archive).resolves.toMatchObject({ success: true });
  expect(existsSync(join(root, 'a'))).toBe(true);
});

it('a failing archive whose recovery-required save fails stays stranded for workspace deletion', async () => {
  const write = atomicFile.writeFileAtomically;
  let reached!: () => void;
  const saving = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (file, contents, options) => {
      if (
        file.includes('destructive-lifecycles') &&
        typeof contents === 'string' &&
        contents.includes('"state":"recovery-required"')
      ) {
        reached();
        await released;
        throw new Error('journal unavailable');
      }
      await write(file, contents, options);
    });
  const lifecycle = withDestructiveLifecycle(
    {
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: 'failing',
      createdAt: '2026-01-01T00:00:00.000Z',
    },
    async () => {
      await destructiveStep('checkout-removal', () => Promise.resolve());
      throw new Error('interrupted');
    },
  );
  const request = { workspaceId: 'a', source: 'portal' as const };
  try {
    await saving;
    // Still running, but already failing: not an archive that will finish.
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  } finally {
    release();
  }
  await expect(lifecycle).rejects.toThrow('interrupted');
  expect((await readDestructiveRecovery('a', 'failing'))?.state).toBe('active');
  await expect(deleteWorkspace(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(existsSync(join(root, 'a'))).toBe(true);
});

it('workspace deletion while archive cleanup resumes, before its first journal save, refuses retryably', async () => {
  interrupt('sidecar:chat plugin state', 'pending');
  await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
  await restart();
  jest.spyOn(atomicFile, 'writeFileAtomically').mockRestore();
  const write = atomicFile.writeFileAtomically;
  let reached!: () => void;
  const resumed = new Promise<void>((resolve) => {
    reached = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false;
  // Hold the resumed lifecycle's first journal save, so the journal on disk
  // still says `recovery-required` while this process runs the cleanup tail.
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (file, contents, options) => {
      if (!held && file.includes('destructive-lifecycles')) {
        held = true;
        reached();
        await released;
      }
      await write(file, contents, options);
    });
  const archive = archiveWorktree(archiveRequest);
  const request = {
    workspaceId: 'a',
    source: 'portal' as const,
    idempotencyKey: 'resuming-cleanup',
  };
  try {
    await Promise.race([
      resumed,
      archive.then(() => {
        throw new Error('The archive finished without a journal save');
      }),
    ]);
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
      'recovery-required',
    );
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'archive-in-progress',
    });
  } finally {
    release();
  }
  await expect(archive).resolves.toMatchObject({ success: true });
  expect(await deleteWorkspace(request)).toMatchObject({ removed: 'code' });
});

/** Hold the archive's successful completion save, before it reaches disk. */
function pauseArchiveCompletion(): {
  reached: Promise<void>;
  release: () => void;
} {
  const write = atomicFile.writeFileAtomically;
  let fired = false;
  let reachedResolve!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (file, contents, options) => {
      if (
        !fired &&
        file.includes('destructive-lifecycles') &&
        typeof contents === 'string' &&
        contents.includes('"operation":"worktree-archive"') &&
        contents.includes('"state":"completed"')
      ) {
        fired = true;
        reachedResolve();
        await released;
      }
      await write(file, contents, options);
    });
  return { reached, release };
}

it('workspace deletion while a finishing archive saves its completion refuses retryably', async () => {
  const pause = pauseArchiveCompletion();
  const archive = archiveWorktree(archiveRequest);
  const request = {
    workspaceId: 'a',
    source: 'portal' as const,
    idempotencyKey: 'finishing-archive',
  };
  try {
    await pause.reached;
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe('active');
    await expect(deleteWorkspace(request)).rejects.toMatchObject({
      reason: 'archive-in-progress',
    });
  } finally {
    pause.release();
  }
  await expect(archive).resolves.toMatchObject({ success: true });
  expect(await deleteWorkspace(request)).toMatchObject({ removed: 'code' });
  expect(existsSync(join(root, 'a'))).toBe(false);
});

it('an archive that finishes while deletion admission reads its journal does not strand the deletion', async () => {
  const pause = pauseArchiveCompletion();
  const archive = archiveWorktree(archiveRequest);
  let settled = false;
  let releaseRead!: () => void;
  const readReleased = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  try {
    await pause.reached;
    const fsPromises =
      jest.requireActual<typeof FsPromises>('node:fs/promises');
    const read = fsPromises.readFile;
    let held = false;
    let readHeld!: () => void;
    const holding = new Promise<void>((resolve) => {
      readHeld = resolve;
    });
    // Admission reads the archive's `active` journal, then the archive
    // finishes and leaves the running set before admission classifies it.
    jest
      .spyOn(fsPromises, 'readFile')
      .mockImplementation(async (...args: Parameters<typeof read>) => {
        const contents = await read(...args);
        if (
          !held &&
          typeof args[0] === 'string' &&
          args[0].includes('destructive-lifecycles') &&
          typeof contents === 'string' &&
          contents.includes('"worktreeId":"one"') &&
          contents.includes('"state":"active"')
        ) {
          held = true;
          readHeld();
          await readReleased;
        }
        return contents;
      });
    const request = {
      workspaceId: 'a',
      source: 'portal' as const,
      idempotencyKey: 'finished-during-admission',
    };
    const deletion = deleteWorkspace(request);
    await holding;
    pause.release();
    await expect(archive).resolves.toMatchObject({ success: true });
    settled = true;
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
      'completed',
    );
    releaseRead();
    expect(await deletion).toMatchObject({ removed: 'code' });
    expect(existsSync(join(root, 'a'))).toBe(false);
  } finally {
    pause.release();
    releaseRead();
    if (!settled) await archive.catch(() => undefined);
  }
});

it('an archive whose completion save fails stays stranded for workspace deletion', async () => {
  const write = atomicFile.writeFileAtomically;
  jest
    .spyOn(atomicFile, 'writeFileAtomically')
    .mockImplementation(async (file, contents, options) => {
      if (
        file.includes('destructive-lifecycles') &&
        typeof contents === 'string' &&
        contents.includes('"worktreeId":"failing"') &&
        contents.includes('"state":"completed"')
      )
        throw new Error('journal unavailable');
      await write(file, contents, options);
    });
  await expect(
    withDestructiveLifecycle(
      {
        operation: 'worktree-archive',
        workspaceId: 'a',
        worktreeId: 'failing',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      () => destructiveStep('checkout-removal', () => Promise.resolve()),
    ),
  ).rejects.toThrow('journal unavailable');
  expect((await readDestructiveRecovery('a', 'failing'))?.state).toBe('active');
  await expect(
    deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(existsSync(join(root, 'a'))).toBe(true);
});

it('an unfinished journal outside its worktree path stays stranded for workspace deletion', async () => {
  const operationId = '3f7c2a9e-1b4d-4c8e-9a6f-2d5e8b1c7a40';
  const journalDir = getW5DestructiveLifecycleDir();
  await mkdir(journalDir, { recursive: true });
  // No lifecycle owns it, and nothing sits at the worktree's own journal path.
  writeFileSync(
    join(journalDir, `${operationId}.json`),
    JSON.stringify({
      version: 1,
      operationId,
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId: 'elsewhere',
      createdAt: '2026-01-01T00:00:00.000Z',
      directoryIdentity: null,
      state: 'active',
      steps: [{ phase: 'checkout-removal', state: 'pending' }],
      ownedPaths: [],
    }),
  );
  expect(await readDestructiveRecovery('a', 'elsewhere')).toBe(null);
  await expect(
    deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(existsSync(join(root, 'a'))).toBe(true);
});

it.each(['pending', 'done'] as const)(
  'files-only quarantine interruption / %s preserves manual recovery',
  async (state) => {
    const rows = (await readWorkspaceWorktrees('a')).map((row) =>
      row.id === 'one'
        ? { ...row, restoredFromFilesOnlyArchiveId: 'earlier' }
        : row,
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: rows }),
    );
    rmSync(join(root, 'a', 'worktrees', 'one', '.git'));
    writeFileSync(
      join(root, 'a', 'worktrees', 'one', 'work.txt'),
      'retained contents',
    );
    const fired = interrupt('file-quarantine', state);
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    const record = await readDestructiveRecovery('a', 'one');
    expect(record?.steps).toContainEqual({ phase: 'file-quarantine', state });
    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
  },
);

it('older quarantine journals require manual repair without resuming Git or accepting a new archive identity', async () => {
  const row = (await readWorkspaceWorktrees('a'))[0];
  const {
    captureArchivedContainerGitState,
    prepareArchivedContainerTeardown,
    readArchivedGitStagedDescriptor,
  } = await import('../archived-container-git');
  const captured = await captureArchivedContainerGitState({
    workspaceId: 'a',
    containerId: 'one',
    workspaceType: 'single-repo',
    worktreePath: join(root, 'a', 'worktrees', 'one'),
    persistedWorktree: row,
  });
  const teardown = await prepareArchivedContainerTeardown({
    workspaceId: 'a',
    containerId: 'one',
    workspaceType: 'single-repo',
    gitState: captured.gitState,
    expectedCreatedAt: row.createdAt,
  });
  const before = await readArchivedGitStagedDescriptor('a', 'one');
  await recoverArchivedGitTeardownsForWorkspace('a');
  expect(await readArchivedGitStagedDescriptor('a', 'one')).toEqual(before);
  expect(existsSync(teardown.quarantinePath)).toBe(true);
  await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(await readDestructiveRecovery('a', 'one')).toBe(null);
});

it('a known Git capture refusal still retains files through the established files-only archive path', async () => {
  const archiveGit = await import('../archived-container-git');
  jest
    .spyOn(archiveGit, 'captureArchivedContainerGitState')
    .mockRejectedValueOnce(
      new archiveGit.MissingWorktreeIncompleteArchivedGitCaptureError(),
    );
  writeFileSync(
    join(root, 'a', 'worktrees', 'one', 'work.txt'),
    'retained contents',
  );
  expect(await archiveWorktree(archiveRequest)).toMatchObject({
    success: true,
  });
  expect((await readDestructiveRecovery('a', 'one'))?.steps).toContainEqual({
    phase: 'git-capture',
    state: 'failed',
  });
  const { readArchivedContainerManifest } =
    await import('../archived-containers');
  expect(await readArchivedContainerManifest('a', 'one')).toMatchObject({
    version: 3,
  });
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'two',
  ]);
});

describe('a standalone archive a crash stopped before its Git capture', () => {
  /** Leaves the journal a crash right after the payload capture leaves. */
  async function crashAfterPayloadCapture(): Promise<DestructiveRecoveryRecord> {
    const archiveGit = await import('../archived-container-git');
    jest
      .spyOn(archiveGit, 'captureArchivedContainerGitState')
      .mockRejectedValueOnce(new Error('process exited'));
    await expect(archiveWorktree(archiveRequest)).rejects.toThrow(
      'process exited',
    );
    const failed = await readDestructiveRecovery('a', 'one');
    if (!failed) throw new Error('Expected an archive journal');
    const crashed: DestructiveRecoveryRecord = {
      ...failed,
      state: 'active',
      steps: failed.steps.filter((step) => step.phase !== 'git-capture'),
    };
    const key = createHash('sha256')
      .update(JSON.stringify(['a', 'one']))
      .digest('hex');
    writeFileSync(
      join(getW5DestructiveLifecycleDir(), `${key}.json`),
      JSON.stringify(crashed),
    );
    await restart();
    return crashed;
  }

  it('is redone by a retry, which completes the archive', async () => {
    const crashed = await crashAfterPayloadCapture();
    expect(crashed.steps).toEqual([
      { phase: 'live-state-teardown', state: 'done' },
      { phase: 'retained-payload-capture', state: 'done' },
    ]);
    expect(existsSync(getArchivedContainerDir('a', 'one'))).toBe(true);
    expect(
      existsSync(join(getArchivedContainerDir('a', 'one'), 'container.json')),
    ).toBe(false);

    expect(await archiveWorktree(archiveRequest)).toMatchObject({
      success: true,
    });

    const record = await readDestructiveRecovery('a', 'one');
    expect(record).toMatchObject({ state: 'completed' });
    expect(record?.operationId).not.toBe(crashed.operationId);
    const { readArchivedContainerManifest } =
      await import('../archived-containers');
    expect(await readArchivedContainerManifest('a', 'one')).toMatchObject({
      kind: 'worktree',
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(await reportDestructiveRecovery()).toEqual([]);
  });

  it('still refuses a retry over a replaced checkout, leaving it and the journal', async () => {
    const crashed = await crashAfterPayloadCapture();
    const checkout = join(root, 'a', 'worktrees', 'one');
    renameSync(checkout, join(dir, 'replaced-one'));
    mkdirSync(checkout);

    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readDestructiveRecovery('a', 'one')).toEqual(crashed);
    expect(existsSync(checkout)).toBe(true);
  });

  it('keeps refusing project deletion and archive janitors', async () => {
    await crashAfterPayloadCapture();

    await expect(
      readInFlightWorktreeDestructiveOperations('a'),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    await expect(
      assertNoDestructiveRecovery('a', 'one', true),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
  });
});

describe('a standalone delete that failed before its checkout left', () => {
  /** Leaves the journal a failed `git worktree remove` leaves. */
  async function failGitUnregister(): Promise<DestructiveRecoveryRecord> {
    interrupt('git-worktree-unregister', 'pending');
    await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
      'controlled interruption',
    );
    jest.restoreAllMocks();
    const failed = await readDestructiveRecovery('a', 'one');
    if (!failed) throw new Error('Expected a delete journal');
    expect(failed).toMatchObject({
      operation: 'worktree-delete',
      state: 'recovery-required',
      steps: [
        { phase: 'live-state-teardown', state: 'done' },
        { phase: 'checkout-removal', state: 'pending' },
        { phase: 'git-worktree-unregister', state: 'pending' },
      ],
    });
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(true);
    await restart();
    return failed;
  }

  it('is taken over by an Archive retry, which retains the checkout', async () => {
    const failed = await failGitUnregister();

    expect(
      await withRefusalDetails(archiveWorktree(archiveRequest)),
    ).toMatchObject({ success: true });

    const record = await readDestructiveRecovery('a', 'one');
    expect(record).toMatchObject({
      operation: 'worktree-archive',
      state: 'completed',
    });
    expect(record?.operationId).not.toBe(failed.operationId);
    const { readArchivedContainerManifest } =
      await import('../archived-containers');
    expect(await readArchivedContainerManifest('a', 'one')).toMatchObject({
      kind: 'worktree',
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(await reportDestructiveRecovery()).toEqual([]);
  });

  it('is finished by a Delete retry, which removes the checkout', async () => {
    const failed = await failGitUnregister();

    expect(
      await withRefusalDetails(deleteWorktree(archiveRequest)),
    ).toMatchObject({ success: true });

    const record = await readDestructiveRecovery('a', 'one');
    expect(record).toMatchObject({
      operation: 'worktree-delete',
      state: 'completed',
    });
    expect(record?.operationId).not.toBe(failed.operationId);
    expect(existsSync(join(root, 'a', 'worktrees', 'one'))).toBe(false);
    expect(existsSync(getArchivedContainerDir('a', 'one'))).toBe(false);
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(await reportDestructiveRecovery()).toEqual([]);
  });

  it('still refuses project deletion and archive janitors', async () => {
    const failed = await failGitUnregister();

    await expect(
      readInFlightWorktreeDestructiveOperations('a'),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    await expect(
      assertNoDestructiveRecovery('a', 'one', true),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(true);
    expect(await readDestructiveRecovery('a', 'one')).toEqual(failed);
  });

  it('still refuses an Archive retry over a replaced checkout, leaving it and the journal', async () => {
    const failed = await failGitUnregister();
    const checkout = join(root, 'a', 'worktrees', 'one');
    renameSync(checkout, join(dir, 'replaced-one'));
    mkdirSync(checkout);

    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readDestructiveRecovery('a', 'one')).toEqual(failed);
    expect(existsSync(checkout)).toBe(true);
  });
});

describe('a committed archive whose metadata a live writer recreated after its sidecar cleanup', () => {
  /** Fails the row removal as a delegation run store's late write does. */
  async function failAfterMetadataRecreated(
    file?: string,
  ): Promise<DestructiveRecoveryRecord> {
    const adhoc = await import('../adhoc-multi-repo-workspaces');
    const metadata = getWorktreeDataDir('a', 'one');
    // An existing directory is protected, as every app-created worktree's is.
    mkdirSync(metadata, { recursive: true });
    writeFileSync(join(metadata, 'panel-layout.json'), '{}');
    jest
      .spyOn(adhoc, 'cleanupCompatibilitySymlinks')
      .mockImplementationOnce(() => {
        mkdirSync(join(metadata, 'delegation', 'runs'), { recursive: true });
        if (file) writeFileSync(join(metadata, file), 'late write');
        return Promise.resolve([]);
      });
    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    const failed = await readDestructiveRecovery('a', 'one');
    if (!failed) throw new Error('Expected an archive journal');
    expect(failed).toMatchObject({ state: 'recovery-required' });
    expect(failed.steps).toContainEqual({
      phase: 'retained-manifest-commit',
      state: 'done',
    });
    expect(failed.steps.map((step) => step.phase)).not.toContain(
      'canonical-row-removal',
    );
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toContain(
      'one',
    );
    await restart();
    return failed;
  }

  it('is finished by a retry when the recreated directory holds no files', async () => {
    await failAfterMetadataRecreated();

    expect(await archiveWorktree(archiveRequest)).toMatchObject({
      success: true,
    });

    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    expect(existsSync(getWorktreeDataDir('a', 'one'))).toBe(false);
    expect(await reportDestructiveRecovery()).toEqual([]);
  });

  it('re-proves the adopted directory empty on the next retry after a resume fails', async () => {
    await failAfterMetadataRecreated();
    const cleanup = await import('../worktree-data-cleanup');
    jest
      .spyOn(cleanup, 'cleanupPersistedWorktreeData')
      .mockRejectedValueOnce(new Error('sidecar cleanup failed'));
    await expect(archiveWorktree(archiveRequest)).rejects.toThrow(
      'sidecar cleanup failed',
    );
    const failed = await readDestructiveRecovery('a', 'one');
    await restart();
    const note = join(getWorktreeDataDir('a', 'one'), 'note.txt');
    writeFileSync(note, 'late write');

    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readDestructiveRecovery('a', 'one')).toEqual(failed);
    expect(readFileSync(note, 'utf8')).toBe('late write');
  });

  it('admits a retry after a crash left the resumed metadata step pending', async () => {
    const failed = await failAfterMetadataRecreated();
    // A resumed attempt saves the step pending again before its removal.
    const crashed: DestructiveRecoveryRecord = {
      ...failed,
      state: 'active',
      steps: failed.steps.map((step) =>
        step.phase === 'sidecar:worktree metadata'
          ? { ...step, state: 'pending' }
          : step,
      ),
    };
    const key = createHash('sha256')
      .update(JSON.stringify(['a', 'one']))
      .digest('hex');
    writeFileSync(
      join(getW5DestructiveLifecycleDir(), `${key}.json`),
      JSON.stringify(crashed),
    );
    await restart();

    expect(await archiveWorktree(archiveRequest)).toMatchObject({
      success: true,
    });
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
    expect(existsSync(getWorktreeDataDir('a', 'one'))).toBe(false);
  });

  it('keeps a file written into the adopted directory after its last check', async () => {
    await failAfterMetadataRecreated();
    const note = join(getWorktreeDataDir('a', 'one'), 'note.txt');
    const { panelLayoutPersistenceStore } =
      await import('../../panels/persistence');
    // Runs inside the metadata task, after the step's identity check.
    jest
      .spyOn(panelLayoutPersistenceStore, 'cancelPendingWrite')
      .mockImplementationOnce(() => {
        writeFileSync(note, 'late write');
      });

    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(readFileSync(note, 'utf8')).toBe('late write');
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toContain(
      'one',
    );
  });

  it('still refuses a retry when the recreated directory holds a file, keeping it', async () => {
    const failed = await failAfterMetadataRecreated('note.txt');

    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(await readDestructiveRecovery('a', 'one')).toEqual(failed);
    expect(
      readFileSync(join(getWorktreeDataDir('a', 'one'), 'note.txt'), 'utf8'),
    ).toBe('late write');
  });
});

// CAN-3039: an earlier attempt staged a Git capture, then the checkout was
// deleted outside the app. That descriptor never reached teardown, and the
// capture path already degrades it to a Git-less container, so archive and
// delete admission must not refuse it as legacy recovery evidence.
function stageCapturingDescriptor(): {
  stagedPath: string;
  snapshotRef: string;
  refExists: (ref: string) => boolean;
} {
  const commit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();
  const snapshotRef = 'refs/app/archived-containers/a/one/__single_repo__';
  execFileSync('git', ['-C', repo, 'update-ref', snapshotRef, commit]);
  const archiveDir = getArchivedContainerDir('a', 'one');
  mkdirSync(archiveDir, { recursive: true });
  const stagedPath = join(archiveDir, 'git-state.staged.json');
  writeFileSync(
    stagedPath,
    JSON.stringify({
      version: 1,
      status: 'capturing',
      repositories: [
        {
          repoId: '__single_repo__',
          repoName: 'repo',
          relativePath: '.',
          referenceRepoPath: repo,
          comparisonBaseCommit: commit,
          headCommit: commit,
          indexSnapshotCommit: commit,
          worktreeSnapshotCommit: commit,
          snapshotRef,
        },
      ],
    }),
  );
  const refExists = (ref: string): boolean => {
    try {
      execFileSync('git', ['-C', repo, 'show-ref', '--verify', '-q', ref]);
      return true;
    } catch {
      return false;
    }
  };
  return { stagedPath, snapshotRef, refExists };
}

it.each([
  ['archive', false, true],
  ['delete', true, false],
] as const)(
  'a staged capture for a checkout deleted outside the app does not block %s',
  async (_mode, deleteWithoutRetentionIfMissing, retained) => {
    const { stagedPath, snapshotRef, refExists } = stageCapturingDescriptor();
    rmSync(join(root, 'a', 'worktrees', 'one'), {
      recursive: true,
      force: true,
    });

    expect(
      await archiveWorktree({
        ...archiveRequest,
        deleteWithoutRetentionIfMissing,
      }),
    ).toMatchObject({ success: true });
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'two',
    ]);
    // Archive keeps the capture pinned; delete releases it.
    expect(existsSync(stagedPath)).toBe(retained);
    expect(refExists(snapshotRef)).toBe(retained);
  },
);

it('a staged capture still requires recovery while its checkout exists', async () => {
  stageCapturingDescriptor();
  await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(existsSync(join(root, 'a', 'worktrees', 'one', '.git'))).toBe(true);
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'one',
    'two',
  ]);
});

it.each(
  (['single-repo', 'multi-repo'] as const).flatMap((workspaceType) =>
    (['slot', 'history', 'history-with-completed-slot'] as const).flatMap(
      (location) =>
        [
          { state: 'active', cleanupRequired: false, protected: true },
          {
            state: 'recovery-required',
            cleanupRequired: false,
            protected: true,
          },
          { state: 'completed', cleanupRequired: true, protected: true },
          { state: 'completed', cleanupRequired: false, protected: false },
        ].map((evidence) => ({ workspaceType, location, ...evidence })),
    ),
  ),
)(
  'journal-only child refs: $workspaceType / $location / $state / cleanup=$cleanupRequired',
  async ({
    workspaceType,
    location,
    state,
    cleanupRequired,
    protected: shouldProtect,
  }) => {
    if (workspaceType === 'multi-repo') multiRepo();
    const repoPaths =
      workspaceType === 'multi-repo' ? [repo, join(dir, 'child')] : [repo];
    const worktreeId = 'journal-only';
    const operationId = randomUUID();
    const key = createHash('sha256')
      .update(JSON.stringify(['a', worktreeId]))
      .digest('hex');
    const journalDir = getW5DestructiveLifecycleDir();
    mkdirSync(journalDir, { recursive: true });
    const journalPath = join(
      journalDir,
      `${location === 'slot' ? key : operationId}.json`,
    );
    const record = {
      version: 1,
      operationId,
      operation: 'worktree-archive',
      workspaceId: 'a',
      worktreeId,
      directoryIdentity: null,
      state,
      cleanupRequired,
      steps: [{ phase: 'checkout-removal', state: 'done' }],
      ownedPaths: [],
    };
    const evidence = JSON.stringify(record);
    writeFileSync(journalPath, evidence);
    const completedSlot = JSON.stringify({
      ...record,
      operationId: randomUUID(),
      state: 'completed',
      cleanupRequired: false,
    });
    if (location === 'history-with-completed-slot')
      writeFileSync(join(journalDir, `${key}.json`), completedSlot);
    mkdirSync(getArchivedContainersRootDir('a'), { recursive: true });
    mkdirSync(getArchivedContainersRootDir('b'), { recursive: true });
    expect(existsSync(getArchivedContainerDir('a', worktreeId))).toBe(false);
    expect(
      (await readWorkspaceWorktrees('a')).map((row) => row.id),
    ).not.toContain(worktreeId);
    const protectedRef = `refs/app/archived-containers/a/${worktreeId}/snapshot`;
    const siblingRef = `refs/app/archived-containers/a/${worktreeId}-sibling/snapshot`;
    const foreignRef = 'refs/app/archived-containers/b/orphan/snapshot';
    const prefixNeighborRef =
      'refs/app/archived-containers/a-other/orphan/snapshot';
    const repositories = repoPaths.map((repoPath) => {
      const git = (...args: string[]): string =>
        execFileSync('git', ['-C', repoPath, ...args], {
          encoding: 'utf8',
        }).trim();
      const commit = git('rev-parse', 'HEAD');
      for (const ref of [
        protectedRef,
        siblingRef,
        foreignRef,
        prefixNeighborRef,
      ])
        git('update-ref', ref, commit);
      const readRef = (ref: string): string =>
        git('for-each-ref', '--format=%(objectname)', ref);
      return { repoPath, commit, readRef };
    });

    await reconcileArchivedGitRefsForWorkspace('a');

    for (const { commit, readRef } of repositories) {
      expect(readRef(siblingRef)).toBe('');
      expect(readRef(foreignRef)).toBe(commit);
      expect(readRef(prefixNeighborRef)).toBe(commit);
      expect(readRef(protectedRef)).toBe(shouldProtect ? commit : '');
    }
    expect(readFileSync(journalPath, 'utf8')).toBe(evidence);

    await reconcileArchivedGitRefsForWorkspace('b');

    for (const { repoPath, commit, readRef } of repositories) {
      // Workspace b is configured only against the source repository.
      expect(readRef(foreignRef)).toBe(repoPath === repo ? '' : commit);
      expect(readRef(protectedRef)).toBe(shouldProtect ? commit : '');
      expect(readRef(prefixNeighborRef)).toBe(commit);
    }
    expect(readFileSync(journalPath, 'utf8')).toBe(evidence);
    if (location === 'history-with-completed-slot')
      expect(readFileSync(join(journalDir, `${key}.json`), 'utf8')).toBe(
        completedSlot,
      );
  },
);

function journalOnlyRefFixture(): () => void {
  const journalDir = getW5DestructiveLifecycleDir();
  mkdirSync(journalDir, { recursive: true });
  const operationId = randomUUID();
  const journalPath = join(journalDir, `${operationId}.json`);
  const evidence = JSON.stringify({
    version: 1,
    operationId,
    operation: 'worktree-archive',
    workspaceId: 'a',
    worktreeId: 'journal-only',
    directoryIdentity: null,
    state: 'recovery-required',
    steps: [],
  });
  writeFileSync(journalPath, evidence);
  mkdirSync(getArchivedContainersRootDir('a'), { recursive: true });
  const git = (...args: string[]): string =>
    execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
  const commit = git('rev-parse', 'HEAD');
  const protectedRef = 'refs/app/archived-containers/a/journal-only/snapshot';
  const orphanRef = 'refs/app/archived-containers/a/orphan/snapshot';
  const foreignRef = 'refs/app/archived-containers/b/orphan/snapshot';
  for (const ref of [protectedRef, orphanRef, foreignRef])
    git('update-ref', ref, commit);
  return () => {
    expect(git('rev-parse', protectedRef)).toBe(commit);
    expect(git('for-each-ref', '--format=%(refname)', orphanRef)).toBe('');
    expect(git('rev-parse', foreignRef)).toBe(commit);
    expect(readFileSync(journalPath, 'utf8')).toBe(evidence);
    expect(existsSync(getArchivedContainerDir('a', 'journal-only'))).toBe(
      false,
    );
  };
}

function journalRefGate(): { reached: Promise<void>; release: () => void } {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
}

it('journal-only child refs: retention excludes a same-workspace journal writer after its inventory snapshot', async () => {
  const verifyRefs = journalOnlyRefFixture();
  const recovery = await import('../w5-destructive-recovery');
  const archives = await import('../archived-containers');
  const { applyArchivedContainerRetention } =
    await import('../archived-container-retention');
  const scanned = journalRefGate();
  const resume = journalRefGate();
  const requested = journalRefGate();
  const read = recovery.readWorkspaceDestructiveRecoveries;
  jest
    .spyOn(recovery, 'readWorkspaceDestructiveRecoveries')
    .mockImplementation(async (id) => {
      const records = await read(id);
      if (id === 'a') {
        expect(archives.isArchivedWorkspaceOperationLockHeld(id)).toBe(true);
        scanned.release();
        await resume.reached;
      }
      return records;
    });
  const retention = applyArchivedContainerRetention();
  let archive: ReturnType<typeof archiveWorktree> | undefined;
  try {
    await scanned.reached;
    const lock = archives.withArchivedWorkspaceOperationLock;
    let entered = false;
    jest
      .spyOn(archives, 'withArchivedWorkspaceOperationLock')
      .mockImplementation((id, work, signal) => {
        if (id === 'a') requested.release();
        return lock(
          id,
          async () => {
            if (id === 'a') entered = true;
            return work();
          },
          signal,
        );
      });
    archive = archiveWorktree(archiveRequest);
    await requested.reached;
    expect(entered).toBe(false);
    expect(await readDestructiveRecovery('a', 'one')).toBe(null);
    resume.release();
    await retention;
    await expect(archive).resolves.toMatchObject({ success: true });
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
      'completed',
    );
    verifyRefs();
  } finally {
    resume.release();
    await Promise.allSettled([retention, archive]);
  }
});

it('journal-only child refs: retention waits for an in-flight completion save before reading the inventory', async () => {
  const verifyRefs = journalOnlyRefFixture();
  const pause = pauseArchiveCompletion();
  const archive = archiveWorktree(archiveRequest);
  const archives = await import('../archived-containers');
  const recovery = await import('../w5-destructive-recovery');
  const { applyArchivedContainerRetention } =
    await import('../archived-container-retention');
  let retention: Promise<void> | undefined;
  try {
    await pause.reached;
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe('active');
    const requested = journalRefGate();
    const lock = archives.withArchivedWorkspaceOperationLock;
    let entered = false;
    jest
      .spyOn(archives, 'withArchivedWorkspaceOperationLock')
      .mockImplementation((id, work, signal) => {
        if (id === 'a') requested.release();
        return lock(
          id,
          async () => {
            if (id === 'a') entered = true;
            return work();
          },
          signal,
        );
      });
    const inventory = jest.spyOn(
      recovery,
      'readWorkspaceDestructiveRecoveries',
    );
    retention = applyArchivedContainerRetention();
    await requested.reached;
    expect(entered).toBe(false);
    expect(inventory).not.toHaveBeenCalledWith('a');
    pause.release();
    await expect(archive).resolves.toMatchObject({ success: true });
    await retention;
    expect(inventory).toHaveBeenCalledWith('a');
    expect((await readDestructiveRecovery('a', 'one'))?.state).toBe(
      'completed',
    );
    verifyRefs();
  } finally {
    pause.release();
    await Promise.allSettled([archive, retention]);
  }
});

it('journal-only child refs: another workspace can publish a journal and refs after the inventory snapshot', async () => {
  const verifyRefs = journalOnlyRefFixture();
  const rows = await readWorkspaceWorktrees('a');
  writeFileSync(
    join(root, 'b', 'worktrees.json'),
    JSON.stringify({
      version: 1,
      worktrees: [{ ...rows[0], branchName: 'foreign' }],
    }),
  );
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'foreign',
    join(root, 'b', 'worktrees', 'one'),
  ]);
  const recovery = await import('../w5-destructive-recovery');
  const archives = await import('../archived-containers');
  const scanned = journalRefGate();
  const resume = journalRefGate();
  const read = recovery.readWorkspaceDestructiveRecoveries;
  jest
    .spyOn(recovery, 'readWorkspaceDestructiveRecoveries')
    .mockImplementation(async (id) => {
      const records = await read(id);
      if (id === 'a') {
        scanned.release();
        await resume.reached;
      }
      return records;
    });
  // Match retention's workspace lock while keeping the later b sweep separate.
  const reconciliation = archives.withArchivedWorkspaceOperationLock('a', () =>
    reconcileArchivedGitRefsForWorkspace('a'),
  );
  try {
    await scanned.reached;
    expect(await readDestructiveRecovery('b', 'one')).toBe(null);
    await expect(
      archiveWorktree({ ...archiveRequest, workspaceId: 'b' }),
    ).resolves.toMatchObject({ success: true });
    const journal = await readDestructiveRecovery('b', 'one');
    expect(journal?.state).toBe('completed');
    const readForeignRefs = (): string =>
      execFileSync(
        'git',
        [
          '-C',
          repo,
          'for-each-ref',
          '--format=%(refname) %(objectname)',
          'refs/app/archived-containers/b/',
        ],
        { encoding: 'utf8' },
      );
    const foreignRefs = readForeignRefs();
    expect(foreignRefs).toContain('refs/app/archived-containers/b/one/');
    resume.release();
    await reconciliation;
    expect(readForeignRefs()).toBe(foreignRefs);
    expect(await readDestructiveRecovery('b', 'one')).toEqual(journal);
    verifyRefs();
  } finally {
    resume.release();
    await reconciliation.catch(() => undefined);
  }
});

it.each(['malformed-json', 'invalid-schema', 'unmappable-child'])(
  'journal-only child refs fail closed for %s evidence',
  async (kind) => {
    const operationId = randomUUID();
    const journalDir = getW5DestructiveLifecycleDir();
    mkdirSync(journalDir, { recursive: true });
    const journalPath = join(journalDir, `${operationId}.json`);
    const evidence =
      kind === 'malformed-json'
        ? '{'
        : JSON.stringify({
            version: kind === 'invalid-schema' ? 2 : 1,
            operationId,
            operation: 'worktree-archive',
            workspaceId: 'a',
            worktreeId:
              kind === 'unmappable-child' ? 'invalid/child' : 'journal-only',
            directoryIdentity: null,
            state: 'recovery-required',
            steps: [],
          });
    writeFileSync(journalPath, evidence);
    mkdirSync(getArchivedContainersRootDir('a'), { recursive: true });
    const refs = [
      'refs/app/archived-containers/a/invalid/child/snapshot',
      'refs/app/archived-containers/a/journal-only/snapshot',
      'refs/app/archived-containers/a/orphan/snapshot',
      'refs/app/archived-containers/b/orphan/snapshot',
    ];
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commit = git('rev-parse', 'HEAD');
    for (const ref of refs) git('update-ref', ref, commit);

    const reconciliation = reconcileArchivedGitRefsForWorkspace('a');
    if (kind === 'unmappable-child')
      await expect(reconciliation).rejects.toThrow();
    else
      await expect(reconciliation).rejects.toMatchObject({
        reason: 'recovery-required',
      });

    for (const ref of refs) expect(git('rev-parse', ref)).toBe(commit);
    expect(readFileSync(journalPath, 'utf8')).toBe(evidence);
  },
);

it.each(['inventory-not-directory', 'journal-not-file'])(
  'journal-only child refs fail closed for filesystem failure: %s',
  async (kind) => {
    const journalDir = getW5DestructiveLifecycleDir();
    const journalPath = join(journalDir, `${randomUUID()}.json`);
    mkdirSync(journalDir, { recursive: true });
    if (kind === 'inventory-not-directory') {
      rmSync(journalDir, { recursive: true });
      writeFileSync(journalDir, 'preserve unreadable inventory');
    } else {
      mkdirSync(journalPath);
      writeFileSync(
        join(journalPath, 'evidence'),
        'preserve unreadable journal',
      );
    }
    mkdirSync(getArchivedContainersRootDir('a'), { recursive: true });
    const refs = [
      'refs/app/archived-containers/a/journal-only/snapshot',
      'refs/app/archived-containers/a/orphan/snapshot',
      'refs/app/archived-containers/b/orphan/snapshot',
    ];
    const git = (...args: string[]): string =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
    const commit = git('rev-parse', 'HEAD');
    for (const ref of refs) git('update-ref', ref, commit);

    await expect(
      reconcileArchivedGitRefsForWorkspace('a'),
    ).rejects.toMatchObject({ reason: 'recovery-required' });

    for (const ref of refs) expect(git('rev-parse', ref)).toBe(commit);
    if (kind === 'inventory-not-directory')
      expect(readFileSync(journalDir, 'utf8')).toBe(
        'preserve unreadable inventory',
      );
    else
      expect(readFileSync(join(journalPath, 'evidence'), 'utf8')).toBe(
        'preserve unreadable journal',
      );
  },
);

it('janitors keep protecting a missing checkout staged capture', async () => {
  const { refExists } = stageCapturingDescriptor();
  const unlisted = 'refs/app/archived-containers/a/one/unlisted';
  execFileSync('git', ['-C', repo, 'update-ref', unlisted, 'HEAD']);
  rmSync(join(root, 'a', 'worktrees', 'one'), {
    recursive: true,
    force: true,
  });
  await expect(assertNoLegacyArchiveRecovery('a', 'one')).rejects.toMatchObject(
    { reason: 'recovery-required' },
  );
  await expect(
    assertNoLegacyArchiveRecovery('a', 'one', {
      admitMissingCheckoutCapture: true,
    }),
  ).resolves.toBeUndefined();
  await reconcileArchivedGitRefsForWorkspace('a');
  expect(refExists(unlisted)).toBe(true);
});

// The capture worker pins each snapshot ref before it publishes that ref to
// the staged descriptor, so an interrupted capture can leave pinned refs the
// descriptor never lists. Archive retains that partial capture; once its
// lifecycle completes, ref reconciliation must still treat the descriptor as
// covering the container's whole ref namespace.
it('ref reconciliation keeps unlisted refs of a partial capture retained by a completed archive', async () => {
  const { stagedPath, snapshotRef, refExists } = stageCapturingDescriptor();
  const unlisted = 'refs/app/archived-containers/a/one/pinned-before-publish';
  execFileSync('git', ['-C', repo, 'update-ref', unlisted, 'HEAD']);
  rmSync(join(root, 'a', 'worktrees', 'one'), {
    recursive: true,
    force: true,
  });
  expect(
    await archiveWorktree({
      ...archiveRequest,
      deleteWithoutRetentionIfMissing: false,
    }),
  ).toMatchObject({ success: true });
  expect((await readDestructiveRecovery('a', 'one'))?.state).toBe('completed');
  expect(existsSync(stagedPath)).toBe(true);

  await reconcileArchivedGitRefsForWorkspace('a');
  expect(refExists(snapshotRef)).toBe(true);
  expect(refExists(unlisted)).toBe(true);
});

it.each([false, true])(
  'an orphan checkout without a row or operation identity is preserved for manual repair (caller timestamp: %s)',
  async (supplied) => {
    const createdAt = (await readWorkspaceWorktrees('a'))[0].createdAt;
    const rows = (await readWorkspaceWorktrees('a')).filter(
      (row) => row.id !== 'one',
    );
    writeFileSync(
      join(root, 'a', 'worktrees.json'),
      JSON.stringify({ version: 1, worktrees: rows }),
    );
    await expect(
      archiveWorktree({
        ...archiveRequest,
        expectedCreatedAt: supplied ? createdAt : undefined,
      }),
    ).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(existsSync(join(root, 'a', 'worktrees', 'one', '.git'))).toBe(true);
    expect(await readDestructiveRecovery('a', 'one')).toBe(null);
  },
);
