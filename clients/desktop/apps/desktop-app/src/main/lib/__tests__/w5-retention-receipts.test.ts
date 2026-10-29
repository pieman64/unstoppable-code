// CAN-4613: in-process retention, real W5 worker and real archive lock.
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import {
  W5CommitLog,
  type W5CommitRequest,
} from '@canopy/desktop-shared/node/w5-commit-log';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import { startedWorkers } from '../../ledger/__tests__/fixtures/tsx-worker-threads';
jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
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

import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import {
  createW5CommitLogFileStore,
  __setDesktopW5FileStoreForTests,
  W5FileWriteRefusedError,
  W5RevisionConflictError,
} from '../w5-commit-log-file-store';
import { nodeW5FileStore } from '../w5-file-store';
import { __resetSidebarItemsStateForTests } from '../sidebar-items';
import { updateWorkspaceConfig } from '../workspace-persistence';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import {
  updateWorkspaceRetention,
  type WorkspaceRetentionPatch,
  type WorkspaceRetentionUpdateOutcome,
} from '../workspace-retention';
import {
  withArchivedWorkspaceOperationLock,
  isArchivedWorkspaceOperationLockHeld,
} from '../archived-containers';
import * as activity from '../workspace-activity';
import { recordLocalWorktreeReplica } from '../worktree-replica-record';
import { recordWorktreeActivity } from '../worktree-observer-records';
import * as splitLocks from '../../services/split-lock-service';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let commits: jest.SpiedFunction<W5CommitLogHost['commit']>;
let reserve: jest.SpiedFunction<W5CommitLogHost['reserve']>;
let callCommit: W5CommitLogHost['commit'];
let callReserve: W5CommitLogHost['reserve'];
let store: ReturnType<typeof createW5CommitLogFileStore>;
let originalDataDir: string | undefined;
const OPERATION = 'core.workspace.retention.update';
const RESOURCE = { kind: 'workspace', workspaceId: 'a' } as const;
const ENABLE = { archiveRetentionDays: 30, autoArchiveDays: 7 };
const RESULT = { workspaceId: 'a', activityBaselineRecorded: true };
const REPLAY = { status: 'replay', outcome: RESULT };
const ONE = { kind: 'worktree', workspaceId: 'a', worktreeId: 'one' } as const;
const MEMBERS = { kind: 'worktrees', workspaceId: 'a' } as const;
const PAST_ACTIVITY = '2000-01-01T00:00:00.000Z';
const FUTURE_ACTIVITY = '2099-01-01T00:00:00.000Z';
const manifestPath = (): string => join(root, 'a', 'workspace.json');
const listPath = (): string => join(root, 'a', 'worktrees.json');
function startHost(
  workerEntry = join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry,
  });
  callCommit = host.commit.bind(host);
  callReserve = host.reserve.bind(host);
  commits = jest.spyOn(host, 'commit');
  reserve = jest.spyOn(host, 'reserve');
  store = createW5CommitLogFileStore(() => host);
  __setDesktopW5FileStoreForTests(store);
  __resetSidebarItemsStateForTests();
}
beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) =>
    ['one', 'future']
      .map((id) => ({
        id,
        branchName: id,
        createdAt,
        lastTouchedAt: id === 'one' ? PAST_ACTIVITY : FUTURE_ACTIVITY,
      }))
      .map((row) => ({
        ...row,
        // Materialize identity once, so restoring the canonical image also
        // restores the same identity for compatibility byte comparisons.
        replica: recordLocalWorktreeReplica('a', row, {
          authorityId: 'local-desktop',
          targetId: 'in_process_worker',
          repoIds: [],
        }),
      })),
  ));
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
});
afterEach(async () => {
  jest.restoreAllMocks();
  activity.resetWorkspaceActivityForTests();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});
