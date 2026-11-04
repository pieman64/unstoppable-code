import {
  CanopyStreamCursorSchema,
  WORKER_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { createCanopyDispatcher } from '../dispatcher';
import {
  createInProcessWorkerBinding,
  type CreateInProcessWorkerBindingOptions,
  type InProcessWorkerBinding,
} from '../in-process-worker-binding';
import { CanopyOperationError } from '../errors';
import type {
  CanopyDispatcher,
  CanopyDispatcherInstructionHandlerMap,
  CanopyDispatcherStreamHandlerMap,
  CanopyStreamFrame,
  CanopyStreamHandle,
  CanopyStreamSink,
} from '../types';
import { serializingWorkerPair } from './serializing-worker-pair';
import {
  WORKER_EXAMPLE_EFFECT_INSTRUCTIONS,
  WORKER_EXAMPLE_INSTRUCTIONS as instructions,
  WORKER_EXAMPLE_STREAMS as streams,
} from './worker-example-definitions';

const definitions = {
  queries: WORKER_QUERY_DEFINITIONS,
  instructions,
  streams,
};
type Write = CanopyDispatcherInstructionHandlerMap<
  typeof instructions
>['worker.example.write'];
type Events = CanopyDispatcherStreamHandlerMap<
  typeof streams
>['worker.example.events'];
type Frame = CanopyStreamFrame<unknown, unknown>;

const caller: CanopyCallerDescriptor = {
  principalId: 'core',
  clientInstanceId: 'binding',
  authorityId: 'authority',
  interfaceKind: 'daemon',
  grants: [
    'worker.example.read',
    'worker.example.write',
    'worker.filesystem.read',
  ],
};
const write = { daemonEpoch: 'epoch', sequence: 1 };
const keyed = { metadata: { idempotencyKey: 'key' } };
const open = { daemonEpoch: 'scope', cursor: null };
const scope = { scope: { workspaceId: 'workspace' } };
const roots = { roots: [] };
const EVENTS = 'worker.example.events';
const CANCEL = 'worker.binding.cancel';

interface Fixture {
  binding: InProcessWorkerBinding;
  pair: ReturnType<typeof serializingWorkerPair>;
  worker: CanopyDispatcher;
}
const fixtures: Fixture[] = [];
afterEach(() => {
  for (const { binding } of fixtures.splice(0)) binding.close();
});
function bind(
  options: {
    grants?: CanopyCallerDescriptor['grants'];
    write?: Write;
    events?: Events;
    roots?: () => Promise<typeof roots> | typeof roots;
  } = {},
): Fixture {
  const pair = serializingWorkerPair();
  const worker = createCanopyDispatcher({
    profile: 'worker',
    definitions,
    handlers: {
      queries: {
        'worker.filesystem.roots.list':
          options.roots ?? ((): typeof roots => roots),
        'worker.filesystem.directory.list': () => ({ entries: [] }),
        'worker.filesystem.file.read': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.search': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.filesystem.link.resolve': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.branch.list': () => ({
          branches: [],
          defaultBranch: null,
          defaultBranchSource: null,
        }),
        'worker.git.executable.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.remote.get': () => ({
          origin: { state: 'absent' as const },
        }),
        'worker.git.worktree.health.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.git.diff.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.script.execution.list': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.pipeline.execution.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.buildQueue.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.status.get': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.query': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.snapshot.export': (): never => {
          throw new Error('Not exercised.');
        },
        'worker.codeGraph.languages.validate': (): never => {
          throw new Error('Not exercised.');
        },
      },
      instructions: {
        'worker.example.write':
          options.write ?? ((params): typeof write => params),
      },
      streams: {
        [EVENTS]: options.events ?? ((): Promise<void> => Promise.resolve()),
      },
    },
    shutdownTimeoutMs: 0,
  });
  const binding = createInProcessWorkerBinding({
    dispatcher: worker,
    definitions,
    caller: { ...caller, grants: [...(options.grants ?? caller.grants)] },
    pair,
  });
  const fixture = { binding, pair, worker };
  fixtures.push(fixture);
  return fixture;
}
const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));
async function until(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500 && !condition(); attempt += 1)
    await tick();
  expect(condition()).toBe(true);
}
async function collect(
  handle: CanopyStreamHandle<unknown, unknown>,
): Promise<Frame[]> {
  const frames: Frame[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  return frames;
}
function sent(connection: Fixture['pair']['client']): CanopyJsonRpcMessage[] {
  return connection.send.mock.calls.map(([message]) => message);
}
function cancels(fixture: Fixture): unknown[] {
  return sent(fixture.pair.client).flatMap((message) =>
    'method' in message && message.method === CANCEL
      ? [message.params.requestId]
      : [],
  );
}
/** Holds matching sends on one side until released. */
function gate(
  connection: Fixture['pair']['client'],
  matches: (message: CanopyJsonRpcMessage) => boolean,
): { release(): void; held(): number } {
  const send = connection.send.getMockImplementation();
  let open = (): void => undefined;
  let released = false;
  let held = 0;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  connection.send.mockImplementation(async (message) => {
    if (!send) throw new Error('Missing serializing sender');
    if (!released && matches(message)) {
      held += 1;
      await opened;
    }
    await send(message);
  });
  return {
    release: (): void => {
      released = true;
      open();
    },
    held: () => held,
  };
}
const isItem = (message: CanopyJsonRpcMessage): boolean =>
  'method' in message && message.method === `${EVENTS}.item`;

describe('instructions', () => {
  it('copies keyed metadata, the fixed caller and the result', async () => {
    const seen = jest.fn<void, [unknown, unknown]>();
    const { binding, pair } = bind({
      write: (params, context) => {
        seen(context.metadata, context.caller);
        return { ...params, sequence: params.sequence + 1 };
      },
    });
    await expect(
      binding.instruction('worker.example.write', write, keyed),
    ).resolves.toEqual({ daemonEpoch: 'epoch', sequence: 2 });
    expect(seen).toHaveBeenCalledWith({ idempotencyKey: 'key' }, caller);
    expect(sent(pair.client)).toEqual([
      expect.objectContaining({
        method: 'worker.example.write',
        params: { ...write, _meta: { idempotencyKey: 'key' } },
      }),
    ]);
  });

  it('requires the idempotency key before anything reaches the wire', async () => {
    const handler = jest.fn((params: typeof write) => params);
    const { binding, pair } = bind({ write: handler });
    await expect(
      binding.instruction('worker.example.write', write),
    ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
    expect(handler).not.toHaveBeenCalled();
    expect(pair.client.send).not.toHaveBeenCalled();
  });

  it('keeps declared errors, strips private causes and fails malformed results closed', async () => {
    const declared = bind({
      write: (): never => {
        throw new CanopyOperationError(
          { kind: 'conflict', message: 'Busy.', retry: { kind: 'never' } },
          new Error('private'),
        );
      },
    });
    await expect(
      declared.binding.instruction('worker.example.write', write, keyed),
    ).rejects.toMatchObject({
      payload: { kind: 'conflict', message: 'Busy.' },
      runtimeCause: undefined,
    });
    const malformed = bind({
      write: () => ({ daemonEpoch: '', sequence: -1 }),
    });
    await expect(
      malformed.binding.instruction('worker.example.write', write, keyed),
    ).rejects.toMatchObject({ payload: { kind: 'internal' } });
  });

  it('denies on the worker with the fixed caller grants', async () => {
    const handler = jest.fn((params: typeof write) => params);
    const { binding } = bind({ grants: [], write: handler });
    await expect(
      binding.instruction('worker.example.write', write, keyed),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(handler).not.toHaveBeenCalled();
  });

  it('refuses an elapsed deadline and a pre-aborted signal', async () => {
    const handler = jest.fn((params: typeof write) => params);
    const { binding, pair } = bind({ write: handler });
    await expect(
      binding.instruction('worker.example.write', write, {
        metadata: {
          idempotencyKey: 'late',
          deadlineAt: '2000-01-01T00:00:00Z',
        },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'deadline_exceeded' } });
    const controller = new AbortController();
    controller.abort();
    await expect(
      binding.instruction('worker.example.write', write, {
        ...keyed,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ payload: { kind: 'cancelled' } });
    expect(handler).not.toHaveBeenCalled();
    expect(pair.client.send).not.toHaveBeenCalled();
  });

  it('carries an abort to the worker handler and consumes its late reply', async () => {
    const aborted = jest.fn();
    const fixture = bind({
      write: (_params, { signal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            aborted();
            reject(new Error('stopped'));
          });
        }),
    });
    const controller = new AbortController();
    const call = fixture.binding.instruction('worker.example.write', write, {
      ...keyed,
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    await until(() => aborted.mock.calls.length === 1);
    expect(cancels(fixture)).toEqual(['worker-request-1']);
    await until(() => sent(fixture.pair.server).some((m) => 'error' in m));
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).resolves.toEqual(roots);
  });

  it('sends a deadline that lapses during admission after its request', async () => {
    const fixture = bind({ write: () => new Promise(() => undefined) });
    const deadlineAt = '2030-01-01T00:00:00.000Z';
    const now = jest.spyOn(Date, 'now');
    now.mockReturnValueOnce(Date.parse(deadlineAt) - 1);
    now.mockReturnValue(Date.parse(deadlineAt));
    try {
      await expect(
        fixture.binding.instruction('worker.example.write', write, {
          metadata: { idempotencyKey: 'key', deadlineAt },
        }),
      ).rejects.toMatchObject({ payload: { kind: 'deadline_exceeded' } });
    } finally {
      now.mockRestore();
    }
    expect(
      sent(fixture.pair.client).map((m) => 'method' in m && m.method),
    ).toEqual(['worker.example.write', CANCEL]);
  });

  it('honours a cancel sent right behind its request', async () => {
    const fixture = bind({ write: () => new Promise(() => undefined) });
    const controller = new AbortController();
    const call = fixture.binding.instruction('worker.example.write', write, {
      ...keyed,
      signal: controller.signal,
    });
    controller.abort();
    await expect(call).rejects.toMatchObject({
      payload: { kind: 'cancelled' },
    });
    // Without the cancel frame the never-settling handler would never reply.
    await until(() => sent(fixture.pair.server).length === 1);
    expect(sent(fixture.pair.server)[0]).toMatchObject({
      id: 'worker-request-1',
      error: { data: { kind: 'cancelled' } },
    });
  });

  it('shares the pending bound with queries and fails them all on close', async () => {
    const never = (): Promise<never> => new Promise(() => undefined);
    const { binding } = bind({ write: never, roots: never });
    const calls = Array.from({ length: 128 }, (_, index) =>
      (index % 2 === 0
        ? binding.instruction('worker.example.write', write, keyed)
        : binding.query('worker.filesystem.roots.list', scope)
      ).catch((error: unknown) => error),
    );
    await expect(
      binding.instruction('worker.example.write', write, keyed),
    ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    await expect(
      binding.query('worker.filesystem.roots.list', scope),
    ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    binding.close();
    for (const result of await Promise.all(calls))
      expect(result).toMatchObject({ payload: { kind: 'unavailable' } });
    await expect(
      binding.instruction('worker.example.write', write, keyed),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
  });
});

describe('effects', () => {
  const effectDefinitions = {
    queries: {},
    instructions: WORKER_EXAMPLE_EFFECT_INSTRUCTIONS,
    streams: {},
  };
  const withMeta = { ...write, _meta: keyed.metadata };
  type Effect = (
    params: unknown,
    metadata: unknown,
  ) => Promise<typeof write> | typeof write;
  function bindEffects(effect: Effect): Fixture {
    const pair = serializingWorkerPair();
    const worker = createCanopyDispatcher({
      profile: 'worker',
      definitions: effectDefinitions,
      handlers: {
        queries: {},
        instructions: {
          'worker.example.append': (params, { metadata }) =>
            effect(params, metadata),
          'worker.example.keyed': (params, { metadata }) =>
            effect(params, metadata),
        },
        streams: {},
      },
      shutdownTimeoutMs: 0,
    });
    const binding = createInProcessWorkerBinding({
      dispatcher: worker,
      definitions: effectDefinitions,
      caller: { ...caller, grants: [...caller.grants] },
      pair,
    });
    const fixture = { binding, pair, worker };
    fixtures.push(fixture);
    return fixture;
  }
  const cases = [
    ['worker.example.append', write, { metadata: {} }, 'never'],
    ['worker.example.keyed', withMeta, keyed, 'same_idempotency_key'],
  ] as const;

  it('validates a schema-declared _meta on the worker and hands it over intact', async () => {
    const seen = jest.fn<void, [unknown, unknown]>();
    const { binding, pair } = bindEffects((params, metadata) => {
      seen(params, metadata);
      return write;
    });
    await expect(
      binding.instruction('worker.example.keyed', withMeta, keyed),
    ).resolves.toEqual(write);
    expect(seen).toHaveBeenCalledWith(withMeta, keyed.metadata);
    expect(sent(pair.client)).toEqual([
      expect.objectContaining({ params: withMeta }),
    ]);
  });

  it('takes the request metadata from a schema-declared _meta alone', async () => {
    const seen = jest.fn<void, [unknown, unknown]>();
    const { binding } = bindEffects((params, metadata) => {
      seen(params, metadata);
      return write;
    });
    await expect(
      binding.instruction('worker.example.keyed', withMeta),
    ).resolves.toEqual(write);
    expect(seen).toHaveBeenCalledWith(withMeta, keyed.metadata);
  });

  it.each(cases)(
    'fails %s at disconnect with its own retry directive',
    async (name, params, options, retry) => {
      const ran = jest.fn();
      const fixture = bindEffects(() => {
        ran();
        return new Promise(() => undefined);
      });
      const call = fixture.binding
        .instruction(name, params, options)
        .catch((error: unknown) => error);
      await until(() => ran.mock.calls.length === 1);
      fixture.pair.client.close();
      const unavailable = {
        payload: { kind: 'unavailable', retry: { kind: retry } },
      };
      expect(await call).toMatchObject(unavailable);
      await expect(
        fixture.binding.instruction(name, params, options),
      ).rejects.toMatchObject(unavailable);
    },
  );

  it.each(cases)(
    'fails %s at a lapsed deadline with its own retry directive',
    async (name, params, options, retry) => {
      const fixture = bindEffects(() => new Promise(() => undefined));
      const deadlineAt = '2030-01-01T00:00:00.000Z';
      const now = jest.spyOn(Date, 'now');
      now.mockReturnValueOnce(Date.parse(deadlineAt) - 1);
      now.mockReturnValue(Date.parse(deadlineAt));
      try {
        await expect(
          fixture.binding.instruction(name, params, {
            metadata: { ...options.metadata, deadlineAt },
          }),
        ).rejects.toMatchObject({
          payload: { kind: 'deadline_exceeded', retry: { kind: retry } },
        });
      } finally {
        now.mockRestore();
      }
    },
  );

  it.each(cases)(
    'refuses %s past its deadline with its own retry directive',
    async (name, params, options, retry) => {
      const ran = jest.fn();
      const fixture = bindEffects(() => {
        ran();
        return write;
      });
      await expect(
        fixture.binding.instruction(name, params, {
          metadata: { ...options.metadata, deadlineAt: '2000-01-01T00:00:00Z' },
        }),
      ).rejects.toMatchObject({
        payload: { kind: 'deadline_exceeded', retry: { kind: retry } },
      });
      expect(sent(fixture.pair.client)).toEqual([]);
      expect(ran).not.toHaveBeenCalled();
    },
  );

  it('keeps the retry delay when it re-keys a transport failure', async () => {
    const fixture = bindEffects(() => new Promise(() => undefined));
    fixture.pair.client.send.mockImplementationOnce(() =>
      Promise.reject(
        new CanopyOperationError({
          kind: 'unavailable',
          message: 'Transport lost.',
          retry: { kind: 'same_request', delayMs: 250 },
        }),
      ),
    );
    await expect(
      fixture.binding.instruction('worker.example.keyed', withMeta, keyed),
    ).rejects.toMatchObject({
      payload: {
        kind: 'unavailable',
        retry: { kind: 'same_idempotency_key', delayMs: 250 },
      },
    });
  });

  it('leaves a pending query retryable as the same request at disconnect', async () => {
    const fixture = bind({ roots: () => new Promise(() => undefined) });
    const call = fixture.binding
      .query('worker.filesystem.roots.list', scope)
      .catch((error: unknown) => error);
    await tick();
    fixture.pair.client.close();
    expect(await call).toMatchObject({
      payload: { kind: 'unavailable', retry: { kind: 'same_request' } },
    });
  });
});

describe('streams', () => {
  it('delivers worker frames in order, after the open reply, with worker cursors', async () => {
    const fixture = bind({
      events: (_params, _context, sink): Promise<void> => {
        sink.emit({ daemonEpoch: 'one' });
        sink.emit({ daemonEpoch: 'two' });
        sink.end('completed');
        return Promise.resolve();
      },
    });
    const frames = await collect(
      await fixture.binding.openStream(EVENTS, open),
    );
    expect(frames).toMatchObject([
      { kind: 'item', item: { daemonEpoch: 'one' } },
      { kind: 'item', item: { daemonEpoch: 'two' } },
      { kind: 'end', outcome: 'completed', error: null },
    ]);
    const wire = sent(fixture.pair.server);
    expect(
      wire.map((m) => ('result' in m ? 'open' : 'method' in m && m.method)),
    ).toEqual(['open', `${EVENTS}.item`, `${EVENTS}.item`, `${EVENTS}.end`]);
    const cursors = wire.flatMap((m) =>
      'method' in m && m.method === `${EVENTS}.item` ? [m.params.cursor] : [],
    );
    expect(frames.slice(0, 2).map(({ cursor }) => cursor)).toEqual(cursors);
    expect(Object.keys(fixture.binding.forwarders.streams)).toEqual([EVENTS]);
  });

  it('returns worker open failures typed', async () => {
    const handler = jest.fn((): Promise<void> => Promise.resolve());
    const denied = bind({ grants: [], events: handler });
    const sink: CanopyStreamSink<unknown> = {
      emit: () => null,
      emitAt: () => null,
      end: () => undefined,
    };
    await expect(
      denied.binding.forwarders.streams[EVENTS](
        open,
        { metadata: {}, signal: new AbortController().signal },
        sink,
      ),
    ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
    expect(handler).not.toHaveBeenCalled();
    const closed = bind();
    await closed.worker.shutdown();
    expect(
      await collect(await closed.binding.openStream(EVENTS, open)),
    ).toMatchObject([
      { kind: 'end', outcome: 'error', error: { kind: 'unavailable' } },
    ]);
  });

  it('bounds open streams alongside a full set of pending queries', async () => {
    const never = (): Promise<never> => new Promise(() => undefined);
    const fixture = bind({ events: never, roots: never });
    const handles = await Promise.all(
      Array.from({ length: 128 }, () =>
        fixture.binding.openStream(EVENTS, open),
      ),
    );
    expect(
      await collect(await fixture.binding.openStream(EVENTS, open)),
    ).toMatchObject([
      {
        kind: 'end',
        outcome: 'error',
        error: { kind: 'resource_exhausted', retry: { kind: 'never' } },
      },
    ]);
    const replies = (): number =>
      sent(fixture.pair.server).filter((m) => 'result' in m).length;
    await until(() => replies() === 128);
    // The core reads the end before its send resolves, as under backpressure.
    const send = fixture.pair.server.send.getMockImplementation();
    let releaseEnd = (): void => undefined;
    const endSent = new Promise<void>((resolve) => {
      releaseEnd = resolve;
    });
    fixture.pair.server.send.mockImplementation(async (message) => {
      if (!send) throw new Error('Missing serializing sender');
      await send(message);
      if ('method' in message && message.method === `${EVENTS}.end`)
        await endSent;
    });
    // A slot frees only once the worker's end frame lands.
    handles[0].close();
    await until(() =>
      sent(fixture.pair.server).some(
        (m) => 'method' in m && m.method === `${EVENTS}.end`,
      ),
    );
    await tick();
    const replacement = await fixture.binding.openStream(EVENTS, open);
    await until(() => replies() === 129);
    const queries = Array.from({ length: 128 }, () =>
      fixture.binding
        .query('worker.filesystem.roots.list', scope)
        .catch((error: unknown) => error),
    );
    await tick();
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).rejects.toMatchObject({ payload: { kind: 'resource_exhausted' } });
    expect(fixture.pair.server.signal.aborted).toBe(false);
    releaseEnd();
    fixture.binding.close();
    for (const result of await Promise.all(queries))
      expect(result).toMatchObject({ payload: { kind: 'unavailable' } });
    expect(await collect(replacement)).toMatchObject([
      { kind: 'end', outcome: 'error', error: { kind: 'unavailable' } },
    ]);
  });

  it.each([
    [
      'an epoch switch',
      (cursor: CanopyStreamCursor): CanopyStreamCursor => ({
        ...cursor,
        daemonEpoch: 'foreign',
      }),
    ],
    [
      'a non-increasing sequence',
      (cursor: CanopyStreamCursor): CanopyStreamCursor => ({
        ...cursor,
        sequence: cursor.sequence - 1,
      }),
    ],
  ])('ends internal and cancels the worker on %s', async (_name, rewrite) => {
    const cleanup = jest.fn();
    const fixture = bind({
      events: (_params, _context, sink): Promise<() => void> => {
        sink.emit({ daemonEpoch: 'one' });
        sink.emit({ daemonEpoch: 'two' });
        return Promise.resolve(cleanup);
      },
    });
    const send = fixture.pair.server.send.getMockImplementation();
    let items = 0;
    fixture.pair.server.send.mockImplementation(async (message) => {
      if (!send) throw new Error('Missing serializing sender');
      if ('method' in message && isItem(message) && ++items === 2)
        return send({
          ...message,
          params: {
            ...message.params,
            cursor: rewrite(
              CanopyStreamCursorSchema.parse(message.params.cursor),
            ),
          },
        });
      return send(message);
    });
    const frames = await collect(
      await fixture.binding.openStream(EVENTS, open),
    );
    expect(frames).toMatchObject([
      { kind: 'item', item: { daemonEpoch: 'one' } },
      { kind: 'end', outcome: 'error', error: { kind: 'internal' } },
    ]);
    await until(() => cleanup.mock.calls.length === 1);
    expect(cancels(fixture)).toHaveLength(1);
  });

  it.each(['close', 'abort'] as const)(
    'carries a %s to the worker and drops its in-flight frames',
    async (how) => {
      const cleanup = jest.fn();
      let sink: CanopyStreamSink<{ daemonEpoch: string }> | undefined;
      const fixture = bind({
        events: (_params, _context, opened): Promise<() => void> => {
          sink = opened;
          return Promise.resolve(cleanup);
        },
      });
      const controller = new AbortController();
      const handle = await fixture.binding.openStream(EVENTS, open, {
        signal: controller.signal,
      });
      await until(() => sent(fixture.pair.server).some((m) => 'result' in m));
      sink?.emit({ daemonEpoch: 'one' });
      await until(() => sent(fixture.pair.server).some(isItem));
      await tick();
      const held = gate(
        fixture.pair.client,
        (m) => 'method' in m && m.method === CANCEL,
      );
      if (how === 'close') handle.close();
      else controller.abort();
      await until(() => held.held() === 1);
      sink?.emit({ daemonEpoch: 'late' });
      await until(() => sent(fixture.pair.server).filter(isItem).length === 2);
      expect(cleanup).not.toHaveBeenCalled();
      held.release();
      await until(() => cleanup.mock.calls.length === 1);
      expect(await collect(handle)).toMatchObject([
        { kind: 'item', item: { daemonEpoch: 'one' } },
        { kind: 'end', outcome: 'cancelled' },
      ]);
      await until(() =>
        sent(fixture.pair.server).some(
          (m) => 'method' in m && m.method === `${EVENTS}.end`,
        ),
      );
      await expect(
        fixture.binding.query('worker.filesystem.roots.list', scope),
      ).resolves.toEqual(roots);
    },
  );

  it('cancels a stream abandoned during open once its late reply lands', async () => {
    const cleanup = jest.fn();
    const fixture = bind({
      events: (): Promise<() => void> => Promise.resolve(cleanup),
    });
    const held = gate(fixture.pair.server, (m) => 'result' in m);
    const controller = new AbortController();
    const handle = await fixture.binding.openStream(EVENTS, open, {
      signal: controller.signal,
    });
    await until(() => held.held() === 1);
    controller.abort();
    expect(await collect(handle)).toMatchObject([
      { kind: 'end', outcome: 'cancelled' },
    ]);
    held.release();
    await until(() => cleanup.mock.calls.length === 1);
    expect(cancels(fixture)).toEqual(['worker-request-1']);
    await until(() =>
      sent(fixture.pair.server).some(
        (m) => 'method' in m && m.method === `${EVENTS}.end`,
      ),
    );
    await tick();
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).resolves.toEqual(roots);
  });

  it('ends open streams, fails pending calls and aborts worker calls on disconnect', async () => {
    const signals: AbortSignal[] = [];
    const fixture = bind({
      write: (_params, { signal }) => {
        signals.push(signal);
        return new Promise(() => undefined);
      },
      events: (_params, { signal }) => {
        signals.push(signal);
        return Promise.resolve();
      },
    });
    const handle = await fixture.binding.openStream(EVENTS, open);
    await until(() => sent(fixture.pair.server).some((m) => 'result' in m));
    const call = fixture.binding
      .instruction('worker.example.write', write, keyed)
      .catch((error: unknown) => error);
    await tick();
    fixture.pair.client.close();
    expect(await collect(handle)).toMatchObject([
      { kind: 'end', outcome: 'error', error: { kind: 'unavailable' } },
    ]);
    expect(await call).toMatchObject({ payload: { kind: 'unavailable' } });
    expect(signals.map(({ aborted }) => aborted)).toEqual([true, true]);
    expect(
      await collect(await fixture.binding.openStream(EVENTS, open)),
    ).toMatchObject([{ kind: 'end', error: { kind: 'unavailable' } }]);
  });
});

describe('strictness', () => {
  it('fails closed on a frame for an unknown subscription', async () => {
    const fixture = bind();
    await fixture.pair.server.send({
      jsonrpc: '2.0',
      method: `${EVENTS}.item`,
      params: {
        subscriptionId: 'unknown',
        cursor: { daemonEpoch: 'epoch', sequence: 1 },
        itemId: 'item-1',
        occurredAt: new Date().toISOString(),
        item: { daemonEpoch: 'one' },
      },
    });
    await until(() => fixture.pair.client.signal.aborted);
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).rejects.toMatchObject({ payload: { kind: 'unavailable' } });
  });

  it.each<CanopyJsonRpcNotification>([
    {
      jsonrpc: '2.0',
      method: 'worker.example.other',
      params: { requestId: 'worker-request-1' },
    },
    { jsonrpc: '2.0', method: CANCEL, params: { requestId: { nested: true } } },
  ])(
    'fails closed on a worker notification other than a cancel: %j',
    async (notification) => {
      const fixture = bind();
      await fixture.pair.client.send(notification);
      await until(() => fixture.pair.server.signal.aborted);
    },
  );

  it('ignores a cancel for a finished request', async () => {
    const fixture = bind();
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).resolves.toEqual(roots);
    await fixture.pair.client.send({
      jsonrpc: '2.0',
      method: CANCEL,
      params: { requestId: 'worker-request-1' },
    });
    await expect(
      fixture.binding.query('worker.filesystem.roots.list', scope),
    ).resolves.toEqual(roots);
  });

  it('refuses definitions the wire cannot carry at construction', () => {
    const pair = serializingWorkerPair();
    const build = (
      maps: Partial<CreateInProcessWorkerBindingOptions['definitions']>,
    ): unknown =>
      createInProcessWorkerBinding({
        dispatcher: createCanopyDispatcher({
          profile: 'worker',
          definitions: { queries: {}, instructions: {}, streams: {} },
          handlers: { queries: {}, instructions: {}, streams: {} },
        }),
        definitions: { queries: {}, instructions: {}, streams: {}, ...maps },
        caller,
        pair,
      });
    expect(() =>
      build({
        streams: { [EVENTS]: { ...streams[EVENTS], openResult: undefined } },
      }),
    ).toThrow('needs an open result');
    const mislabeled = { ...instructions['worker.example.write'] };
    Object.defineProperty(mislabeled, 'kind', { value: 'stream' });
    expect(() =>
      build({ instructions: { 'worker.example.write': mislabeled } }),
    ).toThrow('must declare kind instruction');
    pair.client.close();
  });
});
