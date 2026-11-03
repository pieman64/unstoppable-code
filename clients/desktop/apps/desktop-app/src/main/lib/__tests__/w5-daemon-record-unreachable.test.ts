// GB4 (CAN-5542) PR 1: Electron main's daemon-backed W5 store when its
// record-port connection drops, on a real commit-log worker and real files.
// The record port runs through the unreachable guard, as the production
// lease's does; the daemon side is the core-runtime authority served through
// the daemon control-stream code.
import { readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as CoreStorage from '@canopy/core-runtime/storage';
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
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
  // Same array every checked writer reads, the authority's included.
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
const mockRecordAppDiagnostic = jest.fn();
jest.mock('../../observability', () => ({
  getObservabilityService: jest.fn(() => ({
    purgeWorktreeData: jest.fn(() => Promise.resolve()),
    recordAppDiagnostic: mockRecordAppDiagnostic,
    recordUsageMetricEvent: jest.fn(),
  })),
}));
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));

import { settleDetachedWork } from '@canopy/desktop-shared/node/lib/detached-work';
import type { W5RecordPortTransport } from '@canopy/core-runtime/node/w5/record-port';
import { createW5BoundaryFixture } from './fixtures/w5-boundary-fixture';
import { startW5DaemonRecordHarness } from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import { W5CommitLogHost } from '../../w5-commit-log/commit-log-host';
import { recordRestoredWorktree } from '../archived-container-restore-records';
import { guardW5RecordPortCalls } from '../../canopy-runtime/w5-record-port-guard';
import { __setDesktopW5FileStoreForTests } from '../w5-commit-log-file-store';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
  w5RecordPortTransportOver,
  type W5RecordPortClient,
} from '../w5-daemon-record-store';
import { nodeW5FileStore, W5AuthorityUnreachableError } from '../w5-file-store';
import { w5ConflictCounts } from '../w5-pre-effect-retry';
import {
  __resetSidebarItemsStateForTests,
  writeAllSidebarItems,
} from '../sidebar-items';
import {
  reorderWorkspaces,
  updateWorkspaceMetadata,
} from '../workspace-metadata';
import {
  readWorkspaceWorktrees,
  readWorkspaceWorktreesDetailed,
  setWorktreeRegistryReconciler,
  updateWorkspaceConfig,
  updateWorkspaceWorktrees,
  writeWorkspaceConfig,
} from '../workspace-persistence';
import { getWorkspaceConfigPath } from '../paths';

jest.setTimeout(60_000);

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const WORKER = join(__dirname, '../../w5-commit-log/commit-log-worker.ts');
const REFUSED =
  "Couldn't save this change because the background service isn't running. Reconnect from the notice, then try again.";

let dir: string;
let root: string;
let host: W5CommitLogHost;
let harness: Awaited<ReturnType<typeof startW5DaemonRecordHarness>>;
let restore: () => void;
let originalDataDir: string | undefined;
let owner: AbortController;
/** Electron's current connection: each call resolves it, as the lease does. */
let connection: W5RecordPortClient;
/** Every record-port call Electron sent, by transport method. */
let sent: (keyof W5RecordPortTransport)[];

const listPath = (): string => join(root, 'a', 'worktrees.json');

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error
    ? error.cause
    : undefined;
}

/** `transport`, recording each call as it starts. */
function recording(transport: W5RecordPortTransport): W5RecordPortTransport {
  const record = <R>(
    method: keyof W5RecordPortTransport,
    call: () => Promise<R>,
  ): Promise<R> => {
    sent.push(method);
    return call();
  };
  return {
    capture: (request) => record('capture', () => transport.capture(request)),
    recovery: () => record('recovery', () => transport.recovery()),
    commit: (request) => record('commit', () => transport.commit(request)),
    lookupReceipt: (receipt) =>
      record('lookupReceipt', () => transport.lookupReceipt(receipt)),
    listReservations: () =>
      record('listReservations', () => transport.listReservations()),
    reserve: (params) => record('reserve', () => transport.reserve(params)),
    updateReservationDiagnostics: (params) =>
      record('updateReservationDiagnostics', () =>
        transport.updateReservationDiagnostics(params),
      ),
    releaseReservation: (reservationId) =>
      record('releaseReservation', () =>
        transport.releaseReservation(reservationId),
      ),
    markReservationRecoveryRequired: (params) =>
      record('markReservationRecoveryRequired', () =>
        transport.markReservationRecoveryRequired(params),
      ),
  };
}

