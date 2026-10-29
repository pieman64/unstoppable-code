import assert from 'node:assert/strict';
import {
  decodeCanopyError,
  type CanopyErrorPayload,
  type CanopyOperationName,
} from '@canopy/protocol/canopy-core';
import { z } from 'zod';

import { CanopyTransportError, encodeCanopyChannelDataFrame } from '../codec';
import type { CanopyFramedPair } from '../in-memory';
import type { CanopyByteChannel } from '../types';
import type { CanopyTransportConformanceOptions } from './index';

/** One live control plane whose channel registry and lease clock the kit drives. */
export interface CanopyChannelConformanceInstance {
  /** An authenticated client end served by the control plane, plus its raw wire. */
  connect(): Promise<Pick<CanopyFramedPair, 'client' | 'clientWire'>>;
  /** The lease clock, in epoch milliseconds. */
  now(): number;
  /** Moves the lease clock forward and runs the timers that fall due. */
  advance(ms: number): Promise<void>;
  /** Resolves once the server has seen the lease's connection close. */
  whenDetached(leaseId: string): Promise<void>;
  readonly reconnectGraceMs: number;
  close(): Promise<void>;
}

export interface CanopyChannelConformanceTarget {
  readonly name: string;
  /** An advertised kind whose consumer writes every chunk it reads back. */
  readonly echoKind: string;
  /** An advertised kind whose consumer never reads. */
  readonly holdKind: string;
  start(): Promise<CanopyChannelConformanceInstance>;
}

export interface CanopyChannelConformanceOptions {
  readonly name: string;
  readonly target: CanopyChannelConformanceTarget;
  readonly describe: CanopyTransportConformanceOptions['describe'];
  readonly it: CanopyTransportConformanceOptions['it'];
}

type Client = Pick<CanopyFramedPair, 'client' | 'clientWire'>;

const positive = z.number().int().positive();
const InitializeResultSchema = z.object({
  capabilities: z.object({ channels: z.array(z.string()) }),
  limits: z.object({
    channels: z.object({
      maxChannelsPerLease: positive,
      maxChunkBytes: positive,
      maxBufferedChunks: positive,
      maxBufferedBytes: positive,
    }),
  }),
});
type InitializeResult = z.output<typeof InitializeResultSchema>;

const LeaseSchema = z.object({
  leaseId: z.string().min(1),
  expiresAt: z.string(),
});
type Lease = z.output<typeof LeaseSchema>;

interface Session extends Client {
  readonly lease: Lease;
  readonly limits: InitializeResult['limits']['channels'];
}

const REQUESTED_CAPS = { maxChunkBytes: 1_024, maxBufferedChunks: 64 };

function payloadOf(error: unknown): CanopyErrorPayload {
  if (error instanceof CanopyTransportError) return error.payload;
  throw error;
}

async function rejection(
  promise: Promise<unknown>,
): Promise<CanopyErrorPayload> {
  try {
    await promise;
  } catch (error) {
    return payloadOf(error);
  }
  return assert.fail('Expected a rejection.');
}

function detail(payload: CanopyErrorPayload, key: string): unknown {
  const { details } = payload;
  return typeof details === 'object' &&
    details !== null &&
    !Array.isArray(details)
    ? details[key]
    : undefined;
}

