// CAN-5528: the daemon-backed W5 store's record-port client, leased through
// main's daemon connection service, over a real daemon serving W6g's record
// port and W5e's commit events on a real commit-log worker. The daemon
// attributes the store's commits to the lease, main's own-origin set holds
// it, so the subscriber skips them and handles a peer's, across a drop.
import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { CanopyClient } from '@canopy/core-client';
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
// The launcher only attaches: the test daemon is already running.
jest.mock('@canopy/core-client/node', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createCoreClientNodeMock(),
);
// What main's handlers would refresh: each targeted list and each broad re-read.
jest.mock('../workspace-commit-event-handlers', () =>
  jest
    .requireActual<
      typeof W5RecordPortMocks
    >('./fixtures/electron-w5-record-port-mocks')
    .createCommitEventHandlersMock(),
);

import { createCanopyClientLease } from '@canopy/core-client';
import { connectCanopyClient } from '@canopy/core-client/node';
import { openW5CommitLogDatabase } from '@canopy/core-runtime/node/w5/commit-log';
import type { W5CommitEventSource } from '@canopy/core-runtime/node/w5/commit-events';
import {
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import {
  createW5DaemonRecordStore,
  installW5DaemonRecordStoreForTests,
} from '../../lib/w5-daemon-record-store';
import {
  readWorkspaceWorktrees,
  setWorktreeRegistryReconciler,
  updateWorkspaceWorktrees,
} from '../../lib/workspace-persistence';
import { leaseElectronW5RecordPort } from '../electron-w5-record-port';
import {
  requireTestDaemonHost,
  setUpW5TestDataRoot,
  startW5TestDaemon,
  tearDownW5TestDaemon,
  until,
} from './fixtures/electron-w5-record-port-daemon';
import { refreshedRegistries as mockRefreshed } from './fixtures/electron-w5-record-port-mocks';

jest.setTimeout(60_000);

const posix = process.platform === 'win32' ? describe.skip : describe;
const PEER_DEFINITIONS = {
  queries: CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  instructions: {
    ...CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
    ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  },
  streams: {},
};
type PeerClient = CanopyClient<
  typeof PEER_DEFINITIONS.queries,
  typeof PEER_DEFINITIONS.instructions,
  typeof PEER_DEFINITIONS.streams
>;

let events: W5CommitEventSource | undefined;
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(() => {
  setWorktreeRegistryReconciler((_workspaceId, _current, next) =>
    Promise.resolve({ rows: next }),
  );
});
beforeEach(async () => {
  await setUpW5TestDataRoot({
    prefix: 'c5528-',
    worktrees: (createdAt) => [{ id: 'one', branchName: 'first', createdAt }],
    additionalWorkspaceIds: ['b'],
  });
  mockRefreshed.length = 0;
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await tearDownW5TestDaemon();
  events = undefined;
});

/** A W5 qualification daemon, or one without the W5 host. */
async function startDaemon({ w5Host = true } = {}): Promise<void> {
  await startW5TestDaemon({
    w5Host,
    onW5Host: (host) => {
      events = host.events;
    },
  });
}

/** Another origin on the same daemon, as the CLI would be. */
async function connectPeer(): Promise<PeerClient> {
  const host = requireTestDaemonHost();
  const client = await connectCanopyClient({
    endpoint: host.endpoint,
    clientName: 'peer',
    clientVersion: '0',
    definitions: PEER_DEFINITIONS,
  });
  const lease = createCanopyClientLease({
    client,
    attach: () => Promise.reject(new Error('No reconnect for the peer.')),
    identity: {
      clientInstanceId: 'cli-peer',
      interfaceKind: 'cli',
      label: 'CLI',
    },
    renewalIntervalMs: 60_000,
    presence: () => ({ interactive: true, foreground: false }),
  });
  await lease.acquire();
  cleanups.push(async () => {
    await lease.release('normal_shutdown').catch(() => undefined);
    await client.close();
  });
  return client;
}

/** The peer replaces workspace b's list through the record port. */
async function peerCommit(peer: PeerClient, sentinel: string): Promise<void> {
  const { files } = await peer.query('core.workspaceRecords.capture', {
    files: [{ kind: 'worktrees', workspaceId: 'b' }],
    discoverWorkspaces: false,
  });
  const [image] = files;
  if (image?.state !== 'present' || image.base64 === undefined)
    throw new Error('b list not captured');
  const raw = Buffer.from(image.base64, 'base64').toString('utf8');
  await expect(
    peer.instruction('core.workspaceRecords.commit', {
      operation: 'can5528.test.peer-write',
      advance: [{ kind: 'worktrees', workspaceId: 'b' }],
      files: [
        {
          target: { kind: 'worktrees', workspaceId: 'b' },
          contents: JSON.stringify({ version: 1, worktrees: [], sentinel }),
          previousFingerprint: createHash('sha256')
            .update(raw, 'utf8')
            .digest('hex'),
        },
      ],
      outcome: null,
    }),
  ).resolves.toMatchObject({ status: 'applied' });
}

/** Electron's own write, through the installed daemon-backed store. */
async function ownCommit(branchName: string): Promise<void> {
  await updateWorkspaceWorktrees('a', (rows) =>
    rows.map((row) => ({ ...row, branchName })),
  );
  const [row] = await readWorkspaceWorktrees('a', {
    persistRemovalCleanup: false,
  });
  expect(row?.branchName).toBe(branchName);
}

/** Each journaled commit's `publishedBy` (null when absent), oldest first. */
function committedBy(): (string | null)[] {
  if (!events) return [];
  // Sequence 0 replays every entry; a null cursor only the latest.
  const replay = events.journal.resume({
    daemonEpoch: events.journal.epoch,
    sequence: 0,
  });
  if (replay.kind !== 'replay') return [];
  return replay.entries
    .filter(({ event }) => event.name === 'core.workspace.committed')
    .map(({ event }) => {
      const by = event.payload.publishedBy;
      return typeof by === 'string' ? by : null;
    });
}

const listsRefreshed = (): string[] =>
  mockRefreshed.filter((entry) => entry !== 'broad');

posix(
  'the daemon-backed W5 store leased through the connection service',
  () => {
    it('skips its own commits and handles a peer’s, also after a dropped connection re-attaches', async () => {
      await startDaemon();
      const lease = leaseElectronW5RecordPort();
      cleanups.push(() => lease.close());
      const restore = installW5DaemonRecordStoreForTests(
        createW5DaemonRecordStore({ transport: lease.transport }),
      );
      cleanups.push(restore);
      const host = requireTestDaemonHost();
      // Building the lease opens nothing.
      expect(host.clients).toHaveLength(0);

      // The store's first call opens the session; the subscriber rides it and
      // its open re-reads broadly.
      await lease.transport.recovery();
      expect(host.clients).toHaveLength(1);
      await until(() => mockRefreshed.includes('broad'), 'the open re-read');
      const peer = await connectPeer();

      await ownCommit('own-1');
      await peerCommit(peer, 'peer-1');
      // Journal order is delivery order: once the peer's plan lands, the own
      // commit before it was delivered and skipped.
      await until(() => listsRefreshed().length >= 1, 'the first peer commit');
      expect(listsRefreshed()).toEqual(['b']);
      expect(committedBy()).toEqual([lease.clientInstanceId, 'cli-peer']);

      // Drop the store's connection; the lease attaches a replacement under
      // the same client instance.
      const [dropped] = host.clients;
      await dropped?.close();
      // Committed while the store's connection may be down: handled once.
      await peerCommit(peer, 'peer-2');
      await until(
        () => host.clients.length === 2 && !host.clients[1]?.signal.aborted,
        'the replacement connection',
      );
      await until(
        () =>
          lease.transport.recovery().then(
            () => true,
            () => false,
          ),
        'the re-acquired lease',
      );
      await until(
        () => listsRefreshed().length >= 2,
        'the re-attached subscriber',
      );

      await ownCommit('own-2');
      await peerCommit(peer, 'peer-3');
      await until(() => listsRefreshed().length >= 3, 'the last peer commit');
      // Let any late delivery of the own commit land before the final check.
      await delay(300);
      expect(listsRefreshed()).toEqual(['b', 'b', 'b']);
      expect(committedBy()).toEqual([
        lease.clientInstanceId,
        'cli-peer',
        'cli-peer',
        lease.clientInstanceId,
        'cli-peer',
      ]);
      // One replacement: every call after the drop rode the same lease.
      expect(host.clients).toHaveLength(2);

      // Closing the lease ends its session; the store's calls are refused.
      lease.close();
      await expect(lease.transport.recovery()).rejects.toMatchObject({
        payload: { kind: 'cancelled' },
      });
      await until(
        () => host.clients[1]?.signal.aborted === true,
        'the released connection',
      );
      expect(host.clients).toHaveLength(2);
    });
  },
);

// CAN-5543: these rows turn on the flip build's capability check, which every
// connection above passed before its lease.
/** The first W5 record call's error, from a fresh access module. */
async function firstRecordCallError(): Promise<unknown> {
  let error: unknown;
  // A fresh access module: the suite above disposed the shared one.
  await jest.isolateModulesAsync(async () => {
    jest
      .requireActual<
        typeof W5RecordPortMocks
      >('./fixtures/electron-w5-record-port-mocks')
      .setTestDaemonHost(requireTestDaemonHost());
    const port = await import('../electron-w5-record-port');
    // Jest reuses the storage mock set up by setUpW5TestDataRoot, not the
    // isolated fixture module's uninitialized ownership rows.
    const { isW5DaemonFlipCompiled } = await import('../../lib/w5-flip-gate');
    expect(isW5DaemonFlipCompiled()).toBe(true);
    const access = await import('../electron-daemon-access');
    const lease = port.leaseElectronW5RecordPort();
    error = await lease.transport.recovery().then(
      () => undefined,
      (caught: unknown) => caught,
    );
    lease.close();
    await access.disposeElectronDaemonConnections();
  });
  return error;
}

posix(
  'the flip build capability check against a real daemon (CAN-5543)',
  () => {
    // The payload, not canopyDaemonRefusal: Jest loads two copies of the
    // client error class here.
    it('closes and refuses a daemon without the W5 host before any lease', async () => {
      await startDaemon({ w5Host: false });
      const host = requireTestDaemonHost();
      await expect(firstRecordCallError()).resolves.toMatchObject({
        payload: {
          kind: 'failed_precondition',
          details: { refusal: 'peer_held' },
        },
      });
      await until(
        () => host.clients[0]?.signal.aborted === true,
        'the refused connection',
      );
    });

    it('refuses writer_held when another writer holds the commit log', async () => {
      const dataRoot = process.env.CANOPY_DATA_DIR;
      if (!dataRoot) throw new Error('No test data root.');
      await mkdir(join(dataRoot, 'w5'), { recursive: true, mode: 0o700 });
      const holder = openW5CommitLogDatabase(
        join(dataRoot, 'w5', 'commit-log.sqlite'),
        100,
      );
      try {
        await startDaemon();
        // health.get's untyped `reason` survives main's client definitions.
        await expect(firstRecordCallError()).resolves.toMatchObject({
          payload: {
            kind: 'failed_precondition',
            details: { refusal: 'writer_held' },
          },
        });
      } finally {
        holder.close();
      }
    });
  },
);
