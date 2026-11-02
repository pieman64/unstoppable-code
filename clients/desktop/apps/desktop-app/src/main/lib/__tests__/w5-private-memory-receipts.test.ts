// CAN-4391: keyed replay and revisions of core.workspace.privateMemory.update,
// a one-decision boundary, with the real commit-log worker and filesystem.
import {
  createW5BoundaryFixture,
  isW5FinalPreflightRead,
} from './fixtures/w5-boundary-fixture';
import { W5CommitLog } from '@canopy/desktop-shared/node/w5-commit-log';
import { withStorageOwnershipChange } from '@canopy/desktop-shared/node/lib/storage-admission';
import type { WorkspaceOwnerBinding } from '@canopy/desktop-shared/types';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import {
  updateWorkspaceConfig,
  updateWorkspaceOwnership,
} from '../workspace-persistence';
import { diagnoseW5State } from '../w5-maintenance-diagnosis';
import {
  recordOrganizationPrivateMemory,
  updateWorkspacePrivateMemory,
  WorkspacePrivateMemoryRefusedError,
  type WorkspacePrivateMemoryUpdateOutcome,
} from '../workspace-private-memory';

jest.setTimeout(90_000);
let dir: string;
let root: string;
let dbPath: string;
let host: W5CommitLogHost;
let originalDataDir: string | undefined;

const OPERATION = 'core.workspace.privateMemory.update';
const RESOURCE = { kind: 'workspace', workspaceId: 'a' } as const;
const OWNER: WorkspaceOwnerBinding = {
  type: 'organization',
  organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  instanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  bindingGeneration: 1,
};

function startHost(): void {
  host = new W5CommitLogHost({
    dbPath,
    root,
    workerEntry: join(__dirname, '../../w5-commit-log/commit-log-worker.ts'),
  });
  __setDesktopW5FileStoreForTests(createW5CommitLogFileStore(() => host));
  __resetSidebarItemsStateForTests();
}

