import { Buffer } from 'node:buffer';

import type {
  CanopyErrorPayload,
  CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';
import { CanopyErrorPayloadSchema } from '@canopy/protocol/canopy-core';
import { once } from 'node:events';
import { duplexPair } from 'node:stream';

import {
  CanopyFrameDecoder,
  CanopyTransportError,
  createCanopyAuthProof,
  createCanopyFramedConnection,
  createInMemoryFramedPair,
  encodeCanopyChannelDataFrame,
  encodeCanopyJsonFrame,
  encodeCanopyJsonMessage,
  type CanopyByteChannel,
  type CanopyFramedConnection,
  type CanopyFramedPair,
} from '@canopy/core-transport';

const pairs: CanopyFramedPair[] = [];

async function pair(
  options?: Parameters<typeof createInMemoryFramedPair>[0],
): Promise<CanopyFramedPair> {
  const created = await createInMemoryFramedPair(options);
  pairs.push(created);
  return created;
}

afterEach(() => {
  for (const { client, server } of pairs.splice(0)) {
    client.close();
    server.close();
  }
});

function request(id: number): CanopyJsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    method: 'core.runtime.health.get',
    params: {},
  };
}

async function errorKind(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyTransportError) return error.payload.kind;
    throw error;
  }
  throw new Error('Expected a rejection.');
}

async function errorPayload(
  promise: Promise<unknown>,
): Promise<CanopyErrorPayload> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CanopyTransportError) return error.payload;
    throw error;
  }
  throw new Error('Expected a rejection.');
}