async function restartHost(): Promise<void> {
  await host.shutdown();
  startHost();
}
function images(): Array<string | null> {
  return [join(root, 'index.json'), manifestPath(), listPath()].map((path) =>
    existsSync(path) ? readFileSync(path, 'utf8') : null,
  );
}
function update(
  patch: WorkspaceRetentionPatch = ENABLE,
  options: { expectedRevision?: number; idempotencyKey?: string } = {},
): Promise<WorkspaceRetentionUpdateOutcome> {
  return updateWorkspaceRetention({
    ...options,
    workspaceId: 'a',
    patch,
    source: 'workspace_settings',
  });
}
function keyedEnable(
  expectedRevision?: number,
): Promise<WorkspaceRetentionUpdateOutcome> {
  return update(ENABLE, { idempotencyKey: 'key', expectedRevision });
}
async function revisions(): Promise<number[]> {
  return Promise.all([host.revision(RESOURCE), host.revision(ONE)]);
}
function receiptOf(
  reservation = reserve,
): NonNullable<W5CommitRequest['receipt']> {
  const receipt = reservation.mock.calls[0]?.[0].receipt;
  if (!receipt) throw new Error('Expected a reservation');
  return receipt;
}
async function expectReceipt(expected: object): Promise<void> {
  expect(await host.lookupReceipt(receiptOf())).toMatchObject(expected);
}
async function expectRefusal(
  attempt: Promise<unknown>,
  reason: string,
): Promise<void> {
  await expect(attempt).rejects.toMatchObject({ reason });
}
async function expectCanonicalState(
  bytes: Array<string | null>,
  expectedRevisions: number[],
): Promise<void> {
  expect(images()).toEqual(bytes);
  expect(await revisions()).toEqual(expectedRevisions);
}
async function expectReleased(): Promise<void> {
  expect(await revisions()).toEqual([0, 0]);
  await expectReceipt({ status: 'none' });
  expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
}
async function expectNoDecision(before: Array<string | null>): Promise<void> {
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();
  await expectReleased();
}
async function expectOfflineReservation(): Promise<void> {
  await host.shutdown();
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  // Offline diagnosis lists unresolved journals, not applied decisions.
  expect(diagnosis.commits).toEqual([]);
  expect(diagnosis.reservations).toHaveLength(1);
  expect(diagnosis.reservations[0]).toMatchObject({
    state: 'recovery-required',
  });
}
function withOfflineLog(work: (log: W5CommitLog) => void): void {
  const log = W5CommitLog.open(dbPath);
  try {
    work(log);
  } finally {
    log.close();
  }
}
async function authorizeCommitRecovery(
  before: Array<string | null>,
  absent: boolean,
): Promise<void> {
  commits.mockImplementationOnce((request) => {
    // After main preflight: the real worker saves the decision but refuses
    // application, leaving a commit journal rather than a retry reservation.
    writeFileSync(manifestPath(), `${before[1]}\n`);
    return callCommit(request);
  });
  await expectRefusal(keyedEnable(), 'recovery-required');
  expect(images()).toEqual([before[0], `${before[1]}\n`, before[2]]);
  expect(await revisions()).toEqual([1, absent ? 0 : 1]);
  await expectReceipt({ status: 'commit-recovery-required' });
  expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
  await restartHost();
  await expectRefusal(keyedEnable(), 'recovery-required');
  await host.shutdown();
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  expect(diagnosis.commits).toHaveLength(1);
  expect(diagnosis.commits[0]?.state).toBe('recovery-required');
  expect(diagnosis.reservations).toEqual([]);
  // Authorized offline repair restores only the conflicted preimage.
  writeFileSync(manifestPath(), before[1] ?? '');
  withOfflineLog((cold) => {
    const id = diagnosis.commits[0]?.commitId;
    if (id === undefined) throw new Error('Missing recovery commit');
    cold.retryRecoveryRequiredCommit(id);
  });
}
function gate(): { ready: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { ready, release };
}

