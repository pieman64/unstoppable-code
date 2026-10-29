import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CORE_CLIENT_LEASE_EVICTED,
  CoreClientLeaseEvictedSchema,
  CanopyStreamCursorSchema,
  canopyStreamFrameType,
  composeCanopyOperationEnvelopes,
  decodeCanopyError,
  isCanopySnapshotRequiredError,
  type CanopyErrorKind,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcNotification,
  type CanopyOperationName,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';

import { CanopyTransportError, encodeCanopyJsonFrame } from '../codec';
import type { CanopyFramedPair } from '../in-memory';
import type { CanopyByteChannel, CanopyFramedConnection } from '../types';
import { serveReferenceCore, startReferenceJournal } from './reference-core';

/** One live journal-backed core; each journal case starts and closes its own. */
export interface CanopyJournalConformanceInstance {
  /** Epoch of every cursor this instance issues. */
  readonly daemonEpoch: string;
  /** Plays the core end of one pair against this instance's journal. */
  serve(server: CanopyFramedConnection): void;
  /** Appends `count` events and resolves their cursors in order. */
  append(count: number): Promise<readonly CanopyStreamCursor[]>;
  /** Resolves a same-epoch cursor the journal has evicted and cannot replay. */
  expire(): Promise<CanopyStreamCursor>;
  close(): Promise<void>;
}

export interface CanopyJournalConformanceTarget {
  readonly name: string;
  /** Stream under test; envelopes are composed from its catalog definition. */
  readonly method: keyof typeof CORE_TRANSPORT_STREAM_DEFINITIONS;
  /** Open params merged with each case's `cursor`. */
  readonly params?: Readonly<Record<string, unknown>>;
  start(): Promise<CanopyJournalConformanceInstance>;
}

/** One live control plane whose lease clock the kit drives. */
export interface CanopyLeaseConformanceInstance {
  /** An authenticated client end served by the control plane under test. */
  connect(): Promise<CanopyFramedConnection>;
  /** The lease clock, in epoch milliseconds. */
  now(): number;
  /** Moves the lease clock forward and runs the timers that fall due. */
  advance(ms: number): Promise<void>;
  /** Resolves once the server has seen the lease's connection close. */
  whenDetached(leaseId: string): Promise<void>;
  readonly reconnectGraceMs: number;
  close(): Promise<void>;
}

export interface CanopyLeaseConformanceTarget {
  readonly name: string;
  start(): Promise<CanopyLeaseConformanceInstance>;
}

export interface CanopyLeaseConformanceOptions {
  readonly name: string;
  readonly target: CanopyLeaseConformanceTarget;
  readonly describe: CanopyTransportConformanceOptions['describe'];
  readonly it: CanopyTransportConformanceOptions['it'];
}

export interface CanopyConformancePairOptions {
  readonly clientSecret?: string;
  readonly clientDataRootHash?: string;
  readonly maxFrameBytes?: number;
  readonly maxBufferedMessages?: number;
}

export interface CanopyTransportConformanceOptions {
  /** Binding name shown in the suite title, e.g. `in-memory` or `unix-socket`. */
  readonly name: string;
  readonly createPair: (
    options?: CanopyConformancePairOptions,
  ) => Promise<CanopyFramedPair>;
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => Promise<void>) => void;
  /** Registers a case the binding cannot run yet (jest: `it.todo`). */
  readonly todo: (name: string) => void;
}

export interface CanopyJournalConformanceOptions {
  /** Binding name shown in the suite title. */
  readonly name: string;
  readonly createPair: CanopyTransportConformanceOptions['createPair'];
  readonly target: CanopyJournalConformanceTarget;
  readonly describe: CanopyTransportConformanceOptions['describe'];
  readonly it: CanopyTransportConformanceOptions['it'];
}

/**
 * Cases whose shape is fixed now but which need a lane's lease registry,
 * endpoint, launcher, or kernel. Each owner adds its case to this kit.
 */
