// W6e1 (CAN-4917): the W5 commits of `core.archive.container.restore`'s
// destination records through the record decision port, on the real commit
// log worker and a real files-only (version-3) archive.
//
// One log interleaves the restore's file and archive effects, each port
// decision (as JSON, so it is plain data), each reservation, release, recovery
// mark and commit the worker receives, and the post-commit hooks. The archive
// is made by the real archive path with its Git capture refused, as for a
// checkout whose Git state cannot be captured. Without the decision entries,
// each expected log is the one the code before the port produced.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import type { ArchivedContainerManifest } from '@canopy/desktop-shared/types';
import type * as ArchiveEngine from '../../archive/archive-io-engine';
import type {
  ArchiveIoOperationRequest,
  ArchiveIoOperationType,
  ArchiveIoResultMap,
} from '../../archive/archive-io-protocol';
import type * as CostLifecycle from '../../cost-index/lifecycle';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as Archives from '../archived-containers';
import type * as Recovery from '../archived-container-recovery';
import type * as RestorePort from '../archived-container-restore-decision-port';
import type * as MainProcessLogging from '../main-process-logging';
import type * as SidebarItemGroups from '../sidebar-item-groups';
import type {
  ArchiveRestoreRecordDecision,
  ArchiveRestoreRemovalDecision,
} from '../worktree-record-decisions';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';

const mockEvents: unknown[] = [];
/** Runs, once, after the staged files are copied and before the record. */
let mockAfterFiles: (() => Promise<void>) | undefined;
/**
 * Fails, once, the install of the workspace-root files after the record,
 * after running this writer.
 */
