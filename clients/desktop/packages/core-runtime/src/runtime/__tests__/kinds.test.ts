import {
  CanopyErrorPayloadSchema,
  CanopyStreamCursorSchema,
  CanopyStreamEndSchema,
  defineCanopyInstruction,
  defineCanopyInstructionRegistry,
  defineCanopyQuery,
  defineCanopyQueryRegistry,
  defineCanopyStream,
  defineCanopyStreamRegistry,
  type CanopyCallerDescriptor,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { CanopyOperationError, createCanopyDispatcher } from '../dispatcher';
import { createInProcessCanopyClient } from '../in-process-client';
import type { CanopyDispatcher, CanopyStreamFrame } from '../types';

const caller: CanopyCallerDescriptor = {
  principalId: 'test',
  clientInstanceId: 'client',
  authorityId: 'authority',
  interfaceKind: 'test',
  grants: ['core.example.read', 'core.example.write'],
};
const instructionDefinitions = defineCanopyInstructionRegistry('core', {
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
const streamDefinitions = defineCanopyStreamRegistry('core', {
  'core.example.events': defineCanopyStream({
    plane: 'core',
    domain: 'example',
    version: 1,
    placement: 'core-only',
    idempotency: 'inherent',
    requiredGrants: ['core.example.read'],
    params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).extend({
      cursor: CanopyStreamCursorSchema.nullable().optional(),
    }),
    item: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).transform(
      (item) => ({ daemonEpoch: item.daemonEpoch.toUpperCase() }),
    ),
    end: CanopyStreamEndSchema.transform((value) => ({
      ...value,
      marker: 'parsed',
    })),
    error: CanopyErrorPayloadSchema,
  }),
});
const definitions = {
  queries: {},
  instructions: instructionDefinitions,
  streams: streamDefinitions,
};
const params = { daemonEpoch: 'scope', cursor: null };
interface TestSink {
  emit(
    item: { daemonEpoch: string },
    onCursorAssigned?: (cursor: CanopyStreamCursor) => void,
  ): CanopyStreamCursor | null;
  emitAt(
    cursor: CanopyStreamCursor,
    item: { daemonEpoch: string },
  ): CanopyStreamCursor | null;
  end(outcome: 'completed' | 'cancelled' | 'error'): void;
  endAt(
    cursor: CanopyStreamCursor,
    outcome: 'completed' | 'cancelled' | 'error',
  ): void;
}

function runtime(
  streamHandler: (
    cursor: CanopyStreamCursor | null,
    sink: TestSink,
    signal: AbortSignal,
  ) => Promise<(() => void) | void>,
  timeout = 0,
): CanopyDispatcher<
  typeof definitions.queries,
  typeof instructionDefinitions,
  typeof streamDefinitions
> {
  return createCanopyDispatcher({
    profile: 'core',
    definitions,
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': (request) => Promise.resolve(request),
      },
      streams: {
        'core.example.events': (request, context, sink) =>
          streamHandler(request.cursor ?? null, sink, context.signal),
      },
    },
    shutdownTimeoutMs: timeout,
  });
}

it('validates keyed instructions, grants, and returns the handler result', async () => {
  const dispatcher = runtime(() => Promise.resolve());
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'yes', sequence: 0 },
      { caller, metadata: { idempotencyKey: 'one' } },
    ),
  ).resolves.toEqual({ daemonEpoch: 'yes', sequence: 0 });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'no', sequence: 0 },
      { caller },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'no', sequence: 0 },
      {
        caller: { ...caller, grants: [] },
        metadata: { idempotencyKey: 'two' },
      },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'permission_denied' } });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'no', sequence: 0 },
      {
        caller,
        metadata: {
          idempotencyKey: 'three',
          deadlineAt: '2000-01-01T00:00:00Z',
        },
      },
    ),
  ).rejects.toMatchObject({
    payload: {
      kind: 'deadline_exceeded',
      retry: { kind: 'same_idempotency_key' },
    },
  });
});