it('commits baseline and setting in one decision, then replays without a write', async () => {
  expect(await keyedEnable(0)).toEqual(RESULT);
  expect(commits).toHaveBeenCalledTimes(1);
  const decision = commits.mock.calls[0]?.[0];
  expect(decision).toMatchObject({
    operation: OPERATION,
    outcome: RESULT,
    expectedRevisions: [{ resource: RESOURCE, revision: 0 }],
  });
  expect(decision?.files.map((file) => file.path).sort()).toEqual(
    [manifestPath(), listPath()].sort(),
  );
  expect(await revisions()).toEqual([1, 1]);
  // Membership and the untouched future watermark do not advance.
  expect(await host.revision(MEMBERS)).toBe(0);
  expect(await host.revision({ ...ONE, worktreeId: 'future' })).toBe(0);
  await expectReceipt(REPLAY);
  expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
  const before = images();
  expect(await keyedEnable(999)).toEqual(RESULT);
  await expectCanonicalState(before, [1, 1]);
  expect(commits).toHaveBeenCalledTimes(1);
});

it('replays a lost response before and after restart, preserving a later setting and its bytes', async () => {
  commits.mockImplementationOnce(async (request) => {
    await callCommit(request);
    throw new Error('response lost');
  });
  await expect(keyedEnable()).rejects.toThrow('response lost');
  expect(await revisions()).toEqual([1, 1]);
  await expectReceipt(REPLAY);
  await update({ archiveRetentionDays: null, autoArchiveDays: null });
  const before = images();
  const beforeRevisions = await revisions();
  for (const restart of [false, true]) {
    if (restart) await restartHost();
    commits.mockClear();
    expect(await keyedEnable(0)).toEqual(RESULT);
    expect(commits).not.toHaveBeenCalled();
    await expectCanonicalState(before, beforeRevisions);
    expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
  }
});

it.each([
  { archiveRetentionDays: 31, autoArchiveDays: 7 },
  { archiveRetentionDays: 30, autoArchiveDays: 8 },
  { ...ENABLE, autoArchiveDeleteBranch: true },
])('refuses changed semantic parameters: %j', async (patch) => {
  await keyedEnable();
  const before = images();
  await expectRefusal(update(patch, { idempotencyKey: 'key' }), 'key-reused');
  await expectCanonicalState(before, [1, 1]);
});

it('binds the saved setting to the parameters admitted before awaiting reservation', async () => {
  const request = {
    workspaceId: 'a',
    patch: { ...ENABLE },
    source: 'workspace_settings' as const,
    idempotencyKey: 'key',
    expectedRevision: 0,
  };
  reserve.mockImplementationOnce(async (reservation) => {
    await callReserve(reservation);
    request.patch.autoArchiveDays = 60;
    request.expectedRevision = 99;
  });
  expect(await updateWorkspaceRetention(request)).toEqual(RESULT);
  expect(images()[1]).toContain('"autoArchiveDays": 7');
  expect(await revisions()).toEqual([1, 1]);
  await expectReceipt(REPLAY);
  const before = images();
  expect(await keyedEnable()).toEqual(RESULT);
  await expect(
    update(request.patch, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'key-reused' });
  expect(images()).toEqual(before);
});

it('refuses stale workspace revisions and releases the key, including a decision-time conflict', async () => {
  const before = images();
  for (const idempotencyKey of [undefined, 'key']) {
    await expect(
      update(ENABLE, { idempotencyKey, expectedRevision: 1 }),
    ).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expectCanonicalState(before, [0, 0]);
  }
  await expectReceipt({ status: 'none' });
  jest.spyOn(host, 'revision').mockResolvedValueOnce(1);
  await expect(keyedEnable(1)).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(images()).toEqual(before);
  await expectReleased();
  expect(await keyedEnable(0)).toEqual(RESULT);
});