let mockFailRootFiles: (() => Promise<unknown>) | undefined;
/** The staged destination id, read from the copy's destination. */
let mockStagedId: string | undefined;

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
  schedulePortalStructuralSync: jest.fn(() => mockEvents.push('sync')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockEvents.push('notify')),
}));
jest.mock('../sidebar-item-groups', () => {
  const actual = jest.requireActual<typeof SidebarItemGroups>(
    '../sidebar-item-groups',
  );
  return {
    ...actual,
    publishSidebarItemGroupsChanged: (workspaceId: string): void => {
      mockEvents.push('publish');
      actual.publishSidebarItemGroupsChanged(workspaceId);
    },
  };
});
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));
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
    deleteWorktreeDocs: jest.fn(() => Promise.resolve()),
    worktreeContainerArchived: jest.fn(() => Promise.resolve()),
    worktreeContainerPurged: jest.fn(() => Promise.resolve()),
    worktreeContainerRestored: jest.fn(() => {
      mockEvents.push('chat-search:restored');
      return Promise.resolve();
    }),
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  LEDGER_INTENT_REFUSING_WAIT_MS: 5000,
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerContainerArchived: jest.fn(),
  notifyLedgerContainerRestored: jest.fn(() =>
    mockEvents.push('ledger:restored'),
  ),
  recordLedgerRestoreIntent: jest.fn(() => {
    mockEvents.push('ledger:intent');
    return Promise.resolve('recorded');
  }),
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
jest.mock('../archived-container-restore-decision-port', () => {
  const actual = jest.requireActual<typeof RestorePort>(
    '../archived-container-restore-decision-port',
  );
  // Each is applied as its JSON copy, so the restore's decisions are plain data.
  return {
    ...actual,
    applyArchiveRestoreRecordDecision: (
      workspaceId: string,
      decision: ArchiveRestoreRecordDecision,
    ): ReturnType<typeof actual.applyArchiveRestoreRecordDecision> => {
      const copy = JSON.parse(
        JSON.stringify(decision),
      ) as ArchiveRestoreRecordDecision;
      mockEvents.push({ workspaceId, decision: copy });
      return actual.applyArchiveRestoreRecordDecision(workspaceId, copy);
    },
    applyArchiveRestoreRemovalDecision: (
      workspaceId: string,
      decision: ArchiveRestoreRemovalDecision,
    ): ReturnType<typeof actual.applyArchiveRestoreRemovalDecision> => {
      const copy = JSON.parse(
        JSON.stringify(decision),
      ) as ArchiveRestoreRemovalDecision;
      mockEvents.push({ workspaceId, decision: copy });
      return actual.applyArchiveRestoreRemovalDecision(workspaceId, copy);
    },
  };
});
jest.mock('../archived-container-recovery', () => {
  const actual = jest.requireActual<typeof Recovery>(
    '../archived-container-recovery',
  );
  return {
    ...actual,
    restoreArchivedRecoveryFiles: async (
      ...args: Parameters<typeof actual.restoreArchivedRecoveryFiles>
    ): Promise<void> => {
      mockStagedId = basename(args[1]);
      await actual.restoreArchivedRecoveryFiles(...args);
      mockEvents.push('files');
      const after = mockAfterFiles;
      mockAfterFiles = undefined;
      await after?.();
    },
    restoreArchivedRecoveryWorkspaceRootFiles: (
      ...args: Parameters<
        typeof actual.restoreArchivedRecoveryWorkspaceRootFiles
      >
    ): ReturnType<typeof actual.restoreArchivedRecoveryWorkspaceRootFiles> => {
      mockEvents.push('root-files');
      const fail = mockFailRootFiles;
      mockFailRootFiles = undefined;
      if (fail)
        return fail().then(() =>
          Promise.reject(new Error('root files failed')),
        );
      return actual.restoreArchivedRecoveryWorkspaceRootFiles(...args);
    },
  };
});
jest.mock('../archived-containers', () => {
  const actual = jest.requireActual<typeof Archives>('../archived-containers');
  return {
    ...actual,
    commitArchivedContainer: (
      manifest: ArchivedContainerManifest,
    ): Promise<void> => {
      mockEvents.push(
        manifest.restoredTo
          ? 'archive:restoredTo'
          : manifest.version === 3 && manifest.restoreStaging
            ? 'archive:restoreStaging'
            : 'archive:commit',
      );
      return actual.commitArchivedContainer(manifest);
    },
    purgeArchivedContainerAfterRestore: (
      ...args: Parameters<typeof actual.purgeArchivedContainerAfterRestore>
    ): ReturnType<typeof actual.purgeArchivedContainerAfterRestore> => {
      mockEvents.push('archive:purge');
      return actual.purgeArchivedContainerAfterRestore(...args);
    },
  };
});

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { resetChatStateServiceForTests } from '../../services/chat-state-service';
import * as archiveGit from '../archived-container-git';
import { waitForScheduledArchivedContainerDiskUsage } from '../archived-container-disk-usage';
import { restoreArchivedContainer } from '../archived-container-restore';
import { RestoredWorktreeRecordRefusedError } from '../archived-container-restore-records';
import { readArchivedContainerManifest } from '../archived-containers';
import { getArchivedContainerManifestPath } from '../paths';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  createW5CommitLogFileStore,
  w5ResourceKey,
  W5RevisionConflictError,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import {
  readWorkspaceWorktrees,
  removeWorkspaceWorktrees,
  setBeforeProjectPluginDefaultsChangeHandler,
  updateWorkspaceWorktrees,
} from '../workspace-persistence';
import { archiveWorktree } from '../worktree-archive';

jest.setTimeout(60_000);

const OPERATION = 'core.archive.container.restore';

let dir: string;
let root: string;
let repo: string;
let createdAt: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
/** Runs, once, before the worker receives a commit, as a writer outside the locks. */
let beforeWorkerCommit:
  | ((
      request: W5CommitRequest,
      commit: W5CommitLogHost['commit'],
    ) => Promise<void>)
  | undefined;