it('cancels pending instructions on deadline and shutdown drain', async () => {
  // A frozen clock keeps the deadline from passing before dispatch on a slow
  // runner (CAN-5921); racing the call's settlement keeps the test from hanging.
  const startedAt = new Date('2026-09-04T12:00:00.000Z');
  jest.useFakeTimers({ now: startedAt });
  let entered = false;
  let markEntered: () => void = () => undefined;
  const started = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: instructionDefinitions,
      streams: {},
    },
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': () => {
          entered = true;
          markEntered();
          return new Promise<CanopyStreamCursor>(() => undefined);
        },
      },
      streams: {},
    },
    shutdownTimeoutMs: 0,
  });
  try {
    const deadline = dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'one', sequence: 0 },
      {
        caller,
        metadata: {
          idempotencyKey: 'deadline',
          deadlineAt: new Date(startedAt.getTime() + 20).toISOString(),
        },
      },
    );
    await Promise.race([
      started,
      deadline.then(
        () => undefined,
        () => undefined,
      ),
    ]);
    expect(entered).toBe(true);
    jest.advanceTimersByTime(20);
    await expect(deadline).rejects.toMatchObject({
      payload: {
        kind: 'deadline_exceeded',
        retry: { kind: 'same_idempotency_key' },
      },
    });
  } finally {
    jest.useRealTimers();
  }
  const pending = dispatcher.instruction(
    'core.example.write',
    { daemonEpoch: 'two', sequence: 0 },
    { caller, metadata: { idempotencyKey: 'shutdown' } },
  );
  await dispatcher.shutdown();
  await expect(pending).rejects.toMatchObject({
    payload: { kind: 'cancelled' },
  });
});

it('rejects an idempotency key on an inherent instruction', async () => {
  const inherent = defineCanopyInstructionRegistry('core', {
    'core.example.write': defineCanopyInstruction({
      ...instructionDefinitions['core.example.write'],
      placement: 'core-only',
      idempotency: 'inherent',
    }),
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: { queries: {}, instructions: inherent, streams: {} },
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': (request) => Promise.resolve(request),
      },
      streams: {},
    },
  });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'one', sequence: 0 },
      { caller, metadata: { idempotencyKey: 'unexpected' } },
    ),
  ).rejects.toMatchObject({ payload: { kind: 'invalid_argument' } });
});

it('never recommends replaying a non-idempotent instruction after its deadline', async () => {
  const nonIdempotent = defineCanopyInstructionRegistry('core', {
    'core.example.write': defineCanopyInstruction({
      ...instructionDefinitions['core.example.write'],
      placement: 'core-only',
      idempotency: 'none',
    }),
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: { queries: {}, instructions: nonIdempotent, streams: {} },
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': () =>
          new Promise<CanopyStreamCursor>(() => undefined),
      },
      streams: {},
    },
  });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'one', sequence: 0 },
      { caller, metadata: { deadlineAt: '2000-01-01T00:00:00Z' } },
    ),
  ).rejects.toMatchObject({
    payload: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
  });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'two', sequence: 0 },
      {
        caller,
        metadata: { deadlineAt: new Date(Date.now() + 20).toISOString() },
      },
    ),
  ).rejects.toMatchObject({
    payload: { kind: 'deadline_exceeded', retry: { kind: 'never' } },
  });
  await dispatcher.shutdown();
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'three', sequence: 0 },
      { caller },
    ),
  ).rejects.toMatchObject({
    payload: { kind: 'unavailable', retry: { kind: 'never' } },
  });
});

