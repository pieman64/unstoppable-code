import { Buffer } from 'node:buffer';
import { encodeCanopyJsonFrame } from '@canopy/core-transport';
import type {
  CanopyErrorPayload,
  CanopyInstructionDefinitionMap,
  CanopyQueryDefinitionMap,
  CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../index';
import type { CanopyClient } from '../types';
import { drain, rejection } from './client-conformance';
import {
  CANONICAL_DEFINITIONS,
  serveCanonicalCore,
  type CanonicalCoreServer,
} from './fixtures/canonical-core';
import { createRawWirePair, type RawWirePair } from './fixtures/raw-wire';

/** Wide maps accept dynamic operation names and untyped params. */
type WideClient = CanopyClient<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;

/** Bounded, so a missed settle fails the assertion instead of the Jest timeout. */
function within<T>(promise: Promise<T>): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, 1_000, 'timeout');
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Lets queued in-memory I/O land. */
async function drainIo(): Promise<void> {
  for (let tick = 0; tick < 20; tick += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

/** Reports a promise still pending once queued I/O has landed. */
async function peek<T>(promise: Promise<T>): Promise<T | 'pending'> {
  await drainIo();
  return Promise.race([promise, Promise.resolve<'pending'>('pending')]);
}

const echoReply = (id: number | string, text: string): Buffer =>
  encodeCanopyJsonFrame({
    jsonrpc: '2.0',
    id,
    result: { text, length: text.length },
  });

const notification = (method: string, params: unknown = {}): object => ({
  jsonrpc: '2.0',
  method,
  params,
});

const openReply = (id: number, subscriptionId: string): Buffer =>
  encodeCanopyJsonFrame({
    jsonrpc: '2.0',
    id,
    result: { subscriptionId, acceptedCursor: null },
  });

/** A `core.test.ticks` item, or its completed end, at `sequence`. */
function tickFrame(id: string, sequence: number, end = false): Buffer {
  const cursor = { daemonEpoch: 'epoch-1', sequence };
  const params = end
    ? { outcome: 'completed', error: null }
    : {
        itemId: `item-${sequence}`,
        occurredAt: '2026-10-07T12:00:00Z',
        item: { tick: sequence },
      };
  const method = `core.test.ticks.${end ? 'end' : 'item'}`;
  return encodeCanopyJsonFrame(
    notification(method, { subscriptionId: id, cursor, ...params }),
  );
}

/** Frames JSON text as-is; the encoder refuses batch arrays. */
function rawJsonFrame(json: string): Buffer {
  const body = Buffer.from(json, 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/** `{"text":"a"}` framed, with one body byte counted from the end replaced. */
function patchedFrame(fromEnd: number, byte: number): Buffer {
  const frame = encodeCanopyJsonFrame({ text: 'a' });
  frame[frame.length - fromEnd] = byte;
  return frame;
}

const recordKeyed = (client: WideClient, value: number): Promise<unknown> =>
  client.instruction(
    'core.test.record',
    { value },
    { metadata: { idempotencyKey: `key-${value}` } },
  );

describe('createCanopyClient raw wire', () => {
  const cleanups: (() => Promise<unknown>)[] = [];
  afterEach(async () => {
    const settled: unknown[] = [];
    for (const cleanup of cleanups.splice(0).reverse())
      settled.push(await within(cleanup()));
    // Asserted last so a stuck cleanup still lets the others run.
    expect(settled).not.toContain('timeout');
  });

  /** Echo, record, and ticks hang unless echo is asked for `ok`, so tests inject replies. */
  async function open(maxFrameBytes?: number): Promise<{
    client: WideClient;
    wire: RawWirePair;
    core: CanonicalCoreServer;
  }> {
    const wire = await createRawWirePair({ maxFrameBytes });
    cleanups.push(() => wire.close());
    const core = serveCanonicalCore(wire.server, {
      'core.test.echo': ({ text }) =>
        text === 'ok' ? { text, length: 2 } : new Promise(() => {}),
      'core.test.record': () => new Promise(() => {}),
      'core.test.ticks': () => new Promise(() => {}),
    });
    cleanups.push(() => core.done);
    const client = await createCanopyClient<
      CanopyQueryDefinitionMap,
      CanopyInstructionDefinitionMap,
      CanopyStreamDefinitionMap
    >({
      connection: wire.client,
      clientName: 'raw-wire',
      clientVersion: '1.0.0',
      definitions: CANONICAL_DEFINITIONS,
    });
    cleanups.push(() => client.close());
    return { client, wire, core };
  }

  /**
   * One hostile write must settle the pending call (id 2: initialize was
   * id 1), abort the client and its connection, and keep the reason for
   * later calls of either kind.
   */
  async function expectFailsClosed(
    hostile: Uint8Array | object,
    kind: CanopyErrorPayload['kind'],
    maxFrameBytes?: number,
  ): Promise<void> {
    const { client, wire } = await open(maxFrameBytes);
    const pending = rejection(client.query('core.test.echo', { text: 'a' }));
    if (hostile instanceof Uint8Array) wire.write(hostile);
    else wire.writeFrame(hostile);
    const reason = await within(pending);
    expect(reason).toMatchObject({ kind, retry: { kind: 'never' } });
    expect(client.signal.aborted).toBe(true);
    expect(client.connection.signal.aborted).toBe(true);
    expect(
      await rejection(client.query('core.test.echo', { text: 'ok' })),
    ).toEqual(reason);
    expect(await rejection(recordKeyed(client, 1))).toEqual(reason);
  }

  it('reassembles replies written one byte at a time across frame boundaries', async () => {
    const { client, wire } = await open();
    // Initialize was id 1.
    const first = client.query('core.test.echo', { text: 'a' });
    const second = client.query('core.test.echo', { text: 'bc' });
    const head = echoReply(3, 'bc');
    const bytes = Buffer.concat([head, echoReply(2, 'a')]);
    const writeBytes = (from: number, to: number): void => {
      for (let index = from; index < to; index += 1)
        wire.write(bytes.subarray(index, index + 1));
    };
    writeBytes(0, head.length - 1);
    expect(await peek(second)).toBe('pending');
    writeBytes(head.length - 1, bytes.length - 1);
    expect(await within(second)).toEqual({ text: 'bc', length: 2 });
    expect(await peek(first)).toBe('pending');
    writeBytes(bytes.length - 1, bytes.length);
    expect(await within(first)).toEqual({ text: 'a', length: 1 });
    expect(client.signal.aborted).toBe(false);
  });

  it.each<[string, CanopyErrorPayload['kind'], Uint8Array | object]>([
    [
      'a 4 GiB length header with no body',
      'resource_exhausted',
      Uint8Array.of(0xff, 0xff, 0xff, 0xff),
    ],
    ['invalid UTF-8', 'invalid_argument', patchedFrame(3, 0xff)],
    ['invalid JSON', 'invalid_argument', patchedFrame(1, 0x20)],
    [
      'a malformed JSON-RPC envelope',
      'internal',
      { jsonrpc: '2.0', id: 2, bogus: true },
    ],
    ['an unissued id', 'internal', echoReply(3, 'a')],
    ['id 0', 'internal', echoReply(0, 'a')],
    ['a string id', 'internal', echoReply('2', 'a')],
    [
      'a null-id error',
      'internal',
      {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32600, message: 'Invalid request.' },
      },
    ],
  ])(
    'fails closed on %s and keeps the reason for later calls',
    async (_, kind, hostile) => {
      await expectFailsClosed(hostile, kind);
    },
  );

  it('fails closed on a second reply to a settled call', async () => {
    const { client, wire } = await open();
    const first = client.query('core.test.echo', { text: 'a' });
    wire.write(echoReply(2, 'a'));
    expect(await within(first)).toEqual({ text: 'a', length: 1 });
    const pending = rejection(client.query('core.test.echo', { text: 'b' }));
    wire.write(echoReply(2, 'a'));
    expect(await within(pending)).toMatchObject({ kind: 'internal' });
    expect(client.connection.signal.aborted).toBe(true);
  });

  it('re-arms a deadline beyond the 2^31 ms timer limit instead of firing early', async () => {
    const { client } = await open();
    // Real I/O keeps flowing; only the clock and timeouts are simulated.
    jest.useFakeTimers({
      doNotFake: [
        'nextTick',
        'setImmediate',
        'clearImmediate',
        'queueMicrotask',
      ],
    });
    try {
      const deadlineAt = new Date(Date.now() + 2 ** 31 + 1_000).toISOString();
      const outcome = rejection(
        client.query('core.test.echo', { text: 'slow', _meta: { deadlineAt } }),
      );
      await jest.advanceTimersByTimeAsync(1);
      expect(await peek(outcome)).toBe('pending');
      // Past the first 2^31 - 1 ms timer, still 999 ms short of the deadline.
      await jest.advanceTimersByTimeAsync(2 ** 31);
      expect(await peek(outcome)).toBe('pending');
      await jest.advanceTimersByTimeAsync(1_000);
      expect(await peek(outcome)).toMatchObject({
        kind: 'deadline_exceeded',
        retry: { kind: 'same_request' },
      });
      expect(client.signal.aborted).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  // Option metadata is covered by the conformance suite; these are params-borne.
  it('rejects invalid params and params._meta locally and sends valid params exactly', async () => {
    const { client, core } = await open();
    const invalid: unknown[] = [
      { text: 1 },
      { text: 'a', extra: true },
      'a',
      null,
      ['a'],
      { text: 'a', _meta: { idempotencyKey: 'not-for-queries' } },
      { text: 'a', _meta: { deadlineAt: 'tomorrow' } },
    ];
    for (const params of invalid)
      expect(
        await rejection(client.query('core.test.echo', params)),
      ).toMatchObject({ kind: 'invalid_argument' });
    const valid = [
      { text: 'ok' },
      { text: 'ok', _meta: { traceparent: 't-1' } },
    ];
    for (const params of valid)
      expect(await within(client.query('core.test.echo', params))).toEqual({
        text: 'ok',
        length: 2,
      });
    expect(core.requests.slice(1).map(({ params }) => params)).toStrictEqual(
      valid,
    );
  });

  it('rejects an outgoing request past the frame cap and stays usable', async () => {
    const { client } = await open(4_096);
    expect(
      await rejection(
        client.query('core.test.echo', { text: 'x'.repeat(8_192) }),
      ),
    ).toMatchObject({ kind: 'resource_exhausted', retry: { kind: 'never' } });
    expect(client.signal.aborted).toBe(false);
    expect(
      await within(client.query('core.test.echo', { text: 'ok' })),
    ).toEqual({ text: 'ok', length: 2 });
  });

  describe('framed notifications', () => {
    // None of these carries a live subscription id, so the facade drops them.
    it('drops valid notifications, split or whole, without settling, answering, or closing', async () => {
      const { client, wire } = await open();
      const pending = client.query('core.test.echo', { text: 'a' });
      const send = jest.spyOn(client.connection, 'send');
      const split = Buffer.concat([
        encodeCanopyJsonFrame(notification('core.test.ticks', { seq: 1 })),
        encodeCanopyJsonFrame(notification('core.test.unadvertised')),
      ]);
      for (let index = 0; index < split.length; index += 5)
        wire.write(split.subarray(index, index + 5));
      expect(await peek(pending)).toBe('pending');
      expect(client.signal.aborted).toBe(false);
      wire.write(
        Buffer.concat([
          encodeCanopyJsonFrame(notification('core.test.ticks', { seq: 2 })),
          echoReply(2, 'a'),
          encodeCanopyJsonFrame(notification('core.test.ticks', { seq: 3 })),
        ]),
      );
      expect(await within(pending)).toEqual({ text: 'a', length: 1 });
      await drainIo();
      expect(client.signal.aborted).toBe(false);
      expect(client.connection.signal.aborted).toBe(false);
      expect(
        await within(client.query('core.test.echo', { text: 'ok' })),
      ).toEqual({ text: 'ok', length: 2 });
      // Only the later request reached the wire: no reply to any notification.
      expect(send.mock.calls.map(([message]) => message)).toEqual([
        expect.objectContaining({ id: 3, method: 'core.test.echo' }),
      ]);
    });

    it.each<[string, object]>([
      ['missing params', { jsonrpc: '2.0', method: 'core.test.ticks' }],
      ['array params', notification('core.test.ticks', [1])],
      ['an invalid method name', notification('Not A Method')],
      [
        'a wrong JSON-RPC version',
        { jsonrpc: '1.0', method: 'core.test.ticks', params: {} },
      ],
      [
        'an unknown member',
        { ...notification('core.test.ticks'), extra: true },
      ],
      [
        'a batch',
        rawJsonFrame(JSON.stringify([notification('core.test.ticks')])),
      ],
    ])(
      'fails closed on a notification with %s and keeps the reason',
      async (_, hostile) => {
        await expectFailsClosed(hostile, 'internal');
      },
    );

    it('routes split frames for a live subscription in order and drops unknown ones', async () => {
      const { client, wire } = await open();
      const opening = client.openStream('core.test.ticks', { count: 0 });
      wire.write(openReply(2, 'live'));
      const handle = await opening;
      const send = jest.spyOn(client.connection, 'send');
      const split = Buffer.concat([
        tickFrame('live', 1),
        tickFrame('ghost', 2),
        tickFrame('ghost', 2, true),
        tickFrame('live', 3),
        tickFrame('live', 3, true),
      ]);
      for (let index = 0; index < split.length; index += 5)
        wire.write(split.subarray(index, index + 5));
      expect(await drain(handle.frames)).toMatchObject([
        { kind: 'item', cursor: { sequence: 1 }, item: { tick: 1 } },
        { kind: 'item', cursor: { sequence: 3 }, item: { tick: 3 } },
        { kind: 'end', cursor: { sequence: 3 }, outcome: 'completed' },
      ]);
      expect(send).not.toHaveBeenCalled();
      expect(
        await within(client.query('core.test.echo', { text: 'ok' })),
      ).toEqual({ text: 'ok', length: 2 });
    });

    it('fails closed when the core reuses an active subscription id', async () => {
      const { client, wire } = await open();
      const opening = client.openStream('core.test.ticks', { count: 0 });
      wire.write(openReply(2, 'dup'));
      const handle = await opening;
      const reused = rejection(
        client.openStream('core.test.ticks', { count: 0 }),
      );
      wire.write(openReply(3, 'dup'));
      expect(await within(reused)).toMatchObject({
        kind: 'internal',
        retry: { kind: 'never' },
      });
      expect(await drain(handle.frames)).toMatchObject([
        { kind: 'end', outcome: 'error', error: { kind: 'internal' } },
      ]);
      expect(client.signal.aborted).toBe(true);
      expect(client.connection.signal.aborted).toBe(true);
    });

    it('fails closed on a notification frame past the inbound cap', async () => {
      await expectFailsClosed(
        notification('core.test.ticks', { blob: 'x'.repeat(8_192) }),
        'resource_exhausted',
        4_096,
      );
    });
  });

  describe('truncated frames', () => {
    const reply = echoReply(2, 'a');
    const tick = encodeCanopyJsonFrame(notification('core.test.ticks'));

    it.each<[string, Buffer]>([
      ['a partial length header', reply.subarray(0, 2)],
      ['a reply missing its last byte', reply.subarray(0, reply.length - 1)],
      [
        'a notification missing its last byte',
        tick.subarray(0, tick.length - 1),
      ],
    ])(
      'holds calls on %s, then settles them as unavailable at EOF',
      async (_, truncated) => {
        const { client, wire } = await open();
        const query = rejection(client.query('core.test.echo', { text: 'a' }));
        const keyed = rejection(recordKeyed(client, 1));
        wire.write(truncated);
        expect(await peek(query)).toBe('pending');
        expect(client.signal.aborted).toBe(false);
        wire.end();
        const queryReason = await within(query);
        expect(queryReason).toMatchObject({
          kind: 'unavailable',
          retry: { kind: 'same_request' },
        });
        // A keyed instruction lost to disconnect retries with its key.
        const keyedReason = await within(keyed);
        expect(keyedReason).toMatchObject({
          kind: 'unavailable',
          retry: { kind: 'same_idempotency_key' },
        });
        expect(client.signal.aborted).toBe(true);
        expect(client.connection.signal.aborted).toBe(true);
        expect(
          await rejection(client.query('core.test.echo', { text: 'ok' })),
        ).toEqual(queryReason);
        expect(await rejection(recordKeyed(client, 2))).toEqual(keyedReason);
      },
    );
  });
});