interface CommitEvent {
  commit: string;
  advance: string[];
  files: string[];
  expected?: string[];
  reservation?: true;
  receipt?: true;
}
/** Names the staged destination `staged`, whose id is minted per restore. */
function commitEvent(request: W5CommitRequest): CommitEvent {
  return {
    commit: request.operation,
    advance: request.advance.map(w5ResourceKey).map(stagedKey),
    files: request.files.map((file) => relative(root, file.path)),
    ...(request.expectedRevisions?.length
      ? {
          expected: request.expectedRevisions.map(
            ({ resource, revision }) =>
              `${stagedKey(w5ResourceKey(resource))}@${revision}`,
          ),
        }
      : {}),
    ...(request.reservationId ? { reservation: true } : {}),
    ...(request.receipt ? { receipt: true } : {}),
  };
}
function stagedKey(key: string): string {
  return key.replace(/recovery-[0-9a-f-]{36}/, 'staged');
}

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commit = host.commit.bind(host);
  jest
    .spyOn(host, 'commit')
    .mockImplementation(async (request: W5CommitRequest) => {
      mockEvents.push(commitEvent(request));
      const before = beforeWorkerCommit;
      beforeWorkerCommit = undefined;
      await before?.(request, commit);
      return commit(request);
    });
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation(async (input) => {
    mockEvents.push(`reserve:${input.operation}`);
    return reserve(input);
  });
  const release = host.releaseReservation.bind(host);
  jest
    .spyOn(host, 'releaseReservation')
    .mockImplementation(async (reservationId) => {
      mockEvents.push('release');
      return release(reservationId);
    });
  const markRecovery = host.markReservationRecoveryRequired.bind(host);
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockImplementation(async (reservationId, diagnostics) => {
      mockEvents.push('mark-recovery-required');
      return markRecovery(reservationId, diagnostics);
    });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
}

async function restartHost(): Promise<void> {
  await settleDetachedWork();
  await host.shutdown();
  __resetSidebarItemsStateForTests();
  resetChatStateServiceForTests();
  startHost();
}

const ONE = join('a', 'worktrees', 'one');

beforeEach(async () => {
  resetChatStateServiceForTests();
  ({ dir, root, repo } = createW5BoundaryFixture((at) => {
    createdAt = at;
    return [
      { id: 'one', branchName: 'old', createdAt: at },
      { id: 'two', branchName: 'second', createdAt: at },
    ];
  }));
  mockStagedId = undefined;
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  beforeWorkerCommit = undefined;
  mockAfterFiles = undefined;
  mockFailRootFiles = undefined;
  startHost();
  execFileSync('git', [
    '-C',
    repo,
    'worktree',
    'add',
    '-q',
    '-b',
    'old',
    join(root, ONE),
  ]);
  writeFileSync(join(root, ONE, 'work.txt'), 'retained contents');
  // A refused Git capture archives the checkout's files only (version 3).
  jest
    .spyOn(archiveGit, 'captureArchivedContainerGitState')
    .mockRejectedValueOnce(
      new archiveGit.MissingWorktreeIncompleteArchivedGitCaptureError(),
    );
  await archiveWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo',
    deleteWithoutRetentionIfMissing: true,
  });
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  mockEvents.length = 0;
});
afterEach(async () => {
  await waitForScheduledArchivedContainerDiskUsage();
  await settleDetachedWork();
  setBeforeProjectPluginDefaultsChangeHandler(undefined);
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
  jest.restoreAllMocks();
});

const CANONICAL_FILES = ['index.json', 'a/workspace.json', 'a/worktrees.json'];
function images(): Record<string, string> {
  return Object.fromEntries(
    CANONICAL_FILES.map((file) => [
      file,
      readFileSync(join(root, file), 'utf8'),
    ]),
  );
}
function resources(stagedId?: string): W5Resource[] {
  return [
    { kind: 'workspaces' },
    { kind: 'workspace', workspaceId: 'a' },
    { kind: 'worktrees', workspaceId: 'a' },
    ...['two', ...(stagedId ? [stagedId] : [])].map(
      (worktreeId): W5Resource => ({
        kind: 'worktree',
        workspaceId: 'a',
        worktreeId,
      }),
    ),
  ];
}
async function revisions(stagedId?: string): Promise<Record<string, number>> {
  const entries = await Promise.all(
    resources(stagedId).map(
      async (resource): Promise<[string, number]> => [
        stagedKey(w5ResourceKey(resource)),
        await host.revision(resource),
      ],
    ),
  );
  return Object.fromEntries(entries);
}