beforeEach(() => {
  ({ dir, root } = createW5BoundaryFixture());
  dbPath = join(dir, 'data', 'w5', 'commit-log.sqlite');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  startHost();
  jest.clearAllMocks();
});
afterEach(async () => {
  jest.restoreAllMocks();
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

/** The offline resolve an operator runs on a cold log after shutdown. */
async function resolveColdRecovery(): Promise<void> {
  await host.shutdown();
  const cold = W5CommitLog.open(dbPath);
  try {
    for (const reservation of cold.listReservations())
      if (reservation.state === 'recovery-required')
        cold.resolveRecovery(reservation.reservationId);
  } finally {
    cold.close();
  }
  startHost();
}

const manifestPath = (): string => join(root, 'a', 'workspace.json');

function images(): string[] {
  return ['index.json', 'a/workspace.json', 'a/worktrees.json'].map((file) =>
    readFileSync(join(root, file), 'utf8'),
  );
}

function manifest(): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(manifestPath(), 'utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new Error('Expected a manifest object');
  return { ...parsed };
}

function setPrivateMemory(
  privateMemory: boolean,
  options: { expectedRevision?: number; idempotencyKey?: string } = {},
): Promise<WorkspacePrivateMemoryUpdateOutcome> {
  return updateWorkspacePrivateMemory({
    ...options,
    workspaceId: 'a',
    privateMemory,
    source: 'workspace_settings',
  });
}

function revision(): Promise<number> {
  return host.revision(RESOURCE);
}

function receiptOf(reserve: {
  mock: { calls: ReadonlyArray<Parameters<W5CommitLogHost['reserve']>> };
}): NonNullable<Parameters<W5CommitLogHost['reserve']>[0]['receipt']> {
  const receipt = reserve.mock.calls[0]?.[0].receipt;
  if (!receipt) throw new Error('Expected a reservation');
  return receipt;
}

/** A foreign manifest write between staging and the decision's preflight. */
function armPreflightForeignWrite(): {
  fired: () => number;
  restore: () => void;
} {
  const read = nodeW5FileStore.read.bind(nodeW5FileStore);
  let fired = 0;
  const spy = jest.spyOn(nodeW5FileStore, 'read');
  spy.mockImplementation(async (path) => {
    if (
      fired === 0 &&
      path === manifestPath() &&
      isW5FinalPreflightRead(new Error().stack ?? '')
    ) {
      fired += 1;
      writeFileSync(
        path,
        JSON.stringify({ ...manifest(), foreignField: 'foreign-write' }),
      );
    }
    return read(path);
  });
  return { fired: () => fired, restore: () => spy.mockRestore() };
}

/** The decision request fails as if the worker died before deciding. */
function failBeforeDecision(): void {
  jest.spyOn(host, 'commit').mockImplementation(async () => {
    await host.shutdown();
    throw new Error('worker died before decision');
  });
  // The process dies too, before it can mark its reservation.
  jest
    .spyOn(host, 'markReservationRecoveryRequired')
    .mockRejectedValue(new Error('process died'));
}

it('saves the change, revision, receipt and outcome in one decision and replays it without a write', async () => {
  const commits = jest.spyOn(host, 'commit');
  const first = await setPrivateMemory(true, {
    idempotencyKey: 'key',
    expectedRevision: 0,
  });
  expect(first).toEqual({ workspaceId: 'a', privateMemory: true });
  expect(commits).toHaveBeenCalledTimes(1);
  const [decision] = commits.mock.calls[0] ?? [];
  expect(decision).toMatchObject({
    operation: OPERATION,
    receipt: {
      caller: 'desktop-host:workspace_settings',
      operation: OPERATION,
    },
    expectedRevisions: [{ resource: RESOURCE, revision: 0 }],
    outcome: { workspaceId: 'a', privateMemory: true },
  });
  expect(typeof decision?.reservationId).toBe('string');
  expect(decision?.files.map((file) => file.path)).toEqual([manifestPath()]);
  expect(JSON.stringify(decision?.outcome)).not.toContain(dir);
  expect(manifest().privateMemory).toBe(true);
  expect(await revision()).toBe(1);

  const before = images();
  // Replay precedes the revision check: a stale revision still replays.
  expect(
    await setPrivateMemory(true, {
      idempotencyKey: 'key',
      expectedRevision: 999,
    }),
  ).toEqual(first);
  expect(images()).toEqual(before);
  expect(commits).toHaveBeenCalledTimes(1);
});

it('replays after the worker restarts without undoing a later change', async () => {
  const first = await setPrivateMemory(true, { idempotencyKey: 'key' });
  await setPrivateMemory(false);
  await restartHost();
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual(
    first,
  );
  expect(images()).toEqual(before);
  expect(manifest().privateMemory).toBe(false);
  expect(commits).not.toHaveBeenCalled();
});

it('refuses changed parameters for a used key with unchanged bytes', async () => {
  await setPrivateMemory(true, { idempotencyKey: 'key' });
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  await expect(
    setPrivateMemory(false, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'key-reused' });
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();
});

it('refuses a stale revision with unchanged bytes and releases the key', async () => {
  const before = images();
  for (const idempotencyKey of [undefined, 'key']) {
    const pending = setPrivateMemory(true, {
      idempotencyKey,
      expectedRevision: 1,
    });
    await expect(pending).rejects.toBeInstanceOf(W5RevisionConflictError);
    await expect(pending).rejects.toMatchObject({
      resource: 'workspace:a',
      expected: 1,
      actual: 0,
    });
    expect(images()).toEqual(before);
  }
  expect(await revision()).toBe(0);
  await setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision: 0 });
  expect(manifest().privateMemory).toBe(true);
  expect(await revision()).toBe(1);
});

it('releases the key when the decision itself refuses a stale revision', async () => {
  const before = images();
  // The preflight passes; the worker's decision sees the newer revision.
  jest.spyOn(host, 'revision').mockResolvedValueOnce(1);
  const commits = jest.spyOn(host, 'commit');
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision: 1 }),
  ).rejects.toBeInstanceOf(W5RevisionConflictError);
  expect(commits).toHaveBeenCalledTimes(1);
  expect(images()).toEqual(before);
  expect(await revision()).toBe(0);
  await setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision: 0 });
  expect(await revision()).toBe(1);
});

it('releases the key on a preflight conflict and keeps the foreign write', async () => {
  const reserve = jest.spyOn(host, 'reserve');
  const commits = jest.spyOn(host, 'commit');
  const armed = armPreflightForeignWrite();
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toBeInstanceOf(W5FileWriteRefusedError);
  expect(armed.fired()).toBe(1);
  expect(commits).not.toHaveBeenCalled();
  expect(manifest()).toMatchObject({ foreignField: 'foreign-write' });
  expect(manifest()).not.toHaveProperty('privateMemory');
  expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
    status: 'none',
  });
  expect(await revision()).toBe(0);

  armed.restore();
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(manifest()).toMatchObject({
    foreignField: 'foreign-write',
    privateMemory: true,
  });
});