/** Installs Electron's store over the guarded record port. */
async function installGuardedStore(): Promise<void> {
  connection = await harness.connect();
  const store = createW5DaemonRecordStore({
    root,
    transport: recording(
      w5RecordPortTransportOver(
        guardW5RecordPortCalls({
          connect: () => Promise.resolve(connection),
          owner: owner.signal,
        }),
      ),
    ),
  });
  restore = installW5DaemonRecordStoreForTests(store);
}

beforeEach(async () => {
  ({ dir, root } = createW5BoundaryFixture((createdAt) => [
    { id: 'one', branchName: 'first', createdAt },
    { id: 'two', branchName: 'second', createdAt },
  ]));
  dir = realpathSync(dir);
  root = join(dir, 'data', 'workspaces');
  originalDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = join(dir, 'data');
  __resetSidebarItemsStateForTests();
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
  host = new W5CommitLogHost({
    dbPath: join(dir, 'w5', 'commit-log.sqlite'),
    root,
    workerEntry: WORKER,
  });
  harness = await startW5DaemonRecordHarness({ host });
  owner = new AbortController();
  sent = [];
  restore = (): void => undefined;
  mockRecordAppDiagnostic.mockClear();
  setDaemonOwnedForTest(W5_NAMESPACES);
});
afterEach(async () => {
  owner.abort();
  restore();
  setDaemonOwnedForTest([]);
  await settleDetachedWork();
  __setDesktopW5FileStoreForTests(nodeW5FileStore);
  await harness.close();
  await host.shutdown();
  if (originalDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
  else process.env.CANOPY_DATA_DIR = originalDataDir;
  rmSync(dir, { recursive: true, force: true });
});

const rename = (branchName: string): Promise<unknown> =>
  updateWorkspaceWorktrees('a', (rows) =>
    rows.map((row) => ({ ...row, branchName })),
  );

describe('a connection lost before the decision', () => {
  it('refuses once with the typed error, unretried and uncounted, when the drop lands between the read and the preflight', async () => {
    await installGuardedStore();
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false });
    const before = readFileSync(listPath(), 'utf8');
    const conflicts = new Map(w5ConflictCounts());
    const commits = jest.spyOn(host, 'commit');
    let attempts = 0;
    // The reconciler runs between the read and the preflight of each attempt.
    setWorktreeRegistryReconciler(async (_workspaceId, _current, next) => {
      attempts += 1;
      await connection.close();
      return { rows: next };
    });

    const refused = await rename('renamed').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(W5AuthorityUnreachableError);
    expect(refused).toMatchObject({
      certainty: 'refused',
      reason: 'lost',
      message: REFUSED,
    });
    expect(attempts).toBe(1);
    expect(new Map(w5ConflictCounts())).toEqual(conflicts);
    expect(commits).not.toHaveBeenCalled();
    expect(sent).not.toContain('commit');
    expect(readFileSync(listPath(), 'utf8')).toBe(before);
  });

  it('after the daemon is gone, refuses each write with the unreachable copy and no unreadable-index diagnostic', async () => {
    await installGuardedStore();
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false });
    await connection.close();
    sent.length = 0;

    // Reads fail closed until the projection-only fallback (PR 2).
    await expect(readWorkspaceWorktreesDetailed('a')).resolves.toMatchObject({
      authority: 'unreadable',
    });
    const refused = await rename('renamed').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toMatchObject({
      name: 'WorktreeRegistryUnreadableError',
      message: REFUSED,
    });
    expect(causeOf(refused)).toBeInstanceOf(W5AuthorityUnreachableError);
    await expect(
      recordRestoredWorktree({
        source: 'archived_container_restore',
        workspaceId: 'a',
        archiveId: 'archive-1',
        worktree: {
          id: 'restored',
          branchName: 'restored',
          createdAt: '2026-10-01T00:00:00.000Z',
          label: 'Restored',
        },
      }),
    ).rejects.toMatchObject({
      reason: 'worktrees-unavailable',
      message: `${REFUSED} Staged recovery worktree restored was not recorded; the archived container was preserved.`,
    });
    for (const write of [
      (): Promise<unknown> =>
        updateWorkspaceMetadata({
          workspaceId: 'a',
          source: 'portal',
          patch: { name: 'Renamed' },
        }),
      (): Promise<unknown> =>
        reorderWorkspaces({ source: 'projects_save', workspaceOrder: ['a'] }),
    ])
      await expect(write()).rejects.toMatchObject({
        reason: 'index-unavailable',
        message: REFUSED,
      });
    // The repository's own refusal, which records a diagnostic for an
    // index that was read and found unreadable.
    await expect(writeAllSidebarItems([])).rejects.toMatchObject({
      name: 'WorkspaceIndexUnreadableError',
      message: REFUSED,
    });
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_index_write_refused' }),
    );
    // Nothing reached a daemon: every call was refused on the dropped client.
    expect(sent).not.toContain('commit');
    expect(sent).not.toContain('reserve');
  });

  it('after the daemon is gone, refuses a settings write with the unreachable copy and no unreadable-settings diagnostic', async () => {
    await installGuardedStore();
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false });
    await connection.close();
    const update = jest.fn();

    for (const write of [
      (): Promise<unknown> => updateWorkspaceConfig('a', update),
      (): Promise<unknown> =>
        writeWorkspaceConfig('a', {
          version: 1,
          type: 'multi-repo',
          repos: [],
        }),
    ]) {
      const refused = await write().then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toMatchObject({
        name: 'WorkspaceConfigUnreadableError',
        message: REFUSED,
      });
      expect(causeOf(refused)).toBeInstanceOf(W5AuthorityUnreachableError);
    }
    expect(update).not.toHaveBeenCalled();
    expect(mockRecordAppDiagnostic).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_config_write_refused' }),
    );
  });

  it('control: a reachable authority with a corrupt settings file still records the unreadable-settings diagnostic', async () => {
    await installGuardedStore();
    writeFileSync(getWorkspaceConfigPath('a'), '{');
    await expect(updateWorkspaceConfig('a', jest.fn())).rejects.toMatchObject({
      name: 'WorkspaceConfigUnreadableError',
    });
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_config_write_refused' }),
    );
  });

  it('control: a reachable authority with a corrupt index still records the unreadable-index diagnostic', async () => {
    await installGuardedStore();
    writeFileSync(join(root, 'index.json'), '{');
    await expect(writeAllSidebarItems([])).rejects.toMatchObject({
      name: 'WorkspaceIndexUnreadableError',
    });
    expect(mockRecordAppDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'workspace_index_write_refused' }),
    );
  });
});