interface Observed<T> {
  result: T;
  events: unknown[];
  /** The resources whose revision moved, by how much. */
  advanced: Record<string, number>;
  /** The canonical files whose bytes changed. */
  changed: string[];
}
async function observe<T>(work: () => Promise<T>): Promise<Observed<T>> {
  const beforeRevisions = await revisions(mockStagedId);
  const beforeImages = images();
  mockEvents.length = 0;
  const result = await work();
  await settleDetachedWork();
  const events = [...mockEvents];
  const afterRevisions = await revisions(mockStagedId);
  const afterImages = images();
  const advanced: Record<string, number> = {};
  for (const [key, value] of Object.entries(afterRevisions))
    if (value !== (beforeRevisions[key] ?? 0))
      advanced[key] = value - (beforeRevisions[key] ?? 0);
  return {
    result,
    events: events.map(stagedEvent),
    advanced,
    changed: CANONICAL_FILES.filter(
      (file) => afterImages[file] !== beforeImages[file],
    ),
  };
}
function observeRefusal(
  work: () => Promise<unknown>,
): Promise<Observed<unknown>> {
  return observe(() =>
    work().then(
      () => {
        throw new Error('Expected a refusal');
      },
      (error: unknown) => error,
    ),
  );
}
function withoutResult<T>(observed: Observed<T>): Omit<Observed<T>, 'result'> {
  const { events, advanced, changed } = observed;
  return { events, advanced, changed };
}

/** The decision events with the minted staged id and time named. */
function stagedEvent(event: unknown): unknown {
  if (typeof event !== 'object' || event === null || !('decision' in event))
    return event;
  return JSON.parse(
    JSON.stringify(event)
      .replace(/recovery-[0-9a-f-]{36}/g, 'staged')
      .replace(/"createdAt":"[^"]+"/g, '"createdAt":"staged-at"'),
  );
}

function restore(
  fields: {
    containerId?: string;
    expectedRevision?: number;
    idempotencyKey?: string;
  } = {},
): Promise<unknown> {
  const { containerId = 'one', ...options } = fields;
  return restoreArchivedContainer('a', containerId, options);
}

const RECORD_DECISION = {
  workspaceId: 'a',
  decision: {
    kind: 'archive.container.restore.record',
    worktree: {
      id: 'staged',
      branchName: 'old',
      createdAt: 'staged-at',
      label: 'old',
      restoredFromFilesOnlyArchiveId: 'one',
    },
  },
};
const REMOVAL_DECISION = {
  workspaceId: 'a',
  decision: {
    kind: 'archive.container.restore.remove',
    worktree: { id: 'staged', createdAt: 'staged-at' },
  },
};
/** The record's one commit of the list, advancing the list and the new row. */
function record(expected?: number): CommitEvent {
  return {
    commit: OPERATION,
    advance: ['worktrees:a', 'worktree:a/staged'],
    files: ['a/worktrees.json'],
    ...(expected === undefined
      ? {}
      : { expected: [`worktrees:a@${expected}`] }),
  };
}
/** The rollback's removal, a list write outside the restore's boundary step. */
const ROLLBACK: CommitEvent = {
  commit: 'w5.worktree_list.write',
  advance: ['worktrees:a', 'worktree:a/staged'],
  files: ['a/worktrees.json'],
};
/** The list write's post-commit hooks. */
const HOOKS = ['publish', 'sync', 'notify'];
/** A list update that writes nothing still publishes the sidebar groups. */
const UNWRITTEN_HOOKS = ['publish'];
/** After the record: the archive's destination, the Ledger and the purge. */
const FINISH = [
  'root-files',
  'archive:restoredTo',
  'ledger:restored',
  'chat-search:restored',
  'ledger:intent',
  'ledger:restored',
  'archive:purge',
];
function receipt(expected: number): CommitEvent {
  return {
    commit: OPERATION,
    advance: [],
    files: [],
    expected: [`worktrees:a@${expected}`],
    reservation: true,
    receipt: true,
  };
}
const RECORDED_ADVANCE = { 'worktrees:a': 1, 'worktree:a/staged': 1 };
const STAGED_ID: unknown = expect.stringMatching(/^recovery-[0-9a-f-]{36}$/);
const ANY_STRING: unknown = expect.any(String);
const IDENTITY_CHANGED_MESSAGE: unknown = expect.stringMatching(
  /^Staged recovery worktree recovery-\S+ no longer matches its destination identity; the archived container was preserved\.$/,
);
const RESTORED_WARNING =
  'Restored the remaining files. Git history and staging are not restored automatically; saved Git metadata is kept separately.';

