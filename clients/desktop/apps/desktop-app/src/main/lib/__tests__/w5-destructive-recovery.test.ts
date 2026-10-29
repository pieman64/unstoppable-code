import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import { z } from 'zod';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
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
import { join } from 'node:path';
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
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  readWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceWorktree,
} from '../workspace-persistence';
import {
  destructiveStep,
  destructiveCleanup,
  assertNoLegacyArchiveRecovery,
  withDestructiveLifecycle,
} from '../w5-destructive-recovery';
import * as gitModule from '../git';
import { getArchivedContainerDir } from '../paths';
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
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
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

it('interrupted unkeyed deletion cannot resume destructive cleanup on retry', async () => {
  jest
    .spyOn(host, 'commit')
    .mockRejectedValueOnce(new Error('decision unavailable'));
  await expect(deleteWorktree(archiveRequest)).rejects.toThrow(
    'decision unavailable',
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
    'decision unavailable',
  );
  await host.shutdown();
  __resetSidebarItemsStateForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
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
    if (request.operation === 'core.workspace.delete' && request.files.length) {
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

import * as atomicFile from '../atomic-file';
import {
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
  await host.shutdown();
  __resetSidebarItemsStateForTests();
  resetChatStateServiceForTests();
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  await waitForW5Writer(host);
}
// shutdown() stops waiting for its worker after 2 s; on a loaded runner that
// worker can still hold the log's exclusive lock, and the new host's first
// read would then report the worktree list unreadable.
async function waitForW5Writer(next: W5CommitLogHost): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await next.recoveryReport();
      return;
    } catch (error) {
      if (attempt === 10) throw error;
    }
  }
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
            'best-effort-cleanup',
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
