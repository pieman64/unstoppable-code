// CAN-5338: the retained (archived or deleted) worktree discard on the real
// commit-log worker, files and Git, with the W6c2 host-service substitutes.
// Record-seam evidence, not Electron or Portal transport evidence.
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as MainProcessLogging from '../main-process-logging';
import type * as PlanExploreRegistry from '../plan-explore-registry';
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
const mockSearch = {
  deleteWorkspaceDocs: jest.fn(() => Promise.resolve()),
  deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
  worktreeContainerArchived: jest.fn(() => Promise.resolve()),
  worktreeContainerPurged: jest.fn(() => Promise.resolve()),
  archivedContainerUpdated: jest.fn(),
};
jest.mock('../../chat-search/service', () => ({
  getChatSearchService: jest.fn(() => mockSearch),
}));
jest.mock('../../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5_000,
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
  notifyLedgerContainerArchived: jest.fn(),
  notifyLedgerContainerPurged: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(),
  recordLedgerRestoreIntent: jest.fn(() => Promise.resolve('recorded')),
  ledgerDatabaseMayExist: jest.fn(() => Promise.resolve(false)),
}));
jest.mock('../plan-explore-registry', () => ({
  ...jest.requireActual<typeof PlanExploreRegistry>('../plan-explore-registry'),
  transferPlanExploreTargets: jest.fn(() => Promise.resolve()),
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
jest.mock('../window-send', () => ({ sendToAllWindows: jest.fn() }));
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
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
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
import {
  notifyLedgerContainerRestored,
  recordLedgerRestoreIntent,
} from '../../ledger/lifecycle';
import { transferPlanExploreTargets } from '../plan-explore-registry';
import { readDestructiveRecovery } from '../w5-destructive-recovery';
import { archiveWorktree } from '../worktree-archive';
import {
  commitArchivedContainer,
  listArchivedContainerManifests,
  purgeArchivedContainer,
} from '../archived-containers';
import { workspaceRootPayloadDigest } from '../archived-container-git';
import * as gitExecutable from '../git-executable';
import {
  getArchivedContainerDir,
  getW5DestructiveLifecycleDir,
} from '../paths';
import { sendToAllWindows } from '../window-send';
import { describeWorktreeDiscard, discardWorktree } from '../worktree-discard';

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
  mockArchiveIoFault = undefined;
  resetChatStateServiceForTests();
  if (!originalWatcherFactory)
    throw new Error('Watcher fixture factory missing');
  jest
    .mocked(getAppAdvisorWatcherService)
    .mockImplementation(originalWatcherFactory);
  ({ dir, root, repo } = createW5BoundaryFixture(
    (createdAt) => [{ id: 'one', branchName: 'old', createdAt }],
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
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await shutdownW5BoundaryHost(host, join(dir, 'w5', 'commit-log.sqlite'));
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const RETAINED = { retainedArchives: true } as const;
const movedSource = (): string => `${repo}-unavailable`;
const hideSource = (): void => renameSync(repo, movedSource());
const container = (id = 'one'): string => getArchivedContainerDir('a', id);

async function discard(
  worktreeId: string,
  confirmation: string,
): ReturnType<typeof discardWorktree> {
  return discardWorktree({
    workspaceId: 'a',
    worktreeId,
    confirmation,
    source: 'desktop-ui',
    ...RETAINED,
  });
}

/** Archives `one` as a version-2 archive whose snapshot ref sits in `repo`. */
async function archiveOne(): Promise<
  Extract<ArchivedContainerManifest, { version: 2 }>
> {
  await archiveWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo',
  });
  const [manifest] = await listArchivedContainerManifests('a');
  if (manifest?.version !== 2) throw new Error('Expected a version-2 archive');
  return manifest;
}

function refsIn(path: string): string {
  return execFileSync(
    'git',
    ['-C', path, 'for-each-ref', '--format=%(refname) %(objectname)'],
    { encoding: 'utf8' },
  );
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

function lifecycleJournals(): string[] {
  return existsSync(getW5DestructiveLifecycleDir())
    ? readdirSync(getW5DestructiveLifecycleDir()).sort()
    : [];
}

interface Version3Options {
  readonly phase?: 'captured' | 'verified' | 'removed';
  /** A checkout at the canonical path, recorded by the journal unless foreign. */
  readonly checkout?: 'recorded' | 'foreign';
  readonly restoredTo?: boolean;
  readonly restoreStaging?: boolean;
  /** The checkout was already moved into the quarantine (a crash after the rename). */
  readonly quarantined?: boolean;
  /** Defaults to the single configured source, `repo`. */
  readonly repositories?: readonly {
    referenceRepoPath: string;
    relativePath: string;
    worktreePaths: readonly string[];
    /** A repository other than the one now at the path (a re-clone). */
    repositoryIdentity?: {
      path: string;
      dev: number;
      ino: number;
      birthtimeMs: number;
    };
  }[];
}

const pendingCheckout = (): string => join(root, 'a', 'worktrees', 'pending');
const pendingQuarantine = (): string =>
  join(root, 'a', 'worktrees', '.pending.archive-quarantine');

/**
 * A pending version-3 archive of `pending` whose recovery journal names the
 * project's configured source, `repo` (Q6 b).
 */
async function plantVersion3(options: Version3Options = {}): Promise<void> {
  const containerId = 'pending';
  const createdAt = '2099-01-01T00:00:00.000Z';
  const payloadId = '00000000-0000-4000-8000-000000000003';
  const payload = join(container(containerId), 'recovery-files', payloadId);
  mkdirSync(payload, { recursive: true });
  writeFileSync(join(payload, 'kept.txt'), 'retained');
  const digest = await workspaceRootPayloadDigest({ rootPath: payload });
  if (digest === null) throw new Error('Expected a payload digest');
  let identity: { dev: number; ino: number; birthtimeMs: number } | undefined;
  if (options.checkout) {
    const checkout = join(root, 'a', 'worktrees', containerId);
    mkdirSync(checkout, { recursive: true });
    // Edited after the capture: its digest no longer matches.
    writeFileSync(join(checkout, 'edited.txt'), 'only copy');
    const stats = lstatSync(checkout);
    identity =
      options.checkout === 'recorded'
        ? { dev: stats.dev, ino: stats.ino, birthtimeMs: stats.birthtimeMs }
        : { dev: 1, ino: 2, birthtimeMs: 3 };
    if (options.quarantined) renameSync(checkout, pendingQuarantine());
  }
  const recovery = {
    kind: 'files-only' as const,
    source: 'partial' as const,
    digest,
    payloadId,
    gitCleanupPending: true,
  };
  await commitArchivedContainer({
    id: containerId,
    projectId: 'a',
    kind: 'worktree',
    name: 'Pending archive',
    createdAt,
    archivedAt: '2099-01-02T00:00:00.000Z',
    retentionDays: 7,
    expiresAt: '2099-01-09T00:00:00.000Z',
    chatCount: 0,
    archivedChatCount: 0,
    executionCount: 0,
    workspaceType: options.repositories ? 'multi-repo' : 'single-repo',
    originalWorktree: {
      id: containerId,
      branchName: 'feature/archive',
      createdAt,
    },
    version: 3,
    recovery,
    ...(options.restoredTo
      ? {
          restoredTo: {
            kind: 'worktree' as const,
            id: 'restored',
            restoredAt: '2099-01-03T00:00:00.000Z',
            createdAt: '2099-01-03T00:00:00.000Z',
          },
        }
      : {}),
    ...(options.restoreStaging
      ? {
          restoreStaging: {
            kind: 'worktree' as const,
            id: 'restoring',
            createdAt: '2099-01-03T00:00:00.000Z',
          },
        }
      : {}),
  });
  writeFileSync(
    join(container(containerId), 'recovery.staged.json'),
    JSON.stringify({
      version: 1,
      createdAt,
      phase: options.phase ?? 'removed',
      recovery,
      ...(identity ? { identity, sourceDigest: 'f'.repeat(64) } : {}),
      repositories: (
        options.repositories ?? [
          { referenceRepoPath: repo, relativePath: '', worktreePaths: [] },
        ]
      ).map((repository) => ({
        ...repository,
        repositoryIdentity: repository.repositoryIdentity ?? null,
      })),
    }),
  );
}

function commitIn(path: string): void {
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

/** Project a becomes multi-repo over `present` (repo) and `gone` (moved away later). */
function makeProjectMultiRepo(second: string): void {
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: ['a', 'b'].map((id, order) => ({
        id,
        name: id,
        type: id === 'a' ? 'multi-repo' : 'single-repo',
        color: '#7C3AED',
        collapsed: false,
        order,
      })),
    }),
  );
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      repos: [
        { id: 'present', name: 'present', repoPath: repo },
        { id: 'gone', name: 'gone', repoPath: second },
      ],
    }),
  );
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: [] }),
  );
  __resetSidebarItemsStateForTests();
}