/** The typed error a channel or connection closed with. */
async function aborted(signal: AbortSignal): Promise<CanopyErrorPayload> {
  if (!signal.aborted)
    await new Promise((resolve) =>
      signal.addEventListener('abort', resolve, { once: true }),
    );
  return payloadOf(signal.reason);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Fills the credit window, then starts one write that must stay pending;
 * resolves the error that write later fails with (null if it succeeds).
 */
async function exhaust(
  channel: CanopyByteChannel,
): Promise<{ readonly error: Promise<CanopyErrorPayload | null> }> {
  for (let chunk = 0; chunk < channel.caps.maxBufferedChunks; chunk += 1)
    await channel.write(Uint8Array.of(chunk));
  let settled = false;
  const error = channel.write(Uint8Array.of(0xff)).then(
    () => null,
    (reason: unknown) => payloadOf(reason),
  );
  void error.then(() => {
    settled = true;
  });
  for (let turn = 0; turn < 20; turn += 1) {
    await tick();
    assert.equal(settled, false, 'a write past the credit window settled');
    assert.equal(channel.signal.aborted, false);
  }
  return { error };
}

/**
 * Registers the bulk-channel cases against a control plane: admission order,
 * the per-lease cap, chunk and credit limits, and lease-bound teardown.
 */
export function runCanopyChannelConformance(
  options: CanopyChannelConformanceOptions,
): void {
  const { target } = options;
  const { echoKind, holdKind } = target;
  let nextId = 0;
  const call = async (
    { client }: Client,
    method: CanopyOperationName,
    params: Record<string, unknown> = {},
  ): Promise<unknown> => {
    const id = (nextId += 1);
    await client.send({ jsonrpc: '2.0', id, method, params });
    const response = await client.receive();
    assert.ok('id' in response && !('method' in response), 'not a response');
    assert.equal(response.id, id);
    if ('error' in response)
      assert.fail(
        `${method} failed: ${decodeCanopyError(response.error).message}`,
      );
    return response.result;
  };
  const initialize = async (client: Client): Promise<InitializeResult> =>
    InitializeResultSchema.parse(
      await call(client, 'core.runtime.initialize', {
        client: {
          name: 'conformance',
          version: '0',
          protocolVersions: [1],
          capabilities: [],
        },
      }),
    );
  const acquire = async (
    client: Client,
    previousLeaseId: string | null = null,
  ): Promise<Lease> =>
    LeaseSchema.parse(
      await call(client, 'core.client.lease.acquire', {
        clientInstanceId: 'conformance-client',
        interfaceKind: 'test',
        label: 'Conformance',
        interactive: true,
        foreground: true,
        renewalIntervalMs: 15_000,
        previousLeaseId,
        _meta: { idempotencyKey: `acquire-${(nextId += 1)}` },
      }),
    );
  const session = async (
    instance: CanopyChannelConformanceInstance,
    previousLeaseId: string | null = null,
  ): Promise<Session> => {
    const client = await instance.connect();
    const { limits } = await initialize(client);
    const lease = await acquire(client, previousLeaseId);
    return { ...client, lease, limits: limits.channels };
  };
  const open = (
    { client }: Client,
    kind: string,
    leaseId: string,
  ): Promise<CanopyByteChannel> =>
    client.openChannel({ kind, leaseId, caps: REQUESTED_CAPS });
  // Bypasses the client's own cap and credit checks.
  const writeRaw = (
    { clientWire }: Client,
    channel: CanopyByteChannel,
    bytes: Uint8Array,
  ): void =>
    void clientWire.write(
      encodeCanopyChannelDataFrame(channel.channelId, bytes),
    );
  const channelCase = (
    name: string,
    body: (instance: CanopyChannelConformanceInstance) => Promise<void>,
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
    `Canopy channel conformance: ${options.name} ${target.name}`,
    () => {
      channelCase(
        'opens, carries opaque bytes, and closes a lease-bound channel',
        async (instance) => {
          const client = await instance.connect();
          const early = await rejection(open(client, echoKind, 'lease-1'));
          assert.equal(early.kind, 'failed_precondition');
          const { capabilities, limits } = await initialize(client);
          assert.ok(capabilities.channels.includes(echoKind));
          assert.ok(capabilities.channels.includes(holdKind));
          const unleased = await rejection(open(client, echoKind, 'lease-1'));
          assert.equal(unleased.kind, 'not_found');
          assert.equal(unleased.code, 'core.client.lease.notFound');

          const { leaseId } = await acquire(client);
          const unknown = await rejection(
            open(client, 'conformance.unknown', leaseId),
          );
          assert.equal(unknown.kind, 'capability_unavailable');
          const foreign = await rejection(
            open(client, echoKind, `${leaseId}-foreign`),
          );
          assert.equal(foreign.kind, 'not_found');

          const channel = await open(client, echoKind, leaseId);
          const { caps } = channel;
          const max = limits.channels;
          assert.ok(caps.maxChunkBytes <= REQUESTED_CAPS.maxChunkBytes);
          assert.ok(caps.maxChunkBytes <= max.maxChunkBytes);
          assert.ok(caps.maxBufferedChunks <= REQUESTED_CAPS.maxBufferedChunks);
          assert.ok(caps.maxBufferedChunks <= max.maxBufferedChunks);
          assert.ok(
            caps.maxChunkBytes * caps.maxBufferedChunks <= max.maxBufferedBytes,
          );
          const chunks = [
            Uint8Array.of(0x00, 0xff, 0x7f, 0x80, 0x0a, 0x0d, 0x7b),
            Uint8Array.from({ length: caps.maxChunkBytes }, (_, i) => i * 37),
          ];
          for (const chunk of chunks) {
            await channel.write(chunk);
            assert.deepEqual(await channel.read(), chunk);
          }
          await call(client, 'core.runtime.health.get');
          assert.equal(channel.signal.aborted, false);
          channel.close();
          assert.equal(channel.signal.aborted, true);
          assert.equal(await channel.read(), null);
        },
      );

      channelCase(
        'refuses an open over the per-lease cap and reuses the slot',
        async (instance) => {
          const first = await session(instance);
          const { leaseId } = first.lease;
          const { maxChannelsPerLease } = first.limits;
          const channels: CanopyByteChannel[] = [];
          for (let index = 0; index < maxChannelsPerLease; index += 1)
            channels.push(await open(first, holdKind, leaseId));
          const over = await rejection(open(first, holdKind, leaseId));
          assert.equal(over.kind, 'resource_exhausted');
          assert.equal(
            detail(over, 'maxChannelsPerLease'),
            maxChannelsPerLease,
          );
          // The close frame precedes the next open on the same connection.
          channels[0]?.close();
          await open(first, holdKind, leaseId);

          const second = await session(instance);
          assert.notEqual(second.lease.leaseId, leaseId);
          await open(second, holdKind, second.lease.leaseId);
        },
      );

      channelCase(
        'refuses an oversized chunk with the actionable error',
        async (instance) => {
          const client = await session(instance);
          const channel = await open(client, holdKind, client.lease.leaseId);
          const { maxChunkBytes } = channel.caps;
          const oversized = new Uint8Array(maxChunkBytes + 1);
          const local = await rejection(channel.write(oversized));
          assert.equal(local.kind, 'resource_exhausted');
          assert.equal(detail(local, 'maxChunkBytes'), maxChunkBytes);
          assert.equal(channel.signal.aborted, false);

          writeRaw(client, channel, oversized);
          const closed = await aborted(channel.signal);
          assert.equal(closed.kind, 'resource_exhausted');
          assert.equal(detail(closed, 'maxChunkBytes'), maxChunkBytes);
          assert.equal(client.client.signal.aborted, false);
          await open(client, holdKind, client.lease.leaseId);
        },
      );

      channelCase(
        'bounds bytes in flight with channel credit',
        async (instance) => {
          const client = await session(instance);
          const channel = await open(client, holdKind, client.lease.leaseId);
          const pending = await exhaust(channel);
          writeRaw(client, channel, Uint8Array.of(1));
          const closed = await aborted(channel.signal);
          assert.equal(closed.kind, 'resource_exhausted');
          assert.equal(
            detail(closed, 'maxBufferedChunks'),
            channel.caps.maxBufferedChunks,
          );
          assert.deepEqual(await pending.error, closed);
          assert.equal(client.client.signal.aborted, false);
        },
      );

      channelCase(
        'release closes the lease channels and settles a blocked write',
        async (instance) => {
          const client = await session(instance);
          const { leaseId } = client.lease;
          const held = await open(client, holdKind, leaseId);
          const echo = await open(client, echoKind, leaseId);
          const pending = await exhaust(held);
          await call(client, 'core.client.lease.release', {
            reason: 'normal_shutdown',
          });
          assert.equal((await aborted(held.signal)).kind, 'cancelled');
          assert.equal((await aborted(echo.signal)).kind, 'cancelled');
          assert.equal((await pending.error)?.kind, 'cancelled');
          await call(client, 'core.runtime.health.get');
          const released = await rejection(open(client, echoKind, leaseId));
          assert.equal(released.kind, 'not_found');
        },
      );

      channelCase(
        'TTL eviction closes the lease channels',
        async (instance) => {
          const client = await session(instance);
          const channel = await open(client, echoKind, client.lease.leaseId);
          await instance.advance(
            Date.parse(client.lease.expiresAt) - instance.now() + 1,
          );
          const closed = await aborted(channel.signal);
          assert.equal(closed.kind, 'not_found');
          assert.equal(closed.code, 'core.client.lease.notFound');
        },
      );

      channelCase(
        'rebind to a new connection closes the old connection channels',
        async (instance) => {
          const first = await session(instance);
          const { leaseId } = first.lease;
          const channel = await open(first, echoKind, leaseId);
          const second = await session(instance, leaseId);
          assert.equal(second.lease.leaseId, leaseId);
          const moved = await aborted(channel.signal);
          assert.equal(moved.code, 'core.client.lease.invalidState');
          await open(second, echoKind, leaseId);
          const stale = await rejection(open(first, echoKind, leaseId));
          assert.equal(stale.kind, 'not_found');
        },
      );

      channelCase(
        'disconnect closes channels; reacquire within grace allows new channels',
        async (instance) => {
          const first = await session(instance);
          const { leaseId } = first.lease;
          const channel = await open(first, echoKind, leaseId);
          first.client.close();
          await aborted(channel.signal);
          await instance.whenDetached(leaseId);
          await instance.advance(instance.reconnectGraceMs - 1);
          const second = await session(instance, leaseId);
          assert.equal(second.lease.leaseId, leaseId);
          await open(second, echoKind, leaseId);

          second.client.close();
          await instance.whenDetached(leaseId);
          await instance.advance(instance.reconnectGraceMs + 1);
          const third = await session(instance, leaseId);
          assert.notEqual(third.lease.leaseId, leaseId);
          const evicted = await rejection(open(third, echoKind, leaseId));
          assert.equal(evicted.kind, 'not_found');
        },
      );
    },
  );
}