export const CANOPY_TRANSPORT_CONFORMANCE_PENDING = [
  { name: 'client renews its lease before the TTL', owner: 'CAN-3728 K3' },
  {
    name: 'client reacquires with previousLeaseId after reconnect',
    owner: 'CAN-3728 K3',
  },
  { name: 'stale socket path probe before unlink', owner: 'CAN-3727 C5' },
  {
    name: 'first-instance named pipe owns the endpoint',
    owner: 'CAN-3727 C5',
  },
  {
    name: 'post-bind descriptor and token file handshake',
    owner: 'CAN-3727 C5',
  },
  {
    name: 'concurrent launchers converge on one daemon',
    owner: 'CAN-3729 J2',
  },
  { name: 'split-mode record equality', owner: 'W6' },
] as const;

const SUBSCRIBE = 'core.events.subscribe';

const LeaseSchema = z.object({
  leaseId: z.string().min(1),
  expiresAt: z.string(),
  revision: z.number().int(),
});

const REFERENCE_JOURNAL_TARGET: CanopyJournalConformanceTarget = {
  name: 'reference',
  method: SUBSCRIBE,
  params: { families: ['core.chat'] },
  start: () => Promise.resolve(startReferenceJournal()),
};

const OpenResultSchema = z.object({
  subscriptionId: z.string().min(1),
  acceptedCursor: CanopyStreamCursorSchema.nullable(),
});
const StreamFrameParamsSchema = z.object({
  params: z.object({
    subscriptionId: z.string().min(1),
    cursor: CanopyStreamCursorSchema,
  }),
});

async function rejectionKind(
  promise: Promise<unknown>,
): Promise<CanopyErrorKind> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyTransportError) return error.payload.kind;
    throw error;
  }
  throw new assert.AssertionError({ message: 'Expected a rejection.' });
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function request(
  id: number,
  method: CanopyOperationName = 'core.runtime.health.get',
  params: Record<string, unknown> = {},
): CanopyJsonRpcMessage {
  return { jsonrpc: '2.0', id, method, params };
}

function notification(
  message: CanopyJsonRpcMessage,
): CanopyJsonRpcNotification {
  assert.ok(
    'method' in message && !('id' in message),
    'expected a notification',
  );
  return message;
}

async function receiveResponse(
  connection: CanopyFramedConnection,
): Promise<{ id: unknown; result?: unknown; error?: unknown }> {
  for (;;) {
    const message = await connection.receive();
    if (
      'method' in message &&
      !('id' in message) &&
      message.method === CORE_CLIENT_LEASE_EVICTED
    ) {
      CoreClientLeaseEvictedSchema.parse(message.params);
      continue;
    }
    assert.ok('id' in message && !('method' in message), 'expected a response');
    return message;
  }
}

type CreateTrackedPair = (
  pairOptions?: CanopyConformancePairOptions,
) => Promise<CanopyFramedPair>;
type RegisterCase = (
  name: string,
  body: (
    pair: CreateTrackedPair,
    /** Runs after the case's pairs close, even when the case fails. */
    afterPairs: (cleanup: () => Promise<void>) => void,
  ) => Promise<void>,
) => void;

// Each case owns its pairs, so a runner may schedule cases concurrently.
function trackedCases(
  it: CanopyTransportConformanceOptions['it'],
  createPair: CanopyTransportConformanceOptions['createPair'],
): RegisterCase {
  return (name, body) =>
    it(name, async () => {
      const open: CanopyFramedPair[] = [];
      const cleanups: (() => Promise<void>)[] = [];
      try {
        await body(
          async (pairOptions) => {
            const created = await createPair(pairOptions);
            open.push(created);
            return created;
          },
          (cleanup) => void cleanups.push(cleanup),
        );
      } finally {
        for (const { client, server } of open) {
          client.close();
          server.close();
        }
        for (const cleanup of cleanups) await cleanup();
      }
    });
}