async function storedIds(): Promise<string[]> {
  return (await readWorkspaceWorktrees('a')).map((row) => stagedKey(row.id));
}
function archiveExists(): boolean {
  return existsSync(getArchivedContainerManifestPath('a', 'one'));
}
async function stagedOf(): Promise<{ id: string; createdAt: string }> {
  const manifest = await readArchivedContainerManifest('a', 'one');
  if (manifest.version !== 3 || !manifest.restoreStaging)
    throw new Error('Expected a staged files-only archive');
  return manifest.restoreStaging;
}
async function currentRevision(): Promise<number> {
  return host.revision({ kind: 'worktrees', workspaceId: 'a' });
}

describe('record after the files', () => {
  it('records the staged row in one list commit after copying the files', async () => {
    const restored = await observe(() => restore());
    expect(restored.result).toEqual({
      kind: 'worktree',
      restoredWorktreeId: STAGED_ID,
      branchName: 'old',
      warnings: [RESTORED_WARNING],
    });
    expect(withoutResult(restored)).toEqual({
      events: [
        'archive:restoreStaging',
        'files',
        RECORD_DECISION,
        record(),
        ...HOOKS,
        ...FINISH,
      ],
      advanced: RECORDED_ADVANCE,
      changed: ['a/worktrees.json'],
    });
    const rows = (await readWorkspaceWorktrees('a')).map((stored) => {
      const row = { ...stored };
      delete row.replica;
      return row;
    });
    expect(rows).toEqual([
      { id: 'two', branchName: 'second', createdAt },
      {
        id: mockStagedId,
        branchName: 'old',
        createdAt: ANY_STRING,
        label: 'old',
        restoredFromFilesOnlyArchiveId: 'one',
      },
    ]);
    expect(restored.result).toMatchObject({ restoredWorktreeId: mockStagedId });
    expect(
      readFileSync(
        join(root, 'a', 'worktrees', mockStagedId ?? '', 'work.txt'),
        'utf8',
      ),
    ).toBe('retained contents');
    expect(archiveExists()).toBe(false);
  });

  it('commits nothing for the row when its incarnation is recorded during the copy', async () => {
    mockAfterFiles = async (): Promise<void> => {
      const staged = await stagedOf();
      await updateWorkspaceWorktrees('a', (rows) => [
        ...rows,
        {
          id: staged.id,
          branchName: 'old',
          createdAt: staged.createdAt,
          label: 'concurrent',
        },
      ]);
      mockEvents.push('concurrent-record');
    };
    const restored = await observe(() => restore());
    expect(withoutResult(restored).events).toEqual([
      'archive:restoreStaging',
      'files',
      {
        commit: 'w5.worktree_list.write',
        advance: ['worktrees:a', 'worktree:a/staged'],
        files: ['a/worktrees.json'],
      },
      ...HOOKS,
      'concurrent-record',
      RECORD_DECISION,
      ...UNWRITTEN_HOOKS,
      ...FINISH,
    ]);
    // The concurrent row and its label are kept.
    expect(
      (await readWorkspaceWorktrees('a')).map(({ id, label }) => ({
        id: stagedKey(id),
        label,
      })),
    ).toEqual([
      { id: 'two', label: undefined },
      { id: 'staged', label: 'concurrent' },
    ]);
  });

  it('refuses another incarnation at the staged id without a record commit, keeping the archive', async () => {
    const other = '2026-01-01T00:00:00.000Z';
    mockAfterFiles = async (): Promise<void> => {
      const staged = await stagedOf();
      await updateWorkspaceWorktrees('a', (rows) => [
        ...rows,
        { id: staged.id, branchName: 'other', createdAt: other },
      ]);
      mockEvents.length = 0;
    };
    const refused = await observeRefusal(() => restore());
    expect(refused.result).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
    expect(refused.result).toMatchObject({
      reason: 'identity-changed',
      message: IDENTITY_CHANGED_MESSAGE,
    });
    // The record writes nothing and runs no hook.
    expect(refused.events).toEqual([RECORD_DECISION]);
    expect(archiveExists()).toBe(true);
    // The existing cleanup removes the copied files.
    expect(existsSync(join(root, 'a', 'worktrees', mockStagedId ?? ''))).toBe(
      false,
    );
    const staged = await stagedOf();
    expect(
      (await readWorkspaceWorktrees('a')).find((row) => row.id === staged.id),
    ).toMatchObject({ branchName: 'other', createdAt: other });
  });

  it('reports a staged row archived during the copy as removed, keeping the archive', async () => {
    mockAfterFiles = async (): Promise<void> => {
      const staged = await stagedOf();
      await updateWorkspaceWorktrees('a', (rows) => [
        ...rows,
        { id: staged.id, branchName: 'old', createdAt: staged.createdAt },
      ]);
      await removeWorkspaceWorktrees('a', (row) => row.id === staged.id);
      mockEvents.length = 0;
    };
    const refused = await observeRefusal(() => restore());
    expect(refused.result).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
    expect(refused.result).toMatchObject({ reason: 'destination-removed' });
    // The tombstone drops the appended row, so the list keeps its bytes.
    expect(withoutResult(refused)).toEqual({
      events: [RECORD_DECISION],
      advanced: { 'worktrees:a': 2, 'worktree:a/staged': 2 },
      changed: [],
    });
    expect(await storedIds()).toEqual(['two']);
    expect(archiveExists()).toBe(true);
  });

  it('refuses a partially readable list after the copy, writing nothing', async () => {
    mockAfterFiles = (): Promise<void> => {
      writeFileSync(
        join(root, 'a', 'worktrees.json'),
        JSON.stringify({
          version: 1,
          worktrees: [
            { id: 'two', branchName: 'second', createdAt },
            { id: 'unreadable' },
          ],
        }),
      );
      return Promise.resolve();
    };
    const refused = await observeRefusal(() => restore());
    expect(refused.result).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
    expect(refused.result).toMatchObject({ reason: 'worktrees-unavailable' });
    expect(refused.events).toEqual([
      'archive:restoreStaging',
      'files',
      RECORD_DECISION,
    ]);
    expect(archiveExists()).toBe(true);
  });

  it('keeps the archive when the list revision moves before the record, with nothing recorded', async () => {
    const expected = await currentRevision();
    beforeWorkerCommit = async (request, commit): Promise<void> => {
      expect(request.operation).toBe(OPERATION);
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktrees', workspaceId: 'a' }],
      });
    };
    const conflicted = await observeRefusal(() =>
      restore({ expectedRevision: expected }),
    );
    expect(conflicted.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(conflicted)).toEqual({
      events: [
        'archive:restoreStaging',
        'files',
        RECORD_DECISION,
        record(expected),
      ],
      advanced: { 'worktrees:a': 1 },
      changed: [],
    });
    expect(archiveExists()).toBe(true);
  });

  it('removes the recorded row in its own list write when a later install fails', async () => {
    mockFailRootFiles = (): Promise<void> => Promise.resolve();
    const failed = await observeRefusal(() => restore());
    expect(failed.result).toEqual(new Error('root files failed'));
    expect(withoutResult(failed)).toEqual({
      events: [
        'archive:restoreStaging',
        'files',
        RECORD_DECISION,
        record(),
        ...HOOKS,
        'root-files',
        REMOVAL_DECISION,
        ROLLBACK,
        ...HOOKS,
      ],
      advanced: { 'worktrees:a': 2, 'worktree:a/staged': 2 },
      // The rollback restores the list's bytes.
      changed: [],
    });
    expect(await storedIds()).toEqual(['two']);
    expect(archiveExists()).toBe(true);
  });

  it('keeps a row another incarnation took over when a later install fails', async () => {
    const other = '2026-01-01T00:00:00.000Z';
    // Another incarnation takes the id between the record and the rollback.
    mockFailRootFiles = async (): Promise<void> => {
      await updateWorkspaceWorktrees('a', (rows) =>
        rows.map((row) =>
          row.id.startsWith('recovery-') ? { ...row, createdAt: other } : row,
        ),
      );
      mockEvents.push('takeover');
    };
    const failed = await observeRefusal(() => restore());
    expect(failed.result).toEqual(new Error('root files failed'));
    // The removal finds another incarnation and writes nothing.
    expect(failed.events.slice(failed.events.indexOf('takeover'))).toEqual([
      'takeover',
      REMOVAL_DECISION,
      ...UNWRITTEN_HOOKS,
    ]);
    const kept = (await readWorkspaceWorktrees('a')).find((row) =>
      row.id.startsWith('recovery-'),
    );
    expect(kept).toMatchObject({ createdAt: other });
    if (!kept) throw new Error('Expected the kept row');
    expect(
      readFileSync(join(root, 'a', 'worktrees', kept.id, 'work.txt'), 'utf8'),
    ).toBe('retained contents');
  });
});

