// GB4 (CAN-5542) PR 1: which daemon-backed W5 record-port failures mean the
// authority could not be reached. Calls run over the daemon control-stream
// code to a live record-port authority, so every typed reply crosses the
// wire as it would from the daemon.
import type * as CoreStorage from '@canopy/core-runtime/storage';
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

import { CanopyClientError } from '@canopy/core-client';
import { canopyDaemonRefusalError } from '@canopy/core-client/node';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { W5FileWriteRefusedError } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import { W5AuthorityUnreachableError } from '@canopy/core-runtime/node/w5/file-store';
import { createW5RecordHostPort } from '@canopy/core-runtime/node/w5/record-port';
import { StorageWriteRefusedError } from '@canopy/core-runtime/storage';
import type { W5HostRecoveryReport } from '@canopy/core-runtime/node/w5/commit-log/worker-contract';
import {
  W5CommitLogError,
  W5CommitRefusedError,
} from '@canopy/desktop-shared/node/w5-commit-log/errors';
import {
  startW5DaemonRecordHarness,
  type W5DaemonRecordHarness,
} from '@canopy/desktop-shared/node/w5-routed-writes/__tests__/fixtures/w5-daemon-record-harness';
import {
  w5RecordPortTransportOver,
  type W5RecordPortClient,
} from '../../lib/w5-daemon-record-store';
import {
  createElectronDaemonConnectionService,
  markUnreachable,
} from '../electron-daemon-connection';
import type { ElectronDaemonClient } from '../electron-daemon-host';
import {
  guardW5RecordPortCalls,
  w5UnreachableReasonForTag,
  W5_HOSTLESS_DAEMON_DEGRADES,
  type W5RecordPortGuardOptions,
} from '../w5-record-port-guard';

const W5_NAMESPACES = [
  'workspace_index',
  'workspace_manifest',
  'worktree_list',
];
const EMPTY_REPORT: W5HostRecoveryReport = {
  applied: [],
  recoveryRequired: [],
  interruptedReservations: 0,
};

function barrier(): { promise: Promise<void>; open: () => void } {
  let open = (): void => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** The daemon's W5 host: every call answers or fails as the test sets. */
function fakeHost(): W5CommitLogHostPort {
  return {
    root: '/daemon/w5',
    recoveryReport: () => Promise.resolve(EMPTY_REPORT),
    commit: () => Promise.reject(new Error('Not decided in this test.')),
    lookupReceipt: () => Promise.resolve({ status: 'none' }),
    reserve: () => Promise.resolve(),
    updateReservationDiagnostics: () => Promise.resolve(),
    releaseReservation: () => Promise.resolve(),
    markReservationRecoveryRequired: () => Promise.resolve(),
    revision: () => Promise.resolve(0),
    capture: () => Promise.reject(new Error('Not captured in this test.')),
  };
}

let harnesses: W5DaemonRecordHarness[] = [];
let owner: AbortController;

beforeEach(() => {
  harnesses = [];
  owner = new AbortController();
  setDaemonOwnedForTest(W5_NAMESPACES);
});
afterEach(async () => {
  owner.abort();
  await Promise.all(harnesses.map((harness) => harness.close()));
  setDaemonOwnedForTest([]);
});

async function harnessOver(
  host: W5CommitLogHostPort,
  serveRecordPort = true,
): Promise<W5DaemonRecordHarness> {
  const harness = await startW5DaemonRecordHarness({ host, serveRecordPort });
  harnesses.push(harness);
  return harness;
}

/** Electron's host port over the guarded record port, as the store sees it. */
function guarded(
  options: Partial<W5RecordPortGuardOptions> &
    Pick<W5RecordPortGuardOptions, 'connect'>,
): ReturnType<typeof createW5RecordHostPort> {
  return createW5RecordHostPort({
    root: '/electron/w5',
    transport: w5RecordPortTransportOver(
      guardW5RecordPortCalls({ owner: owner.signal, ...options }),
    ),
  });
}

function causeOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'cause' in error
    ? error.cause
    : undefined;
}

