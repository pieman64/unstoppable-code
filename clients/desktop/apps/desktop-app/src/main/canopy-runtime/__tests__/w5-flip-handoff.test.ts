// GB12 (CAN-5543): the flip launch's startup handoff composition, over
// synthetic daemon probes and launch outcomes.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CanopyClientError } from '@canopy/core-client';
import {
  canopyDaemonRefusalError,
  type CanopyRuntimeDescriptor,
} from '@canopy/core-client/node';
import type { W5CommitLogFileStore } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import type * as FlipBackup from '../../lib/w5-flip-backup';
import type * as StoreModule from '../../lib/w5-commit-log-file-store';
import type * as HandoffStoreModule from '../../lib/w5-handoff-store';
import type { ElectronW5DaemonProbe } from '../electron-daemon-access';
import type * as HandoffModule from '../w5-flip-handoff';

const mockEvents: string[] = [];
const mockPhases: string[] = [];
const mockProbe = jest.fn<
  Promise<ElectronW5DaemonProbe>,
  [number, AbortSignal | undefined]
>();
const mockSettle = jest.fn<
  Promise<void>,
  [CanopyRuntimeDescriptor, number, AbortSignal]
>();
const mockRecovery = jest.fn<Promise<unknown>, []>();
const mockLeaseClose = jest.fn<void, []>();
const mockDisposeConnections = jest.fn<Promise<void>, []>(() =>
  Promise.resolve(),
);
const mockStep = {
  defer: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  prepare: jest.fn<Promise<void>, [string]>(() => Promise.resolve()),
  stop: jest.fn<Promise<void>, []>(() => Promise.resolve()),
};
const mockDaemonStore = {
  read: jest.fn<Promise<unknown>, [string]>(),
  replace: jest.fn<Promise<void>, unknown[]>(),
};
const mockInProcessHost = jest.fn<never, []>(() => {
  throw new Error('the in-process commit log was reached');
});
const mockGate = { flip: true };
const mockWarn = jest.fn<void, unknown[]>();

