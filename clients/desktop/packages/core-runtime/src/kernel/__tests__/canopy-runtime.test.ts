import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError, createCanopyDispatcher } from '../../index';
import type {
  CanopyDispatcher,
  CanopyDispatcherQueryResult,
  CanopyDispatcherStreamEnd,
  CanopyDispatcherStreamItem,
  CanopyStreamFrame,
} from '../../index';
import {
  CANOPY_RUNTIME_QUERY_DEFINITIONS,
  createCanopyRuntime,
  type CanopyRuntime,
  type CanopyRuntimeIdentity,
  type CanopyRuntimeQueries,
  type CanopyRuntimeStreams,
} from '../canopy-runtime';
import type { RuntimeHealthCheck, RuntimeService } from '../service-container';
import type { RuntimePrincipal } from '../runtime-profile-manifest';

const caller: CanopyCallerDescriptor = {
  principalId: 'test',
  clientInstanceId: 'client',
  authorityId: 'authority',
  interfaceKind: 'test',
  grants: ['core.runtime.read', 'core.example.write'],
};
const instructions = defineCanopyInstructionRegistry('core', {
  'core.example.write': defineCanopyInstruction({
    plane: 'core',
    domain: 'example',
    version: 1,
    placement: 'core-only',
    idempotency: 'keyed',
    requiredGrants: ['core.example.write'],
    params: CanopyStreamCursorSchema,
    result: CanopyStreamCursorSchema,
    error: CanopyErrorPayloadSchema,
  }),
});
const identity = { runtimeId: 'runtime', hostId: 'host', authorityId: null };
const cursor = { daemonEpoch: 'one', sequence: 1 };

let log: string[] = [];
beforeEach(() => {
  log = [];
});

type Runtime = CanopyRuntime<
  CanopyDispatcher<
    CanopyRuntimeQueries,
    typeof instructions,
    CanopyRuntimeStreams
  >
>;
type Events = 'core.runtime.events';
type Frame = CanopyStreamFrame<
  CanopyDispatcherStreamItem<CanopyRuntimeStreams, Events>,
  CanopyDispatcherStreamEnd<CanopyRuntimeStreams, Events>
>;

function create(
  options: {
    identity?: CanopyRuntimeIdentity;
    services?: RuntimeService[];
    phaseDeadlineMs?: number;
    closeDispatcher?: () => Promise<void>;
    principalFor?: () => RuntimePrincipal | null;
  } = {},
): Runtime {
  const runtime = createCanopyRuntime({
    profile: 'core',
    identity: options.identity ?? identity,
    definitions: { queries: {}, instructions, streams: {} },
    owners: [{ name: 'core.example', operations: ['core.example.write'] }],
    services: options.services ?? [],
    principalFor: options.principalFor,
    phaseDeadlineMs: options.phaseDeadlineMs ?? 1_000,
    createDispatcher: (input) => {
      const dispatcher = createCanopyDispatcher({
        profile: input.profile,
        definitions: input.definitions,
        handlers: {
          ...input.runtimeHandlers,
          instructions: { 'core.example.write': (params) => params },
        },
        shutdownTimeoutMs: 50,
      });
      const drain = dispatcher.drainInstructions.bind(dispatcher);
      const close = dispatcher.shutdown.bind(dispatcher);
      return Object.assign(dispatcher, {
        drainInstructions: (): void => {
          log.push('drain');
          drain();
        },
        shutdown: async (): Promise<void> => {
          const write = await dispatcher
            .instruction('core.example.write', cursor, {
              caller,
              metadata: { idempotencyKey: 'late' },
            })
            .then(
              () => 'admitted',
              (error: unknown) =>
                error instanceof CanopyOperationError
                  ? error.payload.kind
                  : 'thrown',
            );
          const health = await dispatcher.query(
            'core.runtime.health.get',
            {},
            { caller },
          );
          log.push(`cancel write=${write} read=${health.runtime.state}`);
          await (options.closeDispatcher ?? close)();
        },
      });
    },
  });
  // Desktop overrides shutdown this way; phase 3 must not re-enter it.
  Object.assign(runtime.dispatcher, {
    shutdown: async (): Promise<void> =>
      void (await runtime.shutdown('override')),
  });
  return runtime;
}
async function subscribe(
  runtime: Runtime,
  from: CanopyStreamCursor | null = null,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  await runtime.dispatcher.openStream(
    'core.runtime.events',
    { cursor: from },
    {
      caller,
      onFrame: (frame) => {
        frames.push(frame);
        log.push(
          frame.kind === 'item'
            ? `event ${frame.item.event}`
            : `end ${frame.outcome}`,
        );
      },
    },
  );
  return frames;
}
const health = (
  runtime: Runtime,
): Promise<
  CanopyDispatcherQueryResult<CanopyRuntimeQueries, 'core.runtime.health.get'>
