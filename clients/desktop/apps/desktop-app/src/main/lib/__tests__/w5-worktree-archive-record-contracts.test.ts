// W6c1 record-seam equivalence with the real commit-log worker, canonical files
// and Git. Substituted host hooks are not unmodified product lifecycle
// evidence. The port applies JSON copies of each decision.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoOperationType,
  ArchiveIoResultMap,
} from '../../archive/archive-io-protocol';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
// The archive's host services, as the destructive recovery suite stubs them.
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
  })),
}));
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => ({
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
}));
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
jest.mock('../../cost-index/lifecycle', () => ({
  ...jest.requireActual<typeof CostLifecycle>('../../cost-index/lifecycle'),
  prepareEntryCostArchive: jest.fn(() => Promise.resolve()),
  finishEntryCostArchive: jest.fn(() => Promise.resolve()),
}));
jest.mock('../main-process-logging', () => ({
  ...jest.requireActual<typeof MainProcessLogging>('../main-process-logging'),
  logMainProcessWarn: jest.fn(),
}));

import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import * as atomicFile from '../atomic-file';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import { getArchivedContainerDir } from '../paths';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  readW5Revisions,
} from '../w5-commit-log-file-store';
import {
  readDestructiveRecovery,
  withDestructiveLifecycle,
} from '../w5-destructive-recovery';
import { nodeW5FileStore } from '../w5-file-store';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktrees,
} from '../workspace-persistence';
import * as archivePort from '../worktree-archive-record-decision-port';
import * as creationPort from '../worktree-creation-decision-port';
import { archiveWorktree, deleteWorktree } from '../worktree-archive';
import {
  archiveMultiRepoWorktree,
  archiveSingleRepoWorktree,
} from '../worktree-service';
import { jsonRecordRoundTrip } from './fixtures/json-record-round-trip';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let createdAt: string;
const list = (): string => join('a', 'worktrees.json');
const listPath = (): string => join(root, list());
const checkout = (): string => join(root, 'a', 'worktrees', 'one');

