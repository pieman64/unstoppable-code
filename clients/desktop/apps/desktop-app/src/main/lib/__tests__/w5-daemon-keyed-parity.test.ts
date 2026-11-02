// W6g PR B (CAN-5506) keyed-boundary parity: each keyed scenario runs through
// desktop main's in-process commit-log store and through the daemon record
// port, over real commit-log workers and real Git, and leaves the same bytes,
// journals, commit labels, revisions, outcomes, receipts, reservations and
// hook order. Plan tests 3 (E7 analogue) and 8 (lost response) run here.
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as CoreStorage from '@canopy/core-runtime/storage';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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
const mockHooks: string[] = [];
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
  })),
}));
jest.mock('../../ledger/lifecycle', () => ({
  captureLedgerWorkspaceIncarnations: jest.fn(() => Promise.resolve(null)),
  notifyLedgerWorkspaceDeleted: jest.fn(),
}));
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: jest.fn(),
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(() => mockHooks.push('structural')),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(() => mockHooks.push('structure')),
}));
jest.mock('../desktop-telemetry', () => ({
  recordWorkspaceCrudTelemetry: jest.fn(),
  recordWorktreeCrudTelemetry: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { isHostAbsolutePath } from '@canopy/protocol/canopy-core/core';
import type { WorktreeHealthIssue } from '@canopy/desktop-shared/types';
import type {
  W5CommitRequest,
  W5Resource,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import { fingerprintW5File } from '@canopy/desktop-shared/node/w5-commit-log/fingerprint';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5RecordHostPort,
  type W5RecordPortTransport,
} from '@canopy/core-runtime/node/w5/record-port';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { shutdownW5BoundaryHost } from './fixtures/w5-boundary-host';
import {
  installW5StoreSide,
  type W5StoreSide,
} from './fixtures/w5-store-sides';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { createWorkspace } from '../workspace-creation';
import { deleteWorkspace } from '../workspace-deletion';
import {
  pendingWorkspaceCreationIds,
  pendingWorkspaceCreationPaths,
} from '../w5-workspace-creation-commit';
import { readWorkspaceWorktrees } from '../workspace-persistence';
import { addWorkspaceRepository } from '../workspace-repositories';
import { deleteWorktree } from '../worktree-archive';
import { renameWorktreeBranch } from '../worktree-branch-rename';
import { inProcessBranchRenameGit } from '../../__tests__/helpers/in-process-branch-rename-git';
import { updateWorktree } from '../worktree-update';

jest.setTimeout(180_000);

const NOW = new Date('2026-10-31T12:00:00.000Z');
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** A journal's directory identity: device, inode and birth time. */
const IDENTITY = /\b\d{5,}:\d+:\d+(?:\.\d+)?/g;
/**
 * The content-free name a failed attempt records: the injected error's
 * in-process, the uncertain transport failure's on the daemon side.
 */
const UNCERTAIN_NAME = /"errorName":"(?:Error|CanopyClientError)"/g;
const W5_FILES = [
  'index.json',
  'a/workspace.json',
  'a/worktrees.json',
  'b/workspace.json',
  'b/worktrees.json',
];
const RESOURCES: W5Resource[] = [
  { kind: 'workspaces' },
  { kind: 'workspace', workspaceId: 'a' },
  { kind: 'worktrees', workspaceId: 'a' },
  { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' },
  { kind: 'worktree', workspaceId: 'a', worktreeId: 'two' },
];

interface Context {
  readonly side: W5StoreSide;
  readonly host: W5CommitLogHost;
  /** The host's recording commit, which scenario faults wrap. */
  readonly decide: (
    request: W5CommitRequest,
  ) => ReturnType<W5CommitLogHost['commit']>;
  readonly root: string;
  /** The fixture's source repository, outside the W5 root. */
  readonly repo: string;
  /** Keyed decisions the daemon side sent over its transport. */
  readonly sentKeyed: CoreWorkspaceRecordsKeyedCall[];
  /** Every record-port call on Electron's connection, as it crossed. */
  readonly wire: WireCall[];
  /**
   * The host port the side's store decides through: the commit-log host
   * in-process, the record port over Electron's connection on the daemon side.
   */
  readonly hostPort: () => W5CommitLogHostPort;
}
type CoreWorkspaceRecordsKeyedCall = { operation: string; key: string };
interface WireCall {
  readonly method: keyof W5RecordPortTransport;
  readonly params: unknown;
  /** The result, or the failure's typed payload (or name and message). */
  readonly settled: unknown;
}

function wireFailure(error: unknown): unknown {
  if (typeof error === 'object' && error !== null && 'payload' in error)
    return error.payload;
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : String(error);
}

/** `transport`, recording each call and how it settled into `calls`. */
function recordWire(
  transport: W5RecordPortTransport,
  calls: WireCall[],
): W5RecordPortTransport {
  async function record<T>(
    method: keyof W5RecordPortTransport,
    params: unknown,
    call: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await call();
      calls.push({ method, params, settled: result ?? null });
      return result;
    } catch (error) {
      calls.push({ method, params, settled: wireFailure(error) });
      throw error;
    }
  }
  return {
    capture: (request) =>
      record('capture', request, () => transport.capture(request)),
    recovery: () => record('recovery', {}, () => transport.recovery()),
    commit: (request) =>
      record('commit', request, () => transport.commit(request)),
    lookupReceipt: (receipt) =>
      record('lookupReceipt', { receipt }, () =>
        transport.lookupReceipt(receipt),
      ),
    listReservations: () =>
      record('listReservations', {}, () => transport.listReservations()),
    reserve: (params) =>
      record('reserve', params, () => transport.reserve(params)),
    updateReservationDiagnostics: (params) =>
      record('updateReservationDiagnostics', params, () =>
        transport.updateReservationDiagnostics(params),
      ),
    releaseReservation: (reservationId) =>
      record('releaseReservation', { reservationId }, () =>
        transport.releaseReservation(reservationId),
      ),
    markReservationRecoveryRequired: (params) =>
      record('markReservationRecoveryRequired', params, () =>
        transport.markReservationRecoveryRequired(params),
      ),
  };
}

interface Scenario {
  readonly name: string;
  /** Faults on the in-process host (both sides decide through it). */
  readonly setup?: (context: Context) => void;
  /** Daemon side only: faults on Electron's connection. */
  readonly wrapTransport?: (
    transport: W5RecordPortTransport,
  ) => W5RecordPortTransport;
  readonly steps: readonly ((context: Context) => Promise<unknown>)[];
}

/** One step's portable result: its value, or its typed failure. */
function settled(error: unknown, root: string): unknown {
  if (error instanceof W5RevisionConflictError)
    return {
      error: 'revision-conflict',
      resource: error.resource,
      expected: error.expected,
      actual: error.actual,
    };
  if (error instanceof W5FileWriteRefusedError)
    return { error: 'fingerprint-conflict', path: relative(root, error.path) };
  if (error instanceof W5CommitRefusedError)
    return { error: error.reason, details: error.details };
  if (
    typeof error === 'object' &&
    error !== null &&
    'reason' in error &&
    typeof error.reason === 'string'
  )
    return { error: error.reason };
  // A failed or lost decision call: uncertain on both sides.
  return { error: 'uncertain' };
}

function readTree(path: string): unknown {
  if (!existsSync(path)) return null;
  return readdirSync(path, { withFileTypes: true })
    .map((entry) => [
      entry.name,
      entry.isDirectory()
        ? readTree(join(path, entry.name))
        : readFileSync(join(path, entry.name), 'utf8'),
    ])
    .sort();
}

/** The record-port calls of daemon-side runs, and each run's fixture folder. */
interface WireLog {
  readonly calls: WireCall[];
  readonly dirs: string[];
}

async function run(
  scenario: Scenario,
  side: W5StoreSide,
  wireLog?: WireLog,
): Promise<unknown> {
  let createdAt = '';
  const { dir, root, repo } = createW5BoundaryFixture(
    (at) => {
      createdAt = at;
      return [
        { id: 'one', branchName: 'old', createdAt: at },
        { id: 'two', branchName: 'second', createdAt: at },
      ];
    },
    ['b'],
  );
  const originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
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
  const dbPath = join(dir, 'w5', 'commit-log.sqlite');
  const host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  const commits: unknown[] = [];
  const receipts = new Map<string, NonNullable<W5CommitRequest['receipt']>>();
  const commit = host.commit.bind(host);
  const decide: Context['decide'] = (request) => {
    if (request.receipt)
      receipts.set(JSON.stringify(request.receipt), request.receipt);
    commits.push({
      operation: request.operation,
      advance: request.advance,
      expectedRevisions: request.expectedRevisions,
      files: request.files.map((file) => relative(root, file.path)),
      receipt: request.receipt && {
        caller: request.receipt.caller,
        operation: request.receipt.operation,
        idempotencyKey: request.receipt.idempotencyKey,
      },
      completesReservation: request.reservationId !== undefined,
      outcome: request.outcome ?? null,
    });
    return commit(request);
  };
  jest.spyOn(host, 'commit').mockImplementation(decide);
  wireLog?.dirs.push(dir);
  let daemonPort: W5CommitLogHostPort | undefined;
  const context: Context = {
    side,
    host,
    decide,
    root,
    repo,
    sentKeyed: [],
    wire: wireLog?.calls ?? [],
    hostPort: () => {
      if (side === 'in-process') return host;
      if (!daemonPort) throw new Error('Expected the daemon connection');
      return daemonPort;
    },
  };
  const reserve = host.reserve.bind(host);
  jest.spyOn(host, 'reserve').mockImplementation((input) => {
    if (input.receipt)
      receipts.set(JSON.stringify(input.receipt), input.receipt);
    return reserve(input);
  });
  scenario.setup?.(context);
  const teardown = await installW5StoreSide(side, {
    host,
    root,
    setDaemonOwned: setDaemonOwnedForTest,
    wrapTransport: (transport) => {
      const recorded = recordWire(transport, context.wire);
      const wrapped = scenario.wrapTransport?.(recorded) ?? recorded;
      daemonPort = createW5RecordHostPort({ root, transport: wrapped });
      return {
        ...wrapped,
        commit: (request): ReturnType<W5RecordPortTransport['commit']> => {
          if (request.receipt)
            context.sentKeyed.push({
              operation: request.operation,
              key: request.receipt.idempotencyKey,
            });
          return wrapped.commit(request);
        },
      };
    },
  });
  try {
    mockHooks.length = 0;
    const results: unknown[] = [];
    for (const step of scenario.steps) {
      try {
        results.push({ value: await step(context) });
      } catch (error) {
        results.push(settled(error, root));
      }
    }
    await settleDetachedWork();
    const observed = {
      results,
      files: Object.fromEntries(
        W5_FILES.map((file) => [
          file,
          existsSync(join(root, file))
            ? readFileSync(join(root, file), 'utf8')
            : null,
        ]),
      ),
      checkout: existsSync(join(root, 'a', 'worktrees', 'one')),
      journals: readTree(join(dir, 'data', 'w5', 'destructive-lifecycles')),
      commits,
      revisions: await Promise.all(
        RESOURCES.map((resource) => host.revision(resource)),
      ),
      receipts: await Promise.all(
        Array.from(receipts.values()).map((receipt) =>
          host.lookupReceipt(receipt),
        ),
      ),
      reservations: (await host.recoveryReport()).reservations ?? [],
      hooks: [...mockHooks],
    };
    // Paths, incarnations and generated ids differ by fixture, not by side.
    return JSON.parse(
      JSON.stringify(observed)
        .split(dir)
        .join('<dir>')
        .split(createdAt)
        .join('<createdAt>')
        .replace(UUID, '<uuid>')
        .replace(IDENTITY, '<identity>')
        .replace(UNCERTAIN_NAME, '"errorName":"<uncertain>"'),
    );
  } finally {
    await teardown();
    __setDesktopW5FileStoreForTests(nodeW5FileStore);
    await shutdownW5BoundaryHost(host, dbPath);
    if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = originalDataDir;
    rmSync(dir, { recursive: true, force: true });
    jest.restoreAllMocks();
  }
}

const update = (
  options: { expectedRevision?: number; label?: string } = {},
): Promise<unknown> =>
  updateWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    patch: { label: options.label ?? 'Edited' },
    expectedRevision: options.expectedRevision,
    idempotencyKey: 'key',
  });
const rename = (expectedRevision?: number): Promise<unknown> =>
  renameWorktreeBranch(
    {
      source: 'desktop',
      workspaceId: 'a',
      worktreeId: 'one',
      newBranchName: 'renamed',
      expectedRevision,
      idempotencyKey: 'key',
    },
    inProcessBranchRenameGit,
  );
const removeWorktree = (
  options: { expectedRevision?: number; deleteBranch?: boolean } = {},
): Promise<unknown> =>
  deleteWorktree({
    workspaceId: 'a',
    worktreeId: 'one',
    source: 'single_repo',
    idempotencyKey: 'key',
    ...options,
  });
const rowIds = async (): Promise<string[]> =>
  (await readWorkspaceWorktrees('a')).map((row) => row.id);

/** A routed edit of `one` lands just before the deletion's canonical decision. */
function concurrentEditAtRowRemoval({ host, decide }: Context): void {
  jest.spyOn(host, 'commit').mockImplementation(async (request) => {
    if (request.operation === 'core.worktree.delete' && request.files.length)
      await decide({
        operation: 'test.concurrent-edit',
        outcome: null,
        files: [],
        advance: [{ kind: 'worktree', workspaceId: 'a', worktreeId: 'one' }],
      });
    return decide(request);
  });
}

/**
 * Decides a keyed change to `a`'s list through the side's host port, then
 * sends the same request again, naming the fingerprint its decision replaced.
 */
async function retryKeyedChangeWithOriginalFingerprint({
  hostPort,
  root,
}: Context): Promise<unknown> {
  const path = join(root, 'a', 'worktrees.json');
  const previous = readFileSync(path, 'utf8');
  const request: W5CommitRequest = {
    operation: 'test.keyed-change',
    receipt: {
      caller: 'desktop-host:test',
      operation: 'test.keyed-change',
      idempotencyKey: 'retry-key',
      fingerprint: 'f'.repeat(64),
    },
    advance: [{ kind: 'worktrees', workspaceId: 'a' }],
    files: [
      {
        path,
        contents: `${previous}\n`,
        previousFingerprint: fingerprintW5File(previous),
      },
    ],
    outcome: { label: 'Changed' },
  };
  const first = await hostPort().commit(request);
  const retry = await hostPort().commit(request);
  return { first, retry };
}

/** Row `one` as a health check persists it: broken, naming its checkout. */
function persistHealthIssue({ root }: Context): void {
  const path = join(root, 'a', 'worktrees.json');
  const list: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (
    typeof list !== 'object' ||
    list === null ||
    !('worktrees' in list) ||
    !Array.isArray(list.worktrees)
  )
    throw new Error('Expected the fixture worktree list');
  const rows: unknown[] = list.worktrees;
  const checkout = join(root, 'a', 'worktrees', 'one');
  const healthIssue: WorktreeHealthIssue = {
    status: 'broken',
    code: 'missing-worktree-path',
    message: `Missing ${checkout}`,
    checkedAt: NOW.toISOString(),
    worktreePath: checkout,
  };
  writeFileSync(
    path,
    JSON.stringify({
      ...list,
      worktrees: rows.map((row) =>
        typeof row === 'object' &&
        row !== null &&
        'id' in row &&
        row.id === 'one'
          ? { ...row, healthIssue }
          : row,
      ),
    }),
  );
}

/** A second repository beside the fixture's, outside the W5 root. */
const importedRepo = ({ repo }: Context): string =>
  join(dirname(repo), 'imported');
function createImportedRepo(context: Context): void {
  const path = importedRepo(context);
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

const addRepository = (context: Context): Promise<unknown> =>
  addWorkspaceRepository({
    workspaceId: 'b',
    source: 'workspace_settings',
    repository: { repoPath: importedRepo(context) },
    idempotencyKey: 'add-key',
  });
const importRepository = (context: Context): Promise<unknown> =>
  createWorkspace({
    source: 'import_from_repo',
    variant: {
      kind: 'repository-without-manifest',
      repoPath: importedRepo(context),
    },
    idempotencyKey: 'import-key',
  });

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'keyed update replays its outcome and refuses parameter reuse',
    steps: [
      () => update({ expectedRevision: 0 }),
      () => update({ expectedRevision: 999 }),
      () => update({ label: 'Other' }),
    ],
  },
  {
    name: 'keyed rename releases a stale attempt, then decides once and replays',
    steps: [() => rename(99), () => rename(0), () => rename(999)],
  },
  {
    name: 'keyed worktree delete replays after removal and refuses parameter reuse',
    steps: [
      () => removeWorktree(),
      () => removeWorktree({ expectedRevision: 999 }),
      () => removeWorktree({ deleteBranch: true }),
    ],
  },
  {
    name: 'keyed workspace delete commits its index entry once and replays',
    steps: [
      () =>
        deleteWorkspace({
          workspaceId: 'a',
          source: 'shared_container_fork',
          expectedRevision: 0,
          idempotencyKey: 'delete-key',
        }),
      () =>
        deleteWorkspace({
          workspaceId: 'a',
          source: 'shared_container_fork',
          idempotencyKey: 'delete-key',
        }),
    ],
  },
  {
    // Plan test 3: a conflict after effects, at canonical row removal.
    name: 'E7: a deletion refused at its canonical decision after Git removal keeps the same journal and receipt state',
    setup: concurrentEditAtRowRemoval,
    steps: [
      () => removeWorktree({ expectedRevision: 0 }),
      rowIds,
      () => removeWorktree({ expectedRevision: 0 }),
    ],
  },
  {
    name: 'a failed decision after Git requires recovery and never renames twice',
    setup: ({ host, decide }) => {
      let failed = false;
      jest.spyOn(host, 'commit').mockImplementation((request) => {
        if (!failed && request.receipt) {
          failed = true;
          return Promise.reject(new Error('decision unavailable'));
        }
        return decide(request);
      });
    },
    steps: [() => rename(), () => rename()],
  },
  {
    // Plan test 8: the decision is made, its response never arrives.
    name: 'a lost keyed response is never retried and replays through the receipt',
    setup: ({ side, host, decide }) => {
      if (side !== 'in-process') return;
      let lost = false;
      jest.spyOn(host, 'commit').mockImplementation(async (request) => {
        const outcome = await decide(request);
        if (!lost && request.receipt) {
          lost = true;
          throw new Error('response lost');
        }
        return outcome;
      });
    },
    wrapTransport: (transport) => {
      let lost = false;
      return {
        ...transport,
        commit: async (request) => {
          const result = await transport.commit(request);
          if (!lost && request.receipt) {
            lost = true;
            throw new Error('connection lost');
          }
          return result;
        },
      };
    },
    steps: [() => update(), () => update(), rowIds],
  },
  {
    // A wire-level retry of a decided commit, as after a lost response.
    name: 'a keyed file change retried with its original fingerprint replays its outcome',
    steps: [retryKeyedChangeWithOriginalFingerprint],
  },
  {
    name: 'an interrupted keyed creation keeps its reservations and host-built diagnostics',
    setup: ({ host, decide }) => {
      jest
        .spyOn(host, 'commit')
        .mockImplementation((request) =>
          request.files.some((file) => file.path.endsWith('index.json'))
            ? Promise.reject(new Error('publication unavailable'))
            : decide(request),
        );
    },
    steps: [
      () =>
        createWorkspace({
          source: 'new_multi_repo',
          variant: { kind: 'new-multi-repo', name: 'Created' },
          idempotencyKey: 'create-key',
        }),
      // Identity reads through the store: the daemon side lists them.
      () => pendingWorkspaceCreationIds(),
      () => pendingWorkspaceCreationPaths(),
      () =>
        createWorkspace({
          source: 'new_multi_repo',
          variant: { kind: 'new-multi-repo', name: 'Created' },
          idempotencyKey: 'create-key',
        }),
    ],
  },
  {
    // The image keeps the persisted health issue; the outcome decoders drop it.
    name: 'keyed update and rename of a row with a health issue save and replay health-free outcomes',
    setup: persistHealthIssue,
    steps: [() => update(), () => update(), () => rename(), () => rename()],
  },
  {
    name: 'a keyed import of a local repository decides once and replays',
    setup: createImportedRepo,
    steps: [importRepository, importRepository],
  },
  {
    // DQ-7 reading (i): the saved outcome names the repository's host path.
    name: 'a keyed repository add saves its repository path and replays it',
    setup: (context) => {
      createImportedRepo(context);
      writeFileSync(
        join(context.root, 'b', 'workspace.json'),
        JSON.stringify({ version: 1, type: 'multi-repo', repos: [] }),
      );
    },
    steps: [addRepository, addRepository],
  },
];