describe('in-memory framed pair', () => {
  it('authenticates both ends onto one connection id', async () => {
    const { client, server } = await pair();
    expect(client.connectionId).toBe(server.connectionId);
    expect(client.connectionId).not.toBe('');
  });

  it('delivers frames in order in both directions', async () => {
    const { client, server } = await pair();
    await Promise.all([1, 2, 3].map((id) => client.send(request(id))));
    await Promise.all([3, 2, 1].map((id) => server.send(request(id))));
    for (const id of [1, 2, 3])
      expect(await server.receive()).toMatchObject({ id });
    for (const id of [3, 2, 1])
      expect(await client.receive()).toMatchObject({ id });
  });

  it('propagates close and drains already-delivered frames first', async () => {
    const { client, server } = await pair();
    await client.send(request(1));
    client.close({
      kind: 'unavailable',
      message: 'Client shutting down.',
      retry: { kind: 'same_request' },
    });
    expect(await server.receive()).toMatchObject({ id: 1 });
    await expect(server.receive()).rejects.toMatchObject({
      payload: { message: 'Client shutting down.' },
    });
    expect(server.signal.aborted).toBe(true);
    expect(await errorKind(client.send(request(2)))).toBe('unavailable');
  });

  it('ends a pending receive when its abort signal fires', async () => {
    const { client } = await pair();
    const controller = new AbortController();
    const pending = client.receive({ signal: controller.signal });
    controller.abort();
    expect(await errorKind(pending)).toBe('cancelled');
    expect(client.signal.aborted).toBe(false);
  });

  it('answers a well-framed invalid envelope and keeps the connection', async () => {
    const { client, server, clientWire } = await pair();
    clientWire.write(encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 9 }));
    expect(await client.receive()).toMatchObject({
      id: 9,
      error: { code: -32600, data: { kind: 'invalid_argument' } },
    });
    await client.send(request(10));
    expect(await server.receive()).toMatchObject({ id: 10 });
  });

  it('answers an envelope without jsonrpc or a binding type and stays open', async () => {
    const { client, server, clientWire } = await pair();
    for (const [id, frame] of [
      [9, { id: 9, method: 'core.runtime.health.get', params: {} }],
      [10, { type: 'nope', id: 10 }],
    ] as const) {
      clientWire.write(encodeCanopyJsonFrame(frame));
      expect(await client.receive()).toMatchObject({
        id,
        error: { code: -32600, data: { kind: 'invalid_argument' } },
      });
    }
    await client.send(request(11));
    expect(await server.receive()).toMatchObject({ id: 11 });
  });

  it('closes the connection on a frame over the cap', async () => {
    const { client, server, clientWire } = await pair({ maxFrameBytes: 1_024 });
    const big: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: 'x'.repeat(2_048),
    };
    expect(await errorKind(server.send(big))).toBe('resource_exhausted');
    clientWire.write(Buffer.from([0, 0, 0x10, 0]));
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
    expect(await errorKind(client.receive())).toBe('resource_exhausted');
  });

  it('carries a message over the frame cap in parts once the peer reassembles it', async () => {
    const { client, server } = await pair({
      maxFrameBytes: 1_024,
      maxMessageBytes: 64 * 1_024,
    });
    expect(server.maxMessageBytes).toBe(64 * 1_024);
    const big: CanopyJsonRpcMessage = {
      jsonrpc: '2.0',
      id: 1,
      result: 'ü'.repeat(20_000),
    };
    await server.send(big);
    await client.send(request(2));
    expect(await client.receive()).toEqual(big);
    expect(await server.receive()).toMatchObject({ id: 2 });
    // Over the peer's cap the send is refused and the connection stays open.
    expect(
      await errorKind(
        server.send({ jsonrpc: '2.0', id: 3, result: 'x'.repeat(70_000) }),
      ),
    ).toBe('resource_exhausted');
    await server.send(request(4));
    expect(await client.receive()).toMatchObject({ id: 4 });
  });

  it('joins no more than one frame of parts before the peer authenticates', async () => {
    const [clientWire, serverWire] = duplexPair();
    const accepting = createCanopyFramedConnection(serverWire, {
      role: 'server',
      auth: { secret: 'secret', dataRootHash: '0'.repeat(64) },
      maxFrameBytes: 1_024,
      maxMessageBytes: 64 * 1_024,
    });
    // Parts of an envelope larger than one frame, with no auth.response.
    clientWire.write(
      encodeCanopyJsonMessage(
        { jsonrpc: '2.0', id: 1, result: 'x'.repeat(4_096) },
        1_024,
        64 * 1_024,
      ),
    );
    expect(await errorKind(accepting)).toBe('resource_exhausted');
    clientWire.destroy();
  });

  it('splits only after the peer says how large a message it reassembles', async () => {
    const [clientWire, serverWire] = duplexPair();
    const auth = { secret: 'secret', dataRootHash: '0'.repeat(64) };
    const options = { maxFrameBytes: 1_024, maxMessageBytes: 64 * 1_024 };
    const [client, server] = await Promise.all([
      createCanopyFramedConnection(clientWire, {
        ...options,
        role: 'client',
        auth,
      }),
      createCanopyFramedConnection(serverWire, {
        ...options,
        role: 'server',
        auth,
      }),
    ]);
    try {
      const big: CanopyJsonRpcMessage = {
        jsonrpc: '2.0',
        id: 1,
        result: 'x'.repeat(4_096),
      };
      expect(await errorKind(server.send(big))).toBe('resource_exhausted');
      server.allowPeerMessageBytes?.(client.maxMessageBytes ?? 0);
      await server.send(big);
      expect(await client.receive()).toEqual(big);
    } finally {
      client.close();
      server.close();
    }
  });

  it('ignores bytes a peer keeps writing after a fatal frame', async () => {
    const { server, clientWire } = await pair({ maxFrameBytes: 1_024 });
    clientWire.write(Buffer.from([0, 0, 0x10, 0]));
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
    for (let id = 0; id < 100; id += 1)
      clientWire.write(encodeCanopyJsonFrame(request(id)));
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
  });

  it('holds frames from one large chunk until the bounded queue drains', async () => {
    const { server, clientWire } = await pair({ maxBufferedMessages: 2 });
    clientWire.write(
      Buffer.concat(
        Array.from({ length: 50 }, (_, id) =>
          encodeCanopyJsonFrame(request(id)),
        ),
      ),
    );
    for (let id = 0; id < 50; id += 1)
      expect(await server.receive()).toMatchObject({ id });
  });

  it('runs channel admission before notification and preserves the refusal payload', async () => {
    const { client, server } = await pair();
    const refusal: CanopyErrorPayload = {
      kind: 'permission_denied',
      message: 'The lease does not allow this channel.',
      details: { leaseId: 'lease-1' },
      retry: { kind: 'never' },
    };
    let notified = 0;
    server.onChannel(
      () => {
        notified += 1;
      },
      { admit: () => refusal },
    );
    server.onChannel(
      () => {
        notified += 1;
      },
      {
        admit: () => {
          throw new Error('admission hook failed');
        },
      },
    );
    expect(
      await errorPayload(
        client.openChannel({
          kind: 'pipeline.output',
          leaseId: 'lease-1',
          caps: { maxChunkBytes: 16, maxBufferedChunks: 2 },
        }),
      ),
    ).toEqual(refusal);
    expect(notified).toBe(0);

    const throwingPair = await pair();
    throwingPair.server.onChannel(
      () => {
        notified += 1;
      },
      {
        admit: () => {
          throw new Error('admission hook failed');
        },
      },
    );
    expect(
      await errorPayload(
        throwingPair.client.openChannel({
          kind: 'pipeline.output',
          leaseId: 'lease-1',
          caps: { maxChunkBytes: 16, maxBufferedChunks: 2 },
        }),
      ),
    ).toEqual({
      kind: 'internal',
      message: 'Channel admission failed.',
      retry: { kind: 'never' },
    });
    expect(notified).toBe(0);
  });

  it('unsubscribes the listener and its admission hook together', async () => {
    const { client, server } = await pair();
    let staleListenerCalls = 0;
    let liveListenerCalls = 0;
    const unsubscribe = server.onChannel(
      () => {
        staleListenerCalls += 1;
      },
      {
        admit: () => ({
          kind: 'permission_denied',
          message: 'Removed admission hook ran.',
          retry: { kind: 'never' },
        }),
      },
    );
    unsubscribe();
    server.onChannel(() => {
      liveListenerCalls += 1;
    });
    const channel = await client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'lease-1',
      caps: { maxChunkBytes: 16, maxBufferedChunks: 2 },
    });
    expect(channel.caps).toEqual({ maxChunkBytes: 16, maxBufferedChunks: 2 });
    expect(staleListenerCalls).toBe(0);
    expect(liveListenerCalls).toBe(1);
  });

  it('clamps channel caps to the negotiated bytes-in-flight budget', async () => {
    const cases: Array<{
      options: NonNullable<Parameters<typeof scriptedClient>[0]>;
      requested: { maxChunkBytes: number; maxBufferedChunks: number };
      expected: { maxChunkBytes: number; maxBufferedChunks: number };
    }> = [
      {
        options: {
          maxChannelChunkBytes: 8,
          maxChannelBufferedChunks: 8,
          maxChannelBufferedBytes: 40,
        },
        requested: { maxChunkBytes: 8, maxBufferedChunks: 8 },
        // floor(40 / 8) = 5 chunks fit the byte budget.
        expected: { maxChunkBytes: 8, maxBufferedChunks: 5 },
      },
      {
        options: {
          maxChannelChunkBytes: 100,
          maxChannelBufferedChunks: 10,
          maxChannelBufferedBytes: 40,
        },
        requested: { maxChunkBytes: 100, maxBufferedChunks: 10 },
        // The chunk cap clamps to the 40-byte budget, leaving one chunk.
        expected: { maxChunkBytes: 40, maxBufferedChunks: 1 },
      },
      {
        options: {
          maxChannelChunkBytes: 16,
          maxChannelBufferedChunks: 4,
          maxChannelBufferedBytes: 50,
        },
        requested: { maxChunkBytes: 16, maxBufferedChunks: 4 },
        // floor(50 / 16) = 3 chunks fit the byte budget.
        expected: { maxChunkBytes: 16, maxBufferedChunks: 3 },
      },
      {
        options: { maxFrameBytes: 256, maxChannelBufferedBytes: 4_096 },
        requested: { maxChunkBytes: 4_096, maxBufferedChunks: 4 },
        // A 256-byte frame carries 256 - 66 bytes of channel data.
        expected: { maxChunkBytes: 190, maxBufferedChunks: 4 },
      },
    ];
    let index = 0;
    for (const { options, requested, expected } of cases) {
      const { server, clientWire, next } = await scriptedClient(options);
      let accept: (channel: CanopyByteChannel) => void = () => {};
      const accepted = new Promise<CanopyByteChannel>((resolve) => {
        accept = resolve;
      });
      server.onChannel(accept);
      const channelId = `budget${index}`;
      clientWire.write(
        encodeCanopyJsonFrame({
          type: 'channel.open',
          channelId,
          kind: 'pipeline.output',
          leaseId: 'lease-1',
          caps: requested,
        }),
      );
      const channel = await accepted;
      expect(channel.caps).toEqual(expected);
      expect(await next()).toMatchObject({
        type: 'channel.opened',
        channelId,
        caps: expected,
      });
      server.close();
      index += 1;
    }
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects maxBufferedMessages %p',
    async (maxBufferedMessages) => {
      expect(
        await errorKind(createInMemoryFramedPair({ maxBufferedMessages })),
      ).toBe('invalid_argument');
    },
  );

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects maxChannelBufferedBytes %p',
    async (maxChannelBufferedBytes) => {
      const [wire] = duplexPair();
      expect(
        await errorKind(
          createCanopyFramedConnection(wire, {
            role: 'server',
            auth: { secret: 'scripted', dataRootHash: DATA_ROOT },
            maxChannelBufferedBytes,
          }),
        ),
      ).toBe('invalid_argument');
      wire.destroy();
    },
  );

  it('rejects envelopes that are not JSON-safe and stays open', async () => {
    const { client, server } = await pair();
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const result of [1n, cyclic, new Date(0), Number.NaN, new Map()])
      expect(
        await errorKind(client.send({ jsonrpc: '2.0', id: 1, result })),
      ).toBe('invalid_argument');
    await client.send(request(2));
    expect(await server.receive()).toMatchObject({ id: 2 });
  });

  it('clamps accepted channel caps and the channel count to local limits', async () => {
    const { client, server } = await pair();
    server.onChannel(() => {});
    const request = {
      kind: 'pipeline.output',
      leaseId: 'lease-1',
      caps: { maxChunkBytes: 4 * 1024 * 1024, maxBufferedChunks: 1_000 },
    };
    const first = await client.openChannel(request);
    expect(first.caps).toEqual({
      maxChunkBytes: 256 * 1024,
      maxBufferedChunks: 16,
    });
    for (let index = 1; index < 16; index += 1)
      await client.openChannel(request);
    expect(await errorKind(client.openChannel(request))).toBe(
      'resource_exhausted',
    );
  });

  it('drops a peer that floods malformed envelopes without reading replies', async () => {
    const { server, clientWire } = await pair({ maxBufferedMessages: 1 });
    const invalid = encodeCanopyJsonFrame({
      jsonrpc: '2.0',
      id: 1,
      method: 'x',
    });
    clientWire.write(
      Buffer.concat(Array.from({ length: 5_000 }, () => invalid)),
    );
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
  });

  it('keeps a reading peer connected through a burst of error replies', async () => {
    const { client, clientWire } = await pair();
    clientWire.write(
      Buffer.concat(
        Array.from({ length: 40 }, (_, id) =>
          encodeCanopyJsonFrame({ jsonrpc: '2.0', id, method: 'x' }),
        ),
      ),
    );
    for (let id = 0; id < 40; id += 1)
      expect(await client.receive()).toMatchObject({
        id,
        error: { code: -32600 },
      });
    expect(client.signal.aborted).toBe(false);
  });

  it('stops reading once queued envelopes exceed the byte budget', async () => {
    const { client, server } = await pair({ maxBufferedBytes: 64 * 1024 });
    const payload = 'b'.repeat(32 * 1024);
    let sent = 0;
    const sending = (async (): Promise<void> => {
      for (let id = 1; id <= 20; id += 1) {
        await client.send({ jsonrpc: '2.0', id, result: payload });
        sent = id;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toBeLessThan(20);
    for (let id = 1; id <= 20; id += 1)
      expect(await server.receive()).toMatchObject({ id });
    await sending;
  });

  it('fails closed on a wrong secret or a foreign data root', async () => {
    expect(
      await errorKind(createInMemoryFramedPair({ clientSecret: 'x' })),
    ).toBe('unauthenticated');
    expect(
      await errorKind(
        createInMemoryFramedPair({ clientDataRootHash: 'f'.repeat(64) }),
      ),
    ).toBe('failed_precondition');
  });

  it.each([
    ['an empty string', ''],
    ['an empty byte array', new Uint8Array(0)],
  ])('rejects %s as the secret before any I/O', async (_label, secret) => {
    const [wire] = duplexPair();
    const written: unknown[] = [];
    wire.on('data', (chunk) => written.push(chunk));
    expect(
      await errorKind(
        createCanopyFramedConnection(wire, {
          role: 'server',
          auth: { secret, dataRootHash: '0'.repeat(64) },
          handshakeTimeoutMs: 50,
        }),
      ),
    ).toBe('invalid_argument');
    expect(written).toEqual([]);
    expect(await errorKind(createInMemoryFramedPair({ secret: '' }))).toBe(
      'invalid_argument',
    );
  });

  it('fails pair setup promptly when one side rejects its options', async () => {
    const started = Date.now();
    expect(
      await errorKind(createInMemoryFramedPair({ clientDataRootHash: 'x' })),
    ).toBe('invalid_argument');
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops reading at the buffer bound and resumes as frames drain', async () => {
    const { client, server } = await pair({ maxBufferedMessages: 2 });
    const payload = 'y'.repeat(32 * 1024);
    let sent = 0;
    const sending = (async (): Promise<void> => {
      for (let id = 1; id <= 20; id += 1) {
        await client.send({ jsonrpc: '2.0', id, result: payload });
        sent = id;
      }
    })();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toBeLessThan(20);
    for (let id = 1; id <= 20; id += 1)
      expect(await server.receive()).toMatchObject({ id });
    await sending;
    expect(sent).toBe(20);
  });

  it('negotiates byte channels and enforces their caps', async () => {
    const { client, server } = await pair();
    await expect(
      client.openChannel({
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 16, maxBufferedChunks: 4 },
      }),
    ).rejects.toMatchObject({ payload: { kind: 'capability_unavailable' } });

    const accepted = new Promise<Uint8Array | null>((resolve) =>
      server.onChannel((channel) => {
        expect(channel).toMatchObject({
          kind: 'pipeline.output',
          leaseId: 'lease-1',
        });
        void channel.read().then(resolve);
      }),
    );
    const channel = await client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'lease-1',
      caps: { maxChunkBytes: 16, maxBufferedChunks: 4 },
    });
    await channel.write(Uint8Array.of(1, 2, 3));
    expect(await accepted).toEqual(Uint8Array.of(1, 2, 3));
    const oversizeError = await errorPayload(channel.write(new Uint8Array(17)));
    expect(CanopyErrorPayloadSchema.parse(oversizeError)).toEqual(
      oversizeError,
    );
    expect(oversizeError).toMatchObject({
      kind: 'resource_exhausted',
      message:
        'Chunk exceeds the channel cap of 16 bytes; split writes to at most 16 bytes.',
      details: { maxChunkBytes: 16 },
      retry: { kind: 'never' },
    });
    expect(channel.signal.aborted).toBe(false);
    channel.close();
    expect(await channel.read()).toBeNull();
  });

  it('returns credit at half-window consumption, including waiting readers', async () => {
    const { server, clientWire, next } = await scriptedClient();
    let accept: (channel: CanopyByteChannel) => void = () => {};
    const accepted = new Promise<CanopyByteChannel>((resolve) => {
      accept = resolve;
    });
    server.onChannel(accept);
    const channelId = 'creditCoalescing';
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 4 };
    clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId,
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps,
      }),
    );
    const channel = await accepted;
    expect(await next()).toMatchObject({
      type: 'channel.opened',
      channelId,
      caps,
    });
    clientWire.write(
      Buffer.concat(
        [1, 2, 3, 4].map((value) =>
          encodeCanopyChannelDataFrame(channelId, Uint8Array.of(value)),
        ),
      ),
    );
    expect(await channel.read()).toEqual(Uint8Array.of(1));
    expect(await channel.read()).toEqual(Uint8Array.of(2));
    expect(await next()).toEqual({
      type: 'channel.credit',
      channelId,
      chunks: 2,
    });
    expect(await channel.read()).toEqual(Uint8Array.of(3));
    expect(await channel.read()).toEqual(Uint8Array.of(4));
    expect(await next()).toEqual({
      type: 'channel.credit',
      channelId,
      chunks: 2,
    });
    server.close();
  });

  it('refuses a chunk past the credit the peer holds while credit is batched', async () => {
    const { server, clientWire, next } = await scriptedClient();
    let accept: (channel: CanopyByteChannel) => void = () => {};
    const accepted = new Promise<CanopyByteChannel>((resolve) => {
      accept = resolve;
    });
    server.onChannel(accept);
    const channelId = 'batchedCredit';
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 4 };
    clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId,
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps,
      }),
    );
    const channel = await accepted;
    await next();
    clientWire.write(
      Buffer.concat(
        [1, 2, 3, 4].map((value) =>
          encodeCanopyChannelDataFrame(channelId, Uint8Array.of(value)),
        ),
      ),
    );
    // One read is below the half-window batch, so no credit goes back.
    expect(await channel.read()).toEqual(Uint8Array.of(1));
    clientWire.write(encodeCanopyChannelDataFrame(channelId, Uint8Array.of(5)));
    expect(await next()).toMatchObject({
      type: 'channel.close',
      channelId,
      error: {
        kind: 'resource_exhausted',
        message: 'The peer exceeded the channel credit window of 4 chunks.',
        details: { maxBufferedChunks: 4 },
      },
    });
    for (const value of [2, 3, 4])
      expect(await channel.read()).toEqual(Uint8Array.of(value));
    expect(await channel.read()).toBeNull();
    expect(server.signal.aborted).toBe(false);
    server.close();
  });

  it('credits chunks delivered directly to waiting readers', async () => {
    const { server, clientWire, next } = await scriptedClient();
    let accept: (channel: CanopyByteChannel) => void = () => {};
    const accepted = new Promise<CanopyByteChannel>((resolve) => {
      accept = resolve;
    });
    server.onChannel(accept);
    const channelId = 'directReader';
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 4 };
    clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId,
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps,
      }),
    );
    const channel = await accepted;
    await next();
    const firstRead = channel.read();
    const secondRead = channel.read();
    clientWire.write(
      Buffer.concat(
        [1, 2].map((value) =>
          encodeCanopyChannelDataFrame(channelId, Uint8Array.of(value)),
        ),
      ),
    );
    expect(await firstRead).toEqual(Uint8Array.of(1));
    expect(await secondRead).toEqual(Uint8Array.of(2));
    expect(await next()).toEqual({
      type: 'channel.credit',
      channelId,
      chunks: 2,
    });
    server.close();
  });

  it('reserves concurrent writes within the credit window', async () => {
    const { client, next, write, channelDataCount } = await scriptedServer();
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 3 };
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }));
    const channel = await opening;
    let settled = 0;
    const writes = [1, 2, 3, 4, 5].map((value) =>
      channel.write(Uint8Array.of(value)).then(() => {
        settled += 1;
      }),
    );
    for (const value of [1, 2, 3]) {
      const frame = await next();
      expect(frame).toMatchObject({ type: 'channel.data', channelId });
      if ('bytes' in frame) expect(frame.bytes).toEqual(Uint8Array.of(value));
    }
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise<void>((resolve) => setImmediate(resolve));
    expect(channelDataCount()).toBe(3);
    expect(settled).toBe(3);
    write(
      encodeCanopyJsonFrame({ type: 'channel.credit', channelId, chunks: 2 }),
    );
    await Promise.all(writes);
    for (const value of [4, 5]) {
      const frame = await next();
      expect(frame).toMatchObject({ type: 'channel.data', channelId });
      if ('bytes' in frame) expect(frame.bytes).toEqual(Uint8Array.of(value));
    }
    client.close();
  });

  it('allows a one-chunk window to advance after one read', async () => {
    const { client, server } = await pair();
    let accept: (channel: CanopyByteChannel) => void = () => {};
    const accepted = new Promise<CanopyByteChannel>((resolve) => {
      accept = resolve;
    });
    server.onChannel(accept);
    const channel = await client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'lease-1',
      caps: { maxChunkBytes: 16, maxBufferedChunks: 1 },
    });
    const reader = await accepted;
    await channel.write(Uint8Array.of(1));
    let secondSettled = false;
    const secondWrite = channel.write(Uint8Array.of(2));
    void secondWrite.then(
      () => {
        secondSettled = true;
      },
      () => {
        secondSettled = true;
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(secondSettled).toBe(false);
    expect(await reader.read()).toEqual(Uint8Array.of(1));
    await secondWrite;
    expect(await reader.read()).toEqual(Uint8Array.of(2));
  });

  it('ignores unknown channel credit and interleaves credit with JSON-RPC traffic', async () => {
    const { client, next, write } = await scriptedServer();
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 1 };
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }));
    const channel = await opening;
    await channel.write(Uint8Array.of(1));
    expect(await next()).toMatchObject({ type: 'channel.data' });
    const waitingWrite = channel.write(Uint8Array.of(2));
    write(
      encodeCanopyJsonFrame({
        type: 'channel.credit',
        channelId: 'unknownChannel',
        chunks: 1,
      }),
      encodeCanopyJsonFrame({
        jsonrpc: '2.0',
        method: 'core.runtime.events.item',
        params: { n: 1 },
      }),
      encodeCanopyJsonFrame({ type: 'channel.credit', channelId, chunks: 1 }),
    );
    expect(await client.receive()).toMatchObject({ params: { n: 1 } });
    await waitingWrite;
    expect(await next()).toMatchObject({ type: 'channel.data' });
    expect(client.signal.aborted).toBe(false);
    client.close();
  });

  it('closes a channel when credit exceeds the negotiated window', async () => {
    const { client, next, write } = await scriptedServer();
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 2 };
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }));
    const channel = await opening;
    write(
      encodeCanopyJsonFrame({ type: 'channel.credit', channelId, chunks: 1 }),
    );
    const error = {
      kind: 'invalid_argument',
      message: 'Channel credit exceeds the negotiated window.',
      retry: { kind: 'never' },
    };
    expect(await next()).toMatchObject({
      type: 'channel.close',
      channelId,
      error,
    });
    expect(await errorPayload(channel.write(Uint8Array.of(1)))).toEqual(error);
    expect(client.signal.aborted).toBe(false);
    client.close();
  });

  it('refuses credit for chunks not yet sent, even back to back', async () => {
    const { client, next, write, channelDataCount } = await scriptedServer();
    const caps = { maxChunkBytes: 32, maxBufferedChunks: 2 };
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }));
    const channel = await opening;
    const writes = [1, 2, 3, 4, 5, 6].map((value) =>
      channel.write(Uint8Array.of(value)).catch(() => undefined),
    );
    await next();
    await next();
    const credit = encodeCanopyJsonFrame({
      type: 'channel.credit',
      channelId,
      chunks: 2,
    });
    // The second grant arrives before the writes the first one released.
    write(credit, credit);
    await Promise.all(writes);
    expect(channel.signal.aborted).toBe(true);
    expect(channelDataCount()).toBeLessThanOrEqual(4);
    client.close();
  });

  it('closes only the channel when its pending writer loses the lease', async () => {
    const { client, server } = await pair();
    const accepted: CanopyByteChannel[] = [];
    server.onChannel((channel) => accepted.push(channel));
    const caps = { maxChunkBytes: 16, maxBufferedChunks: 1 };
    const channel = await client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'lease-1',
      caps,
    });
    const reader = accepted.shift();
    expect(reader).toBeDefined();
    await channel.write(Uint8Array.of(1));
    const waitingWrite = channel.write(Uint8Array.of(2));
    const other = await client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'lease-2',
      caps,
    });
    const otherReader = accepted.shift();
    expect(otherReader).toBeDefined();
    const closeReason: CanopyErrorPayload = {
      kind: 'failed_precondition',
      message: 'Lease expired.',
      details: { leaseId: 'lease-1' },
      retry: { kind: 'never' },
    };
    reader?.close(closeReason);
    expect(await errorPayload(waitingWrite)).toEqual(closeReason);
    expect(await errorPayload(channel.write(Uint8Array.of(3)))).toEqual(
      closeReason,
    );
    await other.write(Uint8Array.of(4));
    expect(await otherReader?.read()).toEqual(Uint8Array.of(4));
    expect(client.signal.aborted).toBe(false);
    expect(server.signal.aborted).toBe(false);
  });

  it('rejects a channel write waiting for drain with the channel close payload', async () => {
    const { server, clientWire, next } = await scriptedClient({
      maxChannelChunkBytes: 1_000_000,
      maxChannelBufferedBytes: 1_000_000,
      maxChannelBufferedChunks: 1,
    });
    let accept: (channel: CanopyByteChannel) => void = () => {};
    const accepted = new Promise<CanopyByteChannel>((resolve) => {
      accept = resolve;
    });
    server.onChannel(accept);
    const channelId = 'drainClose';
    clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId,
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 1_000_000, maxBufferedChunks: 1 },
      }),
    );
    const channel = await accepted;
    await next();
    clientWire.pause();
    const waitingWrite = channel.write(new Uint8Array(1_000_000));
    const closeReason: CanopyErrorPayload = {
      kind: 'failed_precondition',
      message: 'Writer revoked.',
      retry: { kind: 'never' },
    };
    channel.close(closeReason);
    expect(await errorPayload(waitingWrite)).toEqual(closeReason);
    expect(server.signal.aborted).toBe(false);
    clientWire.resume();
    server.close();
  });

  it('reports actionable details for inbound chunk caps and window overruns', async () => {
    const oversized = await scriptedClient();
    let acceptOversized: (channel: CanopyByteChannel) => void = () => {};
    const oversizedChannel = new Promise<CanopyByteChannel>((resolve) => {
      acceptOversized = resolve;
    });
    oversized.server.onChannel(acceptOversized);
    oversized.clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId: 'overChunk',
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 4, maxBufferedChunks: 2 },
      }),
    );
    const oversizedReceiver = await oversizedChannel;
    await oversized.next();
    oversized.clientWire.write(
      encodeCanopyChannelDataFrame('overChunk', new Uint8Array(5)),
    );
    const chunkError = {
      kind: 'resource_exhausted',
      message: 'A chunk exceeded the negotiated maxChunkBytes of 4 bytes.',
      details: { maxChunkBytes: 4 },
      retry: { kind: 'never' },
    };
    expect(await oversized.next()).toMatchObject({
      type: 'channel.close',
      channelId: 'overChunk',
      error: chunkError,
    });
    expect(await oversizedReceiver.read()).toBeNull();
    expect(oversized.server.signal.aborted).toBe(false);
    oversized.server.close();

    const overrun = await scriptedClient();
    let acceptOverrun: (channel: CanopyByteChannel) => void = () => {};
    const overrunChannel = new Promise<CanopyByteChannel>((resolve) => {
      acceptOverrun = resolve;
    });
    overrun.server.onChannel(acceptOverrun);
    overrun.clientWire.write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId: 'overWindow',
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 4, maxBufferedChunks: 2 },
      }),
    );
    const overrunReceiver = await overrunChannel;
    await overrun.next();
    overrun.clientWire.write(
      Buffer.concat(
        [1, 2, 3].map((value) =>
          encodeCanopyChannelDataFrame('overWindow', Uint8Array.of(value)),
        ),
      ),
    );
    const windowError = {
      kind: 'resource_exhausted',
      message: 'The peer exceeded the channel credit window of 2 chunks.',
      details: { maxBufferedChunks: 2 },
      retry: { kind: 'never' },
    };
    expect(await overrun.next()).toMatchObject({
      type: 'channel.close',
      channelId: 'overWindow',
      error: windowError,
    });
    expect(await overrunReceiver.read()).toEqual(Uint8Array.of(1));
    expect(await overrunReceiver.read()).toEqual(Uint8Array.of(2));
    expect(await overrunReceiver.read()).toBeNull();
    expect(overrun.server.signal.aborted).toBe(false);
    overrun.server.close();
  });
});

