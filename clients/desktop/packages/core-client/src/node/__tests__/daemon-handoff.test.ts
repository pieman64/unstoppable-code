import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  type CanopyJsonValue,
} from '@canopy/protocol/canopy-core';

import { CanopyClientError, toCanopyClientError } from '../../errors';
import {
  CANOPY_DAEMON_W5_HOST_CHECK,
  classifyCanopyDaemonCapability,
  probeCanopyDaemon,
  waitForCanopyDaemonRelease,
  type CanopyDaemonCapability,
  type CanopyDaemonCapabilityInput,
  type CanopyDaemonProbe,
  type CanopyDaemonReleaseWaitOptions,
} from '../daemon-handoff';
import {
  canopyDaemonRefusal,
  canopyDaemonRefusalError,
} from '../daemon-refusal';
import type { CanopyDescriptorState } from '../descriptor';
import { attachOrStartCanopyDaemon } from '../launcher';
import { descriptorFor, ScriptedDaemon } from './fixtures/scripted-daemon';

const HASH = 'a'.repeat(64);
const CAPTURE = 'core.workspaceRecords.capture';
const COMMIT = 'core.workspaceRecords.commit';
const REQUIRED = { [CAPTURE]: { version: 1 }, [COMMIT]: { version: 1 } };

const manifest = (
  ...names: string[]
): CanopyDaemonCapabilityInput['manifest'] => ({
  has: (kind, name): boolean => kind === 'operations' && names.includes(name),
});
const op = (
  name: string,
  version = 1,
  available = true,
): { name: string; version: number; available: boolean } => ({
  name,
  version,
  available,
});
const w5Check = (
  status: 'pass' | 'warn' | 'fail',
  reason?: string,
): NonNullable<CanopyDaemonCapabilityInput['checks']>[number] => ({
  name: CANOPY_DAEMON_W5_HOST_CHECK,
  status,
  message: null,
  ...(reason !== undefined && { reason }),
});
const ACCEPT: CanopyDaemonCapability = { kind: 'accept' };
const WAIT: CanopyDaemonCapability = { kind: 'wait' };
const SKEW: CanopyDaemonCapability = {
  kind: 'refuse',
  refusal: 'version_skew',
};
const WRITER_HELD: CanopyDaemonCapability = {
  kind: 'refuse',
  refusal: 'writer_held',
};

describe('classifyCanopyDaemonCapability', () => {
  const all = manifest(CAPTURE, COMMIT);
  type Case = Omit<CanopyDaemonCapabilityInput, 'required' | 'operations'> &
    Partial<Pick<CanopyDaemonCapabilityInput, 'operations'>>;
  it.each<[string, Case, object]>([
    [
      'all advertised, but manifest.get lists none of them',
      { manifest: all, operations: [] },
      SKEW,
    ],
    [
      'all advertised at the required versions',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT)] },
      ACCEPT,
    ],
    [
      'all advertised while degraded by an unrelated check',
      {
        manifest: all,
        checks: [
          { name: 'core.daemon.git', status: 'warn', message: 'slow' },
          w5Check('pass'),
        ],
      },
      ACCEPT,
    ],
    [
      'none advertised, the W5 writer held (warn)',
      { manifest: manifest(), checks: [w5Check('warn', 'writer_unavailable')] },
      WRITER_HELD,
    ],
    [
      'none advertised, the W5 writer held (fail)',
      { manifest: manifest(), checks: [w5Check('fail', 'writer_unavailable')] },
      WRITER_HELD,
    ],
    ['none advertised, health not read', { manifest: manifest() }, WAIT],
    [
      'none advertised, no W5 check (an old daemon)',
      {
        manifest: manifest(),
        checks: [{ name: 'core.runtime', status: 'pass', message: null }],
      },
      WAIT,
    ],
    [
      'none advertised, an unknown W5 reason',
      { manifest: manifest(), checks: [w5Check('warn', 'maintenance_held')] },
      WAIT,
    ],
    [
      'none advertised, a W5 check without a reason',
      { manifest: manifest(), checks: [w5Check('warn')] },
      WAIT,
    ],
    [
      'none advertised, a passing W5 check names a stale reason',
      { manifest: manifest(), checks: [w5Check('pass', 'writer_unavailable')] },
      WAIT,
    ],
    [
      'the names advertised only as events',
      {
        manifest: {
          has: (kind, name): boolean =>
            kind === 'events' && [CAPTURE, COMMIT].includes(name),
        },
      },
      WAIT,
    ],
    ['only some advertised', { manifest: manifest(CAPTURE) }, SKEW],
    [
      'an operation at another version (RC and prod skew)',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT, 2)] },
      SKEW,
    ],
    [
      'an operation listed unavailable',
      { manifest: all, operations: [op(CAPTURE), op(COMMIT, 1, false)] },
      SKEW,
    ],
    [
      'an operation missing from manifest.get',
      { manifest: all, operations: [op(CAPTURE)] },
      SKEW,
    ],
  ])('%s', (_, input, want) => {
    expect(
      classifyCanopyDaemonCapability({
        required: REQUIRED,
        operations: [op(CAPTURE), op(COMMIT)],
        ...input,
      }),
    ).toEqual(want);
  });

  it('takes protocol definition maps as the required set', () => {
    const required = {
      ...CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
      ...CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
    };
    const names = Object.keys(required);
    const operations = Object.entries(required).map(([name, d]) =>
      op(name, d.version),
    );
    expect(
      classifyCanopyDaemonCapability({
        required,
        manifest: manifest(...names),
        operations,
      }),
    ).toEqual(ACCEPT);
    expect(
      classifyCanopyDaemonCapability({
        required,
        manifest: manifest(...names.slice(1)),
        operations,
      }),
    ).toEqual(SKEW);
  });

  it('never accepts without the manifest.get versions', () => {
    // @ts-expect-error: calls carry no version, so skew is caught only here.
    const unversioned: CanopyDaemonCapabilityInput = {
      required: REQUIRED,
      manifest: all,
    };
    expect(() => classifyCanopyDaemonCapability(unversioned)).toThrow();
  });

  it('rejects an empty required set', () => {
    let thrown: unknown;
    try {
      classifyCanopyDaemonCapability({
        required: {},
        manifest: manifest(),
        operations: [],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CanopyClientError);
    expect(toCanopyClientError(thrown).payload.kind).toBe('invalid_argument');
  });
});