jest.mock('electron', (): object => ({
  app: { getVersion: (): string => '2.5.0' },
}));
jest.mock('../../lib/w5-flip-gate', (): object => ({
  ...jest.requireActual<object>('../../lib/w5-flip-gate'),
  isW5DaemonFlipCompiled: (): boolean => mockGate.flip,
}));
jest.mock('../../lib/main-process-logging', (): object => ({
  ...jest.requireActual<object>('../../lib/main-process-logging'),
  logMainProcessWarn: (...args: unknown[]): void => mockWarn(...args),
}));
jest.mock('../electron-daemon-access', (): object => ({
  probeElectronDaemonW5: (
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ElectronW5DaemonProbe> => {
    mockEvents.push('probe');
    return mockProbe(timeoutMs, signal);
  },
  disposeElectronDaemonConnections: (): Promise<void> =>
    mockDisposeConnections(),
  noteElectronW5Handoff: (phase: string): void => void mockPhases.push(phase),
}));
jest.mock('../electron-w5-record-port', (): object => ({
  leaseElectronW5RecordPort: (): object => ({
    clientInstanceId: 'electron-main:w5-records:test',
    transport: {
      recovery: (): Promise<unknown> => {
        mockEvents.push('recovery');
        return mockRecovery();
      },
    },
    close: (): void => mockLeaseClose(),
  }),
}));
jest.mock('../w5-refused-daemon', (): object => ({
  settleRefusedW5Daemon: (
    descriptor: CanopyRuntimeDescriptor,
    ms: number,
    signal: AbortSignal,
  ): Promise<void> => {
    mockEvents.push('settle');
    return mockSettle(descriptor, ms, signal);
  },
}));
jest.mock('../../lib/w5-flip-backup', (): object => ({
  ...jest.requireActual<typeof FlipBackup>('../../lib/w5-flip-backup'),
  deferW5FlipBackup: (version: string): Promise<void> => {
    mockEvents.push('defer');
    return mockStep.defer(version);
  },
  prepareW5FlipSpawn: (version: string): Promise<void> => {
    mockEvents.push('prepare');
    return mockStep.prepare(version);
  },
  stopInProcessW5Host: (): Promise<void> => {
    mockEvents.push('stop');
    return mockStep.stop();
  },
}));
jest.mock('../../lib/w5-daemon-record-store', (): object => ({
  createW5DaemonRecordStore: (): object => mockDaemonStore,
}));
jest.mock('../../w5-commit-log/commit-log-host', (): object => ({
  getW5CommitLogHost: (): never => mockInProcessHost(),
  shutdownW5CommitLogHost: (): Promise<void> => Promise.resolve(),
  runningW5CommitLogWorkers: (): number => 0,
}));

type Handoff = typeof HandoffModule;
type Store = typeof StoreModule;
type HandoffStore = typeof HandoffStoreModule;

async function load(): Promise<{
  handoff: Handoff;
  store: Store;
  errors: HandoffStore;
}> {
  const store = await import('../../lib/w5-commit-log-file-store');
  // Jest's setup injects a direct store; production has none.
  store.__setDesktopW5FileStoreForTests(undefined);
  return {
    handoff: await import('../w5-flip-handoff'),
    store,
    errors: await import('../../lib/w5-handoff-store'),
  };
}

const DESCRIPTOR: CanopyRuntimeDescriptor = {
  version: 1,
  pid: 7,
  startIdentity: 'old',
  endpoint: { kind: 'socket', path: '/private/run/core.sock' },
  protocolRange: { min: 1, max: 1 },
  buildVersion: '2.4.0',
  tokenRef: 'core-token',
};
const admitted = { admission: { kind: 'admitted' as const } };

let dir: string;
beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockEvents.length = 0;
  mockPhases.length = 0;
  mockGate.flip = true;
  mockRecovery.mockResolvedValue({});
  mockProbe.mockResolvedValue({ kind: 'absent' });
  mockSettle.mockResolvedValue(undefined);
  dir = mkdtempSync(join(tmpdir(), 'w5-flip-handoff-'));
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('startW5FlipHandoff', () => {
  it('does nothing with legacy rows: no store, no daemon, no backup', async () => {
    const { handoff, store } = await load();
    mockGate.flip = false;
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toBeUndefined();
    expect(mockEvents).toEqual([]);
    expect(mockPhases).toEqual([]);
    await handoff.disposeW5FlipHandoff();
    expect(mockDisposeConnections).not.toHaveBeenCalled();
    // The in-process store still serves W5.
    await expect(
      store.readW5Revisions([{ kind: 'workspaces' }]),
    ).rejects.toThrow('the in-process commit log was reached');
  });

  it('installs the store at once; W5 calls wait for the handoff, then reach the daemon store', async () => {
    const { handoff, store } = await load();
    let finish = (): void => undefined;
    mockRecovery.mockReturnValue(
      new Promise((resolve) => {
        finish = (): void => resolve({});
      }),
    );
    mockDaemonStore.read.mockResolvedValue({ state: 'absent' });
    const settled = handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({ state: 'pending' });
    // Files reads stay in-process, with nothing shown, until it settles.
    expect(mockPhases).toEqual(['pending']);
    // Before any of the handoff ran: the slot already holds the handoff store.
    const read = store.desktopW5FileStore.read(join(dir, 'index.json'));
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockDaemonStore.read).not.toHaveBeenCalled();
    finish();
    await settled;
    await expect(read).resolves.toEqual({ state: 'absent' });
    expect(mockDaemonStore.read).toHaveBeenCalledTimes(1);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({ state: 'ready' });
    expect(mockPhases).toEqual(['pending', 'ready']);
    expect(mockEvents).toEqual(['probe', 'recovery', 'defer', 'stop']);
    expect(mockInProcessHost).not.toHaveBeenCalled();
    expect(mockLeaseClose).not.toHaveBeenCalled();
  });

  it('defers the backup when a daemon serving W5 already holds the log', async () => {
    const { handoff } = await load();
    mockProbe.mockResolvedValue({ kind: 'accept' });
    await handoff.startW5FlipHandoff(admitted);
    expect(mockEvents).toEqual(['probe', 'defer', 'recovery', 'defer', 'stop']);
    expect(mockStep.defer).toHaveBeenCalledWith('2.5.0');
    expect(mockStep.prepare).not.toHaveBeenCalled();
  });

  it('still hands off when the deferral record cannot be written', async () => {
    const { handoff } = await load();
    mockProbe.mockResolvedValue({ kind: 'accept' });
    mockStep.defer.mockRejectedValue(new Error('EACCES'));
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({ state: 'ready' });
  });

  it('waits a refused daemon out within one bound, then probes what replaced it', async () => {
    const { handoff } = await load();
    mockProbe
      .mockResolvedValueOnce({ kind: 'wait', descriptor: DESCRIPTOR })
      .mockResolvedValueOnce({ kind: 'absent' });
    await handoff.startW5FlipHandoff(admitted);
    expect(mockEvents).toEqual([
      'probe',
      'settle',
      'probe',
      'recovery',
      'defer',
      'stop',
    ]);
    const [descriptor, remaining] = mockSettle.mock.calls[0] ?? [];
    expect(descriptor).toBe(DESCRIPTOR);
    expect(remaining).toBeGreaterThan(40_000);
    expect(remaining).toBeLessThanOrEqual(45_000);
  });

  it.each([14_000, 15_000])(
    'keeps reprobes within the total 45 s bound after a 30 s probe and %i ms release wait',
    async (releaseMs) => {
      const { handoff } = await load();
      const started = 1_000;
      let now = started;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockProbe.mockImplementation((timeoutMs) => {
        now += timeoutMs;
        return Promise.resolve({ kind: 'wait', descriptor: DESCRIPTOR });
      });
      mockSettle.mockImplementation(() => {
        now += releaseMs;
        return Promise.resolve();
      });

      await handoff.startW5FlipHandoff(admitted);

      expect(now - started).toBe(45_000);
      expect(mockProbe.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual(
        releaseMs === 14_000 ? [30_000, 1_000] : [30_000],
      );
      expect(handoff.getW5FlipHandoffStatus()).toEqual({
        state: 'degraded',
        reason: 'peer_held',
      });
      expect(mockRecovery).not.toHaveBeenCalled();
    },
  );

  it.each<
    [
      'version_skew' | undefined,
      'deadline_exceeded' | 'unavailable',
      number,
      string,
    ]
  >([
    [undefined, 'deadline_exceeded', 1_000, 'peer_held'],
    ['version_skew', 'deadline_exceeded', 1_000, 'version_skew'],
    ['version_skew', 'deadline_exceeded', 500, 'daemon_unavailable'],
    ['version_skew', 'unavailable', 1_000, 'daemon_unavailable'],
  ])(
    'classifies %s followed by a %s reprobe after %i ms as %s',
    async (refusal, kind, elapsedMs, reason) => {
      const { handoff } = await load();
      let now = 1_000;
      jest.spyOn(performance, 'now').mockImplementation(() => now);
      mockProbe
        .mockImplementationOnce(() => {
          now += 30_000;
          return Promise.resolve({
            kind: 'wait',
            descriptor: DESCRIPTOR,
            ...(refusal && { refusal }),
          });
        })
        .mockImplementationOnce(() => {
          now += elapsedMs;
          return Promise.reject(
            new CanopyClientError({
              kind,
              message: 'Reprobe failed.',
              retry: { kind: 'never' },
            }),
          );
        });
      mockSettle.mockImplementation(() => {
        now += 14_000;
        return Promise.resolve();
      });

      await handoff.startW5FlipHandoff(admitted);

      expect(mockProbe.mock.calls.map(([timeoutMs]) => timeoutMs)).toEqual([
        30_000, 1_000,
      ]);
      expect(handoff.getW5FlipHandoffStatus()).toEqual({
        state: 'degraded',
        reason,
      });
      expect(mockRecovery).not.toHaveBeenCalled();
      expect(mockLeaseClose).toHaveBeenCalled();
    },
  );

  it('refuses peer_held at the bound and degrades: direct reads, writes refused, never in process', async () => {
    const { handoff, store, errors } = await load();
    let now = 1_000;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    mockProbe.mockResolvedValue({ kind: 'wait', descriptor: DESCRIPTOR });
    mockSettle.mockImplementation(() => {
      now += 46_000;
      return Promise.resolve();
    });
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({
      state: 'degraded',
      reason: 'peer_held',
    });
    expect(mockRecovery).not.toHaveBeenCalled();
    expect(mockLeaseClose).toHaveBeenCalled();
    expect(mockEvents.at(-1)).toBe('stop');

    const file = join(dir, 'index.json');
    writeFileSync(file, '{"version":1,"workspaces":[]}');
    await expect(store.desktopW5FileStore.read(file)).resolves.toMatchObject({
      state: 'present',
    });
    const refused = store.desktopW5FileStore.replace(
      file,
      '{}',
      { namespace: 'workspace_index', writer: 'electron_main' },
      {
        operation: 'test.write',
        advance: [{ kind: 'workspaces' }],
        previousRaw: null,
      },
    );
    await expect(refused).rejects.toBeInstanceOf(errors.W5DaemonHandoffError);
    await expect(refused).rejects.toMatchObject({ reason: 'peer_held' });
    const work = jest.fn();
    await expect(
      store.withW5Commit({ operation: 'test.write' }, work),
    ).rejects.toMatchObject({ reason: 'peer_held' });
    expect(work).not.toHaveBeenCalled();
    // Query views read live, named for the degraded handoff.
    await expect(
      store.runW5ReadView({ files: [], discoverWorkspaces: false }, (view) =>
        Promise.resolve(view),
      ),
    ).resolves.toEqual({ status: 'uncaptured', reason: 'handoff-degraded' });
    expect(mockInProcessHost).not.toHaveBeenCalled();
  });

  it('waits out an older W5 build after an update, then spawns ours', async () => {
    const { handoff } = await load();
    mockProbe
      .mockResolvedValueOnce({
        kind: 'wait',
        descriptor: DESCRIPTOR,
        refusal: 'version_skew',
      })
      .mockResolvedValueOnce({ kind: 'absent' });
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({ state: 'ready' });
    expect(mockEvents.slice(0, 4)).toEqual([
      'probe',
      'settle',
      'probe',
      'recovery',
    ]);
  });

  it.each<[string, () => void]>([
    [
      'outlives the wait',
      (): void => {
        mockSettle.mockRejectedValue(
          canopyDaemonRefusalError('peer_held', 'Still running.'),
        );
      },
    ],
    [
      'is still there at the bound',
      (): void => {
        let now = 1_000;
        jest.spyOn(performance, 'now').mockImplementation(() => now);
        mockSettle.mockImplementation(() => {
          now += 46_000;
          return Promise.resolve();
        });
      },
    ],
  ])('refuses version_skew when an RC or prod peer %s', async (_, arrange) => {
    const { handoff } = await load();
    arrange();
    mockProbe.mockResolvedValue({
      kind: 'wait',
      descriptor: DESCRIPTOR,
      refusal: 'version_skew',
    });
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({
      state: 'degraded',
      reason: 'version_skew',
    });
    expect(mockRecovery).not.toHaveBeenCalled();
  });

  it('ends cancelled when the app quits during the wait: W5 calls refuse at once, without a warning', async () => {
    const { handoff, store } = await load();
    mockProbe.mockResolvedValue({ kind: 'wait', descriptor: DESCRIPTOR });
    // The real wait rejects once its signal aborts.
    mockSettle.mockImplementation(
      (_descriptor, _ms, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => reject(new Error('The wait was cancelled.')),
            { once: true },
          );
        }),
    );
    const settled = handoff.startW5FlipHandoff(admitted);
    const work = jest.fn();
    const write = store.withW5Commit({ operation: 'test.write' }, work);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockSettle).toHaveBeenCalledTimes(1);
    handoff.cancelPendingW5FlipHandoff();
    await settled;
    await expect(write).rejects.toMatchObject({ reason: 'cancelled' });
    expect(work).not.toHaveBeenCalled();
    expect(handoff.getW5FlipHandoffStatus()).toEqual({
      state: 'degraded',
      reason: 'cancelled',
    });
    expect(mockPhases).toEqual(['pending', 'cancelled']);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(mockRecovery).not.toHaveBeenCalled();
  });

  it('leaves a finished handoff alone at quit', async () => {
    const { handoff } = await load();
    await handoff.startW5FlipHandoff(admitted);
    handoff.cancelPendingW5FlipHandoff();
    expect(mockLeaseClose).not.toHaveBeenCalled();
    expect(handoff.getW5FlipHandoffStatus()).toEqual({ state: 'ready' });
  });

  const backupRefused = new CanopyClientError({
    kind: 'failed_precondition',
    message: 'The workspace records backup failed.',
    retry: { kind: 'never' },
    details: { w5Handoff: 'backup_refused', detail: 'source-changed' },
  });
  const timedOut = new CanopyClientError({
    kind: 'deadline_exceeded',
    message: 'Core startup timed out.',
    retry: { kind: 'never' },
  });
  const exited = canopyDaemonRefusalError(
    'exited_before_ready',
    'Core exited before it was ready.',
    'unavailable',
  );
  it.each([
    ['writer_held', canopyDaemonRefusalError('writer_held', 'Held.')],
    ['peer_held', canopyDaemonRefusalError('peer_held', 'Held.')],
    ['version_skew', canopyDaemonRefusalError('version_skew', 'Skewed.')],
    ['exited_before_ready', exited],
    ['backup_refused', backupRefused],
  ] as const)(
    'keeps %s through the guarded record lease into the degraded store',
    async (reason, refusal) => {
      const { handoff, store } = await load();
      const { markUnreachable } = await import('../electron-daemon-connection');
      const { guardW5RecordPortCalls } =
        await import('../w5-record-port-guard');
      markUnreachable(refusal, 'start_failed');
      const run = guardW5RecordPortCalls({
        connect: () => Promise.reject(refusal),
        owner: new AbortController().signal,
      });
      mockRecovery.mockImplementation(() =>
        run({
          kind: 'query',
          operation: 'core.workspaceRecords.recovery.get',
          run: () => Promise.reject(new Error('Nothing should be sent.')),
        }),
      );
      await handoff.startW5FlipHandoff(admitted);
      expect(handoff.getW5FlipHandoffStatus()).toMatchObject({
        state: 'degraded',
        reason,
      });
      if (reason === 'backup_refused')
        expect(handoff.getW5FlipHandoffStatus()).toMatchObject({
          detail: 'source-changed',
        });
      const path = join(dir, 'index.json');
      writeFileSync(path, '{"version":1}');
      await expect(store.desktopW5FileStore.read(path)).resolves.toMatchObject({
        state: 'present',
        raw: '{"version":1}',
      });
      const work = jest.fn();
      await expect(
        store.withW5Commit({ operation: 'test.write' }, work),
      ).rejects.toMatchObject({ name: 'W5DaemonHandoffError', reason });
      expect(work).not.toHaveBeenCalled();
      expect(mockInProcessHost).not.toHaveBeenCalled();
    },
  );

  it.each<[string, () => unknown, string, string | undefined]>([
    [
      'a writer-held daemon, without waiting',
      (): unknown =>
        mockProbe.mockResolvedValue({ kind: 'refuse', refusal: 'writer_held' }),
      'writer_held',
      undefined,
    ],
    [
      'a refused backup',
      (): unknown => mockRecovery.mockRejectedValue(backupRefused),
      'backup_refused',
      'source-changed',
    ],
    [
      'our daemon exiting before it was ready',
      (): unknown => mockRecovery.mockRejectedValue(exited),
      'exited_before_ready',
      undefined,
    ],
    [
      'no daemon at all, as its own reason',
      (): unknown => mockRecovery.mockRejectedValue(timedOut),
      'daemon_unavailable',
      undefined,
    ],
    [
      'a failed probe',
      (): unknown =>
        mockProbe.mockRejectedValue(new Error('Core discovery failed.')),
      'daemon_unavailable',
      undefined,
    ],
    [
      'an initial probe timeout without a refused daemon',
      (): unknown => mockProbe.mockRejectedValue(timedOut),
      'daemon_unavailable',
      undefined,
    ],
  ])('degrades typed on %s', async (_, arrange, reason, detail) => {
    const { handoff } = await load();
    arrange();
    await handoff.startW5FlipHandoff(admitted);
    expect(handoff.getW5FlipHandoffStatus()).toEqual({
      state: 'degraded',
      reason,
      ...(detail !== undefined && { detail }),
    });
    // The background service warning shows and latches Files reads.
    expect(mockPhases).toEqual(['pending', 'degraded']);
    expect(mockLeaseClose).toHaveBeenCalled();
    expect(mockStep.stop).toHaveBeenCalled();
    expect(mockSettle).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'W5 startup handoff failed; workspace records are read-only',
      { reason, detail },
    );
  });

  it('refuses before any daemon contact when W11 registration failed', async () => {
    const { handoff } = await load();
    await handoff.startW5FlipHandoff({ admission: { kind: 'failed' } });
    expect(handoff.getW5FlipHandoffStatus()).toEqual({
      state: 'degraded',
      reason: 'host_admission_failed',
    });
    expect(mockEvents).toEqual(['stop']);
  });

  it('runs the step itself on Windows, which has no startup claim', async () => {
    const { handoff } = await load();
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      await handoff.startW5FlipHandoff(admitted);
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    expect(mockEvents).toEqual([
      'probe',
      'prepare',
      'recovery',
      'defer',
      'stop',
    ]);
  });

  it('starts once per process', async () => {
    const { handoff } = await load();
    const first = handoff.startW5FlipHandoff(admitted);
    expect(handoff.startW5FlipHandoff(admitted)).toBe(first);
    await first;
    expect(mockProbe).toHaveBeenCalledTimes(1);
  });
});