const DATA_ROOT = '0'.repeat(64);

/**
 * A client connected to a scripted raw server, so a test controls exactly
 * which frames share one chunk.
 */
async function scriptedServer(
  maxFrameBytes?: number,
  afterAuthOk: Buffer[] = [],
): Promise<{
  client: CanopyFramedConnection;
  next: () => Promise<object>;
  write: (...frames: Buffer[]) => void;
  channelDataCount: () => number;
}> {
  const [clientWire, serverWire] = duplexPair();
  const decoder = new CanopyFrameDecoder();
  const frames: object[] = [];
  const waiters: ((frame: object) => void)[] = [];
  let channelDataCount = 0;
  serverWire.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type === 'channel.data') channelDataCount += 1;
      const value = frame.type === 'json' ? frame.value : frame;
      const waiter = waiters.shift();
      if (waiter) waiter(value);
      else frames.push(value);
    }
  });
  const next = (): Promise<object> => {
    const frame = frames.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => waiters.push(resolve));
  };
  const write = (...chunks: Buffer[]): void => {
    serverWire.write(Buffer.concat(chunks));
  };
  const connecting = createCanopyFramedConnection(clientWire, {
    role: 'client',
    auth: { secret: 'scripted', dataRootHash: DATA_ROOT },
    maxFrameBytes,
  });
  write(
    encodeCanopyJsonFrame({
      type: 'auth.challenge',
      nonce: 'bm9uY2U',
      dataRootHash: DATA_ROOT,
    }),
  );
  await next();
  write(
    encodeCanopyJsonFrame({ type: 'auth.ok', connectionId: 'scripted' }),
    ...afterAuthOk,
  );
  const client = await connecting;
  return { client, next, write, channelDataCount: () => channelDataCount };
}