describe('a connection lost during the decision', () => {
  it('reports outcome-unknown instead of the raw transport error, and recovers again before the next write', async () => {
    await installGuardedStore();
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false });
    const decide = host.commit.bind(host);
    // The decision is made; its response never arrives.
    jest.spyOn(host, 'commit').mockImplementationOnce(async (request) => {
      const outcome = await decide(request);
      await connection.close();
      return outcome;
    });

    const lost = await rename('renamed').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(lost).toBeInstanceOf(W5AuthorityUnreachableError);
    expect(lost).toMatchObject({
      certainty: 'outcome-unknown',
      reason: 'lost',
      message:
        'This change may not have saved. The background service stopped before it confirmed. Reconnect, check the project, then try again.',
    });

    // Reconnected: the store recovers first, then its next write lands.
    connection = await harness.connect();
    sent.length = 0;
    await expect(
      readWorkspaceWorktrees('a', { persistRemovalCleanup: false }),
    ).resolves.toEqual([
      expect.objectContaining({ branchName: 'renamed' }),
      expect.objectContaining({ branchName: 'renamed' }),
    ]);
    expect(sent[0]).toBe('recovery');
    await expect(rename('again')).resolves.toEqual([
      expect.objectContaining({ branchName: 'again' }),
      expect.objectContaining({ branchName: 'again' }),
    ]);
  });
});