async function rejection(call: Promise<unknown>): Promise<unknown> {
  try {
    await call;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to fail.');
}

it('gives the guard each transport call’s operation, and runs only instructions as instructions', async () => {
  const seen: [string, string][] = [];
  const transport = w5RecordPortTransportOver((call) => {
    seen.push([call.operation, call.kind]);
    return Promise.reject(new Error('Not run in this test.'));
  });
  for (const call of [
    transport.capture({
      files: [{ kind: 'index' }],
      discoverWorkspaces: false,
    }),
    transport.recovery(),
    transport.commit({
      operation: 'test.commit',
      advance: [{ kind: 'workspaces' }],
      files: [],
      outcome: null,
    }),
    transport.lookupReceipt({
      caller: 'c',
      operation: 'o',
      idempotencyKey: 'k',
      fingerprint: 'f'.repeat(64),
    }),
    transport.listReservations(),
    transport.reserve({ reservationId: 'r', operation: 'o' }),
    transport.updateReservationDiagnostics({
      reservationId: 'r',
      diagnostics: '{}',
    }),
    transport.releaseReservation('r'),
    transport.markReservationRecoveryRequired({
      reservationId: 'r',
      diagnostics: { operation: 'o', errorName: 'Error' },
    }),
  ])
    await rejection(call);
  // An instruction lost in flight is outcome-unknown; a query never is.
  expect(seen).toEqual([
    ['core.workspaceRecords.capture', 'query'],
    ['core.workspaceRecords.recovery.get', 'query'],
    ['core.workspaceRecords.commit', 'instruction'],
    ['core.workspaceRecords.receipt.lookup', 'query'],
    ['core.workspaceRecords.reservation.list', 'query'],
    ['core.workspaceRecords.reservation.reserve', 'instruction'],
    ['core.workspaceRecords.reservation.updateDiagnostics', 'instruction'],
    ['core.workspaceRecords.reservation.release', 'instruction'],
    ['core.workspaceRecords.reservation.markRecoveryRequired', 'instruction'],
  ]);
});

describe('nothing sent', () => {
  it('keeps a non-flip launch failure unreachable, even with a daemon refusal reason', async () => {
    setDaemonOwnedForTest([]);
    const refusal = canopyDaemonRefusalError(
      'exited_before_ready',
      'Core exited before it was ready.',
      'unavailable',
    );
    markUnreachable(refusal, 'start_failed');
    const onUnreachable = jest.fn();
    const port = guarded({
      connect: () => Promise.reject(refusal),
      onUnreachable,
    });
    const error = await rejection(port.recoveryReport());
    expect(error).toBeInstanceOf(W5AuthorityUnreachableError);
    expect(error).toMatchObject({ certainty: 'refused', reason: 'connect' });
    expect(causeOf(error)).toBe(refusal);
    expect(onUnreachable.mock.calls).toEqual([['start_failed']]);
  });

  it.each([
    ...(
      [
        'writer_held',
        'peer_held',
        'version_skew',
        'exited_before_ready',
      ] as const
    ).map((reason) => canopyDaemonRefusalError(reason, 'Launch refused.')),
    new CanopyClientError({
      kind: 'failed_precondition',
      message: 'Backup refused.',
      retry: { kind: 'never' },
      details: { w5Handoff: 'backup_refused', detail: 'source-changed' },
    }),
  ])(
    'preserves the handoff refusal despite a GA3 connect tag: %s',
    async (refusal) => {
      const service =
        createElectronDaemonConnectionService<ElectronDaemonClient>({
          enabled: true,
          authorityId: 'authority',
          attach: () => Promise.reject(refusal),
        });
      const onUnreachable = jest.fn();
      const port = guarded({
        onUnreachable,
        connect: async () =>
          (
            await service.get(
              {
                principalId: 'local-desktop-user',
                clientInstanceId: 'electron-main:w5-records:test',
                authorityId: 'authority',
                interfaceKind: 'desktop',
                grants: [],
              },
              owner.signal,
            )
          ).client,
      });
      try {
        await expect(rejection(port.recoveryReport())).resolves.toBe(refusal);
        expect(onUnreachable.mock.calls).toEqual([['start_failed']]);
      } finally {
        await service.dispose();
      }
    },
  );

  it('refuses a held call at once, without connecting, and connects once it lifts', async () => {
    const connect = jest.fn(
      (): Promise<W5RecordPortClient> =>
        Promise.reject(new Error('never asked')),
    );
    let latched = true;
    const port = guarded({ connect, held: () => latched });
    for (const call of [
      port.recoveryReport(),
      port.releaseReservation('reservation-1'),
    ])
      await expect(rejection(call)).resolves.toMatchObject({
        name: 'W5AuthorityUnreachableError',
        certainty: 'refused',
        reason: 'held',
      });
    expect(connect).not.toHaveBeenCalled();
    // Read per call: the next call after the latch lifts connects.
    latched = false;
    await rejection(port.recoveryReport());
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('refuses a call whose session the connection service could not reach', async () => {
    const service = createElectronDaemonConnectionService<ElectronDaemonClient>(
      {
        enabled: true,
        authorityId: 'authority',
        attach: () => Promise.reject(new Error('spawn failed')),
      },
    );
    const sends = jest.fn();
    const onUnreachable = jest.fn();
    const port = guarded({
      onUnreachable,
      connect: async () => {
        const session = await service.get(
          {
            principalId: 'local-desktop-user',
            clientInstanceId: 'electron-main:w5-records:test',
            authorityId: 'authority',
            interfaceKind: 'desktop',
            grants: [],
          },
          owner.signal,
        );
        sends();
        return session.client;
      },
    });
    const refused = await rejection(port.releaseReservation('reservation-1'));
    expect(refused).toBeInstanceOf(W5AuthorityUnreachableError);
    expect(refused).toMatchObject({ certainty: 'refused', reason: 'connect' });
    expect(causeOf(refused)).toMatchObject({ message: 'spawn failed' });
    expect(sends).not.toHaveBeenCalled();
    // GA3's tag, reported before the refusal reaches the caller.
    expect(onUnreachable.mock.calls).toEqual([['start_failed']]);
    await service.dispose();
  });

  it('reports only a tagged connect failure, and a throwing observer never changes the refusal', async () => {
    const onUnreachable = jest.fn((): void => {
      throw new Error('observer failed');
    });
    const tagged = new Error('timed out');
    markUnreachable(tagged, 'connect_timeout');
    const rejectTagged = (): Promise<W5RecordPortClient> =>
      Promise.reject(tagged);
    await expect(
      rejection(
        guarded({ connect: rejectTagged, onUnreachable }).recoveryReport(),
      ),
    ).resolves.toMatchObject({ reason: 'connect', cause: tagged });
    expect(onUnreachable.mock.calls).toEqual([['connect_timeout']]);

    onUnreachable.mockClear();
    const dropped = await (await harnessOver(fakeHost())).connect();
    await dropped.close();
    const hostless = await (await harnessOver(fakeHost(), false)).connect();
    const silent: Pick<W5RecordPortGuardOptions, 'connect' | 'held'>[] = [
      { connect: rejectTagged, held: (): boolean => true },
      {
        connect: (): Promise<W5RecordPortClient> =>
          Promise.reject(new Error('untagged')),
      },
      {
        connect: (): Promise<W5RecordPortClient> =>
          Promise.reject(new W5AuthorityUnreachableError('refused', 'connect')),
      },
      { connect: (): Promise<W5RecordPortClient> => Promise.resolve(dropped) },
      { connect: (): Promise<W5RecordPortClient> => Promise.resolve(hostless) },
    ];
    for (const options of silent)
      await rejection(guarded({ ...options, onUnreachable }).recoveryReport());
    expect(onUnreachable).not.toHaveBeenCalled();
    // Closed: the owner's own close is never reported.
    owner.abort();
    await rejection(
      guarded({ connect: rejectTagged, onUnreachable }).recoveryReport(),
    );
    expect(onUnreachable).not.toHaveBeenCalled();
  });

  it.each([
    ['start_failed', 'connect'],
    ['connect_timeout', 'connect'],
    ['host_unavailable', 'connect'],
    ['connection_lost', 'lost'],
    ['reconnect_failed', 'lost'],
  ] as const)('names a get() tagged %s as %s', (tag, reason) => {
    expect(w5UnreachableReasonForTag(tag)).toBe(reason);
  });

  it('passes an untagged connect failure through, and every failure once the owner closed', async () => {
    const disabled =
      createElectronDaemonConnectionService<ElectronDaemonClient>({
        enabled: false,
        authorityId: 'authority',
        attach: () => Promise.reject(new Error('never attached')),
      });
    const port = guarded({
      connect: async () =>
        (
          await disabled.get(
            {
              principalId: 'local-desktop-user',
              clientInstanceId: 'electron-main:w5-records:test',
              authorityId: 'authority',
              interfaceKind: 'desktop',
              grants: [],
            },
            owner.signal,
          )
        ).client,
    });
    await expect(rejection(port.recoveryReport())).resolves.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
    const unreachable = new W5AuthorityUnreachableError('refused', 'connect');
    const hostless = guarded({ connect: () => Promise.reject(unreachable) });
    await expect(rejection(hostless.recoveryReport())).resolves.toBe(
      unreachable,
    );
    // Closed: a latch no longer refuses, and the close is never unreachable.
    owner.abort();
    const cancelled = new CanopyClientError({
      kind: 'cancelled',
      message: 'Desktop connection owner is closed.',
      retry: { kind: 'never' },
    });
    const late = guarded({
      connect: () => Promise.reject(cancelled),
      held: () => true,
    });
    await expect(rejection(late.recoveryReport())).resolves.toBe(cancelled);
    await disabled.dispose();
  });

  it('refuses a call on a client that already dropped, without sending it', async () => {
    const host = fakeHost();
    const release = jest.spyOn(host, 'releaseReservation');
    const client = await (await harnessOver(host)).connect();
    await client.close();
    const port = guarded({ connect: () => Promise.resolve(client) });
    await expect(
      rejection(port.releaseReservation('reservation-1')),
    ).resolves.toMatchObject({
      name: 'W5AuthorityUnreachableError',
      certainty: 'refused',
      reason: 'lost',
    });
    expect(release).not.toHaveBeenCalled();
  });
});

describe('a connection lost in flight', () => {
  it('never wraps an already typed unreachable failure a second time', async () => {
    const client = await (await harnessOver(fakeHost())).connect();
    const failure = new W5AuthorityUnreachableError('outcome-unknown', 'lost');
    const run = guardW5RecordPortCalls({
      connect: () => Promise.resolve(client),
      owner: owner.signal,
    });
    await expect(
      run({
        kind: 'instruction',
        operation: 'core.workspaceRecords.commit',
        run: async () => {
          await client.close();
          throw failure;
        },
      }),
    ).rejects.toBe(failure);
  });

  it('refuses a query, and leaves an instruction outcome-unknown', async () => {
    const host = fakeHost();
    const queried = barrier();
    const released = barrier();
    const never = new Promise<never>(() => undefined);
    jest.spyOn(host, 'recoveryReport').mockImplementation(() => {
      queried.open();
      return never;
    });
    jest.spyOn(host, 'releaseReservation').mockImplementation(() => {
      released.open();
      return never;
    });
    const harness = await harnessOver(host);

    const queryClient = await harness.connect();
    const query = rejection(
      guarded({ connect: () => Promise.resolve(queryClient) }).recoveryReport(),
    );
    await queried.promise;
    await queryClient.close();
    const lostQuery = await query;
    expect(lostQuery).toBeInstanceOf(W5AuthorityUnreachableError);
    expect(lostQuery).toMatchObject({ certainty: 'refused', reason: 'lost' });

    const instructionClient = await harness.connect();
    const instruction = rejection(
      guarded({
        connect: () => Promise.resolve(instructionClient),
      }).releaseReservation('reservation-1'),
    );
    await released.promise;
    await instructionClient.close();
    const lostInstruction = await instruction;
    expect(lostInstruction).toMatchObject({
      name: 'W5AuthorityUnreachableError',
      certainty: 'outcome-unknown',
      reason: 'lost',
      message:
        'This change may not have saved. The background service stopped before it confirmed. Reconnect, check the project, then try again.',
    });
    expect(causeOf(lostInstruction)).toBeInstanceOf(CanopyClientError);
  });
});

describe('a typed refusal from a live W5 authority', () => {
  it.each([
    [
      'a fingerprint conflict',
      (): Error => new W5FileWriteRefusedError('/daemon/w5/index.json'),
      W5FileWriteRefusedError,
    ],
    [
      'a revision conflict',
      (): Error =>
        new W5CommitRefusedError('revision-conflict', 'stale', {
          resource: 'workspaces',
          expected: 1,
          actual: 2,
        }),
      W5CommitRefusedError,
    ],
    [
      'an unavailable log',
      (): Error => new W5CommitLogError('STORAGE_UNAVAILABLE', 'log closed'),
      W5CommitLogError,
    ],
  ] as const)('stays typed: %s', async (_label, refusal, Expected) => {
    const host = fakeHost();
    jest.spyOn(host, 'recoveryReport').mockRejectedValue(refusal());
    const harness = await harnessOver(host);
    const client = await harness.connect();
    const port = guarded({ connect: () => Promise.resolve(client) });
    await expect(rejection(port.recoveryReport())).resolves.toBeInstanceOf(
      Expected,
    );
    expect(client.signal.aborted).toBe(false);
  });

  it('stays typed: a refused write and an unknown reservation', async () => {
    const host = fakeHost();
    jest.spyOn(host, 'releaseReservation').mockRejectedValue(
      new W5CommitRefusedError('unknown-reservation', 'gone', {
        reservationId: 'reservation-1',
      }),
    );
    const client = await (await harnessOver(host)).connect();
    const port = guarded({ connect: () => Promise.resolve(client) });
    await expect(
      rejection(port.releaseReservation('reservation-1')),
    ).resolves.toMatchObject({
      name: 'W5CommitRefusedError',
      reason: 'unknown-reservation',
    });
    setDaemonOwnedForTest([]);
    await expect(
      rejection(port.releaseReservation('reservation-1')),
    ).resolves.toBeInstanceOf(StorageWriteRefusedError);
  });
});

describe('a reached daemon without W5 authority (Q2)', () => {
  it('degrades as unreachable by default, with its own reason and nothing sent', async () => {
    expect(W5_HOSTLESS_DAEMON_DEGRADES).toBe(true);
    const client = await (await harnessOver(fakeHost(), false)).connect();
    const port = guarded({ connect: () => Promise.resolve(client) });
    for (const call of [
      port.recoveryReport(),
      port.releaseReservation('reservation-1'),
    ])
      await expect(rejection(call)).resolves.toMatchObject({
        name: 'W5AuthorityUnreachableError',
        certainty: 'refused',
        reason: 'w5_host_unavailable',
      });
    expect(client.signal.aborted).toBe(false);
  });

  it('checks each call’s own operation on the client manifest before running it', async () => {
    const hostless = await (await harnessOver(fakeHost(), false)).connect();
    const served = await (await harnessOver(fakeHost())).connect();
    const run = jest.fn(() => Promise.resolve('ran'));
    const call = {
      kind: 'instruction',
      operation: 'core.workspaceRecords.commit',
      run,
    } as const;
    await expect(
      guardW5RecordPortCalls({
        connect: () => Promise.resolve(hostless),
        owner: owner.signal,
      })(call),
    ).rejects.toMatchObject({ reason: 'w5_host_unavailable' });
    expect(run).not.toHaveBeenCalled();
    await expect(
      guardW5RecordPortCalls({
        connect: () => Promise.resolve(served),
        owner: owner.signal,
      })(call),
    ).resolves.toBe('ran');
    expect(run).toHaveBeenCalledWith(served);
  });

  it('keeps the typed capability refusal with the seam off', async () => {
    const client = await (await harnessOver(fakeHost(), false)).connect();
    const port = guarded({
      connect: () => Promise.resolve(client),
      degradeHostlessDaemon: false,
    });
    await expect(rejection(port.recoveryReport())).resolves.toMatchObject({
      payload: { kind: 'capability_unavailable' },
    });
  });
});