it.each([
  ['workspace.json', 'present'],
  ['worktrees.json', 'present'],
  ['worktrees.json', 'fresh'],
  ['worktrees.json', 'empty'],
  ['worktrees.json', 'absent'],
] as const)(
  'a preflight conflict in %s commits neither image (baseline=%s)',
  async (file, baseline) => {
    if (baseline === 'fresh') {
      writeFileSync(
        listPath(),
        readFileSync(listPath(), 'utf8').replace('2000-01-01', '2099-01-01'),
      );
    }
    if (baseline === 'empty')
      writeFileSync(listPath(), '{"version":1,"worktrees":[]}');
    if (baseline === 'absent') rmSync(listPath());
    const before = images();
    const replace = store.replace.bind(store);
    let conflicted = false;
    const preimage =
      before[file === 'workspace.json' ? 1 : 2] ??
      '{"version":1,"worktrees":[]}';
    const foreign = `${preimage}\n`;
    const spy = jest
      .spyOn(store, 'replace')
      .mockImplementation(async (...args) => {
        await replace(...args);
        // Both images are staged when the manifest replacement returns. Change
        // one canonical file before the final decision preflight reads either.
        if (!conflicted && args[0] === manifestPath()) {
          conflicted = true;
          writeFileSync(join(root, 'a', file), foreign);
        }
      });
    await expect(keyedEnable()).rejects.toBeInstanceOf(W5FileWriteRefusedError);
    expect(conflicted).toBe(true);
    const expected = [...before];
    expected[file === 'workspace.json' ? 1 : 2] = foreign;
    await expectNoDecision(expected);
    spy.mockRestore();
    // Unchanged guards must not replace even a read-only list file.
    if (baseline !== 'present') chmodSync(listPath(), 0o444);
    const { ino, mode, mtimeMs } = statSync(listPath());
    expect(await keyedEnable()).toEqual(RESULT);
    if (baseline !== 'present') {
      expect(statSync(listPath())).toMatchObject({ ino, mode, mtimeMs });
      expect(readFileSync(listPath(), 'utf8')).toBe(foreign);
      expect(await revisions()).toEqual([1, 0]);
      expect(await host.revision(MEMBERS)).toBe(0);
      expect(commits.mock.calls[0]?.[0].files).toContainEqual(
        expect.objectContaining({ path: listPath(), contents: foreign }),
      );
    }
  },
);

it.each([
  ['cowork', 'manifest', 'unsupported-for-cowork'],
  ['missing', 'manifest', 'not-found'],
  ['unreadable', 'manifest', 'configuration-unavailable'],
  ['unreadable', 'list', 'configuration-unavailable'],
  ['partial', 'list', 'configuration-unavailable'],
  ['mixed', 'list', 'configuration-unavailable'],
] as const)(
  'refuses %s %s before deciding and releases its key',
  async (kind, file, reason) => {
    const path = file === 'manifest' ? manifestPath() : listPath();
    const original = readFileSync(path, 'utf8');
    const corrupt = {
      cowork: original.replace('single-repo', 'cowork'),
      unreadable: '{',
      partial: '{"version":1,"worktrees":[{"id":"broken"}]}',
      mixed: original.replace('"worktrees":[', '"worktrees":[{"id":"broken"},'),
    };
    if (kind === 'missing') rmSync(path);
    else writeFileSync(path, corrupt[kind]);
    const before = images();
    if (kind === 'partial' || kind === 'mixed')
      expect(before[2]).toContain('"id":"broken"');
    await expectRefusal(keyedEnable(), reason);
    await expectNoDecision(before);
    writeFileSync(path, original);
    expect(await keyedEnable()).toEqual(RESULT);
  },
);

it('aborts even a staged baseline on stamp failure; unknown failure retains diagnosed recovery state', async () => {
  const before = images();
  const stamp = activity.touchAllWorkspaceTargets;
  jest
    .spyOn(activity, 'touchAllWorkspaceTargets')
    .mockImplementationOnce(async (...args) => {
      await stamp(...args);
      throw Object.assign(new Error('stamp failed'), { code: 'EIO' });
    });
  await expect(keyedEnable()).rejects.toThrow('stamp failed');
  await expectCanonicalState(before, [0, 0]);
  expect(commits).not.toHaveBeenCalled();
  await expectReceipt({
    status: 'recovery-required',
    diagnostics: { operation: OPERATION, errorCode: 'EIO' },
  });
  await expectOfflineReservation();
  startHost();
  await expectRefusal(keyedEnable(), 'recovery-required');
  expect(images()).toEqual(before);
});