function registeredWorktrees(path: string): string {
  return execFileSync('git', ['-C', path, 'worktree', 'list', '--porcelain'], {
    encoding: 'utf8',
  });
}

describe('CAN-5338 a retained version-2 archive whose source is gone', () => {
  it('still refuses the ordinary purge, and the opted-in discard removes the archive, its search rows and its Ledger scope', async () => {
    const manifest = await archiveOne();
    const ref = manifest.gitState.repositories[0]?.snapshotRef;
    if (!ref) throw new Error('Expected a snapshot ref');
    hideSource();
    const sourceTree = treeImage(movedSource());
    const refs = refsIn(movedSource());
    expect(refs).toContain(ref);

    await expect(purgeArchivedContainer('a', 'one')).rejects.toThrow();
    expect(existsSync(container())).toBe(true);
    // Without the opt-in, nothing new is described (older clients).
    const ordinary = await describeWorktreeDiscard('a', 'one');
    expect(ordinary).toMatchObject({ refusal: { reason: 'not-found' } });

    const description = await describeWorktreeDiscard('a', 'one', RETAINED);
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone'],
      sources: [
        { repoId: '__single_repo__', path: repo, state: 'gone-absent' },
      ],
      targets: [
        {
          kind: 'retained-archive',
          path: container(),
          reason: 'source-gone',
        },
      ],
      mayRemain: [{ kind: 'git-ref', repoId: '__single_repo__' }],
    });
    // A discard without the opt-in finds nothing to bind to.
    await expect(
      discardWorktree({
        workspaceId: 'a',
        worktreeId: 'one',
        confirmation: description.confirmation,
        source: 'desktop-ui',
      }),
    ).resolves.toMatchObject({ status: 'refused', reason: 'not-found' });
    expect(existsSync(container())).toBe(true);

    const journals = lifecycleJournals();
    await expect(discard('one', description.confirmation)).resolves.toEqual({
      status: 'discarded',
      removed: ['retained-archive'],
      gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
      warnings: [],
    });

    expect(existsSync(container())).toBe(false);
    expect(mockSearch.worktreeContainerPurged).toHaveBeenCalledWith('a', 'one');
    expect(sendToAllWindows).toHaveBeenCalledWith(
      IPC_CHANNELS.archivedContainersChanged,
      { workspaceId: 'a' },
    );
    // No W5 journal, as for the ordinary purge.
    expect(lifecycleJournals()).toEqual(journals);
    expect(await readDestructiveRecovery('a', 'one')).toMatchObject({
      state: 'completed',
    });
    // The gone source's tree and refs are never written to.
    expect(treeImage(movedSource())).toEqual(sourceTree);
    expect(refsIn(movedSource())).toBe(refs);
  });

  it('refuses while the source is available but its snapshot ref moved, as the purge does', async () => {
    const manifest = await archiveOne();
    const ref = manifest.gitState.repositories[0]?.snapshotRef;
    if (!ref) throw new Error('Expected a snapshot ref');
    execFileSync('git', [
      '-C',
      repo,
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
      'moved',
    ]);
    execFileSync('git', ['-C', repo, 'update-ref', ref, 'HEAD']);

    await expect(purgeArchivedContainer('a', 'one')).rejects.toThrow(
      /unexpected object/,
    );
    expect(await describeWorktreeDiscard('a', 'one', RETAINED)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'evidence-mismatch' },
    });
    expect(existsSync(container())).toBe(true);
  });

  it('offers nothing for an archive the ordinary purge can delete', async () => {
    await archiveOne();
    expect(await describeWorktreeDiscard('a', 'one', RETAINED)).toMatchObject({
      status: 'refused',
      refusal: { reason: 'no-broken-removal' },
    });
  });

  it('refuses a Git lookup failure as unverified and an unreadable configuration as such', async () => {
    await archiveOne();
    hideSource();
    const lookup = jest
      .spyOn(gitExecutable, 'getResolvedGitExecutableForSpawn')
      .mockRejectedValue(new Error('Git executable lookup failed'));
    expect(await describeWorktreeDiscard('a', 'one', RETAINED)).toMatchObject({
      refusal: { reason: 'source-unverified' },
    });
    lookup.mockRestore();
    writeFileSync(join(root, 'a', 'workspace.json'), '{truncated');
    expect(await describeWorktreeDiscard('a', 'one', RETAINED)).toMatchObject({
      refusal: { reason: 'configuration-unreadable' },
    });
    expect(existsSync(container())).toBe(true);
  });

  it('refuses evidence-mismatch when the configured source is not the recorded one (Q6 b)', async () => {
    await archiveOne();
    hideSource();
    const other = join(dir, 'repointed');
    execFileSync('git', ['init', '-q', other]);
    writeFileSync(
      join(root, 'a', 'workspace.json'),
      JSON.stringify({
        version: 1,
        type: 'single-repo',
        repoPath: other,
        repos: [],
        itemSortMode: 'manual',
      }),
    );
    __resetSidebarItemsStateForTests();
    expect(await describeWorktreeDiscard('a', 'one', RETAINED)).toMatchObject({
      refusal: { reason: 'evidence-mismatch' },
    });
  });

  it('a replacement container between describe and discard is refused as changed and kept', async () => {
    await archiveOne();
    hideSource();
    const description = await describeWorktreeDiscard('a', 'one', RETAINED);
    expect(description.status).toBe('discardable');
    const copy = join(dir, 'replacement');
    cpSync(container(), copy, { recursive: true });
    rmSync(container(), { recursive: true });
    cpSync(copy, container(), { recursive: true });
    const replaced = treeImage(container());

    await expect(
      discard('one', description.confirmation),
    ).resolves.toMatchObject({ status: 'refused', reason: 'changed' });
    expect(treeImage(container())).toEqual(replaced);
  });

  it('after a crash between clearing the contents and removing the directory, a fresh description finishes it', async () => {
    await archiveOne();
    hideSource();
    const description = await describeWorktreeDiscard('a', 'one', RETAINED);
    mockArchiveIoFault = (request): void => {
      if (request.operationId === 'archive:a:one:purge-directory')
        throw new Error('Crashed before the removal');
    };
    await expect(discard('one', description.confirmation)).rejects.toThrow(
      'Crashed before the removal',
    );
    mockArchiveIoFault = undefined;
    // Only the manifest is left, and the archive still lists.
    expect(readdirSync(container())).toEqual(['container.json']);
    expect(
      (await listArchivedContainerManifests('a')).map((entry) => entry.id),
    ).toEqual(['one']);

    const again = await describeWorktreeDiscard('a', 'one', RETAINED);
    expect(again.status).toBe('discardable');
    await expect(discard('one', again.confirmation)).resolves.toMatchObject({
      status: 'discarded',
    });
    expect(existsSync(container())).toBe(false);
  });
});