it('emits ordered items and one terminal frame, and passes a resume cursor', async () => {
  const seen: Array<CanopyStreamCursor | null> = [];
  const emitted: CanopyStreamCursor[] = [];
  const dispatcher = runtime((cursor, sink) => {
    seen.push(cursor);
    const first = sink.emit({ daemonEpoch: 'one' });
    if (first) emitted.push(first);
    sink.emit({ daemonEpoch: 'two' });
    sink.end('completed');
    sink.emit({ daemonEpoch: 'ignored' });
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  expect(handle.openResult).toEqual({
    subscriptionId: handle.requestId,
    acceptedCursor: null,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames.map((frame) => frame.kind)).toEqual(['item', 'item', 'end']);
  expect(frames[0]).toMatchObject({ item: { daemonEpoch: 'ONE' } });
  expect(frames.at(-1)).toMatchObject({ marker: 'parsed' });
  expect(emitted).toEqual([frames[0].cursor]);
  expect(frames[0].cursor.sequence).toBeLessThan(frames[1].cursor.sequence);
  const resume = await dispatcher.openStream(
    'core.example.events',
    { ...params, cursor: frames[1].cursor },
    { caller },
  );
  expect(resume.openResult).toEqual({
    subscriptionId: resume.requestId,
    acceptedCursor: frames[1].cursor,
  });
  for await (const frame of resume.frames) expect(frame.kind).toBeDefined();
  expect(seen).toEqual([null, frames[1].cursor]);
});

it('rejects stream authorization through its Promise result', async () => {
  const dispatcher = runtime(() => Promise.resolve());
  const opened = dispatcher.openStream('core.example.events', params, {
    caller: { ...caller, grants: [] },
  });
  await expect(opened).rejects.toMatchObject({
    payload: { kind: 'permission_denied' },
  });
  await dispatcher.shutdown();
});

it('bounds queued stream items and terminates when the consumer falls behind', async () => {
  let rejected: CanopyStreamCursor | null | undefined;
  const dispatcher = runtime((_cursor, sink) => {
    for (let index = 0; index < 1_026; index++) {
      const cursor = sink.emit({ daemonEpoch: String(index) });
      if (cursor === null) rejected = cursor;
    }
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toHaveLength(1_026);
  expect(frames.at(-1)).toMatchObject({
    kind: 'end',
    outcome: 'error',
    error: {
      kind: 'resource_exhausted',
      retry: { kind: 'after_refresh', resource: 'stream' },
    },
  });
  expect(rejected).toBeNull();
});

it('contains cleanup errors after a stream closes', async () => {
  const dispatcher = runtime(() =>
    Promise.resolve(() => {
      throw new Error('cleanup failed');
    }),
  );
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  await Promise.resolve();
  expect(() => handle.close()).not.toThrow();
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
});

it('ends on caller abort and runs cleanup once', async () => {
  const cleanup = jest.fn();
  const controller = new AbortController();
  const dispatcher = runtime((_cursor, sink) => {
    sink.emit({ daemonEpoch: 'first' });
    return Promise.resolve(cleanup);
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
    signal: controller.signal,
  });
  const iterator = handle.frames[Symbol.asyncIterator]();
  expect((await iterator.next()).value).toMatchObject({ kind: 'item' });
  controller.abort();
  expect((await iterator.next()).value).toMatchObject({
    kind: 'end',
    outcome: 'cancelled',
  });
  expect((await iterator.next()).done).toBe(true);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('closes a stream with one terminal frame and cleanup', async () => {
  const cleanup = jest.fn();
  const dispatcher = runtime(() => Promise.resolve(cleanup));
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  handle.close();
  handle.close();
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it('deadline and shutdown produce terminal frames and drain streams', async () => {
  const cleanup = jest.fn();
  const dispatcher = runtime(() => Promise.resolve(cleanup));
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
    metadata: { deadlineAt: new Date(Date.now() + 20).toISOString() },
  });
  const deadlineFrames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) deadlineFrames.push(frame);
  expect(deadlineFrames).toHaveLength(1);
  expect(deadlineFrames[0]).toMatchObject({
    kind: 'end',
    outcome: 'error',
    error: { kind: 'deadline_exceeded' },
  });
  expect(cleanup).toHaveBeenCalledTimes(1);
  const draining = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  await dispatcher.shutdown();
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of draining.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
  expect(cleanup).toHaveBeenCalledTimes(2);
});

it('drains a stream even while its handler setup remains pending', async () => {
  const dispatcher = runtime(() => new Promise<() => void>(() => undefined));
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  await dispatcher.shutdown();
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
});

it('registers a stream before same-tick shutdown begins', async () => {
  const dispatcher = runtime(() => Promise.resolve());
  const opening = dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const draining = dispatcher.shutdown();
  const handle = await opening;
  await draining;
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
});

it('accepts Zod inputs and returns parsed outputs across instruction and stream calls', async () => {
  const transformedInstruction = defineCanopyInstructionRegistry('core', {
    'core.example.write': defineCanopyInstruction({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.write'],
      params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).transform(
        (value) => ({ text: value.daemonEpoch }),
      ),
      result: CanopyStreamCursorSchema.shape.daemonEpoch.transform(
        (value) => value.length,
      ),
      error: CanopyErrorPayloadSchema,
    }),
  });
  const transformedStream = defineCanopyStreamRegistry('core', {
    'core.example.events': defineCanopyStream({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.read'],
      params: CanopyStreamCursorSchema.pick({ daemonEpoch: true }).extend({
        daemonEpoch: CanopyStreamCursorSchema.shape.daemonEpoch.transform(
          (value) => ({ text: value.toUpperCase() }),
        ),
        cursor: CanopyStreamCursorSchema.nullable().optional(),
      }),
      item: CanopyStreamCursorSchema.shape.daemonEpoch.transform(
        (value) => value.length,
      ),
      end: CanopyStreamEndSchema,
      error: CanopyErrorPayloadSchema,
    }),
  });
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: {
      queries: {},
      instructions: transformedInstruction,
      streams: transformedStream,
    },
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': (request) => Promise.resolve(request.text),
      },
      streams: {
        'core.example.events': (request, _context, sink) => {
          sink.emit(request.daemonEpoch.text);
          sink.end('completed');
          return Promise.resolve();
        },
      },
    },
  });
  await expect(
    dispatcher.instruction(
      'core.example.write',
      { daemonEpoch: 'hello' },
      { caller },
    ),
  ).resolves.toBe(5);
  const handle = await dispatcher.openStream(
    'core.example.events',
    { daemonEpoch: 'hello', cursor: null },
    { caller },
  );
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames[0]).toMatchObject({ kind: 'item', item: 5 });
  expect(frames[1]).toMatchObject({ kind: 'end', outcome: 'completed' });
});