function channelIdOf(frame: object): string {
  if (!('channelId' in frame) || typeof frame.channelId !== 'string')
    throw new Error('Expected a channel frame.');
  return frame.channelId;
}

describe('framed connection over a scripted peer', () => {
  const caps = { maxChunkBytes: 512, maxBufferedChunks: 4 };

  it('delivers data and close that share a chunk with channel.opened', async () => {
    const { client, next, write } = await scriptedServer();
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(
      encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }),
      encodeCanopyChannelDataFrame(channelId, Uint8Array.of(4, 2)),
      encodeCanopyJsonFrame({ type: 'channel.close', channelId, error: null }),
    );
    const channel = await opening;
    expect(await channel.read()).toEqual(Uint8Array.of(4, 2));
    expect(await channel.read()).toBeNull();
    client.close();
  });

  it('finishes a channel whose connection closes in the same chunk', async () => {
    const { client, next, write } = await scriptedServer();
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(
      encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }),
      encodeCanopyJsonFrame({ type: 'connection.close', error: null }),
    );
    const channel = await opening;
    expect(await channel.read()).toBeNull();
    expect(channel.signal.aborted).toBe(true);
  });

  it.each([
    ['maxChunkBytes', { ...caps, maxChunkBytes: caps.maxChunkBytes + 1 }],
    [
      'maxBufferedChunks',
      { ...caps, maxBufferedChunks: caps.maxBufferedChunks + 1 },
    ],
  ])(
    'rejects the open and closes when channel.opened raises %s',
    async (_field, grantedCaps) => {
      const { client, next, write } = await scriptedServer();
      const opening = client.openChannel({
        kind: 'pipeline.output',
        leaseId: 'l',
        caps,
      });
      const channelId = channelIdOf(await next());
      write(
        encodeCanopyJsonFrame({
          type: 'channel.opened',
          channelId,
          caps: grantedCaps,
        }),
      );
      expect(await errorKind(opening)).toBe('invalid_argument');
      expect(client.signal.aborted).toBe(true);
    },
  );

  it('refuses an inbound open that reuses a pending outbound channel id', async () => {
    const { client, next, write } = await scriptedServer();
    const accepted: unknown[] = [];
    client.onChannel((channel) => accepted.push(channel));
    const opening = client.openChannel({
      kind: 'pipeline.output',
      leaseId: 'l',
      caps,
    });
    const channelId = channelIdOf(await next());
    write(
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId,
        kind: 'pipeline.output',
        leaseId: 'l',
        caps,
      }),
    );
    expect(await next()).toMatchObject({
      type: 'channel.close',
      channelId,
      error: { kind: 'already_exists' },
    });
    write(
      encodeCanopyJsonFrame({ type: 'channel.opened', channelId, caps }),
      encodeCanopyChannelDataFrame(channelId, Uint8Array.of(7)),
    );
    const channel = await opening;
    expect(await channel.read()).toEqual(Uint8Array.of(7));
    expect(accepted).toEqual([]);
    client.close();
  });

  it('keeps a frame that shares a chunk with auth.ok', async () => {
    const notification = {
      jsonrpc: '2.0',
      method: 'core.runtime.events.item',
      params: { n: 1 },
    };
    const { client } = await scriptedServer(undefined, [
      encodeCanopyJsonFrame(notification),
    ]);
    expect(client.signal.aborted).toBe(false);
    expect(client.connectionId).toBe('scripted');
    expect(await client.receive()).toEqual(notification);
    client.close();
  });

  it('requests no larger a chunk than its own frame cap can carry', async () => {
    const { client, next } = await scriptedServer(1_024);
    void client
      .openChannel({
        kind: 'pipeline.output',
        leaseId: 'l',
        caps: { maxChunkBytes: 1_500, maxBufferedChunks: 4 },
      })
      .catch(() => {});
    expect(await next()).toMatchObject({
      type: 'channel.open',
      caps: { maxChunkBytes: 1_024 - 66 },
    });
    client.close();
  });
});