describe('CAN-5338 a pending version-3 archive', () => {
  it('that was restored: records the Ledger mapping, finishes the plan transfer and removes the archive', async () => {
    await plantVersion3({ restoredTo: true });
    hideSource();
    // The ordinary deletion leaves its Git cleanup pending and keeps it.
    await expect(purgeArchivedContainer('a', 'pending')).rejects.toThrow(
      'Git registration cleanup is still pending',
    );
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone'],
      targets: [{ kind: 'retained-archive' }],
      alsoDeleted: expect.arrayContaining(['retained-payload-copy']) as unknown,
      mayRemain: [{ kind: 'git-registration', repoId: '__single_repo__' }],
    });

    await expect(
      discard('pending', description.confirmation),
    ).resolves.toMatchObject({
      status: 'discarded',
      removed: ['retained-archive'],
    });
    expect(recordLedgerRestoreIntent).toHaveBeenCalled();
    expect(notifyLedgerContainerRestored).toHaveBeenCalled();
    expect(transferPlanExploreTargets).toHaveBeenCalledWith(
      { projectId: 'a', worktreeId: 'pending' },
      { projectId: 'a', worktreeId: 'restored' },
    );
    expect(existsSync(container('pending'))).toBe(false);
  });

  it('keeps the archive when its Ledger mapping cannot be saved', async () => {
    await plantVersion3({ restoredTo: true });
    hideSource();
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    jest.mocked(recordLedgerRestoreIntent).mockResolvedValueOnce('not_durable');
    await expect(discard('pending', description.confirmation)).rejects.toThrow(
      "Couldn't delete this item. Try again.",
    );
    expect(existsSync(join(container('pending'), 'container.json'))).toBe(true);
  });

  it('refuses while a restore is still installing its destination', async () => {
    await plantVersion3({ restoreStaging: true });
    hideSource();
    expect(
      await describeWorktreeDiscard('a', 'pending', RETAINED),
    ).toMatchObject({ refusal: { reason: 'busy' } });
  });

  it('with an edited checkout and its source available: lists the checkout and the archive, then removes both through the finish step', async () => {
    await plantVersion3({ phase: 'captured', checkout: 'recorded' });
    const checkout = join(root, 'a', 'worktrees', 'pending');
    await expect(purgeArchivedContainer('a', 'pending')).rejects.toThrow(
      'changed after recovery capture',
    );
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['archive-recovery-unverified'],
      targets: [
        {
          kind: 'live-checkout',
          path: checkout,
          reason: 'archive-recovery-unverified',
        },
        { kind: 'retained-archive', path: container('pending') },
      ],
    });

    await expect(
      discard('pending', description.confirmation),
    ).resolves.toMatchObject({
      status: 'discarded',
      removed: ['live-checkout', 'retained-archive'],
    });
    expect(existsSync(checkout)).toBe(false);
    expect(
      existsSync(join(root, 'a', 'worktrees', '.pending.archive-quarantine')),
    ).toBe(false);
    expect(existsSync(container('pending'))).toBe(false);
  });

  it('after a crash between the finish step moving the checkout and its journal write: lists the quarantine and removes it', async () => {
    await plantVersion3({
      phase: 'captured',
      checkout: 'recorded',
      quarantined: true,
    });
    hideSource();
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone', 'archive-recovery-unverified'],
      targets: [
        {
          kind: 'git-quarantine',
          path: pendingQuarantine(),
          reason: 'archive-recovery-unverified',
        },
        { kind: 'retained-archive', path: container('pending') },
      ],
    });

    await expect(
      discard('pending', description.confirmation),
    ).resolves.toMatchObject({
      status: 'discarded',
      removed: ['git-quarantine', 'retained-archive'],
      gitCleanup: [{ repoId: '__single_repo__', status: 'skipped' }],
    });
    expect(existsSync(pendingQuarantine())).toBe(false);
    expect(existsSync(pendingCheckout())).toBe(false);
    expect(existsSync(container('pending'))).toBe(false);
  });

  it('a checkout replaced after the description is refused and kept', async () => {
    await plantVersion3({ phase: 'captured', checkout: 'recorded' });
    hideSource();
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    expect(description.status).toBe('discardable');
    rmSync(pendingCheckout(), { recursive: true });
    mkdirSync(pendingCheckout());
    writeFileSync(join(pendingCheckout(), 'new.txt'), 'someone else');

    await expect(
      discard('pending', description.confirmation),
    ).resolves.toMatchObject({
      status: 'refused',
      reason: 'unverifiable-target',
    });
    expect(existsSync(join(pendingCheckout(), 'new.txt'))).toBe(true);
    expect(existsSync(join(container('pending'), 'container.json'))).toBe(true);
  });

  it('across repositories with one gone: cleans the available one, keeps the gone one untouched and reports it may remain', async () => {
    const second = join(dir, 'second-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', second]);
    commitIn(second);
    makeProjectMultiRepo(second);
    const presentPath = join(pendingCheckout(), 'repos', 'present');
    const gonePath = join(pendingCheckout(), 'repos', 'gone');
    execFileSync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-q',
      '-b',
      'pending',
      presentPath,
    ]);
    execFileSync('git', [
      '-C',
      second,
      'worktree',
      'add',
      '-q',
      '-b',
      'pending',
      gonePath,
    ]);
    // The checkout itself is gone; Git still registers both repositories.
    rmSync(pendingCheckout(), { recursive: true });
    await plantVersion3({
      repositories: [
        {
          referenceRepoPath: repo,
          relativePath: 'repos/present',
          worktreePaths: [presentPath],
        },
        {
          referenceRepoPath: second,
          relativePath: 'repos/gone',
          worktreePaths: [gonePath],
        },
      ],
    });
    renameSync(second, `${second}-moved`);
    const goneRefs = refsIn(`${second}-moved`);
    const goneRegistrations = registeredWorktrees(`${second}-moved`);
    expect(goneRegistrations).toContain(gonePath);

    await expect(purgeArchivedContainer('a', 'pending')).rejects.toThrow(
      'Git registration cleanup is still pending',
    );
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    expect(description).toMatchObject({
      status: 'discardable',
      causes: ['source-gone'],
      sources: [
        { repoId: 'present', path: repo, state: 'available' },
        { repoId: 'gone', path: second, state: 'gone-absent' },
      ],
      targets: [{ kind: 'retained-archive' }],
      mayRemain: [{ kind: 'git-registration', repoId: 'gone' }],
    });

    await expect(
      discard('pending', description.confirmation),
    ).resolves.toMatchObject({
      status: 'discarded',
      gitCleanup: [
        { repoId: 'present', status: 'cleaned' },
        { repoId: 'gone', status: 'skipped' },
      ],
      warnings: [],
    });
    expect(registeredWorktrees(repo)).not.toContain(presentPath);
    expect(refsIn(`${second}-moved`)).toBe(goneRefs);
    expect(registeredWorktrees(`${second}-moved`)).toBe(goneRegistrations);
    expect(existsSync(container('pending'))).toBe(false);
  });

  it('across repositories with one gone and the other re-cloned: refuses, as that cleanup still cannot finish', async () => {
    const second = join(dir, 'second-repo');
    execFileSync('git', ['init', '-q', '-b', 'main', second]);
    commitIn(second);
    makeProjectMultiRepo(second);
    await plantVersion3({
      repositories: [
        {
          referenceRepoPath: repo,
          relativePath: 'repos/present',
          worktreePaths: [],
          // Recorded for another repository than the one now at `repo`.
          repositoryIdentity: {
            path: join(repo, '.git'),
            dev: 1,
            ino: 2,
            birthtimeMs: 3,
          },
        },
        {
          referenceRepoPath: second,
          relativePath: 'repos/gone',
          worktreePaths: [],
        },
      ],
    });
    renameSync(second, `${second}-moved`);

    expect(
      await describeWorktreeDiscard('a', 'pending', RETAINED),
    ).toMatchObject({
      status: 'refused',
      refusal: { reason: 'evidence-mismatch' },
    });
    expect(existsSync(join(container('pending'), 'container.json'))).toBe(true);
  });

  it('with a foreign occupant at the checkout path: refuses and removes nothing', async () => {
    await plantVersion3({ phase: 'captured', checkout: 'foreign' });
    const checkout = join(root, 'a', 'worktrees', 'pending');
    expect(
      await describeWorktreeDiscard('a', 'pending', RETAINED),
    ).toMatchObject({ refusal: { reason: 'unverifiable-target' } });
    expect(existsSync(join(checkout, 'edited.txt'))).toBe(true);
    expect(existsSync(container('pending'))).toBe(true);
  });

  it('after a crash between clearing the contents and removing the directory, the manifest no longer blocks', async () => {
    await plantVersion3();
    hideSource();
    const description = await describeWorktreeDiscard('a', 'pending', RETAINED);
    mockArchiveIoFault = (request): void => {
      if (request.operationId === 'archive:a:pending:purge-directory')
        throw new Error('Crashed before the removal');
    };
    await expect(discard('pending', description.confirmation)).rejects.toThrow(
      'Crashed before the removal',
    );
    mockArchiveIoFault = undefined;
    expect(readdirSync(container('pending'))).toEqual(['container.json']);

    expect(
      await describeWorktreeDiscard('a', 'pending', RETAINED),
    ).toMatchObject({ refusal: { reason: 'no-broken-removal' } });
    await expect(purgeArchivedContainer('a', 'pending')).resolves.toBe(true);
    expect(existsSync(container('pending'))).toBe(false);
  });
});

it('CAN-5338 only the retained discard reaches the purge and finish discard modes (the retention sweep, restore and Auto Delete cannot)', () => {
  const mainRoot = join(__dirname, '..', '..');
  const filesMatching = (pattern: RegExp): string[] => {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__' && entry.name !== 'node_modules')
            walk(path);
        } else if (
          /\.tsx?$/.test(entry.name) &&
          pattern.test(readFileSync(path, 'utf8'))
        )
          files.push(path.slice(mainRoot.length + 1));
      }
    };
    walk(mainRoot);
    return files.sort();
  };
  expect(filesMatching(/\bpurgeArchivedContainerForDiscard\b/)).toEqual([
    'lib/archived-containers.ts',
    'lib/retained-archive-discard.ts',
  ]);
  expect(
    filesMatching(/\babandonVerification\??:|options\??\.abandonVerification/),
  ).toEqual([
    'lib/archived-container-recovery.ts',
    'lib/archived-containers.ts',
    'lib/retained-archive-discard.ts',
  ]);
  expect(filesMatching(/from '\.[^']*\/retained-archive-discard'/)).toEqual([
    'lib/worktree-discard.ts',
  ]);
});