> => runtime.dispatcher.query('core.runtime.health.get', {}, { caller });
const stopHooks = (name: string): RuntimeService['stop'] => {
  const hook = (phase: number) => (): void =>
    void log.push(`stop${phase} ${name}`);
  return { 3: hook(3), 4: hook(4), 5: hook(5), 6: hook(6), 7: hook(7) };
};

describe('createCanopyRuntime', () => {
  it('serves the effective installed manifest using the trusted host principal', async () => {
    let principal: RuntimePrincipal | null = 'interface';
    const runtime = create({ principalFor: () => principal });
    await runtime.start();
    const manifest = await runtime.dispatcher.query(
      'core.runtime.manifest.get',
      {},
      { caller },
    );
    expect(manifest.runtime).toMatchObject({ profile: 'core', state: 'ready' });
    expect(manifest.operations.map((operation) => operation.name)).toEqual([
      'core.runtime.events',
      'core.runtime.health.get',
      'core.runtime.manifest.get',
    ]);
    principal = 'delegating-primary';
    await expect(
      runtime.dispatcher.query('core.runtime.manifest.get', {}, { caller }),
    ).resolves.toMatchObject({ operations: [] });
    principal = null;
    await expect(
      runtime.dispatcher.query(
        'core.runtime.manifest.get',
        { includeUnavailable: true },
        { caller },
      ),
    ).resolves.toMatchObject({ operations: [] });
    await runtime.shutdown('test');
  });
  it('preserves the acknowledged cursor when closed before any new event', async () => {
    const runtime = create();
    await runtime.start();
    const { daemonEpoch } = (await health(runtime)).runtime;
    const acknowledged = { daemonEpoch, sequence: 1 };
    const handle = await runtime.dispatcher.openStream(
      'core.runtime.events',
      { cursor: acknowledged },
      { caller },
    );
    handle.close();
    const terminal = await handle.frames[Symbol.asyncIterator]().next();
    await runtime.shutdown('test-cleanup');
    expect(terminal.value).toMatchObject({
      kind: 'end',
      outcome: 'cancelled',
      cursor: acknowledged,
    });
  });

  it('reports ready only after migrations and journals the transition', async () => {
    let migrate: () => void = () => undefined;
    const runtime = create({
      services: [
        {
          name: 'db',
          plane: 'core',
          migrations: [
            {
              id: 'm1',
              run: (): Promise<void> =>
                new Promise<void>((resolve) => (migrate = resolve)),
            },
          ],
        },
      ],
    });
    expect(runtime.operations).toContainEqual({
      name: 'core.runtime.events',
      kind: 'stream',
      plane: 'core',
      owner: 'core.runtime',
    });
    const starting = runtime.start();
    expect(runtime.start()).toBe(starting);
    const before = await health(runtime);
    expect(before.runtime).toEqual({
      ...identity,
      profile: 'core',
      daemonEpoch: before.runtime.daemonEpoch,
      protocolVersions: [1],
      state: 'starting',
    });
    expect(before.runtime.daemonEpoch).toMatch(/^runtime:/);
    const frames = await subscribe(runtime);
    migrate();
    await starting;
    expect((await health(runtime)).checks).toEqual([
      { name: 'db', status: 'pass', message: null },
    ]);
    expect(frames).toEqual([
      {
        kind: 'item',
        cursor: { daemonEpoch: before.runtime.daemonEpoch, sequence: 1 },
        item: {
          event: 'ready',
          runtime: { ...before.runtime, state: 'ready' },
          details: { checks: [{ name: 'db', status: 'pass', message: null }] },
        },
      },
    ]);
  });

  it.each([
    ['a valid', 'renamed'],
    ['an invalid empty', ''],
  ])(
    'keeps its identity when the caller makes %s change after creation',
    async (_label, changed) => {
      const owned: CanopyRuntimeIdentity = { ...identity };
      const runtime = create({ identity: owned });
      Object.assign(owned, { runtimeId: changed, hostId: changed });
      const frames = await subscribe(runtime);
      await runtime.start();
      await expect(health(runtime)).resolves.toMatchObject({
        runtime: identity,
      });
      await runtime.shutdown('test');
      expect(frames).toMatchObject([
        { item: { event: 'ready', runtime: identity } },
        { item: { event: 'stopping', runtime: identity } },
        { kind: 'end', outcome: 'completed' },
      ]);
    },
  );

  it('degrades with a failed check when a required migration fails', async () => {
    const runtime = create({
      services: [
        {
          name: 'db',
          plane: 'core',
          migrations: [
            {
              id: 'm1',
              run: (): Promise<void> => Promise.reject(new Error('x')),
            },
          ],
        },
      ],
    });
    await expect(runtime.start()).rejects.toThrow('Migration m1 failed: x');
    expect(runtime.health()).toEqual({
      state: 'degraded',
      checks: [
        { name: 'db', status: 'fail', message: 'Migration m1 failed: x' },
      ],
    });
    expect((await subscribe(runtime))[0]).toMatchObject({
      item: { event: 'degraded', runtime: { state: 'degraded' } },
    });
  });

  it('runs the seven shutdown phases in order exactly once', async () => {
    const runtime = create({
      services: [
        { name: 'a', plane: 'core', stop: stopHooks('a') },
        { name: 'b', plane: 'core', dependsOn: ['a'], stop: stopHooks('b') },
      ],
    });
    await runtime.start();
    await subscribe(runtime);
    const stopping = runtime.dispatcher.shutdown();
    expect(runtime.shutdown('again')).toBe(runtime.shutdown('third'));
    await stopping;
    const report = await runtime.shutdown('later');
    expect(report.reason).toBe('override');
    expect(report.phases.map(({ status }) => status)).toEqual(
      Array(7).fill('completed'),
    );
    expect(log).toEqual([
      'event ready',
      'drain',
      'event stopping',
      'end completed',
      'cancel write=unavailable read=stopping',
      ...[3, 4, 5, 6, 7].flatMap((phase) => [
        `stop${phase} b`,
        `stop${phase} a`,
      ]),
    ]);
    expect(runtime.dispatcher.state).toBe('closed');
  });

  it.each([
    ['hangs', 'timed_out', (): Promise<void> => new Promise(() => undefined)],
    ['fails', 'failed', (): Promise<void> => Promise.reject(new Error('x'))],
  ])(
    'still runs phase 3 hooks when dispatcher close %s',
    async (_label, status, closeDispatcher) => {
      const runtime = create({
        phaseDeadlineMs: 20,
        closeDispatcher,
        services: [{ name: 'a', plane: 'core', stop: stopHooks('a') }],
      });
      await runtime.start();
      const report = await runtime.shutdown('test');
      expect(report.phases[2]).toMatchObject({ id: 3, status });
      // A timed-out phase 3 may finish its hooks alongside phase 4.
      expect(log.filter((entry) => entry.startsWith('stop')).sort()).toEqual(
        [3, 4, 5, 6, 7].map((phase) => `stop${phase} a`),
      );
    },
  );

  it('replays last status, resumes source cursors, and refuses stale cursors', async () => {
    let status: 'pass' | 'warn' = 'pass';
    const runtime = create({
      services: [
        {
          name: 'a',
          plane: 'core',
          health: (): RuntimeHealthCheck => ({
            name: 'a',
            status,
            message: null,
          }),
        },
      ],
    });
    await runtime.start();
    status = 'warn';
    runtime.health();
    runtime.health();
    const { daemonEpoch } = (await health(runtime)).runtime;
    const at = (sequence: number): CanopyStreamCursor => ({
      daemonEpoch,
      sequence,
    });
    const late = await subscribe(runtime);
    const resumed = await subscribe(runtime, at(1));
    expect(late.map((frame) => frame.cursor)).toEqual([at(2)]);
    expect(resumed).toEqual(late);
    expect(late[0]).toMatchObject({ item: { event: 'degraded' } });

    for (let index = 0; index < 1_100; index += 1) {
      status = status === 'pass' ? 'warn' : 'pass';
      runtime.health();
    }
    for (const from of [
      { daemonEpoch: 'foreign', sequence: 1 },
      at(1),
      at(5_000),
    ]) {
      const frames = await subscribe(runtime, from);
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        kind: 'end',
        outcome: 'error',
        error: {
          kind: 'failed_precondition',
          code: 'core.runtime.snapshotRequired',
          retry: { kind: 'after_refresh', resource: 'core.runtime.health.get' },
        },
      });
    }
  });

  it.each([
    [
      'a worker profile',
      { profile: 'worker' as const },
      'cannot host core module',
    ],
    [
      'an invalid identity',
      { identity: { ...identity, runtimeId: '' } },
      'runtimeId',
    ],
    [
      'a host operation that shadows a runtime operation',
      { queries: CANOPY_RUNTIME_QUERY_DEFINITIONS },
      'core.runtime.health.get is reserved',
    ],
  ])('rejects %s before creating a dispatcher', (_label, input, message) => {
    const createDispatcher = jest.fn();
    expect(() =>
      createCanopyRuntime({
        profile: 'profile' in input ? input.profile : 'core',
        identity: 'identity' in input ? input.identity : identity,
        definitions: {
          queries: 'queries' in input ? input.queries : {},
          instructions: {},
          streams: {},
        },
        owners: [],
        services: [],
        phaseDeadlineMs: 10,
        createDispatcher,
      }),
    ).toThrow(message);
    expect(createDispatcher).not.toHaveBeenCalled();
  });
});