function start(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}
async function restart(): Promise<void> {
  await settleDetachedWork();
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  resetChatStateServiceForTests();
  start();
  await host.recoveryReport();
}
beforeEach(() => {
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture(
    (at) => [
      { id: 'one', branchName: 'old', createdAt: at },
      { id: 'two', branchName: 'second', createdAt: at },
    ],
    ['b'],
  ));
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  start();
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    checkout(),
  ]);
  createdAt = rowsOnDisk()[0]?.createdAt ?? '';
});
afterEach(async () => {
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const rowSchema = z
  .object({ id: z.string(), branchName: z.string(), createdAt: z.string() })
  .passthrough();
function rowsOnDisk(): z.infer<typeof rowSchema>[] {
  return z
    .object({ worktrees: z.array(rowSchema) })
    .passthrough()
    .parse(JSON.parse(readFileSync(listPath(), 'utf8'))).worktrees;
}
function writeRows(rows: unknown[]): void {
  writeFileSync(listPath(), JSON.stringify({ version: 1, worktrees: rows }));
}
function branchExists(repository: string, branch: string): boolean {
  try {
    execFileSync('git', [
      '-C',
      repository,
      'show-ref',
      '--verify',
      '-q',
      `refs/heads/${branch}`,
    ]);
    return true;
  } catch {
    return false;
  }
}
function multiRepo(): string {
  const child = join(dir, 'child');
  execFileSync('git', ['clone', '-q', '--no-hardlinks', repo, child]);
  writeFileSync(join(checkout(), '.gitignore'), 'repos/\n');
  execFileSync('git', ['-C', checkout(), 'add', '.gitignore']);
  execFileSync('git', [
    '-C',
    checkout(),
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
    join(checkout(), 'repos', 'child'),
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
  const indexPath = join(root, 'index.json');
  writeFileSync(
    indexPath,
    readFileSync(indexPath, 'utf8').replace(
      '"type":"single-repo"',
      '"type":"multi-repo"',
    ),
  );
  __resetSidebarItemsStateForTests();
  return child;
}
function interrupt(
  phase: string,
  state: 'pending' | 'done',
  reached: () => void = () => {
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
        fired ||
        !file.includes('destructive-lifecycles') ||
        typeof contents !== 'string'
      )
        return;
      const record = z
        .object({
          state: z.string(),
          steps: z.array(z.object({ phase: z.string(), state: z.string() })),
        })
        .parse(JSON.parse(contents));
      if (
        record.state === 'active' &&
        record.steps.some(
          (step) => step.phase === phase && step.state === state,
        )
      ) {
        fired = true;
        reached();
      }
    });
  return () => fired;
}

interface Seam {
  events: unknown[];
  commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
  commitOriginal: W5CommitLogHost['commit'];
  receipt: () => Parameters<W5CommitLogHost['lookupReceipt']>[0];
}
/** Records each decision, as JSON, and each commit and reservation, in order. */
function recordArchiveSeam(): Seam {
  const events: unknown[] = [];
  const journal = archivePort.applyArchiveJournalRecord;
  jest
    .spyOn(archivePort, 'applyArchiveJournalRecord')
    .mockImplementation(async (target, decision) => {
      events.push({ decision });
      const found = await journal(
        jsonRecordRoundTrip(target),
        jsonRecordRoundTrip(decision),
      );
      events.push({ found });
      return found;
    });
  const removeRow = archivePort.applyArchivedWorktreeRowRemoval;
  jest
    .spyOn(archivePort, 'applyArchivedWorktreeRowRemoval')
    .mockImplementation(async (target, decision) => {
      events.push({ decision });
      const removed = await removeRow(
        jsonRecordRoundTrip(target),
        jsonRecordRoundTrip(decision),
      );
      events.push({ removed });
      return removed;
    });
  const tombstone = archivePort.applyArchiveCleanupTombstone;
  jest
    .spyOn(archivePort, 'applyArchiveCleanupTombstone')
    .mockImplementation(async (target, decision) => {
      events.push({ decision });
      await tombstone(
        jsonRecordRoundTrip(target),
        jsonRecordRoundTrip(decision),
      );
    });
  const removeReserved = creationPort.applyReservedWorktreeRemoval;
  jest
    .spyOn(creationPort, 'applyReservedWorktreeRemoval')
    .mockImplementation(async (target, decision) => {
      events.push({ decision });
      const removed = await removeReserved(
        jsonRecordRoundTrip(target),
        jsonRecordRoundTrip(decision),
      );
      events.push({ removed });
      return removed;
    });
  const reserve = host.reserve.bind(host);
  const reservations = jest
    .spyOn(host, 'reserve')
    .mockImplementation(async (input) => {
      events.push('reserve');
      return reserve(input);
    });
  const commitOriginal = host.commit.bind(host);
  const commits = jest
    .spyOn(host, 'commit')
    .mockImplementation(async (input) => {
      events.push({
        operation: input.operation,
        files: input.files.map((file) => relative(root, file.path)),
        receipt: Boolean(input.receipt),
        ...(input.expectedRevisions
          ? { expectedRevisions: input.expectedRevisions }
          : {}),
      });
      return commitOriginal(input);
    });
  const receipt = (): Parameters<W5CommitLogHost['lookupReceipt']>[0] => {
    const value = reservations.mock.calls[0]?.[0].receipt;
    if (!value) throw new Error('Expected a keyed reservation');
    return value;
  };
  return { events, commits, commitOriginal, receipt };
}

const archiveRequest = {
  workspaceId: 'a',
  worktreeId: 'one',
  source: 'single_repo' as const,
  deleteWithoutRetentionIfMissing: true,
};
function rowRevision(revision: number): unknown {
  return {
    resource: { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
    revision,
  };
}
async function currentRevision(): Promise<number> {
  const [read] = await readW5Revisions([
    { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
  ]);
  if (!read) throw new Error('Missing row revision');
  return read.revision;
}
// The legacy commits: a journal under the archive's carried-forward revisions
// or as its own list write, then the row removal and the receipt.
function journalCommit(revision?: number): unknown {
  return {
    operation: 'internal.worktree.archive.journal',
    files: [list()],
    receipt: false,
    ...(revision === undefined
      ? {}
      : { expectedRevisions: [rowRevision(revision)] }),
  };
}
const listWrite = {
  operation: 'w5.worktree_list.write',
  files: [list()],
  receipt: false,
};
function removalCommit(operation: string, revision?: number): unknown {
  return {
    operation,
    files: [list()],
    receipt: false,
    ...(revision === undefined
      ? {}
      : { expectedRevisions: [rowRevision(revision)] }),
  };
}
function receiptCommit(operation: string): unknown {
  return { operation, files: [], receipt: true };
}
const reservedRemoval = {
  decision: { kind: 'worktree.create.reservation.remove' },
};
const single = (deletion: unknown): unknown => ({
  decision: {
    kind: 'worktree.archive.journal.record',
    workspaceKind: 'single-repo',
    pendingBranchDeletion: deletion,
  },
});
const found = { found: true };
const removed = { removed: true };
const notFound = { removed: false };
function tip(repository: string, branch: string): string {
  return execFileSync(
    'git',
    ['-C', repository, 'rev-parse', `refs/heads/${branch}`],
    { encoding: 'utf8' },
  ).trim();
}
function guard(repository: string, branch: string): Record<string, string> {
  return {
    referenceRepoPath: repository,
    repositoryIdentity: join(repository, '.git'),
    branchName: branch,
    expectedTip: tip(repository, branch),
  };
}

it('W6c1 journals a keyed single-repository branch deletion before Git, then removes the row in the delete decision', async () => {
  const revision = await currentRevision();
  const deletion = guard(repo, 'old');
  const { events } = recordArchiveSeam();
  const first = await deleteWorktree({
    ...archiveRequest,
    idempotencyKey: 'delete',
    deleteBranch: true,
    expectedRevision: revision,
  });
  expect(first).toMatchObject({ success: true, status: 'archived' });
  expect(events).toEqual([
    'reserve',
    single(deletion),
    found,
    journalCommit(revision),
    reservedRemoval,
    removed,
    // The journal advanced the row once; the removal carries that forward.
    removalCommit('core.worktree.delete', revision + 1),
    receiptCommit('core.worktree.delete'),
  ]);
  expect(branchExists(repo, 'old')).toBe(false);
  expect(rowsOnDisk().map((row) => row.id)).toEqual(['two']);
  events.length = 0;
  await expect(
    deleteWorktree({
      ...archiveRequest,
      idempotencyKey: 'delete',
      deleteBranch: true,
      expectedRevision: revision,
    }),
  ).resolves.toEqual(first);
  expect(events).toEqual([]);
});

it('W6c1 journals an unrevised branch deletion as its own list write', async () => {
  const deletion = guard(repo, 'old');
  const { events } = recordArchiveSeam();
  await expect(
    deleteWorktree({ ...archiveRequest, deleteBranch: true }),
  ).resolves.toMatchObject({ success: true });
  expect(events).toEqual([
    single(deletion),
    listWrite,
    found,
    reservedRemoval,
    removed,
    removalCommit('core.worktree.delete'),
  ]);
});

it('W6c1 journals every multi-repository branch deletion in one record', async () => {
  const child = multiRepo();
  const revision = await currentRevision();
  const deletions = [
    { repoId: 'child', ...guard(child, 'child-old') },
    { repoId: '__workspace_root__', ...guard(repo, 'old') },
  ];
  const { events } = recordArchiveSeam();
  await expect(
    deleteWorktree({
      ...archiveRequest,
      source: 'multi_repo',
      idempotencyKey: 'delete',
      deleteBranch: true,
      expectedRevision: revision,
    }),
  ).resolves.toMatchObject({ success: true });
  expect(events).toEqual([
    'reserve',
    {
      decision: {
        kind: 'worktree.archive.journal.record',
        workspaceKind: 'multi-repo',
        pendingBranchDeletions: deletions,
      },
    },
    found,
    journalCommit(revision),
    reservedRemoval,
    removed,
    removalCommit('core.worktree.delete', revision + 1),
    receiptCommit('core.worktree.delete'),
  ]);
  expect(branchExists(child, 'child-old')).toBe(false);
  expect(branchExists(repo, 'old')).toBe(false);
});

it.each(['single-repo', 'multi-repo'] as const)(
  'W6c1 clears a persisted %s guard when the branch is kept',
  async (workspaceKind) => {
    const child = workspaceKind === 'multi-repo' ? multiRepo() : undefined;
    const persisted = guard(repo, 'old');
    writeRows(
      rowsOnDisk().map((row) =>
        row.id !== 'one'
          ? row
          : child
            ? {
                ...row,
                pendingArchiveBranchDeletions: [
                  { repoId: 'child', ...guard(child, 'child-old') },
                ],
              }
            : { ...row, pendingArchiveBranchDeletion: persisted },
      ),
    );
    const revision = await currentRevision();
    const { events } = recordArchiveSeam();
    await expect(
      deleteWorktree({
        ...archiveRequest,
        source: child ? 'multi_repo' : 'single_repo',
        deleteBranch: false,
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      {
        decision: { kind: 'worktree.archive.journal.clear', workspaceKind },
      },
      found,
      journalCommit(revision),
      reservedRemoval,
      removed,
      removalCommit('core.worktree.delete', revision + 1),
    ]);
    expect(branchExists(repo, 'old')).toBe(true);
    if (child) expect(branchExists(child, 'child-old')).toBe(true);
  },
);

it('W6c1 preserves effects and reports recovery-required when the row removal conflicts after Git', async () => {
  const revision = await currentRevision();
  const deletion = guard(repo, 'old');
  const seam = recordArchiveSeam();
  const conflict = new W5CommitRefusedError(
    'revision-conflict',
    'A rival decision moved the worktree.',
  );
  seam.commits.mockImplementation(async (input) => {
    if (input.operation === 'core.worktree.delete' && input.files.length) {
      seam.events.push('conflict');
      throw conflict;
    }
    seam.events.push({
      operation: input.operation,
      receipt: Boolean(input.receipt),
    });
    return seam.commitOriginal(input);
  });
  const request = {
    ...archiveRequest,
    idempotencyKey: 'conflict',
    deleteBranch: true,
    expectedRevision: revision,
  };
  await expect(deleteWorktree(request)).rejects.toBeDefined();
  expect(seam.events).toEqual([
    'reserve',
    single(deletion),
    found,
    { operation: 'internal.worktree.archive.journal', receipt: false },
    // The removal decision is applied in the refused commit; nothing
    // compensates for the checkout and branch already gone.
    reservedRemoval,
    removed,
    'conflict',
  ]);
  expect(existsSync(checkout())).toBe(false);
  expect(branchExists(repo, 'old')).toBe(false);
  const retained = rowsOnDisk().find((row) => row.id === 'one');
  expect(retained).toMatchObject({ pendingArchiveBranchDeletion: deletion });
  expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
    state: 'recovery-required',
  });
  expect(await host.lookupReceipt(seam.receipt())).toMatchObject({
    status: 'recovery-required',
  });
  const before = readFileSync(listPath());
  seam.events.length = 0;
  await expect(deleteWorktree(request)).rejects.toMatchObject({
    reason: 'recovery-required',
  });
  expect(seam.events).toEqual([]);
  expect(readFileSync(listPath())).toEqual(before);
});

describe('#5894 committed-cleanup retry', () => {
  async function crashAfterManifest(): Promise<void> {
    mkdirSync(join(root, 'a', 'worktree-data', 'one'), { recursive: true });
    const fired = interrupt('sidecar:chat plugin state', 'pending');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    jest.restoreAllMocks();
    await restart();
  }
  function manifestPath(): string {
    return join(getArchivedContainerDir('a', 'one'), 'container.json');
  }

  it('CAN-5158 completes a verified committed archive cleanup after its source becomes unavailable', async () => {
    await crashAfterManifest();
    renameSync(repo, `${repo}-unavailable`);
    await expect(archiveWorktree(archiveRequest)).resolves.toMatchObject({
      success: true,
    });
    expect(rowsOnDisk().map((row) => row.id)).toEqual(['two']);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
    expect(existsSync(manifestPath())).toBe(true);
  });

  it('W6c1 finishes through the reserved row removal alone, ignoring a stale caller revision', async () => {
    await crashAfterManifest();
    const { events } = recordArchiveSeam();
    await expect(
      archiveWorktree({ ...archiveRequest, expectedRevision: 0 }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      reservedRemoval,
      removed,
      removalCommit('core.worktree.archive'),
    ]);
    expect(rowsOnDisk().map((row) => row.id)).toEqual(['two']);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
  });

  it('W6c1 tombstones the archived incarnation when its row is already removed', async () => {
    const fired = interrupt('canonical-row-removal', 'done');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    jest.restoreAllMocks();
    await restart();
    const { events } = recordArchiveSeam();
    await expect(deleteWorktree(archiveRequest)).resolves.toMatchObject({
      success: true,
    });
    expect(events).toEqual([
      reservedRemoval,
      notFound,
      {
        decision: { kind: 'worktree.archive.cleanup.tombstone', createdAt },
      },
    ]);
    expect(isWorkspaceWorktreeRecentlyRemoved('a', 'one', createdAt)).toBe(
      true,
    );
    expect(existsSync(manifestPath())).toBe(true);
  });

  type Corrupt = () => void;
  const viaService = (): Promise<unknown> =>
    archiveSingleRepoWorktree({ workspaceId: 'a', worktreeId: 'one' });
  const replaceCreatedAt = (file: string): void => {
    writeFileSync(
      file,
      readFileSync(file, 'utf8').replaceAll(
        createdAt,
        '2099-01-01T00:00:00.000Z',
      ),
    );
  };
  // The boundary passes the listed row's createdAt as the expected one, so a
  // changed row there refuses as an expected mismatch; an internal caller
  // without one reaches the row check.
  const refusals: [string, Corrupt, (() => Promise<unknown>)?][] = [
    [
      'row-list-not-authoritative',
      (): void =>
        writeRows([
          ...rowsOnDisk(),
          { id: 'unreadable', branchName: 123, createdAt: 'invalid' },
        ]),
    ],
    ['manifest-unreadable', (): void => writeFileSync(manifestPath(), '{')],
    [
      'manifest-kind',
      (): void => {
        const manifest = z
          .object({
            gitState: z.unknown(),
            gitChanges: z.unknown(),
            pullRequestMetadata: z.unknown(),
          })
          .passthrough()
          .parse(JSON.parse(readFileSync(manifestPath(), 'utf8')));
        // A well-formed files-only manifest, which this retry never resumes.
        const {
          gitState: _gitState,
          gitChanges: _gitChanges,
          pullRequestMetadata: _pullRequests,
          ...files
        } = manifest;
        void [_gitState, _gitChanges, _pullRequests];
        writeFileSync(
          manifestPath(),
          JSON.stringify({
            ...files,
            version: 3,
            recovery: {
              kind: 'files-only',
              source: 'retained',
              digest: 'a'.repeat(64),
              payloadId: '00000000-0000-4000-8000-000000000002',
            },
          }),
        );
      },
    ],
    [
      'manifest-created-at-mismatch',
      (): void => replaceCreatedAt(manifestPath()),
    ],
    ['expected-created-at-mismatch', (): void => replaceCreatedAt(listPath())],
    [
      'row-created-at-mismatch',
      (): void => replaceCreatedAt(listPath()),
      viaService,
    ],
    [
      'row-removal-not-journaled',
      (): void => writeRows(rowsOnDisk().filter((row) => row.id !== 'one')),
    ],
  ];
  it.each(refusals)(
    'W6c1 keeps the %s refusal, deciding and committing nothing',
    async (
      check,
      corrupt,
      retry = (): Promise<unknown> => archiveWorktree(archiveRequest),
    ) => {
      await crashAfterManifest();
      corrupt();
      const rows = readFileSync(listPath());
      const journal = await readDestructiveRecovery('a', 'one');
      const { events } = recordArchiveSeam();
      await expect(retry()).rejects.toMatchObject({
        reason: 'recovery-required',
        details: { phase: 'archive-journal', check },
      });
      expect(events).toEqual([]);
      expect(readFileSync(listPath())).toEqual(rows);
      expect(await readDestructiveRecovery('a', 'one')).toEqual(journal);
    },
  );

  it('W6c1 keeps the expected-created-at-mismatch refusal after the row removal, deciding nothing', async () => {
    const fired = interrupt('canonical-row-removal', 'done');
    await expect(archiveWorktree(archiveRequest)).rejects.toBeDefined();
    expect(fired()).toBe(true);
    jest.restoreAllMocks();
    await restart();
    const { events } = recordArchiveSeam();
    await expect(
      archiveWorktree({
        ...archiveRequest,
        expectedCreatedAt: '2099-01-01T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({
      reason: 'recovery-required',
      details: { check: 'expected-created-at-mismatch' },
    });
    expect(events).toEqual([]);
  });

  it('W6c1 keeps the in-step list recheck ahead of the reserved row removal', async () => {
    await crashAfterManifest();
    let changed: Buffer | undefined;
    const fired = interrupt('canonical-row-removal', 'pending', () => {
      writeRows([
        ...rowsOnDisk(),
        { id: 'unreadable', branchName: 123, createdAt: 'invalid' },
      ]);
      changed = readFileSync(listPath());
    });
    const { events } = recordArchiveSeam();
    await expect(archiveWorktree(archiveRequest)).rejects.toMatchObject({
      reason: 'recovery-required',
      details: { check: 'row-list-not-authoritative' },
    });
    expect(fired()).toBe(true);
    expect(events).toEqual([]);
    expect(readFileSync(listPath())).toEqual(changed);
  });
});

describe('internal needs-repair rollback', () => {
  function dropRow(): void {
    writeRows(rowsOnDisk().filter((row) => row.id !== 'one'));
  }

  it('W6c1 tombstones the rolled-back incarnation the reserved removal no longer finds', async () => {
    dropRow();
    const { events } = recordArchiveSeam();
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        expectedCreatedAt: createdAt,
        allowMissingRow: true,
        retainAsArchivedContainer: false,
        deleteBranch: false,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      reservedRemoval,
      notFound,
      {
        decision: { kind: 'worktree.archive.cleanup.tombstone', createdAt },
      },
    ]);
    expect(isWorkspaceWorktreeRecentlyRemoved('a', 'one', createdAt)).toBe(
      true,
    );
    expect(existsSync(checkout())).toBe(false);
  });

  it('W6c1 tombstones a rolled-back multi-repository incarnation after the reserved removal', async () => {
    multiRepo();
    dropRow();
    const { events } = recordArchiveSeam();
    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        expectedCreatedAt: createdAt,
        allowMissingRow: true,
        retainAsArchivedContainer: false,
        deleteBranch: false,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      reservedRemoval,
      notFound,
      {
        decision: { kind: 'worktree.archive.cleanup.tombstone', createdAt },
      },
    ]);
    expect(isWorkspaceWorktreeRecentlyRemoved('a', 'one', createdAt)).toBe(
      true,
    );
  });

  it('W6c1 removes a multi-repository row by id when no incarnation is known', async () => {
    multiRepo();
    dropRow();
    const { events } = recordArchiveSeam();
    await expect(
      archiveMultiRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        allowMissingRow: true,
        retainAsArchivedContainer: false,
        deleteBranch: false,
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      { decision: { kind: 'worktree.archive.row.remove' } },
      notFound,
    ]);
  });

  it('W6c1 removes by id, with the requested order, when no incarnation is known', async () => {
    dropRow();
    const { events } = recordArchiveSeam();
    await expect(
      archiveSingleRepoWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        allowMissingRow: true,
        retainAsArchivedContainer: false,
        deleteBranch: false,
        remainingWorktreeOrder: ['two'],
        expectedRemainingWorktreeOrder: ['two'],
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      {
        decision: {
          kind: 'worktree.archive.row.remove',
          remainingWorktreeOrder: ['two'],
          expectedRemainingWorktreeOrder: ['two'],
        },
      },
      notFound,
    ]);
  });
});