it('releases the retry key when the real retention lease is busy', async () => {
  const before = images();
  const release = splitLocks.acquireWorkspaceArchiveRetentionLease('a');
  try {
    await expect(keyedEnable()).rejects.toThrow(
      'Cannot change deletion retention',
    );
  } finally {
    release();
  }
  await expectNoDecision(before);
  expect(await keyedEnable()).toEqual(RESULT);
});

it.each([false, true])(
  'offline resolution after pre-decision worker death (intervening write=%s)',
  async (intervening) => {
    const before = images();
    commits.mockImplementationOnce(async () => {
      await host.shutdown();
      throw new Error('worker died before decision');
    });
    jest
      .spyOn(host, 'markReservationRecoveryRequired')
      .mockRejectedValueOnce(new Error('process died'));
    await expect(keyedEnable(0)).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    expect(images()).toEqual(before);
    await restartHost();
    expect(await revisions()).toEqual([0, 0]);
    await expectRefusal(keyedEnable(), 'recovery-required');
    if (intervening) await update({ archiveRetentionDays: 14 });
    const retryBefore = images();
    await expectOfflineReservation();
    withOfflineLog((cold) => {
      for (const reservation of cold.listReservations())
        cold.resolveRecovery(reservation.reservationId);
    });
    startHost();
    expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
    if (intervening) {
      await expect(keyedEnable(0)).rejects.toBeInstanceOf(
        W5RevisionConflictError,
      );
      await expectCanonicalState(retryBefore, [1, 0]);
      expect(commits).not.toHaveBeenCalled();
    }
    expect(await keyedEnable(intervening ? 1 : 0)).toEqual(RESULT);
    const applied = images();
    expect(await keyedEnable()).toEqual(RESULT);
    expect(commits).toHaveBeenCalledTimes(1);
    await expectCanonicalState(applied, [intervening ? 2 : 1, 1]);
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'survives worker death during retention application (offline recovery=%s, absent list=%s)',
  async (offlineRecovery, absent) => {
    if (absent) rmSync(listPath());
    const before = images();
    const expectedRevisions = [1, absent ? 0 : 1];
    const workerEntry = join(
      __dirname,
      'fixtures/retention-interrupted-worker.ts',
    );
    if (!offlineRecovery) {
      await host.shutdown();
      startHost(workerEntry);
      commits.mockImplementationOnce(async (request) => {
        try {
          return await callCommit(request);
        } finally {
          // Freeze the crashed worker's files before failure bookkeeping can
          // launch another worker and resume the pending decision.
          await host.shutdown();
        }
      });
    }
    const initial = { commits, reserve };
    if (offlineRecovery) await authorizeCommitRecovery(before, absent);
    if (offlineRecovery) startHost(workerEntry);
    const workerCount = startedWorkers.length;
    // The real worker exits after the first durable image. Startup recovery
    // fails before a request is sent; first application loses its response.
    await expect(keyedEnable()).rejects.toMatchObject({
      reason: offlineRecovery ? 'unavailable' : 'outcome-unknown',
    });
    await host.shutdown();
    expect(startedWorkers.slice(workerCount)).toMatchObject([
      { filename: workerEntry, exitCode: 86 },
    ]);
    const decision = initial.commits.mock.calls[0]?.[0];
    const receipt = receiptOf(initial.reserve);
    const stamped = decision?.files.find((file) => file.path === listPath());
    if (!stamped) throw new Error('Missing list dependency');
    withOfflineLog((interrupted) => {
      const pending = interrupted.listPendingCommits();
      expect(pending).toHaveLength(1);
      expect(pending[0]?.operation).toBe(OPERATION);
      expect(pending[0]?.files).toEqual(decision?.files);
      const manifest = decision?.files.find(
        (file) => file.path === manifestPath(),
      );
      expect(images()).toEqual([before[0], manifest?.contents, before[2]]);
      if (!absent) expect(images()[2]).not.toBe(stamped.contents);
      expect([
        interrupted.revision(RESOURCE),
        interrupted.revision(ONE),
      ]).toEqual(expectedRevisions);
      expect(interrupted.listReservations()).toEqual([]);
      expect(
        interrupted.lookupReceipt(receipt, receipt.fingerprint),
      ).toMatchObject(REPLAY);
    });
    startHost();
    const stamp = jest.spyOn(activity, 'touchAllWorkspaceTargets');
    expect(await keyedEnable()).toEqual(RESULT);
    expect(stamp).not.toHaveBeenCalled();
    expect(commits).not.toHaveBeenCalled();
    expect(images()[2]).toBe(stamped.contents);
    expect(images()[1]).toContain('"autoArchiveDays": 7');
    expect(await revisions()).toEqual(expectedRevisions);
    expect((await host.recoveryReport()).applied).toHaveLength(1);
    expect((await host.recoveryReport()).recoveryRequired).toEqual([]);
    expect((await host.recoveryReport()).reservations ?? []).toEqual([]);
  },
);

it.each(['workspace_manifest', 'worktree_list'] as const)(
  'admits %s before reserving and holds admission through the decision',
  async (namespace) => {
    const reserved = gate();
    const finish = gate();
    reserve.mockImplementationOnce(async (request) => {
      await callReserve(request);
      reserved.release();
      await finish.ready;
    });
    const pending = keyedEnable();
    await reserved.ready;
    const events: string[] = [];
    const changing = withStorageOwnershipChange([namespace], () => {
      events.push('changed');
      expect(images()[1]).toContain('"autoArchiveDays": 7');
    });
    expect(events).toEqual([]);
    finish.release();
    await Promise.all([pending, changing]);
    expect(events).toEqual(['changed']);
  },
);

it('takes the retention lease before the real archive lock, and never takes a manifest lock while waiting for archive', async () => {
  const archiving = gate();
  const finishArchive = gate();
  const leased = gate();
  const events: string[] = [];
  const acquire = splitLocks.acquireWorkspaceArchiveRetentionLease;
  jest
    .spyOn(splitLocks, 'acquireWorkspaceArchiveRetentionLease')
    .mockImplementation((id) => {
      const release = acquire(id);
      events.push('lease');
      leased.release();
      return (): void => {
        events.push('release');
        release();
      };
    });
  const withCommit = store.withCommit.bind(store);
  jest.spyOn(store, 'withCommit').mockImplementation((options, work) => {
    expect(isArchivedWorkspaceOperationLockHeld('a')).toBe(true);
    events.push(options.locks?.map((lock) => lock.kind).join(',') ?? '');
    return withCommit(options, work);
  });
  const archive = withArchivedWorkspaceOperationLock('a', async () => {
    archiving.release();
    await finishArchive.ready;
    // Real contention: archive must be able to acquire the manifest while
    // retention is waiting for the archive lock, not holding its W5 scope.
    await updateWorkspaceConfig('a', (config) => {
      config.autoArchiveDeleteBranch = true;
    });
    events.push('archive finished');
  });
  await archiving.ready;
  const pending = keyedEnable();
  await leased.ready;
  expect(events).toEqual(['lease']);
  finishArchive.release();
  await Promise.all([archive, pending]);
  expect(events).toEqual([
    'lease',
    'archive finished',
    'manifest,list',
    'release',
  ]);
  expect(images()[1]).toContain('"autoArchiveDeleteBranch": true');
  expect(await revisions()).toEqual([2, 1]);
  const release = splitLocks.acquireWorkspaceArchiveRetentionLease('a');
  release();
});

it('holds the real archive and list locks through durable application, letting queued activity finish afterwards', async () => {
  const deciding = gate();
  const finish = gate();
  commits.mockImplementationOnce(async (request) => {
    expect(isArchivedWorkspaceOperationLockHeld('a')).toBe(true);
    deciding.release();
    await finish.ready;
    return callCommit(request);
  });
  const pending = keyedEnable();
  await deciding.ready;
  const events: string[] = [];
  // This writer bypasses the archive lock and must wait on the real list
  // lock retained by the W5 scope, not on an incidental process-wide queue.
  const touching = recordWorktreeActivity({
    source: 'activity_watermark',
    workspaceId: 'a',
    worktreeId: 'one',
    touchedAt: '2090-01-01T00:00:00.000Z',
  }).then(() => {
    events.push('activity');
  });
  const archive = withArchivedWorkspaceOperationLock('a', async () => {
    events.push('archive');
    expect(await host.revision(RESOURCE)).toBe(1);
  });
  expect(events).toEqual([]);
  finish.release();
  await Promise.all([pending, archive, touching]);
  expect(events.slice().sort()).toEqual(['activity', 'archive']);
  expect(readFileSync(listPath(), 'utf8')).toContain(
    '2090-01-01T00:00:00.000Z',
  );
  expect(await revisions()).toEqual([1, 2]);
});

it('preserves unkeyed compatibility bytes, monotonic baselines, unrelated settings and empty lists', async () => {
  await updateWorkspaceConfig('a', (config) => {
    config.privateMemory = true;
  });
  const before = images();
  const stamp = activity.touchAllWorkspaceTargets;
  jest
    .spyOn(activity, 'touchAllWorkspaceTargets')
    .mockImplementation((id) => stamp(id, '2030-01-01T00:00:00.000Z'));
  // Existing compatibility behavior: stamp then save the patch.
  await activity.touchAllWorkspaceTargets('a');
  await updateWorkspaceConfig('a', (config) => {
    config.archiveRetentionDays = ENABLE.archiveRetentionDays;
    config.autoArchiveDays = ENABLE.autoArchiveDays;
  });
  const plain = images();
  writeFileSync(manifestPath(), before[1] ?? '');
  writeFileSync(listPath(), before[2] ?? '');
  commits.mockClear();
  expect(await update()).toEqual(RESULT);
  expect(images()).toEqual(plain);
  expect(readFileSync(listPath(), 'utf8')).toContain(FUTURE_ACTIVITY);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0]).toMatchObject({
    operation: OPERATION,
    receipt: undefined,
    outcome: null,
  });
  const unchanged = images();
  const beforeRevisions = await revisions();
  expect(await update(ENABLE, { idempotencyKey: 'unchanged' })).toEqual({
    workspaceId: 'a',
    activityBaselineRecorded: false,
  });
  await expectCanonicalState(unchanged, beforeRevisions);
  expect(commits.mock.calls[1]?.[0].files).toEqual([
    expect.objectContaining({ path: manifestPath(), contents: unchanged[1] }),
    expect.objectContaining({ path: listPath(), contents: unchanged[2] }),
  ]);
  await update({
    archiveRetentionDays: 0,
    autoArchiveDays: null,
    autoArchiveDeleteBranch: false,
  });
  writeFileSync(listPath(), JSON.stringify({ version: 1, worktrees: [] }));
  const empty = readFileSync(listPath(), 'utf8');
  expect(
    await update({ archiveRetentionDays: null, autoArchiveDays: 1 }),
  ).toEqual(RESULT);
  expect(readFileSync(listPath(), 'utf8')).toBe(empty);
  await update({ archiveRetentionDays: null, autoArchiveDays: null });
  rmSync(listPath());
  const beforeAbsent = await revisions();
  expect(await update()).toEqual(RESULT);
  expect(existsSync(listPath())).toBe(false);
  expect(await revisions()).toEqual(
    beforeAbsent.map((value, index) => (index === 0 ? value + 1 : value)),
  );
});