it('refuses a local change under an organization policy, read in the manifest queue, and releases the key', async () => {
  await updateWorkspaceOwnership('a', () => ({ owner: OWNER }));
  const reserve = jest.spyOn(host, 'reserve');
  const commits = jest.spyOn(host, 'commit');
  // The policy lands in the queue ahead of the keyed change.
  const organization = recordOrganizationPrivateMemory({
    workspaceId: 'a',
    organizationId: OWNER.organizationId,
    projectId: OWNER.projectId,
    privateMemory: false,
  });
  const local = setPrivateMemory(true, { idempotencyKey: 'key' });
  await expect(organization).resolves.toBe(true);
  await expect(local).rejects.toBeInstanceOf(
    WorkspacePrivateMemoryRefusedError,
  );
  await expect(local).rejects.toMatchObject({
    reason: 'managed-by-organization',
  });
  expect(manifest()).toMatchObject({
    privateMemory: false,
    privateMemoryManagedBy: 'organization',
  });
  // Only the organization record decided.
  expect(commits.mock.calls.map(([request]) => request.receipt)).toEqual([
    undefined,
  ]);
  expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
    status: 'none',
  });

  // Once the marker is gone, the same key applies.
  const unmanaged = manifest();
  delete unmanaged.privateMemoryManagedBy;
  writeFileSync(manifestPath(), JSON.stringify(unmanaged));
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(manifest().privateMemory).toBe(true);
});

it('refuses an organization policy recorded after its reservation, before the manifest queue read', async () => {
  await updateWorkspaceOwnership('a', () => ({ owner: OWNER }));
  const reserve = host.reserve.bind(host);
  const reserved = jest
    .spyOn(host, 'reserve')
    .mockImplementationOnce(async (input) => {
      await reserve(input);
      await expect(
        recordOrganizationPrivateMemory({
          workspaceId: 'a',
          organizationId: OWNER.organizationId,
          projectId: OWNER.projectId,
          privateMemory: false,
        }),
      ).resolves.toBe(true);
    });
  const commits = jest.spyOn(host, 'commit');
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'managed-by-organization' });
  expect(manifest()).toMatchObject({
    privateMemory: false,
    privateMemoryManagedBy: 'organization',
  });
  expect(commits.mock.calls.map(([request]) => request.receipt)).toEqual([
    undefined,
  ]);
  expect(await host.lookupReceipt(receiptOf(reserved))).toMatchObject({
    status: 'none',
  });
});

it('refuses an unindexed workspace before reserving its key', async () => {
  const index = readFileSync(join(root, 'index.json'), 'utf8');
  writeFileSync(
    join(root, 'index.json'),
    JSON.stringify({ version: 1, workspaces: [] }),
  );
  const reserve = jest.spyOn(host, 'reserve');
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'not-found' });
  expect(reserve).not.toHaveBeenCalled();
  writeFileSync(join(root, 'index.json'), index);
  await setPrivateMemory(true, { idempotencyKey: 'key' });
  expect(manifest().privateMemory).toBe(true);
});

it('refuses a malformed manifest, leaves it as it is and releases the key', async () => {
  const original = readFileSync(manifestPath(), 'utf8');
  writeFileSync(manifestPath(), '{"vers');
  const reserve = jest.spyOn(host, 'reserve');
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'configuration-unavailable' });
  expect(readFileSync(manifestPath(), 'utf8')).toBe('{"vers');
  expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
    status: 'none',
  });
  writeFileSync(manifestPath(), original);
  await setPrivateMemory(true, { idempotencyKey: 'key' });
  expect(manifest().privateMemory).toBe(true);
});

it('without a key writes the same bytes as the plain manifest write, with no receipt', async () => {
  const original = readFileSync(manifestPath(), 'utf8');
  // Today's write: the guarded manifest read-modify-write alone.
  await updateWorkspaceConfig('a', (config): void => {
    config.privateMemory = true;
  });
  const plain = readFileSync(manifestPath(), 'utf8');
  writeFileSync(manifestPath(), original);

  const commits = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true)).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(readFileSync(manifestPath(), 'utf8')).toBe(plain);
  expect(commits).toHaveBeenCalledTimes(1);
  // Only the commit's name changes, from the plain manifest write's.
  expect(commits.mock.calls[0]?.[0]).toMatchObject({
    operation: OPERATION,
    receipt: undefined,
    reservationId: undefined,
    expectedRevisions: undefined,
    outcome: null,
  });
  // The same change again writes nothing and makes no decision.
  await setPrivateMemory(true);
  expect(commits).toHaveBeenCalledTimes(1);
});

it('checks a current revision without a key and advances it', async () => {
  const commits = jest.spyOn(host, 'commit');
  await setPrivateMemory(true, { expectedRevision: 0 });
  expect(commits.mock.calls[0]?.[0]).toMatchObject({
    receipt: undefined,
    expectedRevisions: [{ resource: RESOURCE, revision: 0 }],
  });
  expect(manifest().privateMemory).toBe(true);
  expect(await revision()).toBe(1);
});

