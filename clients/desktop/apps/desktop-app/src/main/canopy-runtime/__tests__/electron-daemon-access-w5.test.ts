// GB12 (CAN-5543): the flip build's daemon launch inputs and the capability
// check every connection passes before its lease, over synthetic daemons.
import {
  CanopyClientError,
  type CanopyClientQueryOptions,
} from '@canopy/core-client';
import type * as CoreClient from '@canopy/core-client';
import type { createDaemonFilesRoute } from '../daemon-files-route';
import type * as CoreClientNode from '@canopy/core-client/node';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import type { ElectronDaemonConnectionOptions } from '../electron-daemon-connection';
import type * as Access from '../electron-daemon-access';
import type {
  ElectronDaemonClient,
  ElectronDaemonHostInputs,
} from '../electron-daemon-host';
import type { LabsExperimentsService } from '../../services/labs-experiments-service';

let mockFlip = false;
let mockOptions:
  | ElectronDaemonConnectionOptions<ElectronDaemonClient>
  | undefined;
const mockCreateHost = jest.fn<Promise<object>, [ElectronDaemonHostInputs]>();
const mockAttachDaemon = jest.fn();
const mockProbe = jest.fn();
const mockPrepare = jest.fn<Promise<void>, [string]>(() => Promise.resolve());
const mockRequirePrepared = jest.fn<void, []>();
let mockFilesOptions: Parameters<typeof createDaemonFilesRoute>[0];
const mockLabsSubscribe = jest.fn<
  ReturnType<LabsExperimentsService['onSnapshotChanged']>,
  Parameters<LabsExperimentsService['onSnapshotChanged']>
>(() => jest.fn<void, []>());
jest.mock('../../services/labs-experiments-runtime', (): object => ({
  getLabsExperimentsService: () => ({
    getSnapshot: () => ({
      ready: true,
      experiments: [{ id: 'daemon-files-reads', enabled: true }],
    }),
    onSnapshotChanged: mockLabsSubscribe,
  }),
}));
jest.mock('../daemon-files-route', (): object => ({
  createDaemonFilesRoute: (options: typeof mockFilesOptions): object => {
    mockFilesOptions = options;
    return { dispose: jest.fn() };
  },
}));
jest.mock('../../lib/resolve-worktree', (): object => ({
  resolveWorktreeTargetIds: jest.fn(),
}));
jest.mock('../../lib/workspace-registry', (): object => ({
  getWorkspaceType: jest.fn(),
}));

jest.mock('electron', (): object => ({ app: { getVersion: () => '2.5.0' } }));
jest.mock('../../lib/w5-flip-gate', (): object => ({
  isW5DaemonFlipCompiled: (): boolean => mockFlip,
}));
jest.mock('../../lib/w5-flip-backup', (): object => ({
  prepareW5FlipSpawn: (version: string) => mockPrepare(version),
  requireW5FlipSpawnPrepared: (): void => mockRequirePrepared(),
}));
jest.mock('@canopy/core-client/node', (): object => ({
  ...jest.requireActual<typeof CoreClientNode>('@canopy/core-client/node'),
  attachOrStartCanopyDaemon: (...args: unknown[]): unknown =>
    mockAttachDaemon(...args),
  probeCanopyDaemon: (...args: unknown[]): unknown => mockProbe(...args),
}));
jest.mock('../electron-daemon-host', (): object => ({
  ELECTRON_DAEMON_DEFINITIONS: {},
  createElectronDaemonHost: (
    inputs: ElectronDaemonHostInputs,
  ): Promise<object> => mockCreateHost(inputs),
}));
jest.mock('../electron-daemon-connection', (): object => ({
  createElectronDaemonConnectionService: (
    options: ElectronDaemonConnectionOptions<ElectronDaemonClient>,
  ): object => {
    mockOptions = options;
    return { get: jest.fn(), dispose: () => Promise.resolve() };
  },
}));

const REQUIRED = {
  ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
};
const DESCRIPTOR = { pid: 7, startIdentity: 'old' };

interface FakeDaemon {
  served: readonly string[];
  versionOffset?: number;
  w5Check?: { status: 'pass' | 'warn' | 'fail'; reason?: string };
}

