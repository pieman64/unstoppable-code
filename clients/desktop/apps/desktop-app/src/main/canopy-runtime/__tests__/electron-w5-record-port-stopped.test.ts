// GB4 (CAN-5542): the W5 record-port lease over main's real connection
// service once the daemon stops. The lease keeps reconnecting with backoff,
// so its session stays cached; every call meanwhile must be the typed
// unreachable refusal, never the registry's raw "disconnected" error.
import type * as TsxWorkerThreads from '../../ledger/__tests__/fixtures/tsx-worker-threads';
import type * as W5RecordPortMocks from './fixtures/electron-w5-record-port-mocks';

jest.mock('node:worker_threads', () =>
  jest
    .requireActual<
      typeof TsxWorkerThreads
    >('../../ledger/__tests__/fixtures/tsx-worker-threads')
    .createTsxWorkerThreads(),
);
jest.mock('@canopy/core-runtime/storage', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createStorageMock(),
);
jest.mock('../../observability', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createObservabilityMock(),
);
jest.mock('../../portal/portal-structural-sync', () => ({
  schedulePortalStructuralSync: jest.fn(),
}));
jest.mock('../../portal/portal-event-bus', () => ({
  notifyPortalStructureChanged: jest.fn(),
}));
jest.mock('electron', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createElectronMock(),
);
jest.mock('../electron-daemon-host', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createElectronDaemonHostMock(),
);
// The launcher only attaches: a stopped daemon stays stopped.
jest.mock('@canopy/core-client/node', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createCoreClientNodeMock(),
);
jest.mock('../workspace-commit-event-handlers', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createCommitEventHandlersMock(),
);

import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
} from '../../lib/w5-daemon-record-store';
import { w5ConflictCounts } from '../../lib/w5-pre-effect-retry';
import {
  readWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import { getElectronDaemonHealth } from '../electron-daemon-health';
import { leaseElectronW5RecordPort } from '../electron-w5-record-port';
import {
  requireTestDaemonHost,
  setUpW5TestDataRoot,
  startW5TestDaemon,
  stopW5TestDaemon,
  tearDownW5TestDaemon,
  until,
} from './fixtures/electron-w5-record-port-daemon';

jest.setTimeout(60_000);

const posix = process.platform === 'win32' ? describe.skip : describe;
const REFUSED =
  "Couldn't save this change because the background service isn't running. Reconnect from the notice, then try again.";

let restoreStore = (): void => undefined;

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(() =>
  setUpW5TestDataRoot({
    prefix: 'c5542-',
    worktrees: (createdAt) => [{ id: 'one', branchName: 'first', createdAt }],
  }),
);
afterEach(async () => {
  restoreStore();
  restoreStore = (): void => undefined;
  await tearDownW5TestDaemon();
});

posix('the W5 record-port lease after its daemon stops', () => {
  it('refuses every query, instruction and write as unreachable while the lease reconnects', async () => {
    await startW5TestDaemon();
    const lease = leaseElectronW5RecordPort();
    restoreStore = installW5DaemonRecordStoreForTests(
      createW5DaemonRecordStore({ transport: lease.transport }),
    );
    await readWorkspaceWorktrees('a', { persistRemovalCleanup: false });
    const conflicts = new Map(w5ConflictCounts());
    const host = requireTestDaemonHost();
    const health = getElectronDaemonHealth();
    expect(health.getStatus().state).toBe('ok');
    await stopW5TestDaemon();
    await until(
      () => host.clients[0]?.signal.aborted === true,
      'the dropped connection',
    );
    // The drop is hidden while the lease restarts the daemon (Mike, q-13
    // GA3-1); only the lease giving up, by its 30 s bound, shows the notice.
    expect(health.getStatus()).toMatchObject({ state: 'reconnecting' });

    for (const call of [
      (): Promise<unknown> => lease.transport.recovery(),
      (): Promise<unknown> =>
        lease.transport.releaseReservation('reservation-1'),
    ])
      await expect(call()).rejects.toMatchObject({
        name: 'W5AuthorityUnreachableError',
        certainty: 'refused',
        reason: 'lost',
      });
    // A write refuses with the unreachable copy: never a fingerprint
    // conflict, so it is neither retried nor counted.
    await expect(
      updateWorkspaceWorktrees('a', (rows) =>
        rows.map((row) => ({ ...row, branchName: 'renamed' })),
      ),
    ).rejects.toMatchObject({ message: REFUSED });
    expect(new Map(w5ConflictCounts())).toEqual(conflicts);
    // The refusals neither show the notice during the restart nor latch, so
    // the next call still reaches a replacement connection.
    expect(health.getStatus()).toMatchObject({ state: 'reconnecting' });
    expect(health.isLatched()).toBe(false);
    lease.close();
    expect(health.getStatus().state).toBe('ok');
  });
});