describe('disposeW5FlipHandoff', () => {
  it('closes the sessions the Files slot left open, even where the handoff never started', async () => {
    const { handoff } = await load();
    await handoff.disposeW5FlipHandoff();
    expect(mockDisposeConnections).toHaveBeenCalledTimes(1);
  });

  it('releases the record lease, then every daemon session', async () => {
    const { handoff } = await load();
    await handoff.startW5FlipHandoff(admitted);
    mockDisposeConnections.mockImplementation(() => {
      mockEvents.push('dispose-connections');
      return Promise.resolve();
    });
    mockLeaseClose.mockImplementation(() => mockEvents.push('close-lease'));
    await handoff.disposeW5FlipHandoff();
    expect(mockEvents.slice(-2)).toEqual([
      'close-lease',
      'dispose-connections',
    ]);
  });
});

describe('createW5HandoffStore', () => {
  it('forwards synchronously once settled', async () => {
    const { errors } = await load();
    const reserve = jest.fn(() => Promise.resolve());
    const degraded = errors.createW5DegradedStore(
      new errors.W5DaemonHandoffError('peer_held'),
    );
    const daemon: W5CommitLogFileStore = { ...degraded, reserve };
    const handoffStore = errors.createW5HandoffStore(Promise.resolve(daemon));
    await handoffStore.reserve({ reservationId: 'r1', operation: 'test' });
    // No await: it reached the daemon store in this turn.
    void handoffStore.reserve({ reservationId: 'r2', operation: 'test' });
    expect(reserve).toHaveBeenCalledTimes(2);
  });
});

it('refuses removals on a degraded handoff and forwards them only to the selected store', async () => {
  const { errors } = await load();
  const error = new errors.W5DaemonHandoffError('daemon_unavailable');
  const degraded = errors.createW5DegradedStore(error);
  const target = {
    namespace: 'workspace_manifest',
    writer: 'electron_main',
  } as const;
  const removal = { operation: 'remove', advance: [], previousRaw: '{}' };
  await expect(
    degraded.remove('/workspaces/a/workspace.json', target, removal),
  ).rejects.toBe(error);
  const remove = jest.fn(() => Promise.resolve());
  const selected: W5CommitLogFileStore = { ...degraded, remove };
  const handoff = errors.createW5HandoffStore(Promise.resolve(selected));
  await handoff.remove('/workspaces/a/workspace.json', target, removal);
  expect(remove).toHaveBeenCalledWith(
    '/workspaces/a/workspace.json',
    target,
    removal,
  );
});
