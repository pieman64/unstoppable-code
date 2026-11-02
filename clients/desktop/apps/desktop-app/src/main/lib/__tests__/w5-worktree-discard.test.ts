// CAN-5334: the user-only worktree discard on the real commit-log worker,
// files and Git, with the W6c2 host-service substitutes. Record-seam evidence,
// not Electron or Portal transport evidence.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as FsPromises from 'node:fs/promises';
import { z } from 'zod';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
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
/** Runs before every `rm`; a rejection fails that `rm`. */
let mockBeforeRemoval: ((path: string) => Promise<void>) | undefined;
/** Runs before every `rename`, with its source path. */
let mockBeforeRename: ((path: string) => void) | undefined;
/** Runs after every successful `rename`, with its source and target paths. */
let mockAfterRename: ((from: string, to: string) => void) | undefined;
jest.mock('node:fs/promises', () => {
  const actual = jest.requireActual<typeof FsPromises>('node:fs/promises');
  return {
    ...actual,
    rename: async (
      ...args: Parameters<typeof actual.rename>
    ): Promise<void> => {
      mockBeforeRename?.(String(args[0]));
      await actual.rename(...args);
      mockAfterRename?.(String(args[0]), String(args[1]));
    },
    rm: async (...args: Parameters<typeof actual.rm>): Promise<void> => {
      await mockBeforeRemoval?.(String(args[0]));
      return actual.rm(...args);
    },
  };
});
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
import { createHash, randomUUID } from 'node:crypto';
import {
  LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
  lifecycleJournalRefusalKind,
} from '@canopy/protocol/portal/lifecycle-journal';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { WorktreeArchiveRefusedError } from '../worktree-archive-refusal';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import {
  SHARED_CONTAINER_VIEWER_PROJECT_ID,
  type ArchivedContainerManifest,
} from '@canopy/desktop-shared/types';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import { getAppAdvisorWatcherService } from '../../app-advisor/watchers';
import type * as Watchers from '../../app-advisor/watchers';
import { LocalWatcherScheduler } from '../../app-advisor/local-watcher-scheduler';
import { isWorktreeSetupCancellationRequested } from '../worktree-setup-cancellation';
import { setDelegationActivity } from '../../agents/delegation/activity';
import * as sessionManager from '../../agents/session-manager';
import { createLiveBackgroundTaskOwner } from '../../ipc/__tests__/background-work-removal-test-helpers';
import {
  acquireSplitDestinationWorktreeClaim,
  acquireSplitLock,
  releaseSplitDestinationWorktreeClaim,
  releaseSplitLock,
} from '../../services/split-lock-service';
import * as atomicFile from '../atomic-file';
import * as w5Destructive from '../w5-destructive-recovery';
import {
  hasUnresolvedDestructiveRecovery,
  readDestructiveRecovery,
} from '../w5-destructive-recovery';
import * as keyedOperation from '../w5-keyed-operation';
import { archiveWorktree } from '../worktree-archive';
import { listArchivedContainerManifests } from '../archived-containers';
import { assertArchivedGitStateRestorable } from '../archived-container-git';
import * as archivedContainerGit from '../archived-container-git';
import * as archivedContainerRecovery from '../archived-container-recovery';
import * as gitExecutable from '../git-executable';
import * as gitModule from '../git';
import * as worktreeLiveCleanup from '../worktree-live-cleanup';
import * as worktreeDataCleanup from '../worktree-data-cleanup';
import * as registrationRemoval from '../worktree-registration-removal';
import * as animals from '../animals';
import {
  getArchivedContainerDir,
  getW5DestructiveLifecycleDir,
} from '../paths';
import { deleteWorkspace } from '../workspace-deletion';
import { createSingleRepoWorktree } from '../worktree-service';
import {
  describeWorktreeDiscard,
  discardWorktree,
  withTypedArchiveRefusal,
} from '../worktree-discard';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
const originalWatcherFactory = jest
  .mocked(getAppAdvisorWatcherService)
  .getMockImplementation();

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