/** A server connection driven by a scripted raw client that can stop reading. */
async function scriptedClient(
  options: {
    maxFrameBytes?: number;
    closeTimeoutMs?: number;
    maxChannels?: number;
    maxChannelChunkBytes?: number;
    maxChannelBufferedChunks?: number;
    maxChannelBufferedBytes?: number;
  } = {},
): Promise<{
  server: CanopyFramedConnection;
  clientWire: ReturnType<typeof duplexPair>[0];
  serverWire: ReturnType<typeof duplexPair>[1];
  bodySizes: number[];
  next: () => Promise<object>;
}> {
  const [clientWire, serverWire] = duplexPair();
  const decoder = new CanopyFrameDecoder(16 * 1024 * 1024);
  const bodySizes: number[] = [];
  const frames: object[] = [];
  const waiters: ((frame: object) => void)[] = [];
  let onChallenge: (nonce: string) => void = () => {};
  const challenge = new Promise<string>((resolve) => {
    onChallenge = resolve;
  });
  clientWire.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) {
      if (frame.type !== 'json') continue;
      bodySizes.push(Buffer.byteLength(JSON.stringify(frame.value)));
      if ('nonce' in frame.value && typeof frame.value.nonce === 'string')
        onChallenge(frame.value.nonce);
      else if (
        !('type' in frame.value) ||
        typeof frame.value.type !== 'string' ||
        !frame.value.type.startsWith('auth.')
      ) {
        const waiter = waiters.shift();
        if (waiter) waiter(frame.value);
        else frames.push(frame.value);
      }
    }
  });
  const connecting = createCanopyFramedConnection(serverWire, {
    role: 'server',
    auth: { secret: 'scripted', dataRootHash: DATA_ROOT },
    ...options,
  });
  clientWire.write(
    encodeCanopyJsonFrame({
      type: 'auth.response',
      proof: createCanopyAuthProof('scripted', await challenge),
      dataRootHash: DATA_ROOT,
    }),
  );
  const server = await connecting;
  const next = (): Promise<object> => {
    const frame = frames.shift();
    return frame
      ? Promise.resolve(frame)
      : new Promise((resolve) => waiters.push(resolve));
  };
  return { server, clientWire, serverWire, bodySizes, next };
}