beforeEach(() => {
  // Only the clock is fixed; file system, Git and worker timers stay real.
  jest.useFakeTimers({
    now: NOW,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
});
afterEach(() => jest.useRealTimers());

it.each(SCENARIOS.map((scenario) => [scenario.name, scenario]))(
  '%s: the daemon record port matches the in-process store',
  async (_name, scenario) => {
    const inProcess = await run(scenario, 'in-process');
    const wire: WireLog = { calls: [], dirs: [] };
    const daemon = await run(scenario, 'daemon', wire);
    expect(daemon).toEqual(inProcess);
    expect(wireLeaks(wire)).toEqual({ hostPaths: [], decisions: [] });
  },
);

it('E7: the refused deletion is decided once, with no retry, on the daemon side', async () => {
  const scenario = SCENARIOS.find((entry) => entry.name.startsWith('E7'));
  if (!scenario) throw new Error('Expected the E7 scenario');
  const observed = await run(scenario, 'daemon');
  expect(observed).toMatchObject({
    results: [
      { error: 'revision-conflict', expected: 0, actual: 1 },
      { value: ['one', 'two'] },
      { error: 'recovery-required' },
    ],
    checkout: false,
  });
  // One canonical decision attempt for the deletion, and the receipt holds
  // the reservation awaiting recovery: nothing retried it.
  const deletions = (
    observed as { commits: { operation: string; files: unknown[] }[] }
  ).commits.filter(
    (entry) =>
      entry.operation === 'core.worktree.delete' && entry.files.length > 0,
  );
  expect(deletions).toHaveLength(1);
  expect(observed).toMatchObject({
    receipts: [{ status: 'recovery-required' }],
  });
});

it('a decided keyed change retried with its original fingerprint replays on the daemon side, not a conflict', async () => {
  const scenario = SCENARIOS.find((entry) =>
    entry.name.startsWith('a keyed file change retried'),
  );
  if (!scenario) throw new Error('Expected the keyed retry scenario');
  const observed = await run(scenario, 'daemon');
  expect(observed).toMatchObject({
    results: [
      {
        value: {
          first: { status: 'applied' },
          retry: { status: 'replayed', outcome: { label: 'Changed' } },
        },
      },
    ],
    receipts: [{ status: 'replay', outcome: { label: 'Changed' } }],
  });
});

it('a lost keyed response is sent once and replays the saved outcome without a second decision', async () => {
  const scenario = SCENARIOS.find((entry) => entry.name.startsWith('a lost'));
  if (!scenario) throw new Error('Expected the lost-response scenario');
  let sent: CoreWorkspaceRecordsKeyedCall[] = [];
  const observed = await run(
    {
      ...scenario,
      setup: (context) => {
        sent = context.sentKeyed;
        scenario.setup?.(context);
      },
    },
    'daemon',
  );
  const results = (observed as { results: unknown[] }).results;
  expect(results[0]).toEqual({ error: 'uncertain' });
  expect(results[1]).toMatchObject({
    value: { worktree: { id: 'one', label: 'Edited' } },
  });
  // The keyed decision crossed once: the replay came from receipt.lookup.
  expect(sent).toHaveLength(1);
  expect(observed).toMatchObject({ receipts: [{ status: 'replay' }] });
});

interface WireString {
  readonly method: keyof W5RecordPortTransport;
  /** The keys leading to the string, from the call's `params` or `settled`. */
  readonly at: readonly (string | number)[];
  readonly text: string;
}

/** Each string in `value`, key or value, with the keys that lead to it. */
function* wireStrings(
  value: unknown,
  at: readonly (string | number)[] = [],
): Generator<Omit<WireString, 'method'>> {
  if (typeof value === 'string') yield { at, text: value };
  else if (Array.isArray(value))
    for (let index = 0; index < value.length; index += 1)
      yield* wireStrings(value[index], [...at, index]);
  else if (typeof value === 'object' && value !== null)
    for (const [key, entry] of Object.entries(value)) {
      yield { at: [...at, key], text: key };
      yield* wireStrings(entry, [...at, key]);
    }
}

const located = (calls: readonly WireCall[]): WireString[] =>
  calls.flatMap((call) =>
    Array.from(
      wireStrings({ params: call.params, settled: call.settled }),
      (entry) => ({ method: call.method, ...entry }),
    ),
  );

/** A record image: a commit's file contents, or a capture's file bytes. */
const isImage = (at: readonly (string | number)[]): boolean =>
  at[1] === 'files' && (at.at(-1) === 'contents' || at.at(-1) === 'base64');
/**
 * DQ-7 reading (i)'s opaque same-host payloads: images, reservation
 * diagnostics text and saved keyed outcomes. Only these may name a host path.
 */
const isOpaquePayload = (at: readonly (string | number)[]): boolean =>
  isImage(at) || at.at(-1) === 'diagnostics' || at.includes('outcome');
/** A health or expose-* decision's kind or field. */
const HOST_DECISION = /\bhealth|expose-/i;

/**
 * The wire strings that break DQ-7: a host path outside the opaque payloads,
 * and a health or expose-* decision anywhere but inside an image.
 */
function wireLeaks(wire: WireLog): {
  hostPaths: WireString[];
  decisions: WireString[];
} {
  const strings = located(wire.calls);
  const namesHostPath = (text: string): boolean =>
    isHostAbsolutePath(text) || wire.dirs.some((dir) => text.includes(dir));
  return {
    hostPaths: strings.filter(
      ({ at, text }) => !isOpaquePayload(at) && namesHostPath(text),
    ),
    decisions: strings.filter(
      ({ at, text }) => !isImage(at) && HOST_DECISION.test(text),
    ),
  };
}

const imageText = (entry: WireString): string =>
  entry.at.at(-1) === 'base64'
    ? Buffer.from(entry.text, 'base64').toString('utf8')
    : entry.text;

it('keyed calls send host paths only in opaque payloads, and no health or expose-* decision', async () => {
  const runs = [
    'an interrupted keyed creation',
    'keyed rename releases',
    'keyed update and rename of a row with a health issue',
    'a keyed repository add',
  ].map((prefix) => {
    const scenario = SCENARIOS.find((entry) => entry.name.startsWith(prefix));
    if (!scenario) throw new Error(`Expected the ${prefix} scenario`);
    return { scenario, wire: { calls: [], dirs: [] } satisfies WireLog };
  });
  for (const { scenario, wire } of runs) await run(scenario, 'daemon', wire);
  const [creation, , health, repository] = runs.map(({ wire }) => wire);
  if (!creation || !health || !repository) throw new Error('Expected 4 runs');
  const all: WireLog = {
    calls: runs.flatMap(({ wire }) => wire.calls),
    dirs: runs.flatMap(({ wire }) => wire.dirs),
  };
  // Every receipt and reservation call crossed, so the scan is not vacuous.
  expect(new Set(all.calls.map((call) => call.method))).toEqual(
    new Set([
      'capture',
      'commit',
      'recovery',
      'lookupReceipt',
      'listReservations',
      'reserve',
      'updateReservationDiagnostics',
      'releaseReservation',
      'markReservationRecoveryRequired',
    ]),
  );
  expect(wireLeaks(all)).toEqual({ hostPaths: [], decisions: [] });

  // The creation's owned paths cross inside its diagnostics text.
  const [creationDir] = creation.dirs;
  expect(
    located(creation.calls).some(
      ({ at, text }) =>
        at.at(-1) === 'diagnostics' &&
        creationDir !== undefined &&
        text.includes(creationDir),
    ),
  ).toBe(true);
  // The row's health issue crosses only inside the images.
  const healthStrings = located(health.calls);
  expect(
    healthStrings.some(
      (entry) => isImage(entry.at) && imageText(entry).includes('healthIssue'),
    ),
  ).toBe(true);
  // The added repository's path rides in its saved outcome, sent with the
  // decision and returned by its replay.
  const [repositoryDir] = repository.dirs;
  if (repositoryDir === undefined) throw new Error('Expected the fixture');
  const imported = join(repositoryDir, 'imported');
  const outcomePaths = located(repository.calls).filter(
    ({ at, text }) => at.includes('outcome') && text === imported,
  );
  expect(
    outcomePaths.map(({ method, at }) => [method, at[0], at.at(-1)]),
  ).toEqual(
    expect.arrayContaining([
      ['commit', 'params', 'repoPath'],
      ['lookupReceipt', 'settled', 'repoPath'],
    ]),
  );
});