describe('daemon refusals', () => {
  it('round-trips through a serialized payload and ignores foreign details', () => {
    const error = canopyDaemonRefusalError('peer_held', 'Held.');
    expect(error.payload).toMatchObject({
      kind: 'failed_precondition',
      details: { refusal: 'peer_held' },
      retry: { kind: 'never' },
    });
    expect(canopyDaemonRefusal(error)).toBe('peer_held');
    const serialized: unknown = JSON.parse(JSON.stringify(error));
    expect(canopyDaemonRefusal({ payload: serialized })).toBe('peer_held');
    const foreign = (details: CanopyJsonValue): CanopyClientError =>
      new CanopyClientError({
        kind: 'failed_precondition',
        message: 'x',
        details,
        retry: { kind: 'never' },
      });
    expect(canopyDaemonRefusal(foreign({ refusal: 'other' }))).toBeNull();
    expect(canopyDaemonRefusal(foreign(['peer_held']))).toBeNull();
    expect(canopyDaemonRefusal(new Error('peer_held'))).toBeNull();
    expect(canopyDaemonRefusal(undefined)).toBeNull();
  });
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});

type Settled<V> = V | { error: ReturnType<typeof toCanopyClientError> };
async function settle<V>(pending: Promise<V>, ms: number): Promise<Settled<V>> {
  const settled = pending.catch((error: unknown) => ({
    error: toCanopyClientError(error),
  }));
  await jest.advanceTimersByTimeAsync(ms);
  return settled;
}

const probe = (
  world: ScriptedDaemon,
  overrides: Partial<Parameters<typeof probeCanopyDaemon<string>>[0]> = {},
): Promise<CanopyDaemonProbe<string>> =>
  probeCanopyDaemon<string>({
    dataRootHash: HASH,
    ports: world,
    connect: world.attach,
    dispose: (value) => void world.events.push(`dispose:${value}`),
    timeoutMs: 1_000,
    ...overrides,
  });

const waitOut = (
  world: ScriptedDaemon,
  overrides: Partial<CanopyDaemonReleaseWaitOptions> = {},
): Promise<CanopyDescriptorState> =>
  waitForCanopyDaemonRelease({
    ports: world,
    descriptor: descriptorFor(7),
    ...overrides,
  });