it('saves a keyed unchanged choice as a receipt-only decision and replays it', async () => {
  await setPrivateMemory(true);
  const before = images();
  const commits = jest.spyOn(host, 'commit');
  const outcome = await setPrivateMemory(true, {
    idempotencyKey: 'key',
    expectedRevision: 1,
  });
  expect(outcome).toEqual({ workspaceId: 'a', privateMemory: true });
  expect(commits).toHaveBeenCalledTimes(1);
  expect(commits.mock.calls[0]?.[0].files).toEqual([]);
  expect(images()).toEqual(before);
  expect(await revision()).toBe(1);
  await restartHost();
  const restarted = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual(
    outcome,
  );
  expect(restarted).not.toHaveBeenCalled();
  expect(images()).toEqual(before);
});

it('holds manifest storage admission from operation entry until it settles', async () => {
  const reserve = host.reserve.bind(host);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reserving: () => void = () => {};
  const reservingStarted = new Promise<void>((resolve) => {
    reserving = resolve;
  });
  // Held before any write: the reservation precedes staging.
  jest.spyOn(host, 'reserve').mockImplementationOnce(async (input) => {
    reserving();
    await gate;
    return reserve(input);
  });
  const events: string[] = [];
  const pending = setPrivateMemory(true, { idempotencyKey: 'key' });
  await reservingStarted;
  const change = withStorageOwnershipChange(['workspace_manifest'], () => {
    events.push(
      `ownership change, applied=${String(manifest().privateMemory)}`,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(events).toEqual([]);
  release();
  await Promise.all([pending, change]);
  expect(events).toEqual(['ownership change, applied=true']);
});

it('refuses a same-key attempt while the first is deciding, then replays it', async () => {
  const commit = host.commit.bind(host);
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let deciding: () => void = () => {};
  const decidingStarted = new Promise<void>((resolve) => {
    deciding = resolve;
  });
  jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
    deciding();
    await gate;
    return commit(request);
  });
  const first = setPrivateMemory(true, { idempotencyKey: 'key' });
  await decidingStarted;
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'in-progress' });
  release();
  const outcome = await first;
  const before = images();
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual(
    outcome,
  );
  expect(images()).toEqual(before);
});

it('X6a: replays a decision whose response was lost, before and after a restart', async () => {
  const commit = host.commit.bind(host);
  const commits = jest
    .spyOn(host, 'commit')
    .mockImplementationOnce(async (request) => {
      await commit(request);
      throw new Error('response lost');
    });
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toThrow('response lost');
  expect(manifest().privateMemory).toBe(true);
  expect(await revision()).toBe(1);
  // A later unkeyed change the replays must not undo.
  await setPrivateMemory(false);
  const superseded = images();
  expect(commits).toHaveBeenCalledTimes(2);
  const saved = { workspaceId: 'a', privateMemory: true };
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual(
    saved,
  );
  await restartHost();
  const restarted = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual(
    saved,
  );
  expect(images()).toEqual(superseded);
  expect(commits).toHaveBeenCalledTimes(2);
  expect(restarted).not.toHaveBeenCalled();
});

it('applies a decision interrupted before its files and replays the saved outcome', async () => {
  const before = images();
  jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
    await host.shutdown();
    const log = W5CommitLog.open(dbPath);
    try {
      log.commit(request);
    } finally {
      log.close();
    }
    throw new Error('interrupted after decision');
  });
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toThrow('interrupted after decision');
  await restartHost();
  expect((await host.recoveryReport()).applied).toHaveLength(1);
  expect(images()).not.toEqual(before);
  expect(manifest().privateMemory).toBe(true);
  await setPrivateMemory(false);
  const superseded = images();
  const commits = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(images()).toEqual(superseded);
  expect(commits).not.toHaveBeenCalled();
});

it('X6b: an attempt that died before its decision is recovery-required after restart, reported offline, and applies once after resolve', async () => {
  const before = images();
  failBeforeDecision();
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toThrow('worker died before decision');
  jest.restoreAllMocks();
  await restartHost();
  expect(images()).toEqual(before);
  const commits = jest.spyOn(host, 'commit');
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(images()).toEqual(before);
  expect(commits).not.toHaveBeenCalled();

  await host.shutdown();
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  expect(diagnosis.reservations).toEqual([
    expect.objectContaining({ state: 'recovery-required' }),
  ]);
  expect(diagnosis.commits).toEqual([]);

  await resolveColdRecovery();
  const resolved = jest.spyOn(host, 'commit');
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(resolved.mock.calls[0]?.[0].receipt).toBeDefined();
  const applied = images();
  expect(await setPrivateMemory(true, { idempotencyKey: 'key' })).toEqual({
    workspaceId: 'a',
    privateMemory: true,
  });
  expect(resolved).toHaveBeenCalledTimes(1);
  expect(images()).toEqual(applied);
});