describe('framed connection over a scripted client', () => {
  it('never writes a reply larger than its own frame cap', async () => {
    const { server, clientWire, bodySizes } = await scriptedClient({
      maxFrameBytes: 180,
    });
    clientWire.write(encodeCanopyJsonFrame({ jsonrpc: '2.0', id: 1 }));
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
    expect(Math.max(...bodySizes)).toBeLessThanOrEqual(180);
  });

  it('drops a peer that floods refused channel opens and releases its wire', async () => {
    const { server, clientWire, serverWire } = await scriptedClient({
      closeTimeoutMs: 50,
    });
    clientWire.pause();
    clientWire.removeAllListeners('data');
    const opens = Array.from({ length: 2_000 }, (_, index) =>
      encodeCanopyJsonFrame({
        type: 'channel.open',
        channelId: `c${index}`,
        kind: 'pipeline.output',
        leaseId: 'lease-1',
        caps: { maxChunkBytes: 1_024, maxBufferedChunks: 4 },
      }),
    );
    clientWire.write(Buffer.concat(opens));
    expect(await errorKind(server.receive())).toBe('resource_exhausted');
    // The peer never reads, so only the close deadline can free the wire.
    expect(await settlesWithin(destroyed(serverWire), 1_000)).toBe(true);
  });
});