it('replaces a handler-ended stream error the operation does not declare', async () => {
  const narrowStream = defineCanopyStreamRegistry('core', {
    'core.example.events': defineCanopyStream({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.read'],
      params: streamDefinitions['core.example.events'].params,
      item: CanopyStreamCursorSchema.shape.daemonEpoch,
      end: CanopyStreamEndSchema,
      error: CanopyErrorPayloadSchema.refine(
        (error) => error.kind === 'not_found',
      ),
    }),
  });
  const endedErrors = [
    { kind: 'not_found' as const, message: 'Gone.' },
    { kind: 'conflict' as const, message: 'Undeclared.' },
  ];
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: { queries: {}, instructions: {}, streams: narrowStream },
    handlers: {
      queries: {},
      instructions: {},
      streams: {
        'core.example.events': (_request, _context, sink) => {
          const next = endedErrors.shift();
          if (next) sink.end('error', { ...next, retry: { kind: 'never' } });
          return Promise.resolve();
        },
      },
    },
  });
  const endFrames: CanopyStreamFrame<unknown, unknown>[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const handle = await dispatcher.openStream('core.example.events', params, {
      caller,
    });
    for await (const frame of handle.frames) endFrames.push(frame);
  }
  expect(endFrames[0]).toMatchObject({
    kind: 'end',
    outcome: 'error',
    error: { kind: 'not_found', message: 'Gone.' },
  });
  expect(endFrames[1]).toMatchObject({
    kind: 'end',
    outcome: 'error',
    error: { kind: 'internal' },
  });
});

it('runs cleanup if stream setup resolves after bounded shutdown', async () => {
  let resolveSetup: (cleanup: () => void) => void = () => undefined;
  const setup = new Promise<() => void>((resolve) => {
    resolveSetup = resolve;
  });
  const cleanup = jest.fn();
  const dispatcher = runtime(() => setup);
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  await dispatcher.shutdown();
  resolveSetup(cleanup);
  await Promise.resolve();
  await Promise.resolve();
  expect(cleanup).toHaveBeenCalledTimes(1);
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', outcome: 'cancelled' }),
  ]);
});

it('binds the in-process caller for instructions and streams', async () => {
  const seen: string[] = [];
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions,
    handlers: {
      queries: {},
      instructions: {
        'core.example.write': (_request, context) => {
          seen.push(context.caller.principalId);
          return Promise.resolve({ daemonEpoch: 'ok', sequence: 0 });
        },
      },
      streams: {
        'core.example.events': (_request, context, sink) => {
          seen.push(context.caller.principalId);
          sink.end('completed');
          return Promise.resolve();
        },
      },
    },
  });
  const client = createInProcessCanopyClient(dispatcher, caller);
  await client.instruction(
    'core.example.write',
    { daemonEpoch: 'ok', sequence: 0 },
    { metadata: { idempotencyKey: 'client' } },
  );
  const handle = await client.openStream('core.example.events', params);
  for await (const frame of handle.frames) expect(frame.kind).toBeDefined();
  expect(seen).toEqual(['test', 'test']);
});