describe('probeCanopyDaemon', () => {
  it('connects to a live daemon with its token and hash, never claiming or spawning', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    expect(await settle(probe(world), 0)).toEqual({
      kind: 'live',
      descriptor: descriptorFor(7),
      value: 'client-1',
    });
    expect(world.events).toEqual([
      'read',
      'inspect:7',
      'token:secret-token-ref',
      'attach:1000',
    ]);
    expect(world.endpoints).toEqual([
      {
        kind: 'socket',
        path: '/private/run/core.sock',
        auth: { secret: 'secret', dataRootHash: HASH },
      },
    ]);
  });

  it.each<[string, (w: ScriptedDaemon) => void, object]>([
    ['absent', (): void => {}, { kind: 'absent' }],
    [
      'stale',
      (w): void => void (w.raw = descriptorFor(5)),
      { kind: 'stale', reason: 'process_exited' },
    ],
    [
      'incompatible',
      (w): void => w.publish(7, 3),
      { kind: 'incompatible', descriptor: descriptorFor(7, 3) },
    ],
    [
      'unreachable',
      (w): void => {
        w.publish(7);
        w.refusals = 1;
      },
      { kind: 'unreachable', descriptor: descriptorFor(7) },
    ],
  ])('reports %s without connecting further', async (_, arrange, want) => {
    const world = new ScriptedDaemon();
    arrange(world);
    expect(await settle(probe(world), 0)).toEqual(want);
    expect(world.count('acquire') + world.count('spawn')).toBe(0);
    expect(world.count('attach')).toBeLessThanOrEqual(1);
  });

  it('bounds a hung connect and disposes its late value', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const gate = world.defer('attach');
    const outcome = await settle(probe(world), 1_000);
    expect(outcome).toMatchObject({
      error: { payload: { kind: 'deadline_exceeded' } },
    });
    gate.open();
    await jest.advanceTimersByTimeAsync(0);
    expect(world.events.at(-1)).toBe('dispose:client-1');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('redacts a failing token read and fails a non-retryable connect typed', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    world.gates.set('readToken', () =>
      Promise.reject(new Error('/private secret')),
    );
    const outcome = await settle(probe(world), 0);
    expect(outcome).toMatchObject({
      error: { payload: { kind: 'unavailable' } },
    });
    expect(JSON.stringify(outcome)).not.toMatch(/private|secret/);
    const denied = new ScriptedDaemon();
    denied.publish(7);
    const refusal = canopyDaemonRefusalError('version_skew', 'Skewed.');
    const connect = (): Promise<never> => Promise.reject(refusal);
    expect(await settle(probe(denied, { connect }), 0)).toEqual({
      error: refusal,
    });
  });

  it.each<[string, object]>([
    ['an uppercase hash', { dataRootHash: 'A'.repeat(64) }],
    ['no protocol versions', { protocolVersions: [] }],
    ['a zero timeout', { timeoutMs: 0 }],
  ])('rejects %s before any port call', async (_, overrides) => {
    const world = new ScriptedDaemon();
    const outcome = await settle(probe(world, overrides), 0);
    expect(outcome).toMatchObject({
      error: { payload: { kind: 'invalid_argument' } },
    });
    expect(world.events).toEqual([]);
  });
});

describe('waitForCanopyDaemonRelease', () => {
  it.each<[string, (w: ScriptedDaemon) => void, object]>([
    [
      'its process exits',
      (w): void => w.exit(7),
      { kind: 'stale', reason: 'process_exited' },
    ],
    [
      'it withdraws its descriptor',
      (w): void => void (w.raw = null),
      { kind: 'absent' },
    ],
    [
      'another daemon replaces it',
      (w): void => w.publish(8),
      { kind: 'live', descriptor: descriptorFor(8) },
    ],
  ])(
    'waits, reading only the descriptor, until %s',
    async (_, release, want) => {
      const world = new ScriptedDaemon();
      world.publish(7);
      setTimeout(() => release(world), 30_000);
      expect(await settle(waitOut(world), 30_250)).toEqual(want);
      expect(world.count('read')).toBeGreaterThan(100);
      expect(
        world.events.filter((e) => !/^(read|inspect:\d+)$/.test(e)),
      ).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);
    },
  );

  it('waits out the same daemon even while it is incompatible', async () => {
    const world = new ScriptedDaemon();
    world.publish(7, 3);
    setTimeout(() => world.exit(7), 1_000);
    expect(
      await settle(waitOut(world, { descriptor: descriptorFor(7, 3) }), 1_250),
    ).toMatchObject({ kind: 'stale' });
  });

  it('refuses peer_held at its default 45 s bound', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const pending = waitOut(world);
    const early = await settle(
      Promise.race([pending, new Promise((d) => setTimeout(d, 44_000))]),
      44_000,
    );
    expect(early).toBeUndefined();
    const outcome = await settle(pending, 1_000);
    const error = 'error' in outcome ? outcome.error : undefined;
    expect(error).toBeInstanceOf(CanopyClientError);
    expect(canopyDaemonRefusal(error)).toBe('peer_held');
    expect(error?.payload.kind).toBe('failed_precondition');
    expect(jest.getTimerCount()).toBe(0);
  });

  it('keeps cancellation and malformed descriptors as their own failures', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const abort = new AbortController();
    setTimeout(() => abort.abort(), 500);
    const cancelled = await settle(
      waitOut(world, { signal: abort.signal }),
      500,
    );
    expect(cancelled).toMatchObject({
      error: { payload: { kind: 'cancelled' } },
    });
    world.raw = { pid: 7 };
    const malformed = await settle(waitOut(world), 0);
    expect(malformed).toMatchObject({
      error: { payload: { kind: 'failed_precondition' } },
    });
    const error = 'error' in malformed ? malformed.error : undefined;
    expect(canopyDaemonRefusal(error)).toBeNull();
  });
});