function client(daemon: FakeDaemon): {
  manifest: { has: (kind: string, name: string) => boolean };
  query: jest.Mock<
    Promise<unknown>,
    [string, object?, CanopyClientQueryOptions?]
  >;
  close: jest.Mock<Promise<void>, []>;
  signal: AbortSignal;
} {
  return {
    signal: new AbortController().signal,
    manifest: { has: (_kind, name) => daemon.served.includes(name) },
    query: jest.fn<
      Promise<unknown>,
      [string, object?, CanopyClientQueryOptions?]
    >((name) =>
      Promise.resolve(
        name === 'core.runtime.manifest.get'
          ? {
              operations: daemon.served.map((op) => ({
                name: op,
                available: true,
                version:
                  (Object.entries(REQUIRED).find(([n]) => n === op)?.[1]
                    .version ?? 0) + (daemon.versionOffset ?? 0),
              })),
            }
          : {
              runtime: { state: 'ready' },
              checks: daemon.w5Check
                ? [{ name: 'core.daemon.w5-commit-log', ...daemon.w5Check }]
                : [],
            },
      ),
    ),
    close: jest.fn<Promise<void>, []>(() => Promise.resolve()),
  };
}

const W5 = Object.keys(REQUIRED);

async function load(): Promise<typeof Access> {
  const access = await import('../electron-daemon-access');
  access.getElectronDaemonConnections();
  return access;
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  mockOptions = undefined;
  mockFlip = false;
  mockCreateHost.mockResolvedValue({
    authorityId: 'authority',
    canonicalDataRoot: '/private/data',
    launch: { dataRootHash: 'a'.repeat(64), ports: {} },
    connect: jest.fn(),
  });
});

function attachWith(daemon: FakeDaemon): {
  result: Promise<ElectronDaemonClient>;
  fake: ReturnType<typeof client>;
} {
  const fake = client(daemon);
  mockAttachDaemon.mockResolvedValue({ value: fake });
  if (!mockOptions) throw new Error('No connection service');
  return {
    result: mockOptions.attach(new AbortController().signal),
    fake,
  };
}

describe('legacy rows', () => {
  it('launch and attach exactly as before', async () => {
    await load();
    const { result, fake } = attachWith({ served: [] });
    await expect(result).resolves.toBe(fake);
    expect(mockCreateHost).toHaveBeenCalledWith({});
    expect(mockOptions?.setupTimeoutMs).toBeUndefined();
    expect(fake.query).not.toHaveBeenCalled();
  });
});