describe('legacy row without a createdAt', () => {
  function dropCreatedAt(): void {
    writeRows(
      rowsOnDisk().map((row) =>
        row.id === 'one' ? { ...row, createdAt: '' } : row,
      ),
    );
  }

  it('W6c1 preserves effects and reports recovery-required when the by-id removal conflicts after Git', async () => {
    dropCreatedAt();
    const revision = await currentRevision();
    const deletion = guard(repo, 'old');
    const seam = recordArchiveSeam();
    seam.commits.mockImplementation(async (input) => {
      if (input.operation === 'core.worktree.delete' && input.files.length) {
        seam.events.push('conflict');
        throw new W5CommitRefusedError(
          'revision-conflict',
          'A rival decision moved the worktree.',
        );
      }
      seam.events.push({
        operation: input.operation,
        receipt: Boolean(input.receipt),
      });
      return seam.commitOriginal(input);
    });
    const request = {
      ...archiveRequest,
      idempotencyKey: 'legacy-conflict',
      deleteBranch: true,
      expectedRevision: revision,
    };
    await expect(deleteWorktree(request)).rejects.toBeDefined();
    expect(seam.events).toEqual([
      'reserve',
      single(deletion),
      found,
      { operation: 'internal.worktree.archive.journal', receipt: false },
      { decision: { kind: 'worktree.archive.row.remove' } },
      removed,
      'conflict',
    ]);
    expect(existsSync(checkout())).toBe(false);
    expect(branchExists(repo, 'old')).toBe(false);
    expect(rowsOnDisk().find((row) => row.id === 'one')).toMatchObject({
      pendingArchiveBranchDeletion: deletion,
    });
    // The refused removal's tombstone does not outlive the retained row.
    expect(isWorkspaceWorktreeRecentlyRemoved('a', 'one', '')).toBe(false);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'recovery-required',
    });
    expect(await host.lookupReceipt(seam.receipt())).toMatchObject({
      status: 'recovery-required',
    });
    const before = readFileSync(listPath());
    seam.events.length = 0;
    await expect(deleteWorktree(request)).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(seam.events).toEqual([]);
    expect(readFileSync(listPath())).toEqual(before);
  });

  // Runs last: the tombstone of a removed legacy row (`a/one/`) outlives the
  // test in this process and would hide the next test's row.
  it('W6c1 journals the branch deletion, then removes the row by id with its order', async () => {
    dropCreatedAt();
    const deletion = guard(repo, 'old');
    const { events } = recordArchiveSeam();
    await expect(
      deleteWorktree({
        ...archiveRequest,
        deleteBranch: true,
        remainingWorktreeOrder: ['two'],
      }),
    ).resolves.toMatchObject({ success: true });
    expect(events).toEqual([
      single(deletion),
      listWrite,
      found,
      {
        decision: {
          kind: 'worktree.archive.row.remove',
          remainingWorktreeOrder: ['two'],
        },
      },
      removed,
      removalCommit('core.worktree.delete'),
    ]);
    expect(branchExists(repo, 'old')).toBe(false);
    expect(rowsOnDisk().map((row) => row.id)).toEqual(['two']);
  });
});