function registerJournalCases(
  test: RegisterCase,
  target: CanopyJournalConformanceTarget,
): void {
  const { method } = target;
  const envelopes = composeCanopyOperationEnvelopes(
    method,
    CORE_TRANSPORT_STREAM_DEFINITIONS[method],
  );
  const parseNotification = (frame: CanopyJsonRpcNotification): void => {
    assert.ok(envelopes.notification, `${method} has no notification schema`);
    envelopes.notification.parse(frame);
  };

  const open = async (
    client: CanopyFramedConnection,
    id: number,
    cursor: CanopyStreamCursor | null,
  ): Promise<{ id: unknown; result?: unknown; error?: unknown }> => {
    const message: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params: { ...target.params, cursor },
    };
    envelopes.request.parse(message);
    await client.send(message);
    const response = await receiveResponse(client);
    envelopes.response.parse({ jsonrpc: '2.0', ...response });
    assert.equal(response.id, id);
    return response;
  };

  const opened = (response: {
    result?: unknown;
    error?: unknown;
  }): z.output<typeof OpenResultSchema> => {
    assert.equal(
      response.error,
      undefined,
      `open failed: ${decodeCanopyError(response.error).message}`,
    );
    return OpenResultSchema.parse(response.result);
  };

  const receiveItem = async (
    client: CanopyFramedConnection,
    subscriptionId: string,
  ): Promise<CanopyStreamCursor> => {
    const frame = notification(await client.receive());
    parseNotification(frame);
    assert.equal(canopyStreamFrameType(method, frame), 'item', frame.method);
    const { params } = StreamFrameParamsSchema.parse(frame);
    assert.equal(params.subscriptionId, subscriptionId);
    return params.cursor;
  };

  // Replay length is the core's choice; it must ascend to the head exactly.
  const receiveThrough = async (
    client: CanopyFramedConnection,
    subscriptionId: string,
    head: CanopyStreamCursor,
  ): Promise<CanopyStreamCursor[]> => {
    const received: CanopyStreamCursor[] = [];
    for (;;) {
      const cursor = await receiveItem(client, subscriptionId);
      const previous = received[received.length - 1];
      assert.equal(cursor.daemonEpoch, head.daemonEpoch);
      if (previous) assert.ok(cursor.sequence > previous.sequence, 'unordered');
      assert.ok(cursor.sequence <= head.sequence, 'delivered past the head');
      received.push(cursor);
      if (cursor.sequence === head.sequence) return received;
    }
  };

  const append = async (
    instance: CanopyJournalConformanceInstance,
    count: number,
  ): Promise<readonly CanopyStreamCursor[]> => {
    const cursors = await instance.append(count);
    assert.equal(cursors.length, count);
    cursors.forEach((cursor, index) => {
      assert.equal(cursor.daemonEpoch, instance.daemonEpoch);
      if (index > 0) assert.ok(cursor.sequence > cursors[index - 1].sequence);
    });
    return cursors;
  };

  // Either a typed open error or an open reply whose next frame is the
  // terminal `snapshot_required` end for that subscription.
  const expectSnapshotRequired = async (
    client: CanopyFramedConnection,
    cursor: CanopyStreamCursor,
  ): Promise<void> => {
    const response = await open(client, 1, cursor);
    if (response.error !== undefined) {
      const error = decodeCanopyError(response.error);
      assert.ok(isCanopySnapshotRequiredError(error), error.message);
      return;
    }
    const { subscriptionId } = OpenResultSchema.parse(response.result);
    const frame = notification(await client.receive());
    parseNotification(frame);
    assert.equal(canopyStreamFrameType(method, frame), 'snapshot_required');
    assert.equal(frame.params.subscriptionId, subscriptionId);
  };

  const journalCase = (
    name: string,
    body: (
      instance: CanopyJournalConformanceInstance,
      connect: () => Promise<CanopyFramedConnection>,
    ) => Promise<void>,
  ): void =>
    test(name, async (pair, afterPairs) => {
      const instance = await target.start();
      afterPairs(() => instance.close());
      await body(instance, async () => {
        const { client, server } = await pair();
        instance.serve(server);
        return client;
      });
    });

  journalCase(
    'resumes a subscription after the acknowledged cursor',
    async (instance, connect) => {
      const first = await connect();
      const live = opened(await open(first, 1, null));
      const cursors = await append(instance, 5);
      const received = await receiveThrough(
        first,
        live.subscriptionId,
        cursors[4],
      );
      assert.deepEqual(
        received.filter(({ sequence }) => sequence >= cursors[0].sequence),
        cursors,
      );
      first.close();

      const second = await connect();
      const acknowledged = cursors[2];
      const resumed = opened(await open(second, 2, acknowledged));
      assert.deepEqual(resumed.acceptedCursor, acknowledged);
      for (const expected of cursors.slice(3))
        assert.deepEqual(
          await receiveItem(second, resumed.subscriptionId),
          expected,
        );
    },
  );

  journalCase(
    'replays a late subscriber without a cursor through the head',
    async (instance, connect) => {
      const cursors = await append(instance, 3);
      const client = await connect();
      const { subscriptionId } = opened(await open(client, 1, null));
      await receiveThrough(client, subscriptionId, cursors[2]);
    },
  );

  journalCase(
    'answers a foreign-epoch cursor with snapshot_required',
    async (instance, connect) => {
      const [head] = await append(instance, 1);
      await expectSnapshotRequired(await connect(), {
        daemonEpoch: `${instance.daemonEpoch}-foreign`,
        sequence: head.sequence,
      });
    },
  );

  journalCase(
    'answers a cursor past the head with snapshot_required',
    async (instance, connect) => {
      const [head] = await append(instance, 1);
      await expectSnapshotRequired(await connect(), {
        daemonEpoch: instance.daemonEpoch,
        sequence: head.sequence + 1,
      });
    },
  );

  journalCase(
    'answers an evicted cursor with snapshot_required',
    async (instance, connect) => {
      const expired = await instance.expire();
      assert.equal(expired.daemonEpoch, instance.daemonEpoch);
      await expectSnapshotRequired(await connect(), expired);
    },
  );
}