/** Both connections over one `duplexPair`, so a test can observe each wire. */
async function wiredPair(
  side: 'client' | 'server',
  options: { maxBufferedMessages?: number } = {},
): Promise<{
  closing: CanopyFramedConnection;
  sender: CanopyFramedConnection;
  wires: ReturnType<typeof duplexPair>;
}> {
  const wires = duplexPair();
  const auth = { secret: 'wired', dataRootHash: DATA_ROOT };
  const [client, server] = await Promise.all(
    (['client', 'server'] as const).map((role, index) =>
      createCanopyFramedConnection(wires[index], {
        role,
        auth,
        ...(role === side ? options : {}),
      }),
    ),
  );
  return side === 'client'
    ? { closing: client, sender: server, wires }
    : { closing: server, sender: client, wires };
}

function settlesWithin(
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);
}

function destroyed(wire: ReturnType<typeof duplexPair>[0]): Promise<void> {
  return wire.destroyed
    ? Promise.resolve()
    : once(wire, 'close').then(() => {});
}

describe.each(['server', 'client'] as const)(
  'closing a backpressured %s',
  (side) => {
    it('releases both wires and settles the peer', async () => {
      const { closing, sender, wires } = await wiredPair(side, {
        maxBufferedMessages: 1,
      });
      const payload = 'z'.repeat(32 * 1024);
      // Settled markers, so sends rejected by the close are not unhandled.
      const sends = Array.from({ length: 8 }, (_, index) =>
        sender
          .send({ jsonrpc: '2.0', id: index + 1, result: payload })
          .catch(() => {}),
      );
      const pausedWire = wires[side === 'client' ? 0 : 1];
      while (!pausedWire.isPaused())
        await new Promise((resolve) => setImmediate(resolve));
      const receiving = errorKind(sender.receive());

      closing.close();

      expect(
        await settlesWithin(Promise.all(wires.map(destroyed)), 1_000),
      ).toBe(true);
      expect(await settlesWithin(Promise.all(sends), 1_000)).toBe(true);
      expect(await receiving).toBe('unavailable');
      expect(sender.signal.aborted).toBe(true);
    });
  },
);