beforeEach(() => {
  mockArchiveIoFault = undefined;
  mockBeforeRemoval = undefined;
  mockBeforeRename = undefined;
  mockAfterRename = undefined;
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
  jest.clearAllMocks();
});
afterEach(async () => {
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

/** The oldest journal schema (e2f51fe265, CAN-3815); every journal must parse. */
const frozenJournalSchema = z.object({
  version: z.literal(1),
  operationId: z.string().uuid(),
  operation: z.enum([
    'workspace-delete',
    'worktree-archive',
    'worktree-delete',
  ]),
  workspaceId: z.string(),
  worktreeId: z.string().optional(),
  createdAt: z.string().optional(),
  directoryIdentity: z.string().nullable(),
  state: z.enum(['active', 'recovery-required', 'completed']),
  steps: z.array(
    z.object({
      phase: z.string(),
      state: z.enum(['pending', 'done', 'failed']),
    }),
  ),
  outcome: z.unknown().optional(),
  cleanupRequired: z.boolean().optional(),
  ownedPaths: z
    .array(z.object({ path: z.string(), identity: z.string().nullable() }))
    .default([]),
});
/** The archive outcome every desktop replays a completed record through. */
const frozenOutcomeSchema = z.object({
  success: z.boolean(),
  warnings: z.array(z.string()),
  removedTemporaryWorkspaceId: z.string().optional(),
  removedTemporaryWorkspaceName: z.string().optional(),
});

const checkoutOf = (worktreeId: string): string =>
  join(root, 'a', 'worktrees', worktreeId);
const quarantineOf = (worktreeId: string): string =>
  join(root, 'a', 'worktrees', `.${worktreeId}.archive-quarantine`);
/** Where the worker moves a target of `kind` before removing it. */
const asideOf = (
  worktreeId: string,
  kind:
    | 'live-checkout'
    | 'recreated-checkout-path'
    | 'git-quarantine'
    | 'files-only-recovery',
): string =>
  join(
    kind === 'files-only-recovery'
      ? dirname(getArchivedContainerDir('a', worktreeId))
      : join(root, 'a', 'worktrees'),
    `.${worktreeId}.discard-aside-${kind}`,
  );
const checkoutAsideOf = (worktreeId: string): string =>
  asideOf(worktreeId, 'live-checkout');

/** Runs `before` once, ahead of the first `rm` of a matching path. */
function beforeFirstRemoval(
  matches: (path: string) => boolean,
  before: () => Promise<void>,
): void {
  let ran = false;
  mockBeforeRemoval = async (path): Promise<void> => {
    if (ran || !matches(path)) return;
    ran = true;
    await before();
  };
}
const NOTES = 'kept in the archived snapshot';

function journalFileOf(worktreeId?: string): string {
  const key = createHash('sha256')
    .update(JSON.stringify(['a', worktreeId ?? null]))
    .digest('hex');
  return join(getW5DestructiveLifecycleDir(), `${key}.json`);
}

/** Every journal file's text, by name. */
function journalFiles(): Record<string, string> {
  if (!existsSync(getW5DestructiveLifecycleDir())) return {};
  return Object.fromEntries(
    readdirSync(getW5DestructiveLifecycleDir())
      .filter((name) => name.endsWith('.json'))
      .sort()
      .map((name) => [
        name,
        readFileSync(join(getW5DestructiveLifecycleDir(), name), 'utf8'),
      ]),
  );
}

function expectJournalsParseUnderFrozenSchema(): void {
  for (const text of Object.values(journalFiles())) {
    const record = frozenJournalSchema.parse(JSON.parse(text));
    if (record.state === 'completed') frozenOutcomeSchema.parse(record.outcome);
  }
}

function worktreeIds(): string[] {
  return z
    .object({ worktrees: z.array(z.object({ id: z.string() })) })
    .parse(JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')))
    .worktrees.map((worktree) => worktree.id);
}

function rowOf(worktreeId: string): { id: string; createdAt: string } {
  const row = z
    .object({
      worktrees: z.array(z.object({ id: z.string(), createdAt: z.string() })),
    })
    .parse(JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')))
    .worktrees.find((worktree) => worktree.id === worktreeId);
  if (!row) throw new Error(`Expected row ${worktreeId}`);
  return row;
}

/** Journals, rows and the named paths' presence: a refusal changes none. */
function effectSnapshot(paths: readonly string[]): unknown {
  return {
    journals: journalFiles(),
    rows: readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
    paths: paths.map((path) => [path, existsSync(path)]),
  };
}

async function discardAsDescribed(
  worktreeId: string,
): Promise<Awaited<ReturnType<typeof discardWorktree>>> {
  const description = await describeWorktreeDiscard('a', worktreeId);
  return discardWorktree({
    workspaceId: 'a',
    worktreeId,
    confirmation: description.confirmation,
    source: 'desktop-ui',
  });
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    execFileSync(
      'git',
      ['-C', repoPath, 'rev-parse', '--verify', `refs/heads/${branch}`],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

function registrations(repoPath: string): string {
  return execFileSync(
    'git',
    ['-C', repoPath, 'worktree', 'list', '--porcelain'],
    {
      encoding: 'utf8',
    },
  );
}

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

async function expectRestorableArchive(worktreeId: string): Promise<void> {
  expect(await readDestructiveRecovery('a', worktreeId)).toMatchObject({
    state: 'completed',
  });
  const manifest = (await listArchivedContainerManifests('a')).find(
    (candidate: ArchivedContainerManifest) => candidate.id === worktreeId,
  );
  if (manifest?.version !== 2)
    throw new Error(`Expected a Git archive of ${worktreeId}`);
  await assertArchivedGitStateRestorable(manifest);
}

const deletionRequest = (
  key: string,
): Parameters<typeof deleteWorkspace>[0] => ({
  workspaceId: 'a',
  source: 'portal',
  idempotencyKey: key,
});

/** recs.test:3473 — the moved checkout changed during the quarantine move. */
async function strandChangedQuarantine(): Promise<void> {
  addSecondCheckout();
  mockArchiveIoFault = (request): void => {
    if (request.type === 'prepare-teardown' && request.containerId === 'two')
      writeFileSync(
        join(checkoutOf('two'), 'notes.txt'),
        'changed during the move',
      );
  };
  await expect(deleteWorkspace(deletionRequest('changed'))).rejects.toThrow(
    'Archive quarantine requires manual recovery; preserve both paths.',
  );
  mockArchiveIoFault = undefined;
}

/** A project deletion's child archive of two stops right after the move. */
async function strandMovedQuarantine(): Promise<void> {
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
  await expect(deleteWorkspace(deletionRequest('moved'))).rejects.toThrow(
    'Archive stopped after the move',
  );
  mockArchiveIoFault = undefined;
}

/**
 * A project deletion's child archive of two verified its quarantine, then
 * failed removing it. Returns its staged descriptor's path.
 */
async function strandFailedQuarantineRemoval(): Promise<string> {
  addSecondCheckout();
  let failed = false;
  mockArchiveIoFault = (request): void => {
    if (
      failed ||
      request.type !== 'remove-worktree' ||
      request.containerId !== 'two'
    )
      return;
    failed = true;
    throw new Error('git worktree remove failed');
  };
  await expect(deleteWorkspace(deletionRequest('legacy'))).rejects.toThrow(
    'git worktree remove failed',
  );
  mockArchiveIoFault = undefined;
  return join(getArchivedContainerDir('a', 'two'), 'git-state.staged.json');
}

/** The snapshot refs a staged descriptor records. */
function snapshotRefsOf(stagedPath: string): string[] {
  return z
    .object({ repositories: z.array(z.object({ snapshotRef: z.string() })) })
    .parse(JSON.parse(readFileSync(stagedPath, 'utf8')))
    .repositories.map((repository) => repository.snapshotRef);
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    execFileSync('git', ['-C', repoPath, 'show-ref', '--verify', ref], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

/** A standalone archive of one strands at its Git capture: source lost. */
async function strandSourceLoss(): Promise<void> {
  const admission = jest
    .spyOn(archivedContainerRecovery, 'isWorktreeArchiveSourceUnavailable')
    .mockResolvedValue(false);
  renameSync(repo, `${repo}-gone`);
  await expect(
    archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'one',
      source: 'single_repo',
    }),
  ).rejects.toThrow();
  admission.mockRestore();
  rmSync(`${repo}-gone`, { recursive: true, force: true });
}

const pre6710FixtureSchema = z.object({
  pathToken: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      encoding: z.enum(['utf8', 'base64']),
      content: z.string(),
    }),
  ),
  layout: z.array(z.object({ path: z.string(), kind: z.string() })),
});
const fixtureJournalSchema = z
  .object({
    directoryIdentity: z.string(),
    ownedPaths: z.array(
      z.object({ path: z.string(), identity: z.string() }).passthrough(),
    ),
  })
  .passthrough();

/**
 * Writes the dump of recs.test's stranded source-loss scenario on e353a287bd
 * (see the fixture's README) over this test's identical layout, and returns
 * the journal as written. Only the stat identities are rebound: inodes are
 * host-specific, so no dump can carry them.
 */
async function materializePre6710SourceLossFixture(): Promise<string> {
  const fixture = pre6710FixtureSchema.parse(
    JSON.parse(
      readFileSync(
        join(
          __dirname,
          '__fixtures__',
          'can-5334-pre-6710-stranded-source-loss',
          'fixture.json',
        ),
        'utf8',
      ),
    ),
  );
  rmSync(repo, { recursive: true, force: true });
  rmSync(checkoutOf('one'), { recursive: true, force: true });
  for (const entry of fixture.layout)
    if (
      entry.kind === 'directory' &&
      entry.path.startsWith('data/workspaces/a/')
    )
      mkdirSync(join(dir, entry.path), { recursive: true });
  let journalPath: string | undefined;
  for (const file of fixture.files) {
    const target = join(dir, file.path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(
      target,
      file.encoding === 'base64'
        ? Buffer.from(file.content, 'base64')
        : file.content.replaceAll(fixture.pathToken, dir),
    );
    if (file.path.startsWith('data/w5/destructive-lifecycles/'))
      journalPath = target;
  }
  if (journalPath !== journalFileOf('one'))
    throw new Error('The fixture journal is not at the slot of a/one');
  const journal = fixtureJournalSchema.parse(
    JSON.parse(readFileSync(journalPath, 'utf8')),
  );
  const statOf = async (path: string): Promise<string> => {
    const identity = await w5Destructive.readDirectoryStatIdentity(path);
    if (!identity) throw new Error(`Expected a directory at ${path}`);
    return identity;
  };
  // Keeps the CAN-5024 incarnation token the dump recorded.
  const token = journal.directoryIdentity.split(':').slice(3).join(':');
  journal.directoryIdentity = `${await statOf(join(root, 'a'))}:${token}`;
  for (const owned of journal.ownedPaths)
    owned.identity = await statOf(owned.path);
  const text = JSON.stringify(journal);
  writeFileSync(journalPath, text);
  __resetSidebarItemsStateForTests();
  return text;
}

describe('CAN-5334 worktree discard', () => {
  describe('a checkout changed during its quarantine move (recs.test:3473)', () => {
    it('describes the quarantine, discards it after verifying, keeps the branch, and the project deletion then succeeds', async () => {
      await strandChangedQuarantine();
      const description = await describeWorktreeDiscard('a', 'two');
      expect(description).toMatchObject({
        status: 'discardable',
        createdAt: rowOf('two').createdAt,
        causes: expect.arrayContaining([
          'stranded-removal-journal',
          'pending-checkout-quarantine',
        ]) as unknown,
        verifyAtDiscard: 'quarantine-against-snapshots',
        preserved: ['source-working-files', 'branches'],
        alsoDeleted: expect.arrayContaining(['chats', 'plans']) as unknown,
      });
      expect(description.targets.map((target) => target.kind)).toEqual(
        expect.arrayContaining(['git-quarantine']),
      );
      expect(
        description.targets.find((target) => target.kind === 'git-quarantine'),
      ).toMatchObject({
        path: quarantineOf('two'),
        identityVerified: false,
        reason: 'pending-checkout-quarantine',
      });

      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'discarded' });

      expect(existsSync(quarantineOf('two'))).toBe(false);
      expect(existsSync(getArchivedContainerDir('a', 'two'))).toBe(false);
      expect(worktreeIds()).toEqual([]);
      expect(branchExists(repo, 'second')).toBe(true);
      expect(registrations(repo)).not.toContain('archive-quarantine');
      expectJournalsParseUnderFrozenSchema();
      expect(await readDestructiveRecovery('a', 'two')).toMatchObject({
        state: 'completed',
        operation: 'worktree-delete',
      });
      await expectRestorableArchive('one');
      await expect(
        deleteWorkspace(deletionRequest('changed')),
      ).resolves.toMatchObject({
        removed: 'code',
      });
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
    });

    it('refuses with the project deletion retry, removing nothing, when the quarantine still verifies', async () => {
      await strandMovedQuarantine();
      const description = await describeWorktreeDiscard('a', 'two');
      expect(description.verifyAtDiscard).toBe('quarantine-against-snapshots');
      const before = effectSnapshot([quarantineOf('two'), checkoutOf('two')]);

      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: 'retry-available',
        description: {
          refusal: { reason: 'retry-available', retry: 'delete-project' },
        },
      });
      expect(effectSnapshot([quarantineOf('two'), checkoutOf('two')])).toEqual(
        before,
      );
      await expect(
        deleteWorkspace(deletionRequest('moved')),
      ).resolves.toMatchObject({
        removed: 'code',
      });
    });

    it('refuses source-unverified when Git fails during the verification', async () => {
      await strandChangedQuarantine();
      const description = await describeWorktreeDiscard('a', 'two');
      jest
        .spyOn(archivedContainerGit, 'verifyArchivedGitQuarantineSnapshots')
        .mockResolvedValue('error');
      const before = effectSnapshot([quarantineOf('two')]);

      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: 'source-unverified',
      });
      expect(effectSnapshot([quarantineOf('two')])).toEqual(before);
    });
  });

  describe('a checkout path recreated after the move (recs.test:3509)', () => {
    async function strandRecreated(): Promise<void> {
      await strandMovedQuarantine();
      mkdirSync(checkoutOf('two'));
      writeFileSync(join(checkoutOf('two'), 'later.txt'), 'later');
    }

    it('lists the quarantine and the recreated path separately and removes both', async () => {
      await strandRecreated();
      const journal = await readDestructiveRecovery('a', 'two');
      const description = await describeWorktreeDiscard('a', 'two');
      const probe = await w5Destructive.probeProtectedPathIdentity(
        checkoutOf('two'),
        'a',
      );
      if (
        probe === null ||
        !w5Destructive.isVerifiedProtectedPathIdentity(probe)
      ) {
        // Filesystems without birth times cannot verify a new occupant (Q3 A);
        // APFS and NTFS keep them.
        expect(process.platform).toBe('linux');
        expect(description.refusal?.reason).toBe('unverifiable-target');
        return;
      }
      expect(description).toMatchObject({ status: 'discardable' });
      expect(description.targets.map((target) => target.kind)).toEqual([
        'recreated-checkout-path',
        'git-quarantine',
        'files-only-recovery',
      ]);
      const recreated = description.targets[0];
      expect(recreated).toMatchObject({
        path: checkoutOf('two'),
        identityVerified: true,
      });
      // The quarantine is bound by the identity the journal recorded.
      expect(description.targets[1]?.identity).toBe(
        w5Destructive.statIdentityOf(
          journal?.ownedPaths.find((owned) => owned.path === checkoutOf('two'))
            ?.identity ?? '',
        ),
      );

      await expect(discardAsDescribed('two')).resolves.toMatchObject({
        status: 'discarded',
      });
      expect(existsSync(checkoutOf('two'))).toBe(false);
      expect(existsSync(quarantineOf('two'))).toBe(false);
      expect(worktreeIds()).toEqual([]);
      expect(branchExists(repo, 'second')).toBe(true);
      expectJournalsParseUnderFrozenSchema();
    });

    it('refuses and preserves a recreated path that is a symlink', async () => {
      await strandMovedQuarantine();
      const elsewhere = join(dir, 'elsewhere');
      mkdirSync(elsewhere);
      writeFileSync(join(elsewhere, 'kept.txt'), 'kept');
      symlinkSync(elsewhere, checkoutOf('two'), 'dir');
      const before = effectSnapshot([quarantineOf('two'), checkoutOf('two')]);
      const description = await describeWorktreeDiscard('a', 'two');
      expect(description.refusal?.reason).toBe('unverifiable-target');
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'refused' });
      expect(effectSnapshot([quarantineOf('two'), checkoutOf('two')])).toEqual(
        before,
      );
      expect(readFileSync(join(elsewhere, 'kept.txt'), 'utf8')).toBe('kept');
    });

    it('refuses and preserves a recreated path whose identity is unverifiable', async () => {
      await strandRecreated();
      // The occupant's real stat identity, only without CAN-5024 verification
      // (as on a filesystem without birth times).
      const occupant = await w5Destructive.readDirectoryStatIdentity(
        checkoutOf('two'),
      );
      jest
        .spyOn(w5Destructive, 'probeProtectedPathIdentity')
        .mockResolvedValue(`unverifiable:${occupant ?? ''}`);
      const before = effectSnapshot([quarantineOf('two'), checkoutOf('two')]);
      expect((await describeWorktreeDiscard('a', 'two')).refusal?.reason).toBe(
        'unverifiable-target',
      );
      expect(effectSnapshot([quarantineOf('two'), checkoutOf('two')])).toEqual(
        before,
      );
    });

    it('refuses and preserves a quarantine that is not the recorded checkout', async () => {
      await strandMovedQuarantine();
      // Same contents, another directory: no journal or descriptor binds it.
      renameSync(quarantineOf('two'), `${quarantineOf('two')}-moved`);
      execFileSync('cp', [
        '-R',
        `${quarantineOf('two')}-moved`,
        quarantineOf('two'),
      ]);
      const before = effectSnapshot([quarantineOf('two'), checkoutOf('two')]);
      const description = await describeWorktreeDiscard('a', 'two');
      expect(description.refusal?.reason).toBe('unverifiable-target');
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'refused' });
      expect(effectSnapshot([quarantineOf('two'), checkoutOf('two')])).toEqual(
        before,
      );
    });

    it('refuses as changed, removing nothing, when the recreated path is replaced after describe', async () => {
      await strandRecreated();
      const description = await describeWorktreeDiscard('a', 'two');
      if (description.status !== 'discardable') {
        expect(process.platform).toBe('linux');
        return;
      }
      rmSync(checkoutOf('two'), { recursive: true });
      mkdirSync(checkoutOf('two'));
      writeFileSync(join(checkoutOf('two'), 'newer.txt'), 'newer');
      const before = effectSnapshot([quarantineOf('two'), checkoutOf('two')]);

      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'changed' });
      expect(effectSnapshot([quarantineOf('two'), checkoutOf('two')])).toEqual(
        before,
      );
      expect(readFileSync(join(checkoutOf('two'), 'newer.txt'), 'utf8')).toBe(
        'newer',
      );
    });
  });

  describe('a stranded source-loss journal from before #6710', () => {
    it('parses under the oldest schema, is discardable for its gone source, and the discard removes the checkout and staging and retires the copy', async () => {
      const journalText = await materializePre6710SourceLossFixture();
      const stranded = await readDestructiveRecovery('a', 'one');
      expect(stranded).toMatchObject({
        operation: 'worktree-archive',
        state: 'recovery-required',
        createdAt: rowOf('one').createdAt,
      });
      // The steps e353a287bd recorded, as dumped.
      expect(stranded?.steps).toEqual([
        { phase: 'live-state-teardown', state: 'done' },
        { phase: 'retained-payload-capture', state: 'done' },
        { phase: 'git-capture', state: 'pending' },
      ]);
      expect(frozenJournalSchema.parse(JSON.parse(journalText))).toMatchObject({
        operation: 'worktree-archive',
        state: 'recovery-required',
      });
      expect(existsSync(repo)).toBe(false);
      expect(existsSync(checkoutOf('one'))).toBe(true);
      expect(existsSync(getArchivedContainerDir('a', 'one'))).toBe(true);
      expectJournalsParseUnderFrozenSchema();

      const description = await describeWorktreeDiscard('a', 'one');
      expect(description).toMatchObject({
        status: 'discardable',
        causes: ['stranded-removal-journal', 'source-gone'],
        sources: [{ state: 'gone-absent' }],
        mayRemain: [{ kind: 'git-registration', repoId: '__single_repo__' }],
      });
      expect(
        description.targets.map((target) => [target.kind, target.reason]),
      ).toEqual([
        ['live-checkout', 'stranded-removal-journal'],
        ['files-only-recovery', 'stranded-removal-journal'],
      ]);
      expect(description.alsoDeleted).toContain('retained-payload-copy');

      await expect(discardAsDescribed('one')).resolves.toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
      });
      expect(existsSync(checkoutOf('one'))).toBe(false);
      expect(existsSync(getArchivedContainerDir('a', 'one'))).toBe(false);
      expect(worktreeIds()).toEqual(['two']);
      expect(
        existsSync(
          join(getW5DestructiveLifecycleDir(), `${stranded?.operationId}.json`),
        ),
      ).toBe(false);
      expectJournalsParseUnderFrozenSchema();
    });

    it('describes a legacy ready descriptor with a gone source without reading the source (§1.3)', async () => {
      const stagedPath = await strandFailedQuarantineRemoval();
      const staged = z
        .record(z.string(), z.unknown())
        .parse(JSON.parse(readFileSync(stagedPath, 'utf8')));
      delete staged.pullRequestMetadata;
      writeFileSync(stagedPath, JSON.stringify(staged));
      renameSync(repo, `${repo}-gone`);

      const description = await describeWorktreeDiscard('a', 'two');
      expect(description.refusal?.reason).not.toBe('evidence-unreadable');
      expect(description).toMatchObject({
        status: 'discardable',
        causes: expect.arrayContaining(['source-gone']) as unknown,
      });
      expect(readFileSync(stagedPath, 'utf8')).toBe(JSON.stringify(staged));
    });
  });

  describe('refuses before any effect', () => {
    it('a Git lookup failure is source-unverified', async () => {
      await strandSourceLoss();
      jest
        .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
        .mockRejectedValue(new Error('Git lookup temporarily unavailable'));
      const before = effectSnapshot([checkoutOf('one')]);
      const description = await describeWorktreeDiscard('a', 'one');
      expect(description).toMatchObject({
        status: 'refused',
        refusal: { reason: 'source-unverified' },
        sources: [{ state: 'unverified' }],
      });
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: 'source-unverified',
      });
      expect(effectSnapshot([checkoutOf('one')])).toEqual(before);
    });

    it.each([
      'live-checkout',
      'recreated-checkout-path',
      'git-quarantine',
      'files-only-recovery',
    ] as const)(
      'an occupied %s discard aside is unverifiable-target',
      async (kind) => {
        await strandSourceLoss();
        const aside = asideOf('one', kind);
        mkdirSync(aside, { recursive: true });
        writeFileSync(join(aside, 'foreign.txt'), 'foreign');
        const before = effectSnapshot([checkoutOf('one'), aside]);
        const description = await describeWorktreeDiscard('a', 'one');
        expect(description).toMatchObject({
          status: 'refused',
          refusal: { reason: 'unverifiable-target' },
        });
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            confirmation: description.confirmation,
            source: 'desktop-ui',
          }),
        ).resolves.toMatchObject({ status: 'refused' });
        expect(effectSnapshot([checkoutOf('one'), aside])).toEqual(before);
        expect(readFileSync(join(aside, 'foreign.txt'), 'utf8')).toBe(
          'foreign',
        );
      },
    );

    it('unreadable configuration is configuration-unreadable', async () => {
      renameSync(repo, `${repo}-gone`);
      writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');
      const before = effectSnapshot([checkoutOf('one')]);
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'refused',
        refusal: { reason: 'configuration-unreadable' },
      });
      expect(effectSnapshot([checkoutOf('one')])).toEqual(before);
    });

    it('a corrupt staged descriptor is evidence-unreadable', async () => {
      renameSync(repo, `${repo}-gone`);
      mkdirSync(getArchivedContainerDir('a', 'one'), { recursive: true });
      writeFileSync(
        join(getArchivedContainerDir('a', 'one'), 'git-state.staged.json'),
        '{truncated',
      );
      expect((await describeWorktreeDiscard('a', 'one')).refusal?.reason).toBe(
        'evidence-unreadable',
      );
    });

    it('an inaccessible source (EACCES) is source-unverified', async () => {
      const locked = join(dir, 'locked');
      mkdirSync(locked);
      renameSync(repo, join(locked, 'repo'));
      const config = JSON.parse(
        readFileSync(join(root, 'a', 'workspace.json'), 'utf8'),
      ) as Record<string, unknown>;
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({ ...config, repoPath: join(locked, 'repo') }),
      );
      __resetSidebarItemsStateForTests();
      chmodSync(locked, 0o000);
      try {
        expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
          refusal: { reason: 'source-unverified' },
          sources: [{ state: 'unverified' }],
        });
      } finally {
        chmodSync(locked, 0o755);
      }
    });

    it('a source inside another repository is source-unverified (recs.test:2714)', async () => {
      execFileSync('git', ['init', '-q', dir]);
      rmSync(join(repo, '.git'), { recursive: true, force: true });
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        refusal: { reason: 'source-unverified' },
        sources: [{ state: 'unverified' }],
      });
    });

    it('a source that is not a Git repository is gone', async () => {
      rmSync(join(repo, '.git'), { recursive: true, force: true });
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'discardable',
        causes: ['source-gone'],
        sources: [{ state: 'gone-not-a-repository' }],
      });
    });

    it('a source path replaced by a regular file is gone, and the discard keeps the file (review r3 finding 1)', async () => {
      rmSync(repo, { recursive: true, force: true });
      writeFileSync(repo, 'not a checkout');
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'discardable',
        causes: ['source-gone'],
        sources: [{ state: 'gone-not-a-repository' }],
      });
      await expect(discardAsDescribed('one')).resolves.toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
      });
      expect(existsSync(checkoutOf('one'))).toBe(false);
      expect(readFileSync(repo, 'utf8')).toBe('not a checkout');
    });

    it('a source repointed since its capture is evidence-mismatch', async () => {
      addSecondCheckout();
      let failed = false;
      mockArchiveIoFault = (request): void => {
        if (
          failed ||
          request.type !== 'remove-worktree' ||
          request.containerId !== 'two'
        )
          return;
        failed = true;
        throw new Error('git worktree remove failed');
      };
      await expect(
        deleteWorkspace(deletionRequest('repointed')),
      ).rejects.toThrow('git worktree remove failed');
      mockArchiveIoFault = undefined;
      const elsewhere = join(dir, 'elsewhere');
      execFileSync('git', ['init', '-q', elsewhere]);
      const config = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'workspace.json'), 'utf8')),
        );
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({ ...config, repoPath: elsewhere }),
      );
      __resetSidebarItemsStateForTests();
      const before = effectSnapshot([
        checkoutOf('two'),
        quarantineOf('two'),
        getArchivedContainerDir('a', 'two'),
      ]);
      expect(await describeWorktreeDiscard('a', 'two')).toMatchObject({
        status: 'refused',
        refusal: { reason: 'evidence-mismatch' },
        targets: [],
      });
      expect(
        effectSnapshot([
          checkoutOf('two'),
          quarantineOf('two'),
          getArchivedContainerDir('a', 'two'),
        ]),
      ).toEqual(before);
    });

    it('a Cowork project is unsupported', async () => {
      renameSync(repo, `${repo}-gone`);
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({
          version: 1,
          type: 'cowork',
          repos: [],
          cowork: { description: 'cowork', archiveRetentionDays: 7 },
        }),
      );
      const index = z
        .object({ workspaces: z.array(z.record(z.string(), z.unknown())) })
        .passthrough()
        .parse(JSON.parse(readFileSync(join(root, 'index.json'), 'utf8')));
      writeFileSync(
        join(root, 'index.json'),
        JSON.stringify({
          ...index,
          workspaces: index.workspaces.map((entry) =>
            entry.id === 'a' ? { ...entry, type: 'cowork' } : entry,
          ),
        }),
      );
      __resetSidebarItemsStateForTests();
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'refused',
        refusal: { reason: 'unsupported-workspace' },
      });
    });

    it('a read-only scope is refused', async () => {
      expect(
        await describeWorktreeDiscard(
          SHARED_CONTAINER_VIEWER_PROJECT_ID,
          'one',
        ),
      ).toMatchObject({ refusal: { reason: 'read-only-scope' } });
    });

    it('a healthy worktree has no broken removal', async () => {
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'refused',
        refusal: { reason: 'no-broken-removal' },
      });
      expect(await describeWorktreeDiscard('a', 'missing')).toMatchObject({
        refusal: { reason: 'not-found' },
      });
    });

    it('an unfinished project deletion is project-deletion-pending', async () => {
      renameSync(repo, `${repo}-gone`);
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      writeFileSync(
        journalFileOf(),
        JSON.stringify({
          version: 1,
          operationId: '00000000-0000-4000-8000-000000000001',
          operation: 'workspace-delete',
          workspaceId: 'a',
          directoryIdentity: null,
          state: 'recovery-required',
          steps: [{ phase: 'workspace-directory-removal', state: 'pending' }],
          ownedPaths: [],
        }),
      );
      expect((await describeWorktreeDiscard('a', 'one')).refusal?.reason).toBe(
        'project-deletion-pending',
      );
    });
  });

  /** A Git repository at `path` with one commit. */
  function initRepository(path: string): void {
    execFileSync('git', ['init', '-q', '-b', 'main', path]);
    execFileSync('git', [
      '-C',
      path,
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
  }

  /** Project a becomes multi-repo over `repos`. */
  function makeProjectMultiRepo(
    repos: readonly { id: string; repoPath: string }[],
  ): void {
    writeFileSync(
      join(root, 'index.json'),
      JSON.stringify({
        version: 1,
        workspaces: [
          {
            id: 'a',
            name: 'Original',
            type: 'multi-repo',
            color: '#7C3AED',
            collapsed: false,
            order: 0,
          },
          {
            id: 'b',
            name: 'b',
            type: 'single-repo',
            color: '#7C3AED',
            collapsed: false,
            order: 1,
          },
        ],
      }),
    );
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'multi-repo',
        repos: repos.map(({ id, repoPath }) => ({ id, name: id, repoPath })),
      }),
    );
  }

  /** Worktree one checks out `present` (available) and `gone` (moved away). */
  function setUpMultiRepoWithOneGoneSource(): { second: string } {
    const second = join(dir, 'second-repo');
    initRepository(second);
    makeProjectMultiRepo([
      { id: 'present', repoPath: repo },
      { id: 'gone', repoPath: second },
    ]);
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'remove',
      '--force',
      checkoutOf('one'),
    ]);
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'multi',
      join(checkoutOf('one'), 'repos', 'present'),
    ]);
    execFileSync('git', [
      '-C',
      second,
      'worktree',
      'add',
      '-q',
      '-b',
      'multi',
      join(checkoutOf('one'), 'repos', 'gone'),
    ]);
    renameSync(second, `${second}-moved`);
    __resetSidebarItemsStateForTests();
    return { second };
  }

  it('binds the confirmation to the sibling checkouts it showed: a sibling dirtied after describe refuses as changed', async () => {
    setUpMultiRepoWithOneGoneSource();
    const description = await describeWorktreeDiscard('a', 'one');
    expect(description.targets[0]?.repositories?.[0]).toMatchObject({
      repoId: 'present',
      uncommittedChanges: false,
    });
    writeFileSync(
      join(checkoutOf('one'), 'repos', 'present', 'dirty.txt'),
      'dirty',
    );
    const before = effectSnapshot([checkoutOf('one')]);
    await expect(
      discardWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        confirmation: description.confirmation,
        source: 'desktop-ui',
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'changed',
      description: {
        targets: [
          {
            repositories: expect.arrayContaining([
              expect.objectContaining({ uncommittedChanges: true }),
            ]) as unknown,
          },
        ],
      },
    });
    expect(effectSnapshot([checkoutOf('one')])).toEqual(before);
  });

  it('a multi-repo checkout with one gone source keeps both branches, removes the available sibling registration and skips the gone one', async () => {
    const { second } = setUpMultiRepoWithOneGoneSource();
    writeFileSync(
      join(checkoutOf('one'), 'repos', 'present', 'dirty.txt'),
      'dirty',
    );

    const description = await describeWorktreeDiscard('a', 'one');
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone'],
      sources: [
        { repoId: 'present', state: 'available' },
        { repoId: 'gone', state: 'gone-absent' },
      ],
    });
    expect(description.targets[0]).toMatchObject({
      kind: 'live-checkout',
      reason: 'source-gone',
      repositories: [
        {
          repoId: 'present',
          relativePath: 'repos/present',
          uncommittedChanges: true,
        },
        { repoId: 'gone', relativePath: 'repos/gone' },
      ],
    });
    // No descriptor: the registration observed in the source is the tie.
    expect(registrations(repo)).toContain(join('a', 'worktrees', 'one'));
    expect(description.mayRemain).toEqual([
      { kind: 'git-registration', repoId: 'gone' },
    ]);

    await expect(discardAsDescribed('one')).resolves.toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'cleaned' },
        { repoId: 'gone', status: 'skipped' },
      ],
    });
    expect(existsSync(checkoutOf('one'))).toBe(false);
    expect(registrations(repo)).not.toContain(join('a', 'worktrees', 'one'));
    expect(branchExists(repo, 'multi')).toBe(true);
    renameSync(`${second}-moved`, second);
    expect(branchExists(second, 'multi')).toBe(true);
  });

  /** Marks project a temporary, keeping only the rows `keep` names. */
  function makeProjectTemporary(keep: readonly string[]): void {
    const configFile = join(root, 'a', 'workspace.json');
    writeFileSync(
      configFile,
      JSON.stringify({
        ...z
          .record(z.string(), z.unknown())
          .parse(JSON.parse(readFileSync(configFile, 'utf8'))),
        temporary: true,
      }),
    );
    const rowsFile = join(root, 'a', 'worktrees.json');
    const rows = z
      .object({
        version: z.literal(1),
        worktrees: z.array(z.object({ id: z.string() }).passthrough()),
      })
      .parse(JSON.parse(readFileSync(rowsFile, 'utf8')));
    writeFileSync(
      rowsFile,
      JSON.stringify({
        ...rows,
        worktrees: rows.worktrees.filter((row) => keep.includes(row.id)),
      }),
    );
    __resetSidebarItemsStateForTests();
  }

  it('reports the temporary project its last worktree leaves empty, as an ordinary archive does (CAN-5336 review r2)', async () => {
    setUpMultiRepoWithOneGoneSource();
    makeProjectTemporary(['one']);

    await expect(discardAsDescribed('one')).resolves.toMatchObject({
      status: 'discarded',
      removedTemporaryWorkspaceId: 'a',
    });
    expect(worktreeIds()).toEqual([]);
  });

  it('reports no removed project while the temporary project keeps another worktree', async () => {
    setUpMultiRepoWithOneGoneSource();
    makeProjectTemporary(['one', 'two']);

    const result = await discardAsDescribed('one');
    expect(result).toMatchObject({ status: 'discarded' });
    expect(result).not.toHaveProperty('removedTemporaryWorkspaceId');
    expect(worktreeIds()).toEqual(['two']);
  });

  it('a registration Git re-creates under the same id during its removal is kept and never reported as cleaned (review r5 finding 3)', async () => {
    setUpMultiRepoWithOneGoneSource();
    const entry = join(repo, '.git', 'worktrees', 'present');
    const gitdir = readFileSync(join(entry, 'gitdir'), 'utf8');
    let raced = false;
    // Just before the removal's first effect on the entry, whichever it is.
    const recreate = (path: string): void => {
      if (raced || path !== entry) return;
      raced = true;
      rmSync(entry, { recursive: true });
      mkdirSync(entry);
      writeFileSync(join(entry, 'gitdir'), gitdir);
    };
    mockBeforeRename = recreate;
    mockBeforeRemoval = (path): Promise<void> => {
      recreate(path);
      return Promise.resolve();
    };

    const result = await discardAsDescribed('one');

    expect(raced).toBe(true);
    expect(result).toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'failed' },
        { repoId: 'gone', status: 'skipped' },
      ],
    });
    expect(readFileSync(join(entry, 'gitdir'), 'utf8')).toBe(gitdir);
    expect(registrations(repo)).toContain(join('a', 'worktrees', 'one'));
  });

  it('an empty registration Git re-creates under the same id after the removal moves the old one aside survives, and the source is never reported as cleaned (review r6 finding 1)', async () => {
    setUpMultiRepoWithOneGoneSource();
    const entry = join(repo, '.git', 'worktrees', 'present');
    let aside = '';
    mockAfterRename = (from, to): void => {
      if (aside || from !== entry) return;
      aside = to;
      // The user relocks the moved entry, so it is no longer the checked one,
      // and an `add` makes its entry under the freed id.
      writeFileSync(join(to, 'locked'), 'kept by the user\n');
      mkdirSync(entry);
    };

    const result = await discardAsDescribed('one');

    expect(basename(aside)).toMatch(/^\.canopy-removing-present-/);
    expect(result).toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'failed' },
        { repoId: 'gone', status: 'skipped' },
      ],
    });
    expect(readdirSync(entry)).toEqual([]);
    expect(existsSync(join(aside, 'gitdir'))).toBe(true);
  });

  describe.each([
    ['a subset of', 'its source set', ['present'], false],
    ['none of', 'its source set', [], false],
    ['a subset of', 'no source set (an earlier build)', ['present'], true],
    ['none of', 'no source set (an earlier build)', [], true],
  ] as const)(
    'a missing-row resume of a worktree scoped to %s its project repositories, whose journal records %s (review r5 finding 1)',
    (_scope, _journal, includedRepoIds, journalPredatesSourceSet) => {
      /**
       * Worktree one of a multi-repo project over `present` and `extra`,
       * scoped to `includedRepoIds`, under a stranded archive journal.
       */
      async function setUpScopedMultiRepo(): Promise<{ extra: string }> {
        const extra = join(dir, 'extra-repo');
        initRepository(extra);
        makeProjectMultiRepo([
          { id: 'present', repoPath: repo },
          { id: 'extra', repoPath: extra },
        ]);
        const { createdAt } = rowOf('one');
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          JSON.stringify({
            version: 1,
            worktrees: [
              {
                id: 'one',
                branchName: 'old',
                createdAt,
                includedRepoIds: [...includedRepoIds],
              },
              { id: 'two', branchName: 'second', createdAt },
            ],
          }),
        );
        execFileSync('git', [
          '-C',
          repo,
          'worktree',
          'remove',
          '--force',
          checkoutOf('one'),
        ]);
        if (includedRepoIds.length)
          execFileSync('git', [
            '-C',
            repo,
            'worktree',
            'add',
            '-q',
            '-b',
            'multi',
            join(checkoutOf('one'), 'repos', 'present'),
          ]);
        else mkdirSync(checkoutOf('one'));
        mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
        writeFileSync(
          journalFileOf('one'),
          JSON.stringify({
            version: 1,
            operationId: '00000000-0000-4000-8000-000000000003',
            operation: 'worktree-archive',
            workspaceId: 'a',
            worktreeId: 'one',
            createdAt,
            directoryIdentity: null,
            state: 'recovery-required',
            steps: [
              { phase: 'live-state-teardown', state: 'done' },
              { phase: 'git-capture', state: 'failed' },
            ],
            ownedPaths: [
              {
                path: checkoutOf('one'),
                identity: await w5Destructive.readDirectoryStatIdentity(
                  checkoutOf('one'),
                ),
              },
            ],
          }),
        );
        __resetSidebarItemsStateForTests();
        return { extra };
      }

      it('reports only the sources the discard used: no failure, warning, residue or turn diff cleanup outside its scope', async () => {
        const { extra } = await setUpScopedMultiRepo();
        const first = await describeWorktreeDiscard('a', 'one');
        expect(first).toMatchObject({
          status: 'discardable',
          causes: ['stranded-removal-journal'],
          sources: includedRepoIds.map((repoId) => ({
            repoId,
            state: 'available',
          })),
        });
        const watcher = getAppAdvisorWatcherService();
        jest
          .spyOn(watcher, 'commitLocalScopeCancellation')
          .mockRejectedValueOnce(new Error('Interrupted after the row'));
        jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            confirmation: first.confirmation,
            source: 'desktop-ui',
          }),
        ).rejects.toThrow('Interrupted after the row');
        expect(worktreeIds()).toEqual(['two']);
        const interrupted = await readDestructiveRecovery('a', 'one');
        if (!interrupted) throw new Error('Expected the discard journal');
        const gitResults = includedRepoIds.map(
          (repoId) => `discard:git-result:cleaned:${repoId}`,
        );
        expect(
          interrupted.steps
            .map((step) => step.phase)
            .filter((phase) => phase.startsWith('discard:git-result:')),
        ).toEqual(gitResults);
        expect(
          interrupted.steps.filter((step) =>
            step.phase.startsWith('discard:source-set:'),
          ),
        ).toEqual([
          {
            phase: `discard:source-set:${JSON.stringify(includedRepoIds)}`,
            state: 'done',
          },
        ]);
        if (journalPredatesSourceSet)
          writeFileSync(
            journalFileOf('one'),
            JSON.stringify({
              ...interrupted,
              steps: interrupted.steps.filter(
                (step) => !step.phase.startsWith('discard:source-set:'),
              ),
            }),
          );
        const turnDiffRepos: string[] = [];
        jest
          .spyOn(gitModule, 'cleanupPersistedTurnDiffTreeRefs')
          .mockImplementation((repoPath) => {
            turnDiffRepos.push(repoPath);
            return Promise.resolve();
          });

        const resumed = await describeWorktreeDiscard('a', 'one');
        expect(resumed).toMatchObject({
          status: 'discardable',
          causes: ['interrupted-discard'],
          sources: includedRepoIds.map((repoId) => ({ repoId })),
          mayRemain: [],
        });
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            confirmation: resumed.confirmation,
            source: 'desktop-ui',
          }),
        ).resolves.toEqual({
          status: 'discarded',
          removed: ['live-checkout'],
          gitCleanup: includedRepoIds.map((repoId) => ({
            repoId,
            status: 'cleaned',
          })),
          warnings: [],
        });
        expect(turnDiffRepos).toEqual(includedRepoIds.length ? [repo] : []);
        expect(turnDiffRepos).not.toContain(extra);
        expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
          state: 'completed',
        });
        expectJournalsParseUnderFrozenSchema();
      });
    },
  );

  it('with no descriptor, another repository at the source path lists the registration, is never cleaned, and the moved repository keeps it (round 7)', async () => {
    setUpMultiRepoWithOneGoneSource();
    const moved = `${repo}-moved`;
    renameSync(repo, moved);
    execFileSync('git', ['init', '-q', repo]);
    const registered = join('a', 'worktrees', 'one', 'repos', 'present');
    expect(registrations(moved)).toContain(registered);

    const description = await describeWorktreeDiscard('a', 'one');
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone'],
      sources: [
        { repoId: 'present', state: 'available' },
        { repoId: 'gone', state: 'gone-absent' },
      ],
    });
    expect(description.mayRemain).toEqual([
      { kind: 'git-registration', repoId: 'present' },
      { kind: 'git-registration', repoId: 'gone' },
    ]);
    const result = await discardAsDescribed('one');
    expect(result).toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'skipped' },
        { repoId: 'gone', status: 'skipped' },
      ],
    });
    expect(existsSync(checkoutOf('one'))).toBe(false);
    expect(registrations(moved)).toContain(registered);
    expect(branchExists(moved, 'multi')).toBe(true);
  });

  it('a registration still there after its removal is failed with a warning, not cleaned (round 7)', async () => {
    setUpMultiRepoWithOneGoneSource();
    jest
      .spyOn(registrationRemoval, 'removeAbsentWorktreeRegistrations')
      .mockResolvedValue(undefined);

    const result = await discardAsDescribed('one');
    expect(result).toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'failed' },
        { repoId: 'gone', status: 'skipped' },
      ],
    });
    expect(result.status === 'discarded' ? result.warnings : []).toEqual([
      'Git metadata cleanup for repository present did not finish; its registrations or refs may remain.',
    ]);
    expect(registrations(repo)).toContain(join('a', 'worktrees', 'one'));
  });

  it('a retry after the Git cleanup still reports its per-repository statuses and warning', async () => {
    setUpMultiRepoWithOneGoneSource();
    jest
      .spyOn(registrationRemoval, 'removeAbsentWorktreeRegistrations')
      .mockRejectedValueOnce(new Error('Registration cleanup failed'));
    const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
    let failed = false;
    jest
      .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
      .mockImplementation((...args) => {
        if (failed) return cleanup(...args);
        failed = true;
        return Promise.reject(new Error('Interrupted after the Git cleanup'));
      });
    await expect(discardAsDescribed('one')).rejects.toThrow(
      'Interrupted after the Git cleanup',
    );
    expect(existsSync(checkoutOf('one'))).toBe(false);
    expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
      status: 'discardable',
      causes: ['interrupted-discard'],
      targets: [],
      // The failed cleanup is not redone, so its registration may remain.
      mayRemain: [
        { kind: 'git-registration', repoId: 'present' },
        { kind: 'git-registration', repoId: 'gone' },
      ],
    });

    await expect(discardAsDescribed('one')).resolves.toEqual({
      status: 'discarded',
      removed: ['live-checkout'],
      gitCleanup: [
        { repoId: 'present', status: 'failed' },
        { repoId: 'gone', status: 'skipped' },
      ],
      warnings: [
        'Git metadata cleanup for repository present did not finish; its registrations or refs may remain.',
      ],
    });
    // The resumed discard did not redo the finished Git cleanup.
    expect(
      registrationRemoval.removeAbsentWorktreeRegistrations,
    ).toHaveBeenCalledTimes(1);
    expect(worktreeIds()).not.toContain('one');
    expectJournalsParseUnderFrozenSchema();
  });

  it('a retry after an interruption inside the Git cleanup redoes it and reports each repository once', async () => {
    setUpMultiRepoWithOneGoneSource();
    const step = w5Destructive.destructiveStep;
    let interrupted = false;
    jest
      .spyOn(w5Destructive, 'destructiveStep')
      .mockImplementation((phase, work, options) =>
        phase !== 'discard:git-cleanup' || interrupted
          ? step(phase, work, options)
          : step(phase, async () => {
              await work();
              interrupted = true;
              // Its per-repository results are journaled; the step is not done.
              throw new Error('Interrupted inside the Git cleanup');
            }),
      );
    await expect(discardAsDescribed('one')).rejects.toThrow(
      'Interrupted inside the Git cleanup',
    );
    const journal = await readDestructiveRecovery('a', 'one');
    expect(
      journal?.steps
        .filter((recorded) => recorded.phase.startsWith('discard:git'))
        .map((recorded) => [recorded.phase, recorded.state]),
    ).toEqual([
      ['discard:git-cleanup', 'pending'],
      ['discard:git-result:cleaned:present', 'done'],
      ['discard:git-result:skipped:gone', 'done'],
    ]);
    // The second attempt redoes the cleanup, then stops after it.
    jest
      .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
      .mockRejectedValueOnce(new Error('Interrupted after the Git cleanup'));
    await expect(discardAsDescribed('one')).rejects.toThrow(
      'Interrupted after the Git cleanup',
    );
    expect(
      (await readDestructiveRecovery('a', 'one'))?.steps.filter((recorded) =>
        recorded.phase.startsWith('discard:git-result:'),
      ),
    ).toHaveLength(4);

    await expect(discardAsDescribed('one')).resolves.toEqual({
      status: 'discarded',
      removed: ['live-checkout'],
      gitCleanup: [
        { repoId: 'present', status: 'cleaned' },
        { repoId: 'gone', status: 'skipped' },
      ],
      warnings: [],
    });
    expect(registrations(repo)).not.toContain(join('a', 'worktrees', 'one'));
    expectJournalsParseUnderFrozenSchema();
  });

  it('a corrupt multi-repo staged descriptor is evidence-unreadable, removing nothing', async () => {
    setUpMultiRepoWithOneGoneSource();
    mkdirSync(getArchivedContainerDir('a', 'one'), { recursive: true });
    writeFileSync(
      join(getArchivedContainerDir('a', 'one'), 'git-state.staged.json'),
      '{"version":2,"repositories":[{"repoId":"present"',
    );
    const before = effectSnapshot([
      checkoutOf('one'),
      getArchivedContainerDir('a', 'one'),
    ]);
    const description = await describeWorktreeDiscard('a', 'one');
    expect(description).toMatchObject({
      status: 'refused',
      refusal: { reason: 'evidence-unreadable' },
      targets: [],
    });
    await expect(
      discardWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        confirmation: description.confirmation,
        source: 'desktop-ui',
      }),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'evidence-unreadable',
    });
    expect(
      effectSnapshot([checkoutOf('one'), getArchivedContainerDir('a', 'one')]),
    ).toEqual(before);
  });

  it('an interrupted multi-repo discard shows the sibling checkouts again and binds its retry to them', async () => {
    setUpMultiRepoWithOneGoneSource();
    jest
      .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
      .mockRejectedValueOnce(new Error('Interrupted'));
    await expect(discardAsDescribed('one')).rejects.toThrow('Interrupted');
    expect(existsSync(checkoutOf('one'))).toBe(true);

    const resumed = await describeWorktreeDiscard('a', 'one');
    expect(resumed).toMatchObject({
      status: 'discardable',
      causes: ['interrupted-discard'],
      targets: [
        {
          kind: 'live-checkout',
          repositories: [
            {
              repoId: 'present',
              relativePath: 'repos/present',
              uncommittedChanges: false,
            },
            { repoId: 'gone', relativePath: 'repos/gone' },
          ],
        },
      ],
    });
    writeFileSync(
      join(checkoutOf('one'), 'repos', 'present', 'dirty.txt'),
      'dirty',
    );
    const before = effectSnapshot([checkoutOf('one')]);
    await expect(
      discardWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        confirmation: resumed.confirmation,
        source: 'desktop-ui',
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'changed' });
    expect(effectSnapshot([checkoutOf('one')])).toEqual(before);

    await expect(discardAsDescribed('one')).resolves.toMatchObject({
      status: 'discarded',
    });
    expect(existsSync(checkoutOf('one'))).toBe(false);
  });

  describe('snapshot refs that may remain (review r3)', () => {
    it.each([
      [
        'before any target is removed',
        (): void => {
          jest
            .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
            .mockRejectedValueOnce(new Error('Interrupted'));
        },
        true,
      ],
      [
        'after its recovery data is removed',
        (): void => {
          jest
            .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
            .mockRejectedValueOnce(new Error('Interrupted'));
        },
        false,
      ],
    ] as const)(
      'an interrupted discard %s still lists the snapshot ref its skipped source may keep',
      async (_label, interrupt, recoveryDataRemains) => {
        await strandFailedQuarantineRemoval();
        renameSync(repo, `${repo}-gone`);
        const description = await describeWorktreeDiscard('a', 'two');
        expect(description).toMatchObject({
          status: 'discardable',
          sources: [{ repoId: '__single_repo__', state: 'gone-absent' }],
        });
        expect(description.mayRemain).toEqual([
          { kind: 'git-registration', repoId: '__single_repo__' },
          { kind: 'git-ref', repoId: '__single_repo__' },
        ]);
        interrupt();
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: 'two',
            confirmation: description.confirmation,
            source: 'desktop-ui',
          }),
        ).rejects.toThrow('Interrupted');
        expect(existsSync(getArchivedContainerDir('a', 'two'))).toBe(
          recoveryDataRemains,
        );

        const resumed = await describeWorktreeDiscard('a', 'two');
        expect(resumed).toMatchObject({
          status: 'discardable',
          causes: ['interrupted-discard'],
        });
        expect(resumed.mayRemain).toEqual(description.mayRemain);
        await expect(discardAsDescribed('two')).resolves.toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
        });
        expectJournalsParseUnderFrozenSchema();
      },
    );

    it('an interrupted discard whose recovery data holds an unreadable descriptor is still retried, listing the ref (§1.14)', async () => {
      const stagedPath = await strandFailedQuarantineRemoval();
      renameSync(repo, `${repo}-gone`);
      const description = await describeWorktreeDiscard('a', 'two');
      jest
        .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
        .mockRejectedValueOnce(new Error('Interrupted'));
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).rejects.toThrow('Interrupted');
      writeFileSync(stagedPath, '{"version":2,"repositories":[');

      const resumed = await describeWorktreeDiscard('a', 'two');
      expect(resumed).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
      });
      expect(resumed.mayRemain).toEqual([
        { kind: 'git-registration', repoId: '__single_repo__' },
        { kind: 'git-ref', repoId: '__single_repo__' },
      ]);
      await expect(discardAsDescribed('two')).resolves.toMatchObject({
        status: 'discarded',
      });
      expect(existsSync(getArchivedContainerDir('a', 'two'))).toBe(false);
    });

    it('an unreadable staged descriptor during the Git cleanup is reported as failed, not cleaned, and its refs are kept', async () => {
      await strandChangedQuarantine();
      const stagedPath = join(
        getArchivedContainerDir('a', 'two'),
        'git-state.staged.json',
      );
      const refs = snapshotRefsOf(stagedPath);
      expect(refs).not.toHaveLength(0);
      for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
      const description = await describeWorktreeDiscard('a', 'two');
      // Corrupted after the confirmation, before the Git cleanup reads it.
      mockArchiveIoFault = (request): void => {
        if (
          request.type === 'remove-directory' &&
          request.operationId.endsWith(':git-quarantine')
        )
          writeFileSync(stagedPath, '{"version":2,"repositories":[');
      };

      const result = await discardWorktree({
        workspaceId: 'a',
        worktreeId: 'two',
        confirmation: description.confirmation,
        source: 'desktop-ui',
      });
      expect(result).toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
      });
      expect(result.status === 'discarded' ? result.warnings : []).toContain(
        'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
      );
      // Registration cleanup is still attempted.
      expect(registrations(repo)).not.toContain('archive-quarantine');
      for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
      expect(existsSync(quarantineOf('two'))).toBe(false);
    });

    it('an interrupted discard whose descriptor became unreadable lists the ref an available source keeps, and its registration, as its retry reports (review r4 finding 1, round 6)', async () => {
      await strandChangedQuarantine();
      const stagedPath = join(
        getArchivedContainerDir('a', 'two'),
        'git-state.staged.json',
      );
      const refs = snapshotRefsOf(stagedPath);
      const description = await describeWorktreeDiscard('a', 'two');
      expect(description).toMatchObject({
        status: 'discardable',
        sources: [{ repoId: '__single_repo__', state: 'available' }],
        mayRemain: [],
      });
      jest
        .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
        .mockRejectedValueOnce(new Error('Interrupted'));
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).rejects.toThrow('Interrupted');
      writeFileSync(stagedPath, '{"version":2,"repositories":[');

      const resumed = await describeWorktreeDiscard('a', 'two');
      expect(resumed).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
      });
      // It cannot tell whether the descriptor recorded another repository.
      expect(resumed.mayRemain).toEqual([
        { kind: 'git-registration', repoId: '__single_repo__' },
        { kind: 'git-ref', repoId: '__single_repo__' },
      ]);
      await expect(discardAsDescribed('two')).resolves.toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
      });
      for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
    });

    it('an interrupted discard of a repointed source keeps and lists the Git metadata its descriptor records in the old repository', async () => {
      await strandChangedQuarantine();
      const refs = snapshotRefsOf(
        join(getArchivedContainerDir('a', 'two'), 'git-state.staged.json'),
      );
      jest
        .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
        .mockRejectedValueOnce(new Error('Interrupted'));
      await expect(discardAsDescribed('two')).rejects.toThrow('Interrupted');
      const elsewhere = join(dir, 'elsewhere');
      execFileSync('git', ['init', '-q', elsewhere]);
      const config = z
        .record(z.string(), z.unknown())
        .parse(
          JSON.parse(readFileSync(join(root, 'a', 'workspace.json'), 'utf8')),
        );
      writeFileSync(
        join(root, 'a', 'workspace.json'),
        JSON.stringify({ ...config, repoPath: elsewhere }),
      );
      __resetSidebarItemsStateForTests();

      const resumed = await describeWorktreeDiscard('a', 'two');
      expect(resumed).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
        sources: [{ repoId: '__single_repo__', state: 'available' }],
      });
      expect(resumed.mayRemain).toEqual([
        { kind: 'git-registration', repoId: '__single_repo__' },
        { kind: 'git-ref', repoId: '__single_repo__' },
      ]);
      await expect(discardAsDescribed('two')).resolves.toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
      });
      for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
    });

    describe('each early exit of the Git cleanup reports what its facts show (round 6)', () => {
      const stagedPathOf = (worktreeId: string): string =>
        join(getArchivedContainerDir('a', worktreeId), 'git-state.staged.json');

      async function interruptBeforeTheTargets(): Promise<void> {
        jest
          .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
          .mockRejectedValueOnce(new Error('Interrupted'));
        await expect(discardAsDescribed('two')).rejects.toThrow('Interrupted');
      }

      function repointTo(path: string): void {
        const config = z
          .record(z.string(), z.unknown())
          .parse(
            JSON.parse(readFileSync(join(root, 'a', 'workspace.json'), 'utf8')),
          );
        writeFileSync(
          join(root, 'a', 'workspace.json'),
          JSON.stringify({ ...config, repoPath: path }),
        );
        __resetSidebarItemsStateForTests();
      }

      it('a source replaced by another repository at the same path keeps and lists the metadata of the recorded repository, and is never cleaned', async () => {
        await strandChangedQuarantine();
        const refs = snapshotRefsOf(stagedPathOf('two'));
        await interruptBeforeTheTargets();
        const recorded = `${repo}-recorded`;
        renameSync(repo, recorded);
        execFileSync('git', ['init', '-q', repo]);

        const resumed = await describeWorktreeDiscard('a', 'two');
        expect(resumed).toMatchObject({
          status: 'discardable',
          causes: ['interrupted-discard'],
          sources: [{ repoId: '__single_repo__', state: 'available' }],
        });
        expect(resumed.mayRemain).toEqual([
          { kind: 'git-registration', repoId: '__single_repo__' },
          { kind: 'git-ref', repoId: '__single_repo__' },
        ]);
        await expect(discardAsDescribed('two')).resolves.toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
        });
        for (const ref of refs) expect(refExists(recorded, ref)).toBe(true);
        expect(registrations(recorded)).toContain('archive-quarantine');
      });

      it('a repointed source whose descriptor became unreadable lists its registration as well as its ref', async () => {
        await strandChangedQuarantine();
        const refs = snapshotRefsOf(stagedPathOf('two'));
        await interruptBeforeTheTargets();
        const elsewhere = join(dir, 'elsewhere');
        execFileSync('git', ['init', '-q', elsewhere]);
        repointTo(elsewhere);
        writeFileSync(stagedPathOf('two'), '{"version":2,"repositories":[');

        const resumed = await describeWorktreeDiscard('a', 'two');
        expect(resumed).toMatchObject({
          status: 'discardable',
          causes: ['interrupted-discard'],
          sources: [{ repoId: '__single_repo__', state: 'available' }],
        });
        expect(resumed.mayRemain).toEqual([
          { kind: 'git-registration', repoId: '__single_repo__' },
          { kind: 'git-ref', repoId: '__single_repo__' },
        ]);
        const result = await discardAsDescribed('two');
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
        });
        expect(result.status === 'discarded' ? result.warnings : []).toEqual([
          'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
        ]);
        for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
        expect(registrations(repo)).toContain('archive-quarantine');
      });

      it('a snapshot ref moved to another commit is listed, reported as failed, and kept', async () => {
        await strandChangedQuarantine();
        const [ref] = snapshotRefsOf(stagedPathOf('two'));
        if (!ref) throw new Error('Expected a snapshot ref');
        execFileSync('git', ['-C', repo, 'update-ref', ref, 'HEAD']);
        const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim();

        const description = await describeWorktreeDiscard('a', 'two');
        expect(description).toMatchObject({
          status: 'discardable',
          sources: [{ repoId: '__single_repo__', state: 'available' }],
        });
        expect(description.mayRemain).toEqual([
          { kind: 'git-registration', repoId: '__single_repo__' },
          { kind: 'git-ref', repoId: '__single_repo__' },
        ]);
        const result = await discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        });
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
        });
        expect(result.status === 'discarded' ? result.warnings : []).toEqual([
          'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
        ]);
        expect(
          execFileSync('git', ['-C', repo, 'rev-parse', ref], {
            encoding: 'utf8',
          }).trim(),
        ).toBe(head);
      });

      it.each([
        ['a source branch', (): string => 'refs/heads/main'],
        [
          "another worktree's snapshot ref",
          (): string =>
            archivedContainerGit.buildArchivedContainerSnapshotRef(
              'a',
              'one',
              '__single_repo__',
            ),
        ],
      ])(
        'review r8: an interrupted discard whose staged descriptor names %s keeps that ref, lists it and is failed, not cleaned',
        async (_label, foreignRefOf) => {
          await strandChangedQuarantine();
          await interruptBeforeTheTargets();
          const foreignRef = foreignRefOf();
          const tip = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], {
            encoding: 'utf8',
          }).trim();
          execFileSync('git', ['-C', repo, 'update-ref', foreignRef, tip]);
          // The descriptor names the foreign ref at the commit it points to,
          // which is all an unguarded deletion would check.
          const staged = z
            .object({
              repositories: z.array(z.record(z.string(), z.unknown())),
            })
            .passthrough()
            .parse(JSON.parse(readFileSync(stagedPathOf('two'), 'utf8')));
          writeFileSync(
            stagedPathOf('two'),
            JSON.stringify({
              ...staged,
              repositories: staged.repositories.map((repository) => ({
                ...repository,
                snapshotRef: foreignRef,
                worktreeSnapshotCommit: tip,
              })),
            }),
          );

          const resumed = await describeWorktreeDiscard('a', 'two');
          expect(resumed).toMatchObject({
            status: 'discardable',
            causes: ['interrupted-discard'],
            sources: [{ repoId: '__single_repo__', state: 'available' }],
          });
          expect(resumed.mayRemain).toContainEqual({
            kind: 'git-ref',
            repoId: '__single_repo__',
          });
          const result = await discardAsDescribed('two');
          expect(result).toMatchObject({
            status: 'discarded',
            gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
          });
          expect(result.status === 'discarded' ? result.warnings : []).toEqual([
            'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
          ]);
          expect(
            execFileSync('git', ['-C', repo, 'rev-parse', foreignRef], {
              encoding: 'utf8',
            }).trim(),
          ).toBe(tip);
          expect(existsSync(quarantineOf('two'))).toBe(false);
        },
      );

      it("review r8: a descriptor naming a source branch beside the worktree's own snapshot ref deletes only its own and is failed", async () => {
        await strandChangedQuarantine();
        const [ownRef] = snapshotRefsOf(stagedPathOf('two'));
        if (!ownRef) throw new Error('Expected a snapshot ref');
        await interruptBeforeTheTargets();
        const tip = execFileSync('git', ['-C', repo, 'rev-parse', 'main'], {
          encoding: 'utf8',
        }).trim();
        const staged = z
          .object({
            repositories: z.array(z.record(z.string(), z.unknown())).length(1),
            teardown: z.unknown().optional(),
          })
          .parse(JSON.parse(readFileSync(stagedPathOf('two'), 'utf8')));
        // Only a capturing descriptor may name one repository twice.
        writeFileSync(
          stagedPathOf('two'),
          JSON.stringify({
            version: 1,
            status: 'capturing',
            ...(staged.teardown ? { teardown: staged.teardown } : {}),
            repositories: staged.repositories.flatMap((repository) => [
              repository,
              {
                ...repository,
                snapshotRef: 'refs/heads/main',
                worktreeSnapshotCommit: tip,
              },
            ]),
          }),
        );

        const resumed = await describeWorktreeDiscard('a', 'two');
        expect(resumed.status).toBe('discardable');
        expect(resumed.mayRemain).toContainEqual({
          kind: 'git-ref',
          repoId: '__single_repo__',
        });
        const result = await discardAsDescribed('two');
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
        });
        expect(refExists(repo, ownRef)).toBe(false);
        expect(
          execFileSync('git', ['-C', repo, 'rev-parse', 'refs/heads/main'], {
            encoding: 'utf8',
          }).trim(),
        ).toBe(tip);
      });

      it('a source whose read-only Git look fails lists its registration and ref, is failed with a warning, and keeps both', async () => {
        await strandChangedQuarantine();
        const refs = snapshotRefsOf(stagedPathOf('two'));
        jest
          .spyOn(archivedContainerGit, 'inspectArchivedContainerSnapshotRef')
          .mockRejectedValue(new Error('Git failed'));

        const description = await describeWorktreeDiscard('a', 'two');
        expect(description).toMatchObject({
          status: 'discardable',
          sources: [{ repoId: '__single_repo__', state: 'available' }],
        });
        expect(description.mayRemain).toEqual([
          { kind: 'git-registration', repoId: '__single_repo__' },
          { kind: 'git-ref', repoId: '__single_repo__' },
        ]);
        const result = await discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        });
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
        });
        expect(result.status === 'discarded' ? result.warnings : []).toEqual([
          'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
        ]);
        for (const ref of refs) expect(refExists(repo, ref)).toBe(true);
        expect(registrations(repo)).toContain('archive-quarantine');
      });

      it('a source that vanishes during the discard is failed with a warning, and keeps its metadata', async () => {
        await strandChangedQuarantine();
        const refs = snapshotRefsOf(stagedPathOf('two'));
        const description = await describeWorktreeDiscard('a', 'two');
        expect(description.mayRemain).toEqual([]);
        const moved = `${repo}-moved`;
        mockArchiveIoFault = (request): void => {
          if (
            request.type === 'remove-directory' &&
            request.operationId.endsWith(':git-quarantine')
          )
            renameSync(repo, moved);
        };
        const result = await discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        });
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'failed' }],
        });
        expect(result.status === 'discarded' ? result.warnings : []).toContain(
          'Git metadata cleanup for repository __single_repo__ did not finish; its registrations or refs may remain.',
        );
        for (const ref of refs) expect(refExists(moved, ref)).toBe(true);
        expect(registrations(moved)).toContain('archive-quarantine');
      });

      it('a source whose path became a checkout of another repository during the discard is skipped, and the recorded repository keeps its metadata', async () => {
        await strandChangedQuarantine();
        const refs = snapshotRefsOf(stagedPathOf('two'));
        const description = await describeWorktreeDiscard('a', 'two');
        const recorded = `${repo}-recorded`;
        const other = join(dir, 'other');
        initRepository(other);
        mockArchiveIoFault = (request): void => {
          if (
            request.type !== 'remove-directory' ||
            !request.operationId.endsWith(':git-quarantine')
          )
            return;
          renameSync(repo, recorded);
          execFileSync('git', ['-C', other, 'worktree', 'add', '-q', repo]);
        };
        const result = await discardWorktree({
          workspaceId: 'a',
          worktreeId: 'two',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        });
        expect(result).toMatchObject({
          status: 'discarded',
          gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
        });
        for (const ref of refs) expect(refExists(recorded, ref)).toBe(true);
        expect(registrations(recorded)).toContain('archive-quarantine');
      });
    });

    it('an interrupted discard after its Git cleanup removed the refs lists none, though its descriptor is gone', async () => {
      await strandChangedQuarantine();
      const refs = snapshotRefsOf(
        join(getArchivedContainerDir('a', 'two'), 'git-state.staged.json'),
      );
      jest
        .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
        .mockRejectedValueOnce(new Error('Interrupted'));
      await expect(discardAsDescribed('two')).rejects.toThrow('Interrupted');
      expect(existsSync(getArchivedContainerDir('a', 'two'))).toBe(false);
      for (const ref of refs) expect(refExists(repo, ref)).toBe(false);

      const resumed = await describeWorktreeDiscard('a', 'two');
      expect(resumed).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
        mayRemain: [],
      });
      await expect(discardAsDescribed('two')).resolves.toMatchObject({
        status: 'discarded',
        gitCleanup: [{ repoId: '__single_repo__', status: 'cleaned' }],
      });
    });
  });

  describe('same-id recreation', () => {
    it('refuses a journal of another incarnation and never applies an earlier confirmation to a new one', async () => {
      await strandSourceLoss();
      const description = await describeWorktreeDiscard('a', 'one');
      expect(description.status).toBe('discardable');
      const list = JSON.parse(
        readFileSync(join(root, 'a', 'worktrees.json'), 'utf8'),
      ) as {
        worktrees: { id: string; createdAt: string }[];
      };
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({
          ...list,
          worktrees: list.worktrees.map((row) =>
            row.id === 'one'
              ? { ...row, createdAt: '2099-02-02T00:00:00.000Z' }
              : row,
          ),
        }),
      );
      __resetSidebarItemsStateForTests();
      const before = effectSnapshot([
        checkoutOf('one'),
        getArchivedContainerDir('a', 'one'),
      ]);

      expect((await describeWorktreeDiscard('a', 'one')).refusal?.reason).toBe(
        'other-incarnation',
      );
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: 'other-incarnation',
      });
      expect(
        effectSnapshot([
          checkoutOf('one'),
          getArchivedContainerDir('a', 'one'),
        ]),
      ).toEqual(before);
    });

    it('never removes a checkout that reappeared where the stranded journal recorded none', async () => {
      await strandSourceLoss();
      const stranded = await readDestructiveRecovery('a', 'one');
      if (!stranded) throw new Error('Expected a stranded journal');
      // The journal saw no checkout; the directory there now is a new occupant.
      writeFileSync(
        journalFileOf('one'),
        JSON.stringify({
          ...stranded,
          ownedPaths: [
            ...stranded.ownedPaths.filter(
              (owned) => owned.path !== checkoutOf('one'),
            ),
            { path: checkoutOf('one'), identity: null },
          ],
        }),
      );
      const before = effectSnapshot([checkoutOf('one')]);
      const description = await describeWorktreeDiscard('a', 'one');
      expect(description).toMatchObject({
        status: 'refused',
        refusal: { reason: 'unverifiable-target' },
      });
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'refused' });
      expect(effectSnapshot([checkoutOf('one')])).toEqual(before);
    });

    it('a new worktree never takes an id whose journal is unfinished or whose quarantine remains (Q7)', async () => {
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      writeFileSync(
        join(getW5DestructiveLifecycleDir(), `${'e'.repeat(64)}.json`),
        JSON.stringify({
          version: 1,
          operationId: '00000000-0000-4000-8000-000000000002',
          operation: 'worktree-delete',
          workspaceId: 'a',
          worktreeId: 'heron',
          createdAt: '2099-01-01T00:00:00.000Z',
          directoryIdentity: null,
          state: 'recovery-required',
          steps: [{ phase: 'discard:begin', state: 'done' }],
          ownedPaths: [],
        }),
      );
      mkdirSync(quarantineOf('ibis'), { recursive: true });
      mkdirSync(checkoutAsideOf('kite'), { recursive: true });
      const excluded: string[][] = [];
      const pick = jest
        .spyOn(animals, 'generateUniqueAnimalName')
        .mockImplementation((existing) => {
          excluded.push(Array.from(existing));
          return 'newt';
        });
      await createSingleRepoWorktree({ workspaceId: 'a' }).catch(
        () => undefined,
      );
      expect(pick).toHaveBeenCalled();
      expect(excluded[0]).toEqual(
        expect.arrayContaining(['heron', 'ibis', 'kite']),
      );
    });
  });

  describe('an interruption at each durable step finishes on an explicit retry', () => {
    /** The whole discard's result, as an uninterrupted one reports it. */
    const SOURCE_LOSS_RESULT = {
      status: 'discarded',
      removed: ['live-checkout', 'files-only-recovery'],
      gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
      warnings: [],
    };

    it('an uninterrupted discard reports the whole result', async () => {
      await strandSourceLoss();
      await expect(discardAsDescribed('one')).resolves.toEqual(
        SOURCE_LOSS_RESULT,
      );
    });

    async function expectFinishedDiscardOf(worktreeId: string): Promise<void> {
      expectJournalsParseUnderFrozenSchema();
      const retry = await describeWorktreeDiscard('a', worktreeId);
      expect(retry.status).toBe('discardable');
      // The retry reports the whole discard, including earlier attempts' effects.
      await expect(discardAsDescribed(worktreeId)).resolves.toEqual(
        SOURCE_LOSS_RESULT,
      );
      expect(existsSync(checkoutOf(worktreeId))).toBe(false);
      expect(existsSync(getArchivedContainerDir('a', worktreeId))).toBe(false);
      expect(worktreeIds()).not.toContain(worktreeId);
      expect(await readDestructiveRecovery('a', worktreeId)).toMatchObject({
        state: 'completed',
      });
      expect(
        Object.values(journalFiles()).filter((text) =>
          text.includes('"state":"recovery-required"'),
        ),
      ).toEqual([]);
      expectJournalsParseUnderFrozenSchema();
    }

    it('between the copy and the claim', async () => {
      await strandSourceLoss();
      const stranded = await readDestructiveRecovery('a', 'one');
      const write = atomicFile.writeFileAtomically;
      let calls = 0;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation((...args) => {
          calls += 1;
          if (
            calls >= 2 &&
            String(args[0]).startsWith(getW5DestructiveLifecycleDir())
          )
            return Promise.reject(new Error('Crashed before the claim'));
          return write(...args);
        });
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Crashed before the claim',
      );
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      // Both files hold the stranded record; the redo supersedes it again.
      expect(await readDestructiveRecovery('a', 'one')).toEqual(stranded);
      expect(
        existsSync(
          join(getW5DestructiveLifecycleDir(), `${stranded?.operationId}.json`),
        ),
      ).toBe(true);
      expect(existsSync(checkoutOf('one'))).toBe(true);
      await expectFinishedDiscardOf('one');
    });

    it('refused before the claim: the discard removes its own copy', async () => {
      await strandSourceLoss();
      const stranded = await readDestructiveRecovery('a', 'one');
      if (!stranded) throw new Error('Expected the stranded journal');
      const copy = join(
        getW5DestructiveLifecycleDir(),
        `${stranded.operationId}.json`,
      );
      const write = atomicFile.writeFileAtomically;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation(async (...args) => {
          await write(...args);
          if (String(args[0]) !== copy) return;
          // A new occupant takes the checkout path before the claim's check.
          rmSync(checkoutOf('one'), { recursive: true, force: true });
          writeFileSync(checkoutOf('one'), 'occupant');
        });
      await expect(discardAsDescribed('one')).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      expect(await readDestructiveRecovery('a', 'one')).toEqual(stranded);
      expect(existsSync(copy)).toBe(false);
      expect(readFileSync(checkoutOf('one'), 'utf8')).toBe('occupant');
      expectJournalsParseUnderFrozenSchema();
    });

    it.each([
      ['the live-state teardown', 'live-state'],
      ['the checkout removal', 'remove-checkout'],
      ['the staging removal', 'remove-staging'],
      ['the sidecar cleanup, after the copy is retired', 'sidecar'],
    ] as const)('in %s', async (_label, fault) => {
      await strandSourceLoss();
      const stranded = await readDestructiveRecovery('a', 'one');
      if (fault === 'live-state')
        jest
          .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
          .mockRejectedValueOnce(new Error('Interrupted'));
      if (fault === 'remove-checkout' || fault === 'remove-staging') {
        const path =
          fault === 'remove-checkout'
            ? checkoutOf('one')
            : getArchivedContainerDir('a', 'one');
        let failed = false;
        mockArchiveIoFault = (request): void => {
          if (
            failed ||
            request.type !== 'remove-directory' ||
            request.input.path !== path
          )
            return;
          failed = true;
          throw new Error('Interrupted');
        };
      }
      if (fault === 'sidecar') {
        const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
        let failed = false;
        jest
          .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
          .mockImplementation((...args) => {
            if (failed) return cleanup(...args);
            failed = true;
            return Promise.reject(new Error('Interrupted'));
          });
      }
      await expect(discardAsDescribed('one')).rejects.toThrow('Interrupted');
      mockArchiveIoFault = undefined;
      const interrupted = await readDestructiveRecovery('a', 'one');
      expect(interrupted).toMatchObject({
        operation: 'worktree-delete',
        state: 'recovery-required',
      });
      expect(interrupted?.steps[0]?.phase).toBe(
        `discard:supersede:${stranded?.operationId}`,
      );
      const resumed = await describeWorktreeDiscard('a', 'one');
      expect(resumed.causes).toEqual(['interrupted-discard']);
      for (const target of resumed.targets)
        expect(target.reason).toBe('interrupted-discard');
      if (fault === 'sidecar') {
        // Retired before the row's removal (§1.2).
        expect(worktreeIds()).toContain('one');
        expect(
          existsSync(
            join(
              getW5DestructiveLifecycleDir(),
              `${stranded?.operationId}.json`,
            ),
          ),
        ).toBe(false);
      }
      await expectFinishedDiscardOf('one');
    });

    it.each(['live-checkout', 'files-only-recovery'] as const)(
      'after the %s was moved aside for its removal: the retry finds it there and finishes it',
      async (kind) => {
        await strandSourceLoss();
        const path =
          kind === 'live-checkout'
            ? checkoutOf('one')
            : getArchivedContainerDir('a', 'one');
        const aside = asideOf('one', kind);
        const identity = await w5Destructive.readDirectoryStatIdentity(path);
        expect(identity).not.toBeNull();
        beforeFirstRemoval(
          (removed) => removed.endsWith(basename(aside)),
          () => Promise.reject(new Error('Interrupted after the move')),
        );
        await expect(discardAsDescribed('one')).rejects.toThrow(
          'Interrupted after the move',
        );
        mockBeforeRemoval = undefined;
        expect(existsSync(path)).toBe(false);
        expect(await w5Destructive.readDirectoryStatIdentity(aside)).toBe(
          identity,
        );
        const resumed = await describeWorktreeDiscard('a', 'one');
        expect(
          resumed.targets.find((target) => target.kind === kind),
        ).toMatchObject({ path: aside, reason: 'interrupted-discard' });
        await expectFinishedDiscardOf('one');
        expect(existsSync(aside)).toBe(false);
      },
    );

    it('after the move, an aside holding another directory refuses the retry and is kept', async () => {
      await strandSourceLoss();
      beforeFirstRemoval(
        (path) => path.endsWith('.one.discard-aside-live-checkout'),
        () => Promise.reject(new Error('Interrupted after the move')),
      );
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Interrupted after the move',
      );
      mockBeforeRemoval = undefined;
      renameSync(checkoutAsideOf('one'), join(dir, 'confirmed-elsewhere'));
      mkdirSync(checkoutAsideOf('one'));
      writeFileSync(join(checkoutAsideOf('one'), 'foreign.txt'), 'foreign');
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'refused',
        refusal: { reason: 'unverifiable-target' },
      });
      expect(
        readFileSync(join(checkoutAsideOf('one'), 'foreign.txt'), 'utf8'),
      ).toBe('foreign');
      expectJournalsParseUnderFrozenSchema();
    });

    it('after the row removal: the missing-row resume finishes it by id', async () => {
      await strandSourceLoss();
      const watcher = getAppAdvisorWatcherService();
      jest
        .spyOn(watcher, 'commitLocalScopeCancellation')
        .mockRejectedValueOnce(new Error('Interrupted after the row'));
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Interrupted after the row',
      );
      expect(worktreeIds()).toEqual(['two']);
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        state: 'recovery-required',
      });
      // Project deletion refuses until the discard finishes (E handles it).
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      const description = await describeWorktreeDiscard('a', 'one');
      expect(description).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
        targets: [],
      });
      await expect(discardAsDescribed('one')).resolves.toEqual(
        SOURCE_LOSS_RESULT,
      );
      expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
        state: 'completed',
      });
      expectJournalsParseUnderFrozenSchema();
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(false);
    });

    it('CAN-5337 after the row removal: the project deletion lists the interrupted discard, and the project deletes once it finishes', async () => {
      await strandSourceLoss();
      const watcher = getAppAdvisorWatcherService();
      jest
        .spyOn(watcher, 'commitLocalScopeCancellation')
        .mockRejectedValueOnce(new Error('Interrupted after the row'));
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Interrupted after the row',
      );
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      const { describeProjectDeletionDiscard } =
        await import('../project-deletion-discard');

      const description = await describeProjectDeletionDiscard('a');

      expect(description.status).toBe('discardable');
      expect(
        description.items.map((item) => [
          item.worktreeName,
          item.description.worktreeId,
          item.description.causes,
        ]),
      ).toEqual([
        ['second', 'two', ['source-gone']],
        [undefined, 'one', ['interrupted-discard']],
      ]);
      for (const item of description.items)
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: item.description.worktreeId,
            confirmation: item.description.confirmation,
            source: 'portal-ui',
          }),
        ).resolves.toMatchObject({ status: 'discarded' });
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
    });

    it('CAN-5337 after the recovery copy was moved aside: the project deletion lists that interrupted discard, and the project deletes once it finishes', async () => {
      await strandSourceLoss();
      const aside = asideOf('one', 'files-only-recovery');
      beforeFirstRemoval(
        (removed) => removed.endsWith(basename(aside)),
        () => Promise.reject(new Error('Interrupted after the move')),
      );
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Interrupted after the move',
      );
      mockBeforeRemoval = undefined;
      expect(existsSync(aside)).toBe(true);
      const { describeProjectDeletionDiscard } =
        await import('../project-deletion-discard');

      const description = await describeProjectDeletionDiscard('a');

      expect(description.status).toBe('discardable');
      expect(
        description.items.map((item) => [
          item.description.worktreeId,
          item.description.causes,
        ]),
      ).toEqual([
        ['one', ['interrupted-discard']],
        ['two', ['source-gone']],
      ]);
      for (const item of description.items)
        await expect(
          discardWorktree({
            workspaceId: 'a',
            worktreeId: item.description.worktreeId,
            confirmation: item.description.confirmation,
            source: 'portal-ui',
          }),
        ).resolves.toMatchObject({ status: 'discarded' });
      expect(existsSync(aside)).toBe(false);
      await expect(
        deleteWorkspace({ workspaceId: 'a', source: 'portal' }),
      ).resolves.toMatchObject({ removed: 'code' });
    });

    it('after the row removal of a retry that followed a failed step: the missing-row resume still finishes it', async () => {
      await strandSourceLoss();
      let failed = false;
      mockArchiveIoFault = (request): void => {
        if (
          failed ||
          request.type !== 'remove-directory' ||
          request.input.path !== checkoutOf('one')
        )
          return;
        failed = true;
        throw new Error('Interrupted');
      };
      await expect(discardAsDescribed('one')).rejects.toThrow('Interrupted');
      mockArchiveIoFault = undefined;
      const watcher = getAppAdvisorWatcherService();
      jest
        .spyOn(watcher, 'commitLocalScopeCancellation')
        .mockRejectedValueOnce(new Error('Interrupted after the row'));
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(watcher);
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Interrupted after the row',
      );
      expect(worktreeIds()).toEqual(['two']);

      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'discardable',
        causes: ['interrupted-discard'],
      });
      await expect(discardAsDescribed('one')).resolves.toEqual(
        SOURCE_LOSS_RESULT,
      );
      expect(await hasUnresolvedDestructiveRecovery('a', 'one')).toBe(false);
      expectJournalsParseUnderFrozenSchema();
    });

    it('a rejected watcher cancellation releases its fence and setup cancellation, and a same-id worktree then admits watchers (review r7 finding 1)', async () => {
      await strandSourceLoss();
      const { createdAt } = rowOf('one');
      const service = jest
        .requireActual<typeof Watchers>('../../app-advisor/watchers')
        .getAppAdvisorWatcherService();
      jest.mocked(getAppAdvisorWatcherService).mockReturnValue(service);
      const destination = { projectId: 'a', worktreeId: 'one', chatId: 'c' };
      const wakeup = {
        kind: 'scheduled_wakeup' as const,
        delaySeconds: 3600,
        scheduledFor: '',
      };
      try {
        await service.createLocalWatcher(wakeup, destination, 'tool-before');
        jest
          .spyOn(LocalWatcherScheduler.prototype, 'cancel')
          .mockRejectedValueOnce(new Error('termination failed'));
        const release = jest.spyOn(service, 'releaseLocalScopeFence');

        await expect(discardAsDescribed('one')).rejects.toThrow(
          'termination failed',
        );

        expect(release).toHaveBeenCalledWith('a', 'one');
        expect(
          isWorktreeSetupCancellationRequested({
            workspaceId: 'a',
            worktreeId: 'one',
            createdAt,
          }),
        ).toBe(false);
        await expect(discardAsDescribed('one')).resolves.toEqual(
          SOURCE_LOSS_RESULT,
        );
        const list = z
          .object({ worktrees: z.array(z.unknown()) })
          .passthrough()
          .parse(
            JSON.parse(readFileSync(join(root, 'a', 'worktrees.json'), 'utf8')),
          );
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          JSON.stringify({
            ...list,
            worktrees: [
              ...list.worktrees,
              {
                id: 'one',
                branchName: 'new',
                createdAt: '2099-03-03T00:00:00.000Z',
              },
            ],
          }),
        );
        __resetSidebarItemsStateForTests();
        await expect(
          service.createLocalWatcher(wakeup, destination, 'tool-after'),
        ).resolves.toMatchObject({ status: 'active' });
      } finally {
        service.shutdown();
      }
    });
  });

  describe('an ordinary archive retry after an interrupted discard (review r2 finding 1)', () => {
    /** One's archive crashed before its Git capture; its source is then gone. */
    async function strandCrashedArchiveWithGoneSource(): Promise<string> {
      let failed = false;
      mockArchiveIoFault = (request): void => {
        if (
          failed ||
          request.operationId !== 'archive:a:one:copy-managed-payload'
        )
          return;
        failed = true;
        throw new Error('Payload capture failed');
      };
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toThrow('Payload capture failed');
      mockArchiveIoFault = undefined;
      const failedJournal = await readDestructiveRecovery('a', 'one');
      if (!failedJournal) throw new Error('Expected the archive journal');
      writeFileSync(
        journalFileOf('one'),
        JSON.stringify({ ...failedJournal, state: 'active' }),
      );
      renameSync(repo, `${repo}-gone`);
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'discardable',
      });
      return join(
        getW5DestructiveLifecycleDir(),
        `${failedJournal.operationId}.json`,
      );
    }

    const archiveOne = (): ReturnType<typeof archiveWorktree> =>
      archiveWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        source: 'single_repo',
      });

    async function expectProjectDeletionUnblocked(): Promise<void> {
      await expect(
        w5Destructive.readInFlightWorktreeDestructiveOperations('a'),
      ).resolves.toEqual([]);
      expectJournalsParseUnderFrozenSchema();
      await expect(
        deleteWorkspace(deletionRequest('after-recovery')),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
    }

    it('crashed between the copy and the claim: the resumed archive retires the copy', async () => {
      const copy = await strandCrashedArchiveWithGoneSource();
      const stranded = await readDestructiveRecovery('a', 'one');
      const write = atomicFile.writeFileAtomically;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation((...args) =>
          String(args[0]) === journalFileOf('one')
            ? Promise.reject(new Error('Crashed before the claim'))
            : write(...args),
        );
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Crashed before the claim',
      );
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      expect(await readDestructiveRecovery('a', 'one')).toEqual(stranded);
      expect(readFileSync(copy, 'utf8')).toBe(JSON.stringify(stranded));

      renameSync(`${repo}-gone`, repo);
      await expect(archiveOne()).resolves.toMatchObject({ success: true });
      await expectRestorableArchive('one');
      await expectProjectDeletionUnblocked();
      expect(existsSync(copy)).toBe(false);
    });

    it('crashed between retiring the copy and the takeover claim: a later archive retry still resumes', async () => {
      const copy = await strandCrashedArchiveWithGoneSource();
      const stranded = await readDestructiveRecovery('a', 'one');
      const write = atomicFile.writeFileAtomically;
      const crashSlotWrites = (message: string): void => {
        jest
          .spyOn(atomicFile, 'writeFileAtomically')
          .mockImplementation((...args) =>
            String(args[0]) === journalFileOf('one')
              ? Promise.reject(new Error(message))
              : write(...args),
          );
      };
      crashSlotWrites('Crashed before the claim');
      await expect(discardAsDescribed('one')).rejects.toThrow(
        'Crashed before the claim',
      );
      renameSync(`${repo}-gone`, repo);
      crashSlotWrites('Crashed before the takeover claim');
      await expect(archiveOne()).rejects.toThrow(
        'Crashed before the takeover claim',
      );
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      expect(existsSync(copy)).toBe(false);
      expect(await readDestructiveRecovery('a', 'one')).toEqual(stranded);

      await expect(archiveOne()).resolves.toMatchObject({ success: true });
      await expectRestorableArchive('one');
      await expectProjectDeletionUnblocked();
    });

    it('crashed between the copy and the claim of a child archive: the project deletion resumes it and retires the copy', async () => {
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
      await expect(deleteWorkspace(deletionRequest('child'))).rejects.toThrow(
        'Git capture failed',
      );
      mockArchiveIoFault = undefined;
      const stranded = await readDestructiveRecovery('a', 'two');
      if (!stranded) throw new Error('Expected the child archive journal');
      const copy = join(
        getW5DestructiveLifecycleDir(),
        `${stranded.operationId}.json`,
      );
      renameSync(repo, `${repo}-gone`);
      expect(await describeWorktreeDiscard('a', 'two')).toMatchObject({
        status: 'discardable',
      });
      const write = atomicFile.writeFileAtomically;
      jest
        .spyOn(atomicFile, 'writeFileAtomically')
        .mockImplementation((...args) =>
          String(args[0]) === journalFileOf('two')
            ? Promise.reject(new Error('Crashed before the claim'))
            : write(...args),
        );
      await expect(discardAsDescribed('two')).rejects.toThrow(
        'Crashed before the claim',
      );
      jest.mocked(atomicFile.writeFileAtomically).mockRestore();
      expect(readFileSync(copy, 'utf8')).toBe(JSON.stringify(stranded));
      expectJournalsParseUnderFrozenSchema();

      renameSync(`${repo}-gone`, repo);
      await expect(
        deleteWorkspace(deletionRequest('child')),
      ).resolves.toMatchObject({ removed: 'code' });
      expect(existsSync(copy)).toBe(false);
      expect(await hasUnresolvedDestructiveRecovery('a')).toBe(false);
    });

    it('crashed after the claim: the archive retry refuses, and the discard retry finishes and retires the copy', async () => {
      const copy = await strandCrashedArchiveWithGoneSource();
      jest
        .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
        .mockRejectedValueOnce(new Error('Interrupted'));
      await expect(discardAsDescribed('one')).rejects.toThrow('Interrupted');
      expect(existsSync(copy)).toBe(true);

      renameSync(`${repo}-gone`, repo);
      // The slot holds the discard's journal, which only a discard resumes.
      await expect(archiveOne()).rejects.toMatchObject({
        reason: 'recovery-required',
      });
      await expect(
        w5Destructive.readInFlightWorktreeDestructiveOperations('a'),
      ).rejects.toMatchObject({ reason: 'recovery-required' });
      expect(existsSync(checkoutOf('one'))).toBe(true);

      await expect(discardAsDescribed('one')).resolves.toMatchObject({
        status: 'discarded',
      });
      expect(existsSync(copy)).toBe(false);
      expect(existsSync(checkoutOf('one'))).toBe(false);
      expect(branchExists(repo, 'old')).toBe(true);
      await expectProjectDeletionUnblocked();
    });
  });

  it('never removes a directory that takes the checkout path while the removal walks the confirmed one (review r1 finding 1)', async () => {
    await strandSourceLoss();
    const movedAway = join(dir, 'confirmed-moved-away');
    beforeFirstRemoval(
      (path) =>
        path.endsWith(join('worktrees', 'one')) ||
        path.endsWith('.one.discard-aside-live-checkout'),
      () => {
        // Another actor moves the confirmed checkout away, if it still can,
        // and recreates the path.
        if (existsSync(checkoutOf('one')))
          renameSync(checkoutOf('one'), movedAway);
        mkdirSync(checkoutOf('one'));
        writeFileSync(join(checkoutOf('one'), 'replacement.txt'), 'new');
        return Promise.resolve();
      },
    );
    // The next step sees a new occupant of a confirmed path and stops.
    await expect(discardAsDescribed('one')).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    mockBeforeRemoval = undefined;
    expect(
      readFileSync(join(checkoutOf('one'), 'replacement.txt'), 'utf8'),
    ).toBe('new');
    // The confirmed checkout was removed where it was moved aside.
    expect(existsSync(checkoutAsideOf('one'))).toBe(false);
    expect(existsSync(movedAway)).toBe(false);
    // No old journal or consent authorizes the new occupant.
    expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
      status: 'refused',
      refusal: { reason: 'unverifiable-target' },
    });
    expectJournalsParseUnderFrozenSchema();
  });

  it('treats described paths as display-only: a request carrying other paths removes only the host-derived targets', async () => {
    await strandSourceLoss();
    const decoy = join(dir, 'decoy');
    mkdirSync(decoy);
    writeFileSync(join(decoy, 'keep.txt'), 'keep');
    const description = await describeWorktreeDiscard('a', 'one');
    const removalPaths: string[] = [];
    mockArchiveIoFault = (request): void => {
      if (request.type === 'remove-directory')
        removalPaths.push(request.input.path);
    };
    // Extra fields a client might send back; the request type has no path.
    const tampered = {
      workspaceId: 'a',
      worktreeId: 'one',
      confirmation: description.confirmation,
      source: 'portal-ui' as const,
      path: decoy,
      targets: description.targets.map((target) => ({
        ...target,
        path: decoy,
      })),
      sources: description.sources.map((source) => ({
        ...source,
        path: decoy,
      })),
    };
    await expect(discardWorktree(tampered)).resolves.toMatchObject({
      status: 'discarded',
      removed: ['live-checkout', 'files-only-recovery'],
    });
    expect(removalPaths).toEqual([
      checkoutOf('one'),
      getArchivedContainerDir('a', 'one'),
    ]);
    expect(readFileSync(join(decoy, 'keep.txt'), 'utf8')).toBe('keep');
  });

  describe('retry pointers and the outcome', () => {
    it('points to removing the worktree again for an archive that crashed before its Git capture', async () => {
      let failed = false;
      mockArchiveIoFault = (request): void => {
        if (
          failed ||
          request.operationId !== 'archive:a:one:copy-managed-payload'
        )
          return;
        failed = true;
        throw new Error('Payload capture failed');
      };
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toThrow('Payload capture failed');
      mockArchiveIoFault = undefined;
      const failedJournal = await readDestructiveRecovery('a', 'one');
      writeFileSync(
        journalFileOf('one'),
        JSON.stringify({ ...failedJournal, state: 'active' }),
      );
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        refusal: { reason: 'retry-available', retry: 'remove-worktree' },
      });

      // With the source gone, source admission refuses that retry first.
      renameSync(repo, `${repo}-gone`);
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toMatchObject({ reason: 'source-unavailable' });
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        status: 'discardable',
        causes: ['stranded-removal-journal', 'source-gone'],
      });
      await expect(discardAsDescribed('one')).resolves.toMatchObject({
        status: 'discarded',
      });
      expect(existsSync(checkoutOf('one'))).toBe(false);
    });

    it('points to the project deletion for a resumable child archive', async () => {
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
      await expect(deleteWorkspace(deletionRequest('child'))).rejects.toThrow(
        'Git capture failed',
      );
      mockArchiveIoFault = undefined;
      expect(await describeWorktreeDiscard('a', 'two')).toMatchObject({
        refusal: { reason: 'retry-available', retry: 'delete-project' },
      });
    });

    it('points to the verified committed-archive cleanup', async () => {
      const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
      let failed = false;
      jest
        .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
        .mockImplementation((...args) => {
          if (failed) return cleanup(...args);
          failed = true;
          return Promise.reject(new Error('Sidecar cleanup failed'));
        });
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toThrow('Sidecar cleanup failed');
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        refusal: { reason: 'retry-available', retry: 'finish-archive-cleanup' },
      });

      // That cleanup needs no source, so a gone one keeps the pointer valid.
      renameSync(repo, `${repo}-gone`);
      expect(await describeWorktreeDiscard('a', 'one')).toMatchObject({
        refusal: { reason: 'retry-available', retry: 'finish-archive-cleanup' },
      });
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).resolves.toMatchObject({ success: true });
    });

    it('refuses a committed archive its cleanup cannot finish as retained-archive, removing nothing (Q4 A)', async () => {
      const cleanup = worktreeDataCleanup.cleanupPersistedWorktreeData;
      let failed = false;
      jest
        .spyOn(worktreeDataCleanup, 'cleanupPersistedWorktreeData')
        .mockImplementation((...args) => {
          if (failed) return cleanup(...args);
          failed = true;
          return Promise.reject(new Error('Sidecar cleanup failed'));
        });
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).rejects.toThrow('Sidecar cleanup failed');
      // #6578: a directory recreated at the checkout path stops that cleanup.
      mkdirSync(checkoutOf('one'));
      renameSync(repo, `${repo}-gone`);
      const before = effectSnapshot([
        checkoutOf('one'),
        getArchivedContainerDir('a', 'one'),
      ]);
      const description = await describeWorktreeDiscard('a', 'one');
      expect(description).toMatchObject({
        status: 'refused',
        refusal: { reason: 'retained-archive' },
        targets: [],
      });
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({
        status: 'refused',
        reason: 'retained-archive',
      });
      expect(
        effectSnapshot([
          checkoutOf('one'),
          getArchivedContainerDir('a', 'one'),
        ]),
      ).toEqual(before);
    });

    it('a later archive of a discarded id is already-archived, and the discard reserves no idempotency key', async () => {
      await strandSourceLoss();
      const keyed = jest.spyOn(keyedOperation, 'runKeyedW5Operation');
      await expect(discardAsDescribed('one')).resolves.toMatchObject({
        status: 'discarded',
      });
      expect(keyed).not.toHaveBeenCalled();
      await expect(
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        }),
      ).resolves.toMatchObject({ status: 'already-archived', success: true });
    });

    it('a typed archive refusal carries the discard description; without the flag it still throws', async () => {
      renameSync(repo, `${repo}-gone`);
      const run = (): Promise<unknown> =>
        archiveWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          source: 'single_repo',
        });
      await expect(
        withTypedArchiveRefusal({ workspaceId: 'a', worktreeId: 'one' }, () =>
          archiveWorktree({
            workspaceId: 'a',
            worktreeId: 'one',
            source: 'single_repo',
          }),
        ),
      ).rejects.toMatchObject({ reason: 'source-unavailable' });
      await expect(
        withTypedArchiveRefusal(
          { typedRefusal: true, workspaceId: 'a', worktreeId: 'one' },
          () =>
            archiveWorktree({
              workspaceId: 'a',
              worktreeId: 'one',
              source: 'single_repo',
            }),
        ),
      ).resolves.toMatchObject({
        success: false,
        warnings: [],
        refusal: {
          reason: 'source-unavailable',
          discard: { status: 'discardable', causes: ['source-gone'] },
        },
      });
      await expect(run()).rejects.toMatchObject({
        reason: 'source-unavailable',
      });
    });

    // CAN-5336 Q9 A: a typed opt-in changes only the discardable answer.
    it('a typed archive refusal that is not discardable keeps its original throw (G journal refusal)', async () => {
      mkdirSync(getW5DestructiveLifecycleDir(), { recursive: true });
      writeFileSync(
        join(getW5DestructiveLifecycleDir(), `${randomUUID()}.json`),
        'not json',
      );
      const thrown = await withTypedArchiveRefusal(
        { typedRefusal: true, workspaceId: 'a', worktreeId: 'two' },
        () =>
          archiveWorktree({
            workspaceId: 'a',
            worktreeId: 'two',
            source: 'single_repo',
          }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBeInstanceOf(W5CommitRefusedError);
      expect(thrown).toMatchObject({
        reason: 'recovery-required',
        message: LIFECYCLE_JOURNAL_UNREADABLE_REFUSAL,
      });
      expect(lifecycleJournalRefusalKind(thrown)).toBe('unreadable-entry');
    });

    it('a typed archive refusal whose description is refused keeps its original throw', async () => {
      // The source is present, so the description refuses: nothing is broken.
      await expect(describeWorktreeDiscard('a', 'one')).resolves.toMatchObject({
        status: 'refused',
      });
      const original = new WorktreeArchiveRefusedError(
        'source-unavailable',
        'original refusal',
      );
      await expect(
        withTypedArchiveRefusal(
          { typedRefusal: true, workspaceId: 'a', worktreeId: 'one' },
          () => Promise.reject(original),
        ),
      ).rejects.toBe(original);
    });

    it('a typed archive refusal whose description throws keeps the original refusal', async () => {
      const original = new WorktreeArchiveRefusedError(
        'source-unavailable',
        'original refusal',
      );
      await expect(
        withTypedArchiveRefusal(
          { typedRefusal: true, workspaceId: 'a', worktreeId: '../escape' },
          () => Promise.reject(original),
        ),
      ).rejects.toBe(original);
    });
  });

  describe('safeguards', () => {
    async function expectRefusedBusy(): Promise<void> {
      const description = await describeWorktreeDiscard('a', 'one');
      const before = effectSnapshot([checkoutOf('one')]);
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'refused', reason: 'busy' });
      expect(effectSnapshot([checkoutOf('one')])).toEqual(before);
    }

    beforeEach(() => {
      renameSync(repo, `${repo}-gone`);
    });

    it('a live delegate', async () => {
      setDelegationActivity('discard-owner', 'a/one/chat-a', 1);
      try {
        await expectRefusedBusy();
      } finally {
        setDelegationActivity('discard-owner', 'a/one/chat-a', 0);
      }
    });

    it('close-blocking background work', async () => {
      jest
        .spyOn(sessionManager, 'listLiveBackgroundTaskOwners')
        .mockReturnValue([
          createLiveBackgroundTaskOwner('a', 'one', 'chat-a', 'local_agent'),
        ]);
      await expectRefusedBusy();
    });

    it('a split lock or a split destination claim', async () => {
      acquireSplitLock('a', 'one');
      try {
        await expectRefusedBusy();
      } finally {
        releaseSplitLock('a', 'one');
      }
      acquireSplitDestinationWorktreeClaim('a', 'one');
      try {
        await expectRefusedBusy();
      } finally {
        releaseSplitDestinationWorktreeClaim('a', 'one');
      }
    });

    it('a discard already in flight', async () => {
      const description = await describeWorktreeDiscard('a', 'one');
      const actual = worktreeLiveCleanup.cleanupLiveWorktreeState;
      let concurrent: unknown;
      jest
        .spyOn(worktreeLiveCleanup, 'cleanupLiveWorktreeState')
        .mockImplementation(async (...args) => {
          concurrent = await describeWorktreeDiscard('a', 'one');
          return actual(...args);
        });
      await expect(
        discardWorktree({
          workspaceId: 'a',
          worktreeId: 'one',
          confirmation: description.confirmation,
          source: 'desktop-ui',
        }),
      ).resolves.toMatchObject({ status: 'discarded' });
      expect(concurrent).toMatchObject({ refusal: { reason: 'busy' } });
    });
  });

  it('only user interfaces import the executor (Auto Delete, automations and boot recovery cannot)', () => {
    const mainRoot = join(__dirname, '..', '..');
    const importersOf = (module: RegExp): string[] => {
      const importers: string[] = [];
      const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (entry.name !== '__tests__' && entry.name !== 'node_modules')
              walk(path);
          } else if (
            /\.tsx?$/.test(entry.name) &&
            module.test(readFileSync(path, 'utf8'))
          )
            importers.push(path.slice(mainRoot.length + 1));
        }
      };
      walk(mainRoot);
      return importers.sort();
    };
    expect(importersOf(/from '[^']*\/worktree-discard(-interface)?'/)).toEqual([
      'ipc/index.ts',
      'ipc/workspaces.ts',
      'ipc/worktree-discard.ts',
      'ipc/worktrees.ts',
      // CAN-5337: describes only; its own importers are user interfaces.
      'lib/project-deletion-discard.ts',
      'lib/worktree-discard-interface.ts',
      'portal/adapters/worktree-adapter.ts',
    ]);
    expect(
      readFileSync(
        join(mainRoot, 'lib', 'project-deletion-discard.ts'),
        'utf8',
      ),
    ).not.toMatch(/\bdiscardWorktree\b/);
    expect(importersOf(/from '\.[^']*\/project-deletion-discard'/)).toEqual([
      'ipc/worktree-discard.ts',
      'portal/adapters/workspace-adapter.ts',
    ]);
  });
});