/**
 * Registers the journal cases (cursor resume, late replay, snapshot_required)
 * against any core that serves a catalog stream, so production cores reuse
 * the cases the reference core passes.
 */
export function runCanopyJournalConformance(
  options: CanopyJournalConformanceOptions,
): void {
  const { target } = options;
  options.describe(
    `Canopy journal conformance: ${options.name} ${target.name} ${target.method}`,
    () =>
      registerJournalCases(
        trackedCases(options.it, options.createPair),
        target,
      ),
  );
}

/**
 * Registers the lease cases (CAN-3727 C6) against a control plane: TTL
 * eviction with idempotent re-acquire, and reconnect-grace retention.
 */
export function runCanopyLeaseConformance(
  options: CanopyLeaseConformanceOptions,
): void {
  const { target } = options;
  let nextId = 0;
  const call = async (
    client: CanopyFramedConnection,
    method: CanopyOperationName,
    params: Record<string, unknown>,
  ): Promise<{ result?: unknown; error?: unknown }> => {
    const id = (nextId += 1);
    await client.send(request(id, method, params));
    const response = await receiveResponse(client);
    assert.equal(response.id, id);
    return response;
  };
  const initialized = async (
    instance: CanopyLeaseConformanceInstance,
  ): Promise<CanopyFramedConnection> => {
    const client = await instance.connect();
    const { error } = await call(client, 'core.runtime.initialize', {
      client: {
        name: 'conformance',
        version: '0',
        protocolVersions: [1],
        capabilities: [],
      },
    });
    assert.equal(error, undefined, 'initialize failed');
    return client;
  };
  const acquire = async (
    client: CanopyFramedConnection,
    previousLeaseId: string | null = null,
  ): Promise<z.output<typeof LeaseSchema>> => {
    const { result, error } = await call(client, 'core.client.lease.acquire', {
      clientInstanceId: 'conformance-client',
      interfaceKind: 'test',
      label: 'Conformance',
      interactive: true,
      foreground: true,
      renewalIntervalMs: 15_000,
      previousLeaseId,
      _meta: { idempotencyKey: `acquire-${(nextId += 1)}` },
    });
    assert.equal(error, undefined, 'acquire failed');
    return LeaseSchema.parse(result);
  };
  const renew = (
    client: CanopyFramedConnection,
    lease: z.output<typeof LeaseSchema>,
  ): Promise<{ result?: unknown; error?: unknown }> =>
    call(client, 'core.client.lease.renew', {
      expectedRevision: lease.revision,
      interactive: true,
      foreground: true,
    });
  const leaseCase = (
    name: string,
    body: (instance: CanopyLeaseConformanceInstance) => Promise<void>,
  ): void =>
    options.it(name, async () => {
      const instance = await target.start();
      try {
        await body(instance);
      } finally {
        await instance.close();
      }
    });

  options.describe(
    `Canopy lease conformance: ${options.name} ${target.name}`,
    () => {
      leaseCase('lease TTL expiry evicts the client', async (instance) => {
        const client = await initialized(instance);
        const lease = await acquire(client);
        await instance.advance(
          Date.parse(lease.expiresAt) - instance.now() - 1,
        );
        const renewed = LeaseSchema.parse((await renew(client, lease)).result);
        await instance.advance(
          Date.parse(renewed.expiresAt) - instance.now() + 1,
        );
        const evicted = decodeCanopyError((await renew(client, renewed)).error);
        assert.ok(
          evicted.code === 'core.client.lease.notFound' ||
            evicted.code === 'core.client.lease.invalidState',
          evicted.message,
        );
        // Eviction is recoverable: a fresh acquire binds a new lease.
        const reacquired = await acquire(client, lease.leaseId);
        assert.notEqual(reacquired.leaseId, lease.leaseId);
      });

      leaseCase(
        'reconnect grace keeps lease registrations',
        async (instance) => {
          const first = await initialized(instance);
          const lease = await acquire(first);
          first.close();
          await instance.whenDetached(lease.leaseId);
          await instance.advance(instance.reconnectGraceMs - 1);
          const second = await initialized(instance);
          const retained = await acquire(second, lease.leaseId);
          assert.equal(retained.leaseId, lease.leaseId);
          // Rebound: the old connection's grace no longer applies.
          await instance.advance(instance.reconnectGraceMs + 1);
          assert.equal((await renew(second, retained)).error, undefined);

          second.close();
          await instance.whenDetached(lease.leaseId);
          await instance.advance(instance.reconnectGraceMs + 1);
          const third = await initialized(instance);
          const replaced = await acquire(third, lease.leaseId);
          assert.notEqual(replaced.leaseId, lease.leaseId);
        },
      );
    },
  );
}

