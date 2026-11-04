// W6b record-seam equivalence with the real commit-log worker, canonical files
// and Git. Substituted host hooks are not unmodified product lifecycle
// evidence. The port applies JSON copies of each decision.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { jsonRecordRoundTrip } from './fixtures/json-record-round-trip';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
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
// The archive's host services, as the remaining-boundaries suite stubs them.
jest.mock('../post-archive-sync', () => ({
  queueTrackedGitHubWorktreeSync: jest.fn(),
}));
jest.mock('../../browser/browser-profile-lifecycle', () => ({
  prepareTaskBrowserRetirement: jest.fn(() => Promise.resolve('retirement')),
  settleFailedTaskBrowserRetirement: jest.fn(() => Promise.resolve()),
  retireRemovedBrowserTask: jest.fn(() => Promise.resolve()),
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

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import { W5CommitRefusedError } from '@canopy/desktop-shared/node/w5-commit-log/errors';
import type { WorktreeData } from '@canopy/desktop-shared/types';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import * as animals from '../animals';
import * as git from '../git';
import { getWorktreeDataDir, getWorktreeDir } from '../paths';
import { isRecord } from '../type-guards';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import {
  isWorkspaceWorktreeRecentlyRemoved,
  readWorkspaceWorktrees,
} from '../workspace-persistence';
import * as creationPort from '../worktree-creation-decision-port';
import {
  createWorktreeFromSelection,
  type WorktreeCreationRequest,
} from '../worktree-creation';
import { archiveWorktree } from '../worktree-archive';

jest.setTimeout(60_000);
let dir: string;
let root: string;
let repo: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;
let reservations: jest.SpiedFunction<W5CommitLogHost['reserve']>;
let commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
let commitOriginal: W5CommitLogHost['commit'];
const list = (): string => join('a', 'worktrees.json');

function start(): void {
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}
beforeEach(() => {
  ({ dir, root, repo } = createW5BoundaryFixture());
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  start();
  reservations = jest.spyOn(host, 'reserve');
  commitOriginal = host.commit.bind(host);
  commits = jest.spyOn(host, 'commit');
});
afterEach(async () => {
  await settleDetachedWork();
  jest.restoreAllMocks();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

function useMultiRepoWorkspace(): void {
  writeFileSync(
    join(root, 'a', 'workspace.json'),
    JSON.stringify({
      version: 1,
      type: 'multi-repo',
      sourceRepoPath: repo,
      repos: [],
    }),
  );
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({
      version: 1,
      workspaces: [
        { id: 'a', name: 'Multi', type: 'multi-repo', color: 'blue', order: 0 },
      ],
    }),
  );
  __resetSidebarItemsStateForTests();
}
function request(
  overrides: Partial<WorktreeCreationRequest<'single-repo'>> = {},
): WorktreeCreationRequest<'single-repo'> {
  return {
    workspaceId: 'a',
    workspaceKind: 'single-repo',
    branch: { kind: 'new', branchName: 'created' },
    base: { kind: 'repository-default' },
    allowBaseBranchNetwork: false,
    seedPanelLayoutMode: false,
    idempotencyKey: 'create-key',
    ...overrides,
  };
}
const repairRequest: WorktreeCreationRequest<'multi-repo'> = {
  workspaceId: 'a',
  workspaceKind: 'multi-repo',
  branch: { kind: 'new', branchName: 'repair' },
  base: { kind: 'repository-default' },
  includedRepoIds: [],
  surfaceNeedsRepairInResponse: true,
  allowBaseBranchNetwork: false,
  seedPanelLayoutMode: false,
  idempotencyKey: 'repair-key',
};
function receipt(): Parameters<W5CommitLogHost['lookupReceipt']>[0] {
  const value = reservations.mock.calls[0]?.[0].receipt;
  if (!value) throw new Error('Expected a keyed reservation');
  return value;
}

/** Records each decision and each commit, in order. */
function recordCreationSeam(): unknown[] {
  const events: unknown[] = [];
  const reserve = creationPort.applyWorktreeCreationReservation;
  jest
    .spyOn(creationPort, 'applyWorktreeCreationReservation')
    .mockImplementation(async (workspaceId, decision, preconditions) => {
      events.push(`decision:${decision.kind}`);
      return reserve(
        workspaceId,
        jsonRecordRoundTrip(decision),
        jsonRecordRoundTrip(preconditions),
      );
    });
  const record = creationPort.applyReservedWorktreeRecord;
  jest
    .spyOn(creationPort, 'applyReservedWorktreeRecord')
    .mockImplementation(async (target, decision) => {
      events.push(`decision:${decision.kind}`);
      return record(target, jsonRecordRoundTrip(decision));
    });
  const setup = creationPort.applyWorktreeSetupRecord;
  jest
    .spyOn(creationPort, 'applyWorktreeSetupRecord')
    .mockImplementation(async (target, decision) => {
      events.push(`setup:${decision.kind}`);
      return setup(target, jsonRecordRoundTrip(decision));
    });
  jest
    .spyOn(creationPort, 'applyReservedWorktreeRemoval')
    .mockImplementation(() => {
      events.push('decision:worktree.create.reservation.remove');
      return Promise.reject(new Error('Unexpected reserved row removal'));
    });
  const create = git.createWorktree;
  jest.spyOn(git, 'createWorktree').mockImplementation(async (...args) => {
    events.push('git');
    return create(...args);
  });
  reservations.mockImplementation(async (input) => {
    events.push('reserve');
    return W5CommitLogHost.prototype.reserve.call(host, input);
  });
  commits.mockImplementation(async (input) => {
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
  return events;
}
// The legacy commits: the reservation and receipts commit as the create,
// each setup record as its own list write.
const reservationCommit = {
  operation: 'core.worktree.create',
  files: [list()],
  receipt: false,
};
const setupCommit = {
  operation: 'w5.worktree_list.write',
  files: [list()],
  receipt: false,
};
function receiptCommit(files: string[] = []): unknown {
  return { operation: 'core.worktree.create', files, receipt: true };
}
/** Whether a list write holds a completed creation row: the promotion. */
function promotesRow(input: Parameters<W5CommitLogHost['commit']>[0]): boolean {
  return (
    input.operation === setupCommit.operation &&
    input.files.some((file) => {
      const written: unknown =
        file.contents === null ? null : JSON.parse(file.contents);
      return (
        isRecord(written) &&
        Array.isArray(written.worktrees) &&
        written.worktrees.some(
          (row: unknown) =>
            isRecord(row) &&
            row.setupPhase === 'git-ready' &&
            isRecord(row.creation) &&
            row.creation.state === 'complete',
        )
      );
    })
  );
}

it('W6b commits a keyed synchronous create decision by decision, then saves only the receipt', async () => {
  const events = recordCreationSeam();
  const first = await createWorktreeFromSelection(request());
  expect(first).toMatchObject({
    status: 'created',
    record: { setupPhase: 'git-ready' },
  });
  expect(events).toEqual([
    'reserve',
    'decision:worktree.create.reserve',
    reservationCommit,
    'decision:worktree.create.phase',
    setupCommit,
    'git',
    'setup:worktree.create.promote',
    setupCommit,
    receiptCommit(),
  ]);
  events.length = 0;
  await expect(createWorktreeFromSelection(request())).resolves.toEqual(first);
  expect(events).toEqual([]);
});

it.each([
  ['single-repo', 'validateBranchName'],
  ['single-repo', 'isBranchNameAvailable'],
  ['multi-repo', 'validateBranchName'],
  ['multi-repo', 'isBranchNameAvailable'],
] as const)(
  '%s releases a keyed Git preflight failure from %s and retries the same key',
  async (workspaceKind, check) => {
    if (workspaceKind === 'multi-repo') useMultiRepoWorkspace();
    const creationRequest: WorktreeCreationRequest = {
      ...request(),
      workspaceKind,
      callerSource: 'pipeline-host',
      repairWorkspaceRoot: true,
      ...(workspaceKind === 'multi-repo' ? { includedRepoIds: [] } : {}),
    };
    const failure = Object.assign(
      new Error(
        check === 'validateBranchName'
          ? 'Selected Git executable cannot be used: /missing/git'
          : 'spawn git ENOENT: repository cwd is missing',
      ),
      { code: 'ENOENT' },
    );
    const preflight = jest.spyOn(git, check).mockRejectedValue(failure);
    const released = jest.spyOn(host, 'releaseReservation');
    const marked = jest.spyOn(host, 'markReservationRecoveryRequired');
    const before = readFileSync(join(root, list()), 'utf8');

    await expect(createWorktreeFromSelection(creationRequest)).rejects.toBe(
      failure,
    );
    expect(commits).not.toHaveBeenCalled();
    expect(readFileSync(join(root, list()), 'utf8')).toBe(before);
    expect(released).toHaveBeenCalledWith(
      reservations.mock.calls[0]?.[0].reservationId,
    );
    expect(marked).not.toHaveBeenCalled();
    const key = receipt();
    expect(await host.lookupReceipt(key)).toMatchObject({ status: 'none' });

    preflight.mockRestore();
    await expect(
      createWorktreeFromSelection(creationRequest),
    ).resolves.toMatchObject({ status: 'created' });
    expect(reservations).toHaveBeenCalledTimes(2);
    expect(await host.lookupReceipt(key)).toMatchObject({ status: 'replay' });
    expect(marked).not.toHaveBeenCalled();
  },
);

it('W6b checks the expected worktrees revision on the reservation only', async () => {
  const events = recordCreationSeam();
  await createWorktreeFromSelection(
    request({ idempotencyKey: undefined, expectedRevision: 0 }),
  );
  expect(events).toEqual([
    'decision:worktree.create.reserve',
    {
      ...reservationCommit,
      expectedRevisions: [
        { resource: { kind: 'worktrees', workspaceId: 'a' }, revision: 0 },
      ],
    },
    'decision:worktree.create.phase',
    setupCommit,
    'git',
    'setup:worktree.create.promote',
    setupCommit,
  ]);
});

it('W6b saves a deferred create receipt after its reservation, before setup records', async () => {
  const events = recordCreationSeam();
  let settle: () => void = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  await createWorktreeFromSelection(
    request({ deferGitSetup: true, onGitSetupSettled: settle }),
  );
  await settled;
  expect(events).toEqual([
    'reserve',
    'decision:worktree.create.reserve',
    reservationCommit,
    receiptCommit(),
    'decision:worktree.create.phase',
    setupCommit,
    'git',
    'decision:worktree.create.promote',
    setupCommit,
  ]);
});

it('W6b retains a needs-repair row in the same decision as its receipt', async () => {
  useMultiRepoWorkspace();
  const events = recordCreationSeam();
  const first = await createWorktreeFromSelection(repairRequest);
  expect(first).toMatchObject({ status: 'needs-repair' });
  expect(events).toEqual([
    'reserve',
    'decision:worktree.create.reserve',
    reservationCommit,
    'decision:worktree.create.phase',
    setupCommit,
    'git',
    'decision:worktree.create.phase',
    receiptCommit([list()]),
  ]);
  const rows = await readWorkspaceWorktrees('a');
  expect(rows).toHaveLength(1);
  const [retained] = rows;
  expect(retained?.creation).toMatchObject({
    state: 'recovery-required',
    phase: 'source-root-repair',
  });
  events.length = 0;
  await expect(createWorktreeFromSelection(repairRequest)).resolves.toEqual(
    first,
  );
  expect(events).toEqual([]);
});

it.each(['promote', 'receipt'] as const)(
  'W6b preserves effects and reports recovery-required when the %s commit conflicts after Git',
  async (step) => {
    const events = recordCreationSeam();
    const seamCommit = commits.getMockImplementation();
    if (!seamCommit) throw new Error('Expected the seam commit');
    const conflict = new W5CommitRefusedError(
      'revision-conflict',
      'A rival decision moved the worktrees collection.',
    );
    commits.mockImplementation(async (input) => {
      if (
        (step === 'promote' && promotesRow(input)) ||
        (step === 'receipt' && input.receipt)
      ) {
        events.push('conflict');
        throw conflict;
      }
      return seamCommit(input);
    });
    await expect(createWorktreeFromSelection(request())).rejects.toBe(conflict);
    const effectsAndPromotion = [
      'reserve',
      'decision:worktree.create.reserve',
      reservationCommit,
      'decision:worktree.create.phase',
      setupCommit,
      'git',
      'setup:worktree.create.promote',
    ];
    expect(events).toEqual(
      step === 'promote'
        ? [
            ...effectsAndPromotion,
            'conflict',
            // The existing setup failure record; no compensating removal.
            'decision:worktree.create.phase',
            setupCommit,
          ]
        : [...effectsAndPromotion, setupCommit, 'conflict'],
    );
    const rows = await readWorkspaceWorktrees('a');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.creation?.state).toBe(
      step === 'promote' ? 'recovery-required' : 'complete',
    );
    const checkout = jest.mocked(git.createWorktree).mock.calls[0]?.[1] ?? '';
    expect(existsSync(join(checkout, '.git'))).toBe(true);
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    events.length = 0;
    await expect(createWorktreeFromSelection(request())).rejects.toMatchObject({
      reason: 'recovery-required',
    });
    expect(events).toEqual([]);
    expect(await readWorkspaceWorktrees('a')).toEqual(rows);
  },
);

it('W6b removes only the reserved incarnation, applying the expected order', async () => {
  const createdAt = '2026-10-24T00:00:00.000Z';
  const rows: WorktreeData[] = [
    { id: 'first', branchName: 'first', createdAt },
    { id: 'reserved', branchName: 'reserved', createdAt },
    { id: 'last', branchName: 'last', createdAt },
  ];
  writeFileSync(
    join(root, 'a', 'worktrees.json'),
    JSON.stringify({ version: 1, worktrees: rows }),
  );
  const target = { workspaceId: 'a', worktreeId: 'reserved', createdAt };
  const removal = {
    kind: 'worktree.create.reservation.remove',
    remainingWorktreeOrder: ['last', 'first'],
    expectedRemainingWorktreeOrder: ['first', 'last'],
  } as const;
  await expect(
    creationPort.applyReservedWorktreeRemoval(
      { ...target, createdAt: 'replacement' },
      jsonRecordRoundTrip(removal),
    ),
  ).resolves.toBe(false);
  await expect(
    creationPort.applyReservedWorktreeRemoval(
      target,
      jsonRecordRoundTrip(removal),
    ),
  ).resolves.toBe(true);
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'last',
    'first',
  ]);
  expect(isWorkspaceWorktreeRecentlyRemoved('a', 'reserved', createdAt)).toBe(
    true,
  );
});

it.each([undefined, 'create-key'])(
  'W6b refuses a checkout path another row reserves with no commit (key %s)',
  async (idempotencyKey) => {
    jest
      .spyOn(animals, 'generateUniqueAnimalName')
      .mockReturnValueOnce('fresh');
    const held: WorktreeData = {
      id: 'held',
      branchName: 'held',
      createdAt: '2026-10-24T00:00:00.000Z',
      setupPhase: 'git-pending',
      creation: {
        operationId: 'held-operation',
        state: 'recovery-required',
        phase: 'git-setup',
        checkouts: [
          { repositoryPath: repo, checkoutPath: getWorktreeDir('a', 'fresh') },
        ],
      },
    };
    writeFileSync(
      join(root, list()),
      JSON.stringify({ version: 1, worktrees: [held] }),
    );
    const before = readFileSync(join(root, list()), 'utf8');
    const released = jest.spyOn(host, 'releaseReservation');
    const marked = jest.spyOn(host, 'markReservationRecoveryRequired');
    const events = recordCreationSeam();
    await expect(
      createWorktreeFromSelection(request({ idempotencyKey })),
    ).rejects.toMatchObject({
      reason: 'checkout-reserved',
      message: 'Checkout path is already in use',
    });
    // The pure apply refuses inside the list update, before its commit.
    expect(events).toEqual([
      ...(idempotencyKey ? ['reserve'] : []),
      'decision:worktree.create.reserve',
    ]);
    expect(readFileSync(join(root, list()), 'utf8')).toBe(before);
    const metadata = getWorktreeDataDir('a', 'fresh');
    if (!idempotencyKey) {
      expect(existsSync(metadata)).toBe(false);
      return;
    }
    // As on base: the metadata reservation already counts as an effect, so
    // the key is held for recovery rather than released.
    expect(released).not.toHaveBeenCalled();
    expect(marked).toHaveBeenCalledWith(
      reservations.mock.calls[0]?.[0].reservationId,
      { operation: 'core.worktree.create', errorName: 'Error' },
    );
    expect(await host.lookupReceipt(receipt())).toMatchObject({
      status: 'recovery-required',
    });
    expect(existsSync(metadata)).toBe(true);
    events.length = 0;
    await expect(
      createWorktreeFromSelection(request({ idempotencyKey })),
    ).rejects.toMatchObject({ reason: 'recovery-required' });
    expect(events).toEqual([]);
    expect(readFileSync(join(root, list()), 'utf8')).toBe(before);
  },
);

it('W6b archives a pending reserved row through the removal decision in the expected order', async () => {
  const createdAt = '2026-10-24T00:00:00.000Z';
  // Tombstones are process-wide; the removal test above holds 'reserved'.
  const pending: WorktreeData = {
    id: 'pending',
    branchName: 'pending',
    createdAt,
    setupPhase: 'git-pending',
    creation: {
      operationId: 'reserved-operation',
      state: 'pending',
      phase: 'reserved',
      checkouts: [
        {
          repositoryPath: repo,
          checkoutPath: getWorktreeDir('a', 'pending'),
        },
      ],
    },
  };
  writeFileSync(
    join(root, list()),
    JSON.stringify({
      version: 1,
      worktrees: [
        { id: 'first', branchName: 'first', createdAt },
        pending,
        { id: 'last', branchName: 'last', createdAt },
      ],
    }),
  );
  const events: unknown[] = [];
  const remove = creationPort.applyReservedWorktreeRemoval;
  jest
    .spyOn(creationPort, 'applyReservedWorktreeRemoval')
    .mockImplementation(async (target, decision) => {
      const removed = await remove(
        jsonRecordRoundTrip(target),
        jsonRecordRoundTrip(decision),
      );
      events.push({ target, decision, removed });
      return removed;
    });
  commits.mockImplementation(async (input) => {
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
  await expect(
    archiveWorktree({
      workspaceId: 'a',
      worktreeId: 'pending',
      source: 'single_repo',
      expectedCreatedAt: createdAt,
      expectedRevision: 0,
      deleteWithoutRetentionIfMissing: true,
      remainingWorktreeOrder: ['last', 'first'],
      expectedRemainingWorktreeOrder: ['first', 'last'],
    }),
  ).resolves.toEqual({ status: 'archived', success: true, warnings: [] });
  // Base commits the same single row removal under the caller's revision.
  expect(events).toEqual([
    {
      target: { workspaceId: 'a', worktreeId: 'pending', createdAt },
      decision: {
        kind: 'worktree.create.reservation.remove',
        remainingWorktreeOrder: ['last', 'first'],
        expectedRemainingWorktreeOrder: ['first', 'last'],
      },
      removed: true,
    },
    {
      operation: 'core.worktree.archive',
      files: [list()],
      receipt: false,
      expectedRevisions: [
        {
          resource: {
            kind: 'worktree',
            workspaceId: 'a',
            worktreeId: 'pending',
          },
          revision: 0,
        },
      ],
    },
  ]);
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'last',
    'first',
  ]);
  expect(isWorkspaceWorktreeRecentlyRemoved('a', 'pending', createdAt)).toBe(
    true,
  );
});

it('W6b archives a pending deferred create mid-Git through the removal decision, then cancels its setup', async () => {
  const createdAt = '2026-10-24T00:00:00.000Z';
  writeFileSync(
    join(root, list()),
    JSON.stringify({
      version: 1,
      worktrees: [
        { id: 'first', branchName: 'first', createdAt },
        { id: 'last', branchName: 'last', createdAt },
      ],
    }),
  );
  const remove = creationPort.applyReservedWorktreeRemoval;
  const events = recordCreationSeam();
  jest
    .mocked(creationPort.applyReservedWorktreeRemoval)
    .mockImplementation(async (target, decision) => {
      events.push(`decision:${decision.kind}`);
      const removed = await remove(target, jsonRecordRoundTrip(decision));
      events.push({ removed, decision });
      return removed;
    });
  const seamGit = jest.mocked(git.createWorktree).getMockImplementation();
  if (!seamGit) throw new Error('Expected the seam Git spy');
  let reachGit: () => void = () => {};
  const gitReached = new Promise<void>((resolve) => {
    reachGit = resolve;
  });
  let releaseGit: () => void = () => {};
  const gitHeld = new Promise<void>((resolve) => {
    releaseGit = resolve;
  });
  jest.mocked(git.createWorktree).mockImplementation(async (...args) => {
    reachGit();
    await gitHeld;
    return seamGit(...args);
  });
  let settle: (outcome: string) => void = () => {};
  const settled = new Promise<string>((resolve) => {
    settle = resolve;
  });
  const created = await createWorktreeFromSelection(
    request({
      idempotencyKey: undefined,
      deferGitSetup: true,
      onGitSetupSettled: ({ outcome }) => settle(outcome),
    }),
  );
  if (created.status !== 'created') throw new Error('Expected a created row');
  const { worktreeId } = created.record;
  await gitReached;
  const [pending] = await readWorkspaceWorktrees('a');
  expect(pending).toMatchObject({
    id: worktreeId,
    setupPhase: 'git-pending',
    creation: { state: 'pending', phase: 'git-setup' },
  });
  await expect(
    archiveWorktree({
      workspaceId: 'a',
      worktreeId,
      source: 'single_repo',
      expectedCreatedAt: pending?.createdAt,
      deleteWithoutRetentionIfMissing: true,
      remainingWorktreeOrder: ['last', 'first'],
      expectedRemainingWorktreeOrder: ['first', 'last'],
    }),
  ).resolves.toEqual({ status: 'archived', success: true, warnings: [] });
  releaseGit();
  await expect(settled).resolves.toBe('cancelled');
  expect(events).toEqual([
    'decision:worktree.create.reserve',
    reservationCommit,
    'decision:worktree.create.phase',
    setupCommit,
    'decision:worktree.create.reservation.remove',
    {
      removed: true,
      decision: {
        kind: 'worktree.create.reservation.remove',
        remainingWorktreeOrder: ['last', 'first'],
        expectedRemainingWorktreeOrder: ['first', 'last'],
      },
    },
    { operation: 'core.worktree.archive', files: [list()], receipt: false },
    // The held add runs after the archive; cancellation records nothing.
    'git',
  ]);
  expect((await readWorkspaceWorktrees('a')).map((row) => row.id)).toEqual([
    'last',
    'first',
  ]);
  expect(
    isWorkspaceWorktreeRecentlyRemoved('a', worktreeId, pending?.createdAt),
  ).toBe(true);
  expect(existsSync(getWorktreeDir('a', worktreeId))).toBe(false);
});