describe('the GB12 startup sequence over scripted daemons', () => {
  const launchW5 = (
    world: ScriptedDaemon,
  ): Promise<Awaited<ReturnType<typeof attachOrStartCanopyDaemon<string>>>> =>
    attachOrStartCanopyDaemon<string>({
      dataRoot: '/private/data',
      dataRootHash: HASH,
      runtimeMode: 'prod',
      daemon: { executable: '/private/bin/canopy', w5Host: true },
      ports: world,
      attach: world.attach,
      dispose: (client) => void world.events.push(`dispose:${client}`),
      beforeSpawn: {
        timeoutMs: 1_000,
        run: (): Promise<void> => {
          world.events.push('beforeSpawn');
          return Promise.resolve();
        },
      },
      platform: 'darwin',
      timeoutMs: 1_000,
    });

  /** Probe, classify (an old daemon serves no W5 operations), wait, then launch. */
  async function handoff(world: ScriptedDaemon): Promise<string> {
    const found = await probe(world, { timeoutMs: 30_000 });
    if (found.kind === 'live') {
      const verdict = classifyCanopyDaemonCapability({
        required: REQUIRED,
        manifest: manifest(),
        operations: [],
      });
      world.events.push(`close:${found.value}`);
      if (verdict.kind !== 'wait') throw new Error(verdict.kind);
    }
    if (found.kind !== 'absent' && found.kind !== 'stale')
      await waitOut(world, { descriptor: found.descriptor });
    world.events.push('launch');
    const { value } = await launchW5(world);
    return value;
  }

  it.each<[string, number]>([
    ['a refused live daemon in its idle grace', 1],
    ['an incompatible daemon left by an update', 3],
  ])('waits out %s, then spawns ours with --w5-host v1', async (_, major) => {
    const world = new ScriptedDaemon();
    world.publish(7, major);
    // The old daemon's 30 s idle grace ends, then it stops.
    setTimeout(() => world.exit(7), 32_000);
    // Only a compatible daemon was connected to (and closed) by the probe.
    const client = major === 1 ? 'client-2' : 'client-1';
    expect(await settle(handoff(world), 33_000)).toBe(client);
    expect(world.spawns[0]?.args.slice(-2)).toEqual(['--w5-host', 'v1']);
    const tail = world.events.slice(world.events.indexOf('launch'));
    expect(tail.slice(0, 8)).toEqual([
      'launch',
      'read',
      'inspect:7',
      'acquire',
      'read',
      'inspect:7',
      'beforeSpawn',
      'spawn',
    ]);
    expect(world.count('acquire')).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('refuses peer_held when the peer outlives the wait, spawning nothing', async () => {
    const world = new ScriptedDaemon();
    world.publish(7);
    const outcome = await settle(handoff(world), 46_000);
    const error = typeof outcome === 'string' ? undefined : outcome.error;
    expect(error).toBeInstanceOf(CanopyClientError);
    expect(canopyDaemonRefusal(error)).toBe('peer_held');
    expect(world.count('acquire') + world.count('spawn')).toBe(0);
    expect(world.events).not.toContain('launch');
  });
});