/**
 * Registers the doc 05 transport conformance cases for one binding.
 * Assertions use `node:assert/strict`, so any runner that reports thrown
 * errors (jest, `node:test`, Playwright) can host the kit.
 */
export function runCanopyTransportConformance(
  options: CanopyTransportConformanceOptions,
): void {
  const { describe, todo } = options;
  const test = trackedCases(options.it, options.createPair);

  describe(`Canopy transport conformance: ${options.name}`, () => {
    test('reassembles a request written one byte at a time', async (pair) => {
      const { server, clientWire } = await pair();
      for (const byte of Array.from(encodeCanopyJsonFrame(request(1)))) {
        clientWire.write(Uint8Array.of(byte));
        await tick();
      }
      assert.deepEqual(await server.receive(), request(1));
    });

    test('correlates concurrent requests answered out of order', async (pair) => {
      const { client, server } = await pair();
      const ids = [1, 2, 3, 4, 5, 6, 7, 8];
      await Promise.all(ids.map((id) => client.send(request(id))));
      const received = await Promise.all(ids.map(() => server.receive()));
      for (const message of received.reverse()) {
        assert.ok('id' in message && 'method' in message);
        await server.send({
          jsonrpc: '2.0',
          id: message.id,
          result: { echo: message.id },
        });
      }
      const responses = await Promise.all(
        ids.map(() => receiveResponse(client)),
      );
      assert.deepEqual(
        responses.map(({ id }) => id),
        [...ids].reverse(),
      );
      for (const { id, result } of responses)
        assert.deepEqual(result, { echo: id });
    });

    test('carries payloads up to the frame cap and fails closed beyond it', async (pair) => {
      const maxFrameBytes = 64 * 1024;
      const { client, server, clientWire } = await pair({ maxFrameBytes });
      const envelopeBytes =
        encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 1, result: '' }).length - 4;
      const atCap = 'x'.repeat(maxFrameBytes - envelopeBytes);
      await client.send({ jsonrpc: '2.0', id: 1, result: atCap });
      assert.deepEqual(await server.receive(), {
        jsonrpc: '2.0',
        id: 1,
        result: atCap,
      });
      assert.equal(
        await rejectionKind(
          client.send({ jsonrpc: '2.0', id: 2, result: `${atCap}x` }),
        ),
        'resource_exhausted',
      );
      assert.equal(client.signal.aborted, false);
      const header = Buffer.alloc(4);
      header.writeUInt32BE(maxFrameBytes + 1, 0);
      clientWire.write(header);
      assert.equal(await rejectionKind(server.receive()), 'resource_exhausted');
      assert.equal(await rejectionKind(client.receive()), 'resource_exhausted');
    });

    test('applies backpressure to an unread stream and resumes in order', async (pair) => {
      const { client, server } = await pair({ maxBufferedMessages: 4 });
      // 64 MiB ceiling: past any OS socket buffer, so only backpressure stops it.
      const ceiling = 1024;
      const item = 'z'.repeat(64 * 1024);
      let sent = 0;
      let stop = false;
      const sending = (async (): Promise<void> => {
        while (!stop && sent < ceiling) {
          await server.send({
            jsonrpc: '2.0',
            method: `${SUBSCRIBE}.item`,
            params: { sequence: sent + 1, item },
          });
          sent += 1;
        }
      })();
      // Paused means a send stays pending across event-loop turns, not a time window.
      for (let idleTurns = 0, last = -1; idleTurns < 20; last = sent) {
        await tick();
        assert.ok(sent < ceiling, `sender was not paused (sent ${sent})`);
        idleTurns = sent === last ? idleTurns + 1 : 0;
      }
      stop = true;
      const pendingSequence = sent + 1;
      for (let sequence = 1; sequence <= pendingSequence; sequence += 1)
        assert.equal(
          notification(await client.receive()).params.sequence,
          sequence,
        );
      await sending;
      assert.equal(sent, pendingSequence);
    });

    test('cancels a pending receive without closing the connection', async (pair) => {
      const { client, server } = await pair();
      const controller = new AbortController();
      const pending = client.receive({ signal: controller.signal });
      controller.abort();
      assert.equal(await rejectionKind(pending), 'cancelled');
      await server.send({ jsonrpc: '2.0', id: 1, result: null });
      assert.deepEqual(await client.receive(), {
        jsonrpc: '2.0',
        id: 1,
        result: null,
      });
    });

    test('surfaces a disconnect mid-stream to both ends', async (pair) => {
      const { client, server } = await pair();
      const pending = server.receive();
      await server.send({
        jsonrpc: '2.0',
        method: `${SUBSCRIBE}.item`,
        params: { n: 1 },
      });
      assert.equal(notification(await client.receive()).params.n, 1);
      client.close();
      assert.equal(await rejectionKind(pending), 'unavailable');
      assert.equal(await rejectionKind(server.send(request(2))), 'unavailable');
      assert.equal(server.signal.aborted, true);
    });

    registerJournalCases(test, REFERENCE_JOURNAL_TARGET);

    test('answers malformed envelopes and closes on malformed frames', async (pair) => {
      const { client, server, clientWire } = await pair();
      clientWire.write(
        encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 5, method: 'nope' }),
      );
      const invalid = await receiveResponse(client);
      assert.equal(invalid.id, 5);
      assert.equal(decodeCanopyError(invalid.error).kind, 'invalid_argument');
      clientWire.write(
        Buffer.concat([Buffer.from([0, 0, 0, 2]), Buffer.from('[]')]),
      );
      assert.equal(
        decodeCanopyError((await receiveResponse(client)).error).kind,
        'invalid_argument',
      );
      await client.send(request(6));
      assert.deepEqual(await server.receive(), request(6));
      clientWire.write(Buffer.from([0, 0, 0, 2, 0x7b, 0x7b]));
      assert.equal(await rejectionKind(server.receive()), 'invalid_argument');
      assert.equal(await rejectionKind(client.receive()), 'invalid_argument');
    });

    test('negotiates bulk channels within their caps', async (pair) => {
      const { client, server } = await pair();
      const caps = { maxChunkBytes: 1_024, maxBufferedChunks: 8 };
      assert.equal(
        await rejectionKind(
          client.openChannel({
            kind: 'pipeline.output',
            leaseId: 'lease-1',
            caps,
          }),
        ),
        'capability_unavailable',
      );
      const accepted = new Promise<Uint8Array | null>((resolve) => {
        server.onChannel((channel) => void channel.read().then(resolve));
      });
      const channel = await client.openChannel({
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps,
      });
      assert.deepEqual(channel.caps, caps);
      await channel.write(Uint8Array.of(7, 8, 9));
      assert.deepEqual(await accepted, Uint8Array.of(7, 8, 9));
      assert.equal(
        await rejectionKind(
          channel.write(new Uint8Array(caps.maxChunkBytes + 1)),
        ),
        'resource_exhausted',
      );
    });

    test('bulk channel credit flow control', async (pair) => {
      const { client, server } = await pair();
      const acceptedChannels: CanopyByteChannel[] = [];
      const channelWaiters: ((channel: CanopyByteChannel) => void)[] = [];
      server.onChannel((channel) => {
        const waiter = channelWaiters.shift();
        if (waiter) waiter(channel);
        else acceptedChannels.push(channel);
      });
      const nextChannel = (): Promise<CanopyByteChannel> => {
        const channel = acceptedChannels.shift();
        return channel
          ? Promise.resolve(channel)
          : new Promise((resolve) => channelWaiters.push(resolve));
      };

      const channel = await client.openChannel({
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 32, maxBufferedChunks: 4 },
      });
      assert.deepEqual(channel.caps, {
        maxChunkBytes: 32,
        maxBufferedChunks: 4,
      });
      const serverChannel = await nextChannel();
      const chunks = [1, 2, 3, 4, 5].map((value) => Uint8Array.of(value));
      for (const chunk of chunks.slice(0, 4)) await channel.write(chunk);
      let fifthSettled = false;
      const fifthWrite = channel.write(chunks[4]);
      void fifthWrite.then(
        () => {
          fifthSettled = true;
        },
        () => {
          fifthSettled = true;
        },
      );
      for (let turn = 0; turn < 20; turn += 1) {
        await tick();
        assert.equal(fifthSettled, false);
        assert.equal(channel.signal.aborted, false);
        assert.equal(serverChannel.signal.aborted, false);
      }
      assert.deepEqual(await serverChannel.read(), chunks[0]);
      assert.deepEqual(await serverChannel.read(), chunks[1]);
      await fifthWrite;
      for (const chunk of chunks.slice(2))
        assert.deepEqual(await serverChannel.read(), chunk);

      await serverChannel.write(Uint8Array.of(9));
      assert.deepEqual(await channel.read(), Uint8Array.of(9));

      const echoClient = await client.openChannel({
        kind: 'pipeline.output',
        leaseId: 'lease-2',
        caps: { maxChunkBytes: 32, maxBufferedChunks: 4 },
      });
      const echoServer = await nextChannel();
      const echoing = (async (): Promise<void> => {
        for (let index = 0; index < 8; index += 1) {
          const chunk = await echoServer.read();
          assert.ok(chunk);
          await echoServer.write(chunk);
        }
      })();
      for (let value = 10; value < 18; value += 1) {
        const chunk = Uint8Array.of(value);
        await echoClient.write(chunk);
        assert.deepEqual(await echoClient.read(), chunk);
      }
      await echoing;
      assert.equal(client.signal.aborted, false);
      assert.equal(server.signal.aborted, false);
      assert.equal(channel.signal.aborted, false);
      assert.equal(serverChannel.signal.aborted, false);
      assert.equal(echoClient.signal.aborted, false);
      assert.equal(echoServer.signal.aborted, false);
    });

    test('fails authentication closed', async (pair) => {
      assert.equal(
        await rejectionKind(pair({ clientSecret: 'wrong' })),
        'unauthenticated',
      );
      assert.equal(
        await rejectionKind(pair({ clientDataRootHash: 'f'.repeat(64) })),
        'failed_precondition',
      );
    });

    test('fails closed with an actionable error on a protocol-major mismatch', async (pair) => {
      const { client, server } = await pair();
      void serveReferenceCore(server, { daemonEpoch: 'epoch-1', journal: [] });
      await client.send(
        request(1, 'core.runtime.initialize', {
          client: {
            name: 'test',
            version: '0',
            protocolVersions: [99],
            capabilities: [],
          },
        }),
      );
      const error = decodeCanopyError((await receiveResponse(client)).error);
      assert.equal(error.kind, 'failed_precondition');
      assert.deepEqual(error.details, {
        supportedProtocolVersions: [1],
        action: 'restart_or_update',
      });
      assert.equal(await rejectionKind(client.receive()), 'unavailable');
    });

    for (const { name, owner } of CANOPY_TRANSPORT_CONFORMANCE_PENDING)
      todo(`${name} (pending ${owner})`);
  });
}