it('marks a failed decision recovery-required at once, as diagnosed offline', async () => {
  const reserve = jest.spyOn(host, 'reserve');
  const error = Object.assign(new Error('worker failed'), { code: 'EIO' });
  jest.spyOn(host, 'commit').mockRejectedValueOnce(error);
  await expect(setPrivateMemory(true, { idempotencyKey: 'key' })).rejects.toBe(
    error,
  );
  expect(await host.lookupReceipt(receiptOf(reserve))).toMatchObject({
    status: 'recovery-required',
    diagnostics: { operation: OPERATION, errorCode: 'EIO' },
  });
  const before = images();
  await expect(
    setPrivateMemory(true, { idempotencyKey: 'key' }),
  ).rejects.toMatchObject({ reason: 'recovery-required' });
  expect(images()).toEqual(before);
  await host.shutdown();
  const diagnosis = await diagnoseW5State(join(dir, 'data'));
  expect(diagnosis.reservations).toHaveLength(1);
  expect(diagnosis.reservations[0]?.state).toBe('recovery-required');
  expect(diagnosis.reservations[0]?.diagnostics).toContain('"errorCode":"EIO"');
  startHost();
});

it.each(['plain', 'expected'] as const)(
  'X6c-%s: after a resolve, a same-key retry over an intervening write',
  async (variant) => {
    const expectedRevision = variant === 'expected' ? 0 : undefined;
    failBeforeDecision();
    await expect(
      setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision }),
    ).rejects.toThrow('worker died before decision');
    jest.restoreAllMocks();
    await restartHost();
    expect(manifest()).not.toHaveProperty('privateMemory');

    // Another, unkeyed request intervenes.
    await setPrivateMemory(false);
    expect(await revision()).toBe(1);
    await expect(
      setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision }),
    ).rejects.toMatchObject({ reason: 'recovery-required' });

    await resolveColdRecovery();
    const commits = jest.spyOn(host, 'commit');
    const retry = setPrivateMemory(true, {
      idempotencyKey: 'key',
      expectedRevision,
    });
    if (variant === 'plain') {
      // A first application: the last writer wins.
      await expect(retry).resolves.toEqual({
        workspaceId: 'a',
        privateMemory: true,
      });
      expect(commits).toHaveBeenCalledTimes(1);
      expect(commits.mock.calls[0]?.[0].receipt).toBeDefined();
      expect(manifest().privateMemory).toBe(true);
      const applied = images();
      await expect(
        setPrivateMemory(true, { idempotencyKey: 'key' }),
      ).resolves.toEqual({ workspaceId: 'a', privateMemory: true });
      expect(commits).toHaveBeenCalledTimes(1);
      expect(images()).toEqual(applied);
    } else {
      await expect(retry).rejects.toBeInstanceOf(W5RevisionConflictError);
      await expect(retry).rejects.toMatchObject({
        reason: 'revision-conflict',
        expected: 0,
        actual: 1,
      });
      expect(commits).not.toHaveBeenCalled();
      expect(manifest().privateMemory).toBe(false);
      expect(await revision()).toBe(1);
      // The refusal released the key.
      await expect(
        setPrivateMemory(true, { idempotencyKey: 'key', expectedRevision: 1 }),
      ).resolves.toEqual({ workspaceId: 'a', privateMemory: true });
      expect(commits).toHaveBeenCalledTimes(1);
    }
  },
);

it('lets one of two keyed writes at the same revision land and releases the other key', async () => {
  const results = await Promise.allSettled([
    setPrivateMemory(true, { idempotencyKey: 'first', expectedRevision: 0 }),
    setPrivateMemory(false, { idempotencyKey: 'second', expectedRevision: 0 }),
  ]);
  const refused = results.filter((result) => result.status === 'rejected');
  expect(refused).toHaveLength(1);
  expect(refused[0]?.reason).toBeInstanceOf(W5RevisionConflictError);
  expect(await revision()).toBe(1);
  const loser = results[0]?.status === 'rejected' ? 'first' : 'second';
  await setPrivateMemory(loser === 'first', {
    idempotencyKey: loser,
    expectedRevision: 1,
  });
  expect(await revision()).toBe(2);
  expect(manifest().privateMemory).toBe(loser === 'first');
});