describe('a flip build', () => {
  beforeEach(() => {
    mockFlip = true;
  });

  it('spawns with the W5 host after the claimed pre-spawn step, under a longer setup bound', async () => {
    await load();
    const { result } = attachWith({ served: W5 });
    await result;
    const [inputs] = mockCreateHost.mock.calls[0] ?? [];
    expect(Object.keys(inputs ?? {})).toEqual(['w5']);
    expect(inputs?.w5?.beforeSpawn?.timeoutMs).toBe(120_000);
    await inputs?.w5?.beforeSpawn?.run(new AbortController().signal);
    expect(mockPrepare).toHaveBeenCalledWith('2.5.0');
    expect(mockOptions?.setupTimeoutMs).toBe(150_000);
    // The claimed spawn runs the step itself.
    expect(mockRequirePrepared).not.toHaveBeenCalled();
  });

  it('leaves the step to the handoff on Windows, which has no startup claim, and launches only once it ran', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const unprepared = new Error('spawn-unprepared');
    try {
      await load();
      await attachWith({ served: W5 }).result;
      expect(mockRequirePrepared).toHaveBeenCalledTimes(1);
      mockRequirePrepared.mockImplementationOnce(() => {
        throw unprepared;
      });
      mockAttachDaemon.mockClear();
      await expect(attachWith({ served: W5 }).result).rejects.toBe(unprepared);
      expect(mockAttachDaemon).not.toHaveBeenCalled();
    } finally {
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
    expect(mockCreateHost).toHaveBeenCalledWith({ w5: {} });
  });

  it('accepts a daemon serving every record operation at our versions, keeping it open', async () => {
    await load();
    const { result, fake } = attachWith({
      served: W5,
      w5Check: { status: 'warn', reason: 'unrelated' },
    });
    await expect(result).resolves.toBe(fake);
    expect(fake.close).not.toHaveBeenCalled();
    expect(fake.query.mock.calls.map(([name]) => name).sort()).toEqual([
      'core.runtime.health.get',
      'core.runtime.manifest.get',
    ]);
  });

  it.each<[string, FakeDaemon, string]>([
    [
      'an old daemon without W5, which the handoff waited out',
      { served: [] },
      'peer_held',
    ],
    [
      'an in-process peer holding the log',
      { served: [], w5Check: { status: 'fail', reason: 'writer_unavailable' } },
      'writer_held',
    ],
    [
      'an RC or prod peer at other versions',
      { served: W5, versionOffset: 1 },
      'version_skew',
    ],
    ['a daemon serving only some', { served: W5.slice(0, 1) }, 'version_skew'],
  ])('closes and refuses %s before any lease', async (_, daemon, refusal) => {
    const { canopyDaemonRefusal } = jest.requireActual<typeof CoreClientNode>(
      '@canopy/core-client/node',
    );
    await load();
    const { result, fake } = attachWith(daemon);
    const error: unknown = await result.then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(canopyDaemonRefusal(error)).toBe(refusal);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe('probeElectronDaemonW5', () => {
  it.each<[string, unknown, object]>([
    ['absent', { kind: 'absent' }, { kind: 'absent' }],
    ['stale', { kind: 'stale' }, { kind: 'absent' }],
    [
      'incompatible',
      { kind: 'incompatible', descriptor: DESCRIPTOR },
      { kind: 'wait', descriptor: DESCRIPTOR, refusal: 'version_skew' },
    ],
    [
      'unreachable',
      { kind: 'unreachable', descriptor: DESCRIPTOR },
      { kind: 'wait', descriptor: DESCRIPTOR },
    ],
  ])('maps a %s descriptor', async (_, probe, verdict) => {
    const access = await load();
    mockProbe.mockResolvedValue(probe);
    await expect(access.probeElectronDaemonW5(1_000)).resolves.toEqual(verdict);
  });

  it.each<[string, FakeDaemon, object]>([
    ['serves W5', { served: W5 }, { kind: 'accept' }],
    [
      'cannot serve W5',
      { served: [] },
      { kind: 'wait', descriptor: DESCRIPTOR },
    ],
    [
      'holds the log for a peer',
      { served: [], w5Check: { status: 'fail', reason: 'writer_unavailable' } },
      { kind: 'refuse', refusal: 'writer_held' },
    ],
    [
      'serves W5 at other versions, to wait out before refusing version_skew',
      { served: W5, versionOffset: 1 },
      { kind: 'wait', descriptor: DESCRIPTOR, refusal: 'version_skew' },
    ],
  ])(
    'classifies a live daemon that %s and closes it',
    async (_, daemon, verdict) => {
      const access = await load();
      const fake = client(daemon);
      mockProbe.mockResolvedValue({
        kind: 'live',
        descriptor: DESCRIPTOR,
        value: fake,
      });
      await expect(access.probeElectronDaemonW5(1_000)).resolves.toEqual(
        verdict,
      );
      expect(fake.close).toHaveBeenCalledTimes(1);
    },
  );
});

describe('probeElectronDaemonW5 when the read fails', () => {
  it('waits out a daemon that drops the probe as it exits on idle', async () => {
    const access = await load();
    const fake = client({ served: [] });
    fake.query.mockRejectedValue(
      new CanopyClientError({
        kind: 'unavailable',
        message: 'Connection closed.',
        retry: { kind: 'never' },
      }),
    );
    mockProbe.mockResolvedValue({
      kind: 'live',
      descriptor: DESCRIPTOR,
      value: fake,
    });
    await expect(access.probeElectronDaemonW5(1_000)).resolves.toEqual({
      kind: 'wait',
      descriptor: DESCRIPTOR,
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('fails on any other read error', async () => {
    const access = await load();
    const fake = client({ served: [] });
    const { CanopyClientError: CurrentClientError } = jest.requireActual<
      typeof CoreClient
    >('@canopy/core-client');
    const failure = new CurrentClientError({
      kind: 'internal',
      message: 'Broken.',
      retry: { kind: 'never' },
    });
    fake.query.mockRejectedValue(failure);
    mockProbe.mockResolvedValue({
      kind: 'live',
      descriptor: DESCRIPTOR,
      value: fake,
    });
    await expect(access.probeElectronDaemonW5(1_000)).rejects.toBe(failure);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('propagates handoff cancellation during discovery', async () => {
    const access = await load();
    const owner = new AbortController();
    mockProbe.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      owner.abort();
      expect(signal.aborted).toBe(true);
      return Promise.resolve({ kind: 'absent' });
    });
    await expect(
      access.probeElectronDaemonW5(1_000, owner.signal),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
  });
});

describe('the capability read budget', () => {
  afterEach(() => jest.useRealTimers());

  it.each(['core.runtime.manifest.get', 'core.runtime.health.get'])(
    'ends a probe when %s never answers, closing its client',
    async (hung) => {
      const access = await load();
      const fake = client({ served: W5 });
      const answer = fake.query.getMockImplementation();
      fake.query.mockImplementation((name) =>
        name === hung
          ? new Promise(() => {})
          : (answer?.(name) ?? Promise.resolve({})),
      );
      mockProbe.mockResolvedValue({
        kind: 'live',
        descriptor: DESCRIPTOR,
        value: fake,
      });
      jest.useFakeTimers();
      const outcomes: unknown[] = [];
      void access.probeElectronDaemonW5(1_000).then(
        (value) => outcomes.push(value),
        (error: unknown) => outcomes.push(error),
      );
      await jest.advanceTimersByTimeAsync(1_000);
      expect(outcomes).toMatchObject([
        { payload: { kind: 'deadline_exceeded' } },
      ]);
      expect(fake.close).toHaveBeenCalledTimes(1);
      for (const [, , options] of fake.query.mock.calls) {
        expect(options?.signal?.aborted).toBe(true);
        expect(options?.metadata?.deadlineAt).toBeDefined();
      }
    },
  );

  it('includes discovery time in the capability read budget', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    fake.query.mockImplementation(() => new Promise(() => {}));
    jest.useFakeTimers();
    mockProbe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({ kind: 'live', descriptor: DESCRIPTOR, value: fake }),
            600,
          );
        }),
    );
    const outcomes: unknown[] = [];
    void access
      .probeElectronDaemonW5(1_000)
      .catch((error: unknown) => outcomes.push(error));
    await jest.advanceTimersByTimeAsync(600);
    expect(fake.query).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(400);
    expect(outcomes).toMatchObject([
      { payload: { kind: 'deadline_exceeded' } },
    ]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('closes a discovery result that arrives after the deadline without querying it', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    jest.useFakeTimers();
    mockProbe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({ kind: 'live', descriptor: DESCRIPTOR, value: fake }),
            1_500,
          );
        }),
    );
    const outcomes: unknown[] = [];
    void access
      .probeElectronDaemonW5(1_000)
      .catch((error: unknown) => outcomes.push(error));
    await jest.advanceTimersByTimeAsync(1_000);
    expect(outcomes).toMatchObject([
      { payload: { kind: 'deadline_exceeded' } },
    ]);
    expect(fake.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(500);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.query).not.toHaveBeenCalled();
  });

  it('does not discover or connect for an already cancelled handoff', async () => {
    const access = await load();
    const owner = new AbortController();
    owner.abort();
    await expect(
      access.probeElectronDaemonW5(30_000, owner.signal),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(mockCreateHost).not.toHaveBeenCalled();
    expect(mockProbe).not.toHaveBeenCalled();
  });

  it('closes a live discovery result at the deadline even before the expiry timer runs', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    jest.useFakeTimers();
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    try {
      mockProbe.mockImplementationOnce(() => {
        now.mockReturnValue(1_000);
        return Promise.resolve({
          kind: 'live',
          descriptor: DESCRIPTOR,
          value: fake,
        });
      });
      await expect(access.probeElectronDaemonW5(1_000)).rejects.toMatchObject({
        payload: { kind: 'deadline_exceeded' },
      });
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(fake.query).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it('closes discovery arriving after cancellation without querying or changing the outcome', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    jest.useFakeTimers();
    mockProbe.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({ kind: 'live', descriptor: DESCRIPTOR, value: fake }),
            100,
          );
        }),
    );
    const owner = new AbortController();
    const outcomes: unknown[] = [];
    void access.probeElectronDaemonW5(1_000, owner.signal).then(
      (value) => outcomes.push(value),
      (error: unknown) => outcomes.push(error),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(mockProbe).toHaveBeenCalledTimes(1);
    owner.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcomes).toMatchObject([{ payload: { kind: 'cancelled' } }]);
    expect(fake.close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(outcomes).toMatchObject([{ payload: { kind: 'cancelled' } }]);
    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(fake.query).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
  });

  it.each(['cancelled', 'deadline_exceeded'] as const)(
    'ignores successful capability replies arriving after %s',
    async (kind) => {
      const access = await load();
      const fake = client({ served: W5 });
      const answer = fake.query.getMockImplementation();
      if (!answer) throw new Error('No capability answers');
      jest.useFakeTimers();
      fake.query.mockImplementation(
        (name) =>
          new Promise((resolve) => {
            setTimeout(() => resolve(answer(name)), 1_500);
          }),
      );
      mockProbe.mockResolvedValue({
        kind: 'live',
        descriptor: DESCRIPTOR,
        value: fake,
      });
      const owner = new AbortController();
      const outcomes: unknown[] = [];
      void access.probeElectronDaemonW5(1_000, owner.signal).then(
        (value) => outcomes.push(value),
        (error: unknown) => outcomes.push(error),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(fake.query).toHaveBeenCalledTimes(2);
      if (kind === 'cancelled') owner.abort();
      await jest.advanceTimersByTimeAsync(1_000);
      expect(outcomes).toMatchObject([{ payload: { kind } }]);
      expect(fake.close).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(500);
      expect(outcomes).toMatchObject([{ payload: { kind } }]);
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it.each(['cancelled', 'deadline_exceeded'] as const)(
    'ends capability classification with %s on an ordinary flip connection too',
    async (kind) => {
      mockFlip = true;
      await load();
      const fake = client({ served: W5 });
      fake.query.mockImplementation(() => new Promise(() => {}));
      mockAttachDaemon.mockResolvedValue({ value: fake });
      jest.useFakeTimers();
      const owner = new AbortController();
      const outcomes: unknown[] = [];
      if (!mockOptions) throw new Error('No connection service');
      void mockOptions.attach(owner.signal).then(
        (value) => outcomes.push(value),
        (error: unknown) => outcomes.push(error),
      );
      await jest.advanceTimersByTimeAsync(0);
      expect(fake.query).toHaveBeenCalledTimes(2);
      if (kind === 'cancelled') owner.abort();
      await jest.advanceTimersByTimeAsync(kind === 'cancelled' ? 0 : 30_000);
      expect(outcomes).toMatchObject([{ payload: { kind } }]);
      expect(fake.close).toHaveBeenCalledTimes(1);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('cancels a hung capability read at quit, without waiting for its deadline', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    fake.query.mockImplementation(() => new Promise(() => {}));
    mockProbe.mockResolvedValue({
      kind: 'live',
      descriptor: DESCRIPTOR,
      value: fake,
    });
    jest.useFakeTimers();
    const owner = new AbortController();
    const outcomes: unknown[] = [];
    void access.probeElectronDaemonW5(30_000, owner.signal).then(
      (value) => outcomes.push(value),
      (error: unknown) => outcomes.push(error),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(fake.query).toHaveBeenCalledTimes(2);
    owner.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcomes).toMatchObject([{ payload: { kind: 'cancelled' } }]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('does not mistake cancellation closing the client for an idle exit', async () => {
    const access = await load();
    const fake = client({ served: W5 });
    const socket = new AbortController();
    fake.signal = socket.signal;
    fake.query.mockImplementation(() => new Promise(() => {}));
    mockProbe.mockResolvedValue({
      kind: 'live',
      descriptor: DESCRIPTOR,
      value: fake,
    });
    jest.useFakeTimers();
    const owner = new AbortController();
    owner.signal.addEventListener('abort', () => socket.abort());
    const outcomes: unknown[] = [];
    void access.probeElectronDaemonW5(30_000, owner.signal).then(
      (value) => outcomes.push(value),
      (error: unknown) => outcomes.push(error),
    );
    await jest.advanceTimersByTimeAsync(0);
    expect(fake.query).toHaveBeenCalledTimes(2);
    owner.abort();
    await jest.advanceTimersByTimeAsync(0);
    expect(outcomes).toMatchObject([{ payload: { kind: 'cancelled' } }]);
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});

describe('Files constructed after the handoff settles', () => {
  it('preserves an admission failure before Files registers, warning and latching its fallback', async () => {
    const access = await load();
    const { getElectronDaemonHealth } =
      await import('../electron-daemon-health');
    const health = getElectronDaemonHealth();
    access.noteElectronW5Handoff('pending');
    access.noteElectronW5Handoff('degraded');
    expect(health.getStatus().state).toBe('ok');
    const files = await import('../electron-daemon-files-access');
    files.getDesktopDaemonFilesRoute();
    expect(health.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'start_failed',
    });
    expect(health.isLatched()).toBe(true);
    expect(mockFilesOptions.reachability?.isLatched()).toBe(true);
    expect(mockAttachDaemon).not.toHaveBeenCalled();
  });

  it.each(['ready', 'cancelled'] as const)(
    'shows nothing for a %s handoff on late registration',
    async (phase) => {
      const access = await load();
      access.noteElectronW5Handoff('pending');
      access.noteElectronW5Handoff(phase);
      const files = await import('../electron-daemon-files-access');
      files.getDesktopDaemonFilesRoute();
      const { getElectronDaemonHealth } =
        await import('../electron-daemon-health');
      expect(getElectronDaemonHealth().getStatus().state).toBe('ok');
      expect(getElectronDaemonHealth().isLatched()).toBe(false);
    },
  );

  it('retains degradation until Files is enabled, but never replays it after Try again', async () => {
    const access = await load();
    const { getElectronDaemonHealth } =
      await import('../electron-daemon-health');
    const health = getElectronDaemonHealth();
    access.setElectronDaemonFilesConsumerEnabled(false);
    access.noteElectronW5Handoff('degraded');
    expect(health.getStatus().state).toBe('ok');
    access.setElectronDaemonFilesConsumerEnabled(true);
    expect(health.getStatus()).toMatchObject({
      state: 'unavailable',
      reason: 'start_failed',
    });
    expect(health.isLatched()).toBe(true);
    await health.retry(() => Promise.resolve(true));
    access.setElectronDaemonFilesConsumerEnabled(true);
    expect(health.getStatus().state).toBe('ok');
    access.setElectronDaemonFilesConsumerEnabled(false);
    access.setElectronDaemonFilesConsumerEnabled(true);
    expect(health.getStatus().state).toBe('ok');
    expect(health.isLatched()).toBe(false);
  });
});

// q-13 and #7297: the handoff is a restart window; a degraded one warns.
describe('the handoff as background service reachability', () => {
  const refusal = (
    kind: CoreClientNode.CanopyDaemonRefusal,
  ): CanopyClientError =>
    jest
      .requireActual<typeof CoreClientNode>('@canopy/core-client/node')
      .canopyDaemonRefusalError(kind, 'Refused.');

  async function loadWithHealth(): Promise<{
    access: typeof Access;
    shown: (string | undefined)[];
  }> {
    const access = await load();
    const { getElectronDaemonHealth } =
      await import('../electron-daemon-health');
    const health = getElectronDaemonHealth();
    health.setConsumerEnabled('files_reads', true);
    const shown: (string | undefined)[] = [];
    health.onStatusChanged((status) => {
      shown.push(status.state === 'unavailable' ? status.reason : status.state);
    });
    return { access, shown };
  }

  it('claims only W5 capability refusals while the handoff is pending', async () => {
    const { access, shown } = await loadWithHealth();
    const claims = (error: unknown): boolean | undefined =>
      mockOptions?.isRestartRefusal?.(error);
    expect(claims(refusal('peer_held'))).toBe(false);
    access.noteElectronW5Handoff('pending');
    expect(access.isElectronW5HandoffPending()).toBe(true);
    for (const kind of ['writer_held', 'peer_held', 'version_skew'] as const)
      expect(claims(refusal(kind))).toBe(true);
    expect(claims(refusal('exited_before_ready'))).toBe(false);
    expect(claims(new Error('spawn failed'))).toBe(false);
    access.noteElectronW5Handoff('ready');
    expect(access.isElectronW5HandoffPending()).toBe(false);
    expect(claims(refusal('peer_held'))).toBe(false);
    expect(shown).toEqual([]);
  });

  it('warns and latches once the handoff degrades', async () => {
    const { access, shown } = await loadWithHealth();
    const { getElectronDaemonHealth } =
      await import('../electron-daemon-health');
    access.noteElectronW5Handoff('pending');
    access.noteElectronW5Handoff('degraded');
    expect(access.isElectronW5HandoffPending()).toBe(false);
    expect(shown).toEqual(['start_failed']);
    expect(getElectronDaemonHealth().isLatched()).toBe(true);
  });

  it('shows nothing when quit cancels the handoff', async () => {
    const { access, shown } = await loadWithHealth();
    const { getElectronDaemonHealth } =
      await import('../electron-daemon-health');
    access.noteElectronW5Handoff('pending');
    access.noteElectronW5Handoff('cancelled');
    expect(access.isElectronW5HandoffPending()).toBe(false);
    expect(shown).toEqual([]);
    expect(getElectronDaemonHealth().isLatched()).toBe(false);
  });
});