describe('W6c1 port members', () => {
  const at = '2026-10-24T00:00:00.000Z';

  it('removes every incarnation at the id, applying the expected order, and tombstones it', async () => {
    const rows: WorktreeData[] = [
      { id: 'first', branchName: 'first', createdAt: at },
      { id: 'removed', branchName: 'removed', createdAt: 'any' },
      { id: 'last', branchName: 'last', createdAt: at },
    ];
    writeRows(rows);
    await expect(
      archivePort.applyArchivedWorktreeRowRemoval(
        { workspaceId: 'a', worktreeId: 'removed' },
        jsonRecordRoundTrip({
          kind: 'worktree.archive.row.remove',
          remainingWorktreeOrder: ['last', 'first'],
          expectedRemainingWorktreeOrder: ['first', 'last'],
        }),
      ),
    ).resolves.toBe(true);
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'last',
      'first',
    ]);
    expect(isWorkspaceWorktreeRecentlyRemoved('a', 'removed', 'any')).toBe(
      true,
    );
  });

  it('keeps the list order when the remaining rows moved', async () => {
    writeRows([
      { id: 'first', branchName: 'first', createdAt: at },
      { id: 'moved', branchName: 'moved', createdAt: at },
      { id: 'last', branchName: 'last', createdAt: at },
    ]);
    await archivePort.applyArchivedWorktreeRowRemoval(
      { workspaceId: 'a', worktreeId: 'moved' },
      {
        kind: 'worktree.archive.row.remove',
        remainingWorktreeOrder: ['last', 'first'],
        expectedRemainingWorktreeOrder: ['last', 'first'],
      },
    );
    expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
      'first',
      'last',
    ]);
  });

  it('refuses a journal for another incarnation than the running lifecycle, writing nothing', async () => {
    const before = readFileSync(listPath());
    const commits = jest.spyOn(host, 'commit');
    await expect(
      withDestructiveLifecycle(
        {
          operation: 'worktree-delete',
          workspaceId: 'a',
          worktreeId: 'one',
          createdAt: '2099-01-01T00:00:00.000Z',
          allowMissingRow: true,
        },
        () =>
          archivePort.applyArchiveJournalRecord(
            { workspaceId: 'a', worktreeId: 'one' },
            {
              kind: 'worktree.archive.journal.clear',
              workspaceKind: 'single-repo',
            },
          ),
      ),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(readFileSync(listPath())).toEqual(before);
    expect(commits).not.toHaveBeenCalled();
  });

  it('reports an absent row without writing', async () => {
    const before = readFileSync(listPath());
    await expect(
      archivePort.applyArchiveJournalRecord(
        { workspaceId: 'a', worktreeId: 'missing' },
        { kind: 'worktree.archive.journal.clear', workspaceKind: 'multi-repo' },
      ),
    ).resolves.toBe(false);
    expect(readFileSync(listPath())).toEqual(before);
  });
});