it('delivers frames synchronously to onFrame listeners after flushing buffered frames', async () => {
  let streamSink:
    | {
        emit(item: { daemonEpoch: string }): CanopyStreamCursor | null;
        end(outcome: 'completed' | 'cancelled' | 'error'): void;
      }
    | undefined;
  const dispatcher = runtime((_cursor, sink) => {
    streamSink = sink;
    sink.emit({ daemonEpoch: 'buffered' });
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  handle.onFrame(() => {
    throw new Error('isolated');
  });
  handle.onFrame((frame) => frames.push(frame));
  expect(frames).toEqual([]);
  const detach = handle.onFrame(() => undefined);
  detach();
  const cursor = streamSink?.emit({ daemonEpoch: 'live' });
  expect(frames.at(-1)).toEqual({
    kind: 'item',
    cursor,
    item: { daemonEpoch: 'LIVE' },
  });
  streamSink?.end('completed');
  expect(frames.at(-1)).toMatchObject({ kind: 'end', outcome: 'completed' });
  await expect(handle.frames[Symbol.asyncIterator]().next()).rejects.toThrow(
    'consumed by onFrame',
  );
  await dispatcher.shutdown();
});

it('delivers buffered items before a reentrant close terminal frame', async () => {
  const dispatcher = runtime((_cursor, sink) => {
    sink.emit({ daemonEpoch: 'first' });
    sink.emit({ daemonEpoch: 'second' });
    sink.emit({ daemonEpoch: 'third' });
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const received: string[] = [];
  handle.onFrame((frame) => {
    received.push(frame.kind === 'item' ? frame.item.daemonEpoch : frame.kind);
    if (received.length === 1) handle.close();
  });
  expect(received).toEqual(['FIRST', 'SECOND', 'THIRD', 'end']);
  await dispatcher.shutdown();
});

it('flushes buffered frames to the first onFrame listener and rejects mixed consumption', async () => {
  const dispatcher = runtime((_cursor, sink) => {
    sink.emit({ daemonEpoch: 'one' });
    return Promise.resolve();
  });
  const pushed = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  pushed.onFrame((frame) => frames.push(frame));
  expect(frames).toMatchObject([
    { kind: 'item', item: { daemonEpoch: 'ONE' } },
  ]);
  pushed.close();
  expect(frames.at(-1)).toMatchObject({ kind: 'end', outcome: 'cancelled' });

  const pulled = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const iterator = pulled.frames[Symbol.asyncIterator]();
  await expect(iterator.next()).resolves.toMatchObject({
    value: { kind: 'item' },
  });
  expect(() => pulled.onFrame(() => undefined)).toThrow(
    'consumed by the frames iterator',
  );
  pulled.close();
  await dispatcher.shutdown();
});

it('delivers frames emitted during handler setup to an onFrame option before open resolves', async () => {
  const dispatcher = runtime((_cursor, sink) => {
    sink.emit({ daemonEpoch: 'setup' });
    return Promise.resolve();
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  const opened = dispatcher.openStream('core.example.events', params, {
    caller,
    onFrame: (frame) => frames.push(frame),
  });
  expect(frames).toMatchObject([
    { kind: 'item', item: { daemonEpoch: 'SETUP' } },
  ]);
  const handle = await opened;
  await expect(handle.frames[Symbol.asyncIterator]().next()).rejects.toThrow(
    'consumed by onFrame',
  );
  handle.close();
  expect(frames.at(-1)).toMatchObject({ kind: 'end', outcome: 'cancelled' });
  await dispatcher.shutdown();
});

it('drains instruction admission while queries, streams, and in-flight instructions continue', async () => {
  const queryDefinitions = defineCanopyQueryRegistry('core', {
    'core.example.read': defineCanopyQuery({
      plane: 'core',
      domain: 'example',
      version: 1,
      placement: 'core-only',
      idempotency: 'inherent',
      requiredGrants: ['core.example.read'],
      params: CanopyStreamCursorSchema,
      result: CanopyStreamCursorSchema,
      error: CanopyErrorPayloadSchema,
    }),
  });
  let releaseWrite: () => void = () => undefined;
  const dispatcher = createCanopyDispatcher({
    profile: 'core',
    definitions: { ...definitions, queries: queryDefinitions },
    handlers: {
      queries: { 'core.example.read': (request) => request },
      instructions: {
        'core.example.write': (request) =>
          new Promise<CanopyStreamCursor>((resolve) => {
            releaseWrite = (): void => resolve(request);
          }),
      },
      streams: {
        'core.example.events': (_request, _context, sink) => {
          sink.emit({ daemonEpoch: 'live' });
          sink.end('completed');
          return Promise.resolve();
        },
      },
    },
  });
  const cursor = { daemonEpoch: 'one', sequence: 1 };
  const refusal = (): Promise<unknown> =>
    dispatcher
      .instruction('core.example.write', cursor, {
        caller,
        metadata: { idempotencyKey: 'late' },
      })
      .then(
        () => 'admitted',
        (error: unknown) =>
          error instanceof CanopyOperationError ? error.payload : error,
      );
  const inFlight = dispatcher.instruction('core.example.write', cursor, {
    caller,
    metadata: { idempotencyKey: 'in-flight' },
  });
  dispatcher.drainInstructions();
  dispatcher.drainInstructions();
  expect(dispatcher.state).toBe('draining');
  const drained = await refusal();
  await expect(
    dispatcher.query('core.example.read', cursor, { caller }),
  ).resolves.toEqual(cursor);
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames.map((frame) => frame.kind)).toEqual(['item', 'end']);
  releaseWrite();
  await expect(inFlight).resolves.toEqual(cursor);
  await dispatcher.shutdown();
  dispatcher.drainInstructions();
  expect(dispatcher.state).toBe('closed');
  expect(drained).toMatchObject({
    kind: 'unavailable',
    retry: { kind: 'same_idempotency_key' },
  });
  expect(drained).toEqual(await refusal());
});

const item = { daemonEpoch: 'item' };
const at = (sequence: number, daemonEpoch = 'journal'): CanopyStreamCursor => ({
  daemonEpoch,
  sequence,
});

it('preserves supplied source cursors on item and terminal frames', async () => {
  const source = { daemonEpoch: 'journal', sequence: 7 };
  const returned: Array<CanopyStreamCursor | null> = [];
  const dispatcher = runtime((_cursor, sink) => {
    returned.push(sink.emitAt(source, { daemonEpoch: 'one' }));
    source.sequence = 99;
    returned.push(
      sink.emitAt(
        { daemonEpoch: 'journal', sequence: 9 },
        { daemonEpoch: 'two' },
      ),
    );
    sink.end('completed');
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(returned).toEqual([at(7), at(9)]);
  expect(frames).toEqual([
    { kind: 'item', cursor: at(7), item: { daemonEpoch: 'ONE' } },
    { kind: 'item', cursor: at(9), item: { daemonEpoch: 'TWO' } },
    expect.objectContaining({
      kind: 'end',
      cursor: at(9),
      outcome: 'completed',
      marker: 'parsed',
    }),
  ]);
});

const corrupt = (cursor: CanopyStreamCursor): void => {
  Object.assign(cursor, at(99, 'other'));
};
const parsedItem = { daemonEpoch: 'ITEM' };
it.each(['onFrame', 'pulled', 'returned'] as const)(
  'keeps supplied cursor ordering private when a %s cursor is mutated',
  async (boundary) => {
    let streamSink: TestSink | undefined;
    const dispatcher = runtime((_cursor, sink) => {
      streamSink = sink;
      return Promise.resolve();
    });
    const handle = await dispatcher.openStream('core.example.events', params, {
      caller,
    });
    const frames: CanopyStreamFrame<unknown, unknown>[] = [];
    const iterator = handle.frames[Symbol.asyncIterator]();
    if (boundary === 'onFrame') {
      handle.onFrame((frame) => corrupt(frame.cursor));
      handle.onFrame((frame) => frames.push(frame));
    }
    const source = at(7);
    const first = streamSink?.emitAt(source, item) ?? null;
    const results = [first && { ...first }];
    corrupt(source);
    if (boundary === 'returned' && first) corrupt(first);
    const pulled = boundary === 'pulled' ? await iterator.next() : undefined;
    if (pulled && !pulled.done) {
      frames.push({ ...pulled.value, cursor: { ...pulled.value.cursor } });
      corrupt(pulled.value.cursor);
    }
    results.push(
      streamSink?.emitAt(at(9), item) ?? null,
      streamSink?.emitAt(at(100, 'other'), item) ?? null,
    );
    let next = boundary === 'onFrame' ? undefined : await iterator.next();
    for (; next && !next.done; next = await iterator.next())
      frames.push(next.value);
    expect(results).toEqual([at(7), at(9), null]);
    expect(frames).toEqual([
      { kind: 'item', cursor: at(7), item: parsedItem },
      { kind: 'item', cursor: at(9), item: parsedItem },
      expect.objectContaining({ kind: 'end', cursor: at(9), outcome: 'error' }),
    ]);
  },
);

it.each(['onCursorAssigned', 'returned'] as const)(
  'keeps allocated cursors private when a %s cursor is mutated',
  async (boundary) => {
    const results: Array<CanopyStreamCursor | null> = [];
    const dispatcher = runtime((_cursor, sink) => {
      const assigned = boundary === 'onCursorAssigned' ? corrupt : undefined;
      const cursor = sink.emit(item, assigned);
      results.push(cursor && { ...cursor });
      if (boundary === 'returned' && cursor) corrupt(cursor);
      sink.end('completed');
      return Promise.resolve();
    });
    const handle = await dispatcher.openStream('core.example.events', params, {
      caller,
    });
    const frames: CanopyStreamFrame<unknown, unknown>[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    const [itemFrame, endFrame] = frames;
    expect([...results, itemFrame?.cursor, endFrame?.cursor]).toEqual(
      Array(3).fill(expect.objectContaining({ sequence: 1 })),
    );
    expect(frames).toMatchObject([
      { kind: 'item', item: parsedItem },
      { kind: 'end', outcome: 'completed' },
    ]);
  },
);

type Emitted = Array<CanopyStreamCursor | null>;
it.each(['close', 'shutdown', 'synchronous end'] as const)(
  'ends an idle resumed stream at a private copy of the resume cursor on %s',
  async (terminal) => {
    const dispatcher = runtime((cursor, sink) => {
      if (cursor) corrupt(cursor);
      if (terminal === 'synchronous end') sink.end('completed');
      return Promise.resolve();
    });
    const request = { ...params, cursor: at(4) };
    const opened = dispatcher.openStream('core.example.events', request, {
      caller,
    });
    corrupt(request.cursor);
    const handle = await opened;
    const accepted = handle.openResult.acceptedCursor;
    expect(accepted).toEqual(at(4));
    if (accepted) corrupt(accepted);
    if (terminal === 'close') handle.close();
    const stopping = dispatcher.shutdown();
    const frames: CanopyStreamFrame<unknown, unknown>[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    await stopping;
    expect(frames).toEqual([
      expect.objectContaining({
        kind: 'end',
        cursor: at(4),
        outcome: terminal === 'synchronous end' ? 'completed' : 'cancelled',
      }),
    ]);
  },
);

it.each<[string, EmitScenario]>([
  ['allocated', (sink): Emitted => [sink.emit(item)]],
  ['supplied', (sink): Emitted => [sink.emitAt(at(5), item)]],
])('ends a resumed stream at its last %s cursor', async (_label, emit) => {
  let emitted: Emitted = [];
  const dispatcher = runtime((_cursor, sink) => {
    emitted = emit(sink);
    sink.end('completed');
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream(
    'core.example.events',
    { ...params, cursor: at(4) },
    { caller },
  );
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  const [last] = emitted;
  expect(last).not.toBeNull();
  expect(last).not.toEqual(at(4));
  expect(frames).toEqual([
    { kind: 'item', cursor: last, item: parsedItem },
    expect.objectContaining({
      kind: 'end',
      cursor: last,
      outcome: 'completed',
    }),
  ]);
});

it.each([
  ['an equal', at(4)],
  ['a lower', at(3)],
  ['a foreign-epoch', at(5, 'other')],
])('rejects %s first supplied cursor after resume', async (_label, first) => {
  let emitted: CanopyStreamCursor | null | undefined;
  const dispatcher = runtime((cursor, sink) => {
    if (cursor) corrupt(cursor);
    emitted = sink.emitAt(first, item);
    sink.end('completed');
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream(
    'core.example.events',
    { ...params, cursor: at(4) },
    { caller },
  );
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(emitted).toBeNull();
  expect(frames).toEqual([
    expect.objectContaining({ kind: 'end', cursor: at(4), outcome: 'error' }),
  ]);
});

type EmitScenario = (sink: TestSink) => Array<CanopyStreamCursor | null>;
const invalidEmits: Record<string, EmitScenario> = {
  'an invalid cursor': (sink) => [sink.emitAt(at(1, ''), item)],
  'an invalid item': (sink) => [sink.emitAt(at(1), { daemonEpoch: '' })],
  'a repeated sequence': (sink) => [
    sink.emitAt(at(3), item),
    sink.emitAt(at(3), item),
  ],
  'a lower sequence': (sink) => [
    sink.emitAt(at(3), item),
    sink.emitAt(at(2), item),
  ],
  'an epoch switch': (sink) => [
    sink.emitAt(at(3), item),
    sink.emitAt(at(4, 'other'), item),
  ],
  'emitAt after emit': (sink) => [sink.emit(item), sink.emitAt(at(3), item)],
  'emit after emitAt': (sink) => [sink.emitAt(at(3), item), sink.emit(item)],
};
it.each(Object.entries(invalidEmits))(
  'ends the stream as an invalid result on %s',
  async (_label, emit) => {
    let results: Array<CanopyStreamCursor | null> = [];
    let afterEnd: CanopyStreamCursor | null | undefined;
    const dispatcher = runtime((_cursor, sink) => {
      results = emit(sink);
      afterEnd = sink.emitAt(at(50), item);
      return Promise.resolve();
    });
    const handle = await dispatcher.openStream('core.example.events', params, {
      caller,
    });
    const frames: CanopyStreamFrame<unknown, unknown>[] = [];
    for await (const frame of handle.frames) frames.push(frame);
    expect(results.at(-1)).toBeNull();
    expect(afterEnd).toBeNull();
    expect(frames).toHaveLength(results.length);
    expect(frames.at(-1)).toMatchObject({
      kind: 'end',
      outcome: 'error',
      error: {
        kind: 'internal',
        message: 'The operation returned an invalid result.',
      },
    });
    if (frames.length > 1) expect(frames[1].cursor).toEqual(frames[0].cursor);
  },
);

type EndScenario = {
  resume: CanopyStreamCursor | null;
  run: (sink: TestSink) => void;
  end: CanopyStreamCursor;
};
// A bridge ends where its source ended, such as a worker stream that ends
// before its first item (CAN-5696), so a resume from that end reaches the source.
it.each<[string, EndScenario]>([
  [
    'adopts the cursor of a stream with no items',
    {
      resume: null,
      run: (sink): void => sink.endAt(at(6), 'completed'),
      end: at(6),
    },
  ],
  [
    'keeps the last supplied cursor',
    {
      resume: null,
      run: (sink): void => {
        sink.emitAt(at(5), item);
        sink.endAt(at(5), 'completed');
      },
      end: at(5),
    },
  ],
  [
    'moves past the last supplied cursor',
    {
      resume: null,
      run: (sink): void => {
        sink.emitAt(at(5), item);
        sink.endAt(at(7), 'completed');
      },
      end: at(7),
    },
  ],
  [
    'keeps the resume cursor of an idle resumed stream',
    {
      resume: at(4),
      run: (sink): void => sink.endAt(at(4), 'completed'),
      end: at(4),
    },
  ],
])('endAt %s', async (_label, { resume, run, end }) => {
  const dispatcher = runtime((_cursor, sink) => {
    run(sink);
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream(
    'core.example.events',
    { ...params, cursor: resume },
    { caller },
  );
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames.at(-1)).toEqual(
    expect.objectContaining({ kind: 'end', cursor: end, outcome: 'completed' }),
  );
});

it.each<[string, EndScenario]>([
  [
    'an invalid cursor',
    {
      resume: null,
      run: (sink): void => {
        sink.emitAt(at(5), item);
        sink.endAt(at(6, ''), 'completed');
      },
      end: at(5),
    },
  ],
  [
    'a lower sequence',
    {
      resume: null,
      run: (sink): void => {
        sink.emitAt(at(5), item);
        sink.endAt(at(4), 'completed');
      },
      end: at(5),
    },
  ],
  [
    'an epoch switch',
    {
      resume: null,
      run: (sink): void => {
        sink.emitAt(at(5), item);
        sink.endAt(at(6, 'other'), 'completed');
      },
      end: at(5),
    },
  ],
  [
    'a foreign epoch after resume',
    {
      resume: at(4),
      run: (sink): void => sink.endAt(at(5, 'other'), 'completed'),
      end: at(4),
    },
  ],
  [
    'a sequence below the resume cursor',
    {
      resume: at(4),
      run: (sink): void => sink.endAt(at(3), 'completed'),
      end: at(4),
    },
  ],
])('endAt ends as an invalid result on %s', async (_label, scenario) => {
  const dispatcher = runtime((_cursor, sink) => {
    scenario.run(sink);
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream(
    'core.example.events',
    { ...params, cursor: scenario.resume },
    { caller },
  );
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(frames.at(-1)).toMatchObject({
    kind: 'end',
    cursor: scenario.end,
    outcome: 'error',
    error: { message: 'The operation returned an invalid result.' },
  });
});

it('endAt after an allocated cursor ends as an invalid result', async () => {
  let allocated: CanopyStreamCursor | null = null;
  const dispatcher = runtime((_cursor, sink) => {
    allocated = sink.emit(item);
    sink.endAt(at(50), 'completed');
    return Promise.resolve();
  });
  const handle = await dispatcher.openStream('core.example.events', params, {
    caller,
  });
  const frames: CanopyStreamFrame<unknown, unknown>[] = [];
  for await (const frame of handle.frames) frames.push(frame);
  expect(allocated).not.toBeNull();
  expect(frames.at(-1)).toMatchObject({
    kind: 'end',
    cursor: allocated,
    outcome: 'error',
  });
});