it('tears down both ends when one wire ends without a close frame', async () => {
  const { closing: client, sender: server, wires } = await wiredPair('client');
  const receiving = Promise.all(
    [client, server].map((end) => errorKind(end.receive())),
  );

  wires[0].end();

  expect(await settlesWithin(receiving, 1_000)).toBe(true);
  expect(await receiving).toEqual(['unavailable', 'unavailable']);
  expect(await settlesWithin(Promise.all(wires.map(destroyed)), 1_000)).toBe(
    true,
  );
});

it.each([0, 1.5, Number.NaN])(
  'rejects closeTimeoutMs %p',
  async (closeTimeoutMs) => {
    const [, serverWire] = duplexPair();
    expect(
      await errorKind(
        createCanopyFramedConnection(serverWire, {
          role: 'server',
          auth: { secret: 's', dataRootHash: DATA_ROOT },
          closeTimeoutMs,
        }),
      ),
    ).toBe('invalid_argument');
  },
);

it('rejects a data-root value that is not a SHA-256 digest before any I/O', async () => {
  const [clientWire, serverWire] = duplexPair();
  const written: Buffer[] = [];
  clientWire.on('data', (chunk: Buffer) => written.push(chunk));
  expect(
    await errorKind(
      createCanopyFramedConnection(serverWire, {
        role: 'server',
        auth: { secret: 's', dataRootHash: '/Users/alice/Library/Canopy' },
      }),
    ),
  ).toBe('invalid_argument');
  await new Promise((resolve) => setImmediate(resolve));
  expect(written).toEqual([]);
});