describe('keyed restore (KA)', () => {
  it('reserves before the files, records, then saves the receipt last; replays after a restart with nothing written', async () => {
    const expected = await currentRevision();
    const request = { expectedRevision: expected, idempotencyKey: 'key' };
    const first = await observe(() => restore(request));
    expect(first.result).toEqual({
      kind: 'worktree',
      restoredWorktreeId: STAGED_ID,
      branchName: 'old',
      warnings: [RESTORED_WARNING],
    });
    expect(withoutResult(first)).toEqual({
      events: [
        `reserve:${OPERATION}`,
        'archive:restoreStaging',
        'files',
        RECORD_DECISION,
        record(expected),
        ...HOOKS,
        ...FINISH,
        receipt(expected + 1),
      ],
      advanced: RECORDED_ADVANCE,
      changed: ['a/worktrees.json'],
    });
    const recorded = images();

    await restartHost();
    // A replay ignores the now-stale revision and writes nothing.
    const replay = await observe(() =>
      restore({ ...request, expectedRevision: 99 }),
    );
    expect(replay.result).toEqual(first.result);
    expect(withoutResult(replay)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    const reused = await observeRefusal(() =>
      restore({ ...request, containerId: 'other' }),
    );
    expect(reused.result).toMatchObject({ reason: 'key-reused' });
    expect(withoutResult(reused)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(images()).toEqual(recorded);
  });

  it('refuses a stale revision before any effect with no canonical change and releases the key', async () => {
    const stale = await observeRefusal(() =>
      restore({ expectedRevision: 7, idempotencyKey: 'key' }),
    );
    expect(stale.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(stale)).toEqual({
      events: [`reserve:${OPERATION}`, 'release'],
      advanced: {},
      changed: [],
    });
    expect(archiveExists()).toBe(true);
    const expected = await currentRevision();
    expect(
      (
        await observe(() =>
          restore({ expectedRevision: expected, idempotencyKey: 'key' }),
        )
      ).result,
    ).toMatchObject({ kind: 'worktree', branchName: 'old' });
  });

  it('keeps the archive and reports recovery-required when the list revision moves after the files', async () => {
    const expected = await currentRevision();
    beforeWorkerCommit = async (request, commit): Promise<void> => {
      // An edit of the list lands between the preflight and the record.
      expect(request.operation).toBe(OPERATION);
      await commit({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktrees', workspaceId: 'a' }],
      });
    };
    const request = { expectedRevision: expected, idempotencyKey: 'key' };
    const conflicted = await observeRefusal(() => restore(request));
    expect(conflicted.result).toBeInstanceOf(W5RevisionConflictError);
    expect(withoutResult(conflicted)).toEqual({
      events: [
        `reserve:${OPERATION}`,
        'archive:restoreStaging',
        'files',
        RECORD_DECISION,
        record(expected),
        'mark-recovery-required',
      ],
      // Only the concurrent edit's revision moved.
      advanced: { 'worktrees:a': 1 },
      changed: [],
    });
    expect(archiveExists()).toBe(true);

    const retried = await observeRefusal(() => restore(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    await restartHost();
    const afterRestart = await observeRefusal(() => restore(request));
    expect(afterRestart.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(afterRestart)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(archiveExists()).toBe(true);
  });

  it('reports recovery-required for another incarnation at the staged id after the files', async () => {
    mockAfterFiles = async (): Promise<void> => {
      const staged = await stagedOf();
      await updateWorkspaceWorktrees('a', (rows) => [
        ...rows,
        {
          id: staged.id,
          branchName: 'other',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      mockEvents.length = 0;
    };
    const request = { idempotencyKey: 'key' };
    const refused = await observeRefusal(() => restore(request));
    expect(refused.result).toMatchObject({ reason: 'identity-changed' });
    expect(refused.events).toEqual([RECORD_DECISION, 'mark-recovery-required']);
    const retried = await observeRefusal(() => restore(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(archiveExists()).toBe(true);
  });

  it.each([
    [
      'worktrees-unavailable',
      (): Promise<void> => {
        writeFileSync(
          join(root, 'a', 'worktrees.json'),
          JSON.stringify({
            version: 1,
            worktrees: [
              { id: 'two', branchName: 'second', createdAt },
              { id: 'unreadable' },
            ],
          }),
        );
        return Promise.resolve();
      },
    ],
    [
      'destination-removed',
      async (): Promise<void> => {
        const staged = await stagedOf();
        await updateWorkspaceWorktrees('a', (rows) => [
          ...rows,
          { id: staged.id, branchName: 'old', createdAt: staged.createdAt },
        ]);
        await removeWorkspaceWorktrees('a', (row) => row.id === staged.id);
      },
    ],
  ])(
    'reports recovery-required for a %s refusal after the files',
    async (reason, afterFiles) => {
      mockAfterFiles = async (): Promise<void> => {
        await afterFiles();
        mockEvents.length = 0;
      };
      const request = { idempotencyKey: 'key' };
      const refused = await observeRefusal(() => restore(request));
      expect(refused.result).toBeInstanceOf(RestoredWorktreeRecordRefusedError);
      expect(refused.result).toMatchObject({ reason });
      expect(refused.events).toEqual([
        RECORD_DECISION,
        'mark-recovery-required',
      ]);
      const retried = await observeRefusal(() => restore(request));
      expect(retried.result).toMatchObject({ reason: 'recovery-required' });
      expect(withoutResult(retried)).toEqual({
        events: [],
        advanced: {},
        changed: [],
      });
      expect(archiveExists()).toBe(true);
    },
  );

  it('keeps the rollback and reports recovery-required when a later install fails', async () => {
    mockFailRootFiles = (): Promise<void> => Promise.resolve();
    const expected = await currentRevision();
    const request = { expectedRevision: expected, idempotencyKey: 'key' };
    const failed = await observeRefusal(() => restore(request));
    expect(failed.result).toEqual(new Error('root files failed'));
    expect(failed.events).toEqual([
      `reserve:${OPERATION}`,
      'archive:restoreStaging',
      'files',
      RECORD_DECISION,
      record(expected),
      ...HOOKS,
      'root-files',
      REMOVAL_DECISION,
      ROLLBACK,
      ...HOOKS,
      'mark-recovery-required',
    ]);
    expect(await storedIds()).toEqual(['two']);
    const retried = await observeRefusal(() => restore(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(archiveExists()).toBe(true);
  });

  it('retains and diagnoses an attempt interrupted between the files and the record', async () => {
    beforeWorkerCommit = async (): Promise<void> => {
      await host.shutdown();
      throw new Error('interrupted before the record commit');
    };
    const expected = await currentRevision();
    const request = { expectedRevision: expected, idempotencyKey: 'key' };
    const before = images();
    mockEvents.length = 0;
    await expect(restore(request)).rejects.toThrow(
      'interrupted before the record commit',
    );
    expect(mockEvents.map(stagedEvent)).toEqual([
      `reserve:${OPERATION}`,
      'archive:restoreStaging',
      'files',
      RECORD_DECISION,
      // The stopped worker takes no recovery mark; launch recovery finds the
      // reservation instead.
      record(expected),
    ]);
    expect(images()).toEqual(before);

    await restartHost();
    expect(
      (await host.recoveryReport()).recoveryRequiredReservations,
    ).toHaveLength(1);
    const retried = await observeRefusal(() => restore(request));
    expect(retried.result).toMatchObject({ reason: 'recovery-required' });
    expect(withoutResult(retried)).toEqual({
      events: [],
      advanced: {},
      changed: [],
    });
    expect(archiveExists()).toBe(true);
  });
});
