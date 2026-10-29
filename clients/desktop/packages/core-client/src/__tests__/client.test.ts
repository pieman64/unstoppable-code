import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  type CanopyErrorPayload,
  type CanopyInstructionDefinitionMap,
  type CanopyQueryDefinitionMap,
  type CanopyStreamDefinitionMap,
} from '@canopy/protocol/canopy-core';

import { createCanopyClient } from '../index';
import type { CanopyClient } from '../types';
import {
  describeCanopyClientConformance,
  rejection,
} from './client-conformance';
import {
  CANONICAL_DEFINITIONS,
  serveCanonicalCore,
  type CanonicalCoreServer,
  type CanonicalHandlers,
} from './fixtures/canonical-core';

describeCanopyClientConformance('in-memory framed pair', async () => {
  const { client, server } = await createInMemoryFramedPair();
  return {
    client,
    server,
    close: (): Promise<void> => {
      client.close();
      server.close();
      return Promise.resolve();
    },
  };
});

type WideClient = CanopyClient<
  CanopyQueryDefinitionMap,
  CanopyInstructionDefinitionMap,
  CanopyStreamDefinitionMap
>;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Bounded, so a missed settle fails the assertion instead of the Jest timeout. */
function within<T>(promise: Promise<T>): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(resolve, 1_000, 'timeout');
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Wide maps accept dynamic operation names and untyped params. */
async function connectWide(handlers: CanonicalHandlers = {}): Promise<{
  client: WideClient;
  server: CanopyFramedConnection;
  core: CanonicalCoreServer;
}> {
  const { client: connection, server } = await createInMemoryFramedPair();
  const core = serveCanonicalCore(server, handlers);
  const client = await createCanopyClient<
    CanopyQueryDefinitionMap,
    CanopyInstructionDefinitionMap,
    CanopyStreamDefinitionMap
  >({
    connection,
    clientName: 'regression',
    clientVersion: '1.0.0',
    definitions: CANONICAL_DEFINITIONS,
  });
  return { client, server, core };
}

describe('createCanopyClient error bounds', () => {
  it('reports an over-long unknown operation name as a bounded capability_unavailable', async () => {
    const { client } = await connectWide();
    const payload = await rejection(client.query('x'.repeat(5_000), {}));
    expect(payload.kind).toBe('capability_unavailable');
    expect(payload.message.length).toBeLessThanOrEqual(4_096);
    await client.close();
  });

  it('keeps a remote retry delay when a keyed instruction is retryable', async () => {
    const { client } = await connectWide();
    client.connection.close({
      kind: 'unavailable',
      message: 'Core restarting.',
      retry: { kind: 'same_request', delayMs: 250 },
    });
    expect(
      await rejection(
        client.instruction(
          'core.test.record',
          { value: 1 },
          { metadata: { idempotencyKey: 'key-1' } },
        ),
      ),
    ).toMatchObject({
      kind: 'unavailable',
      retry: { kind: 'same_idempotency_key', delayMs: 250 },
    });
  });
});

describe('createCanopyClient request metadata', () => {
  it('expires a call by the deadline embedded in params._meta', async () => {
    const { client } = await connectWide({
      'core.test.echo': () => new Promise(() => {}),
    });
    const deadlineAt = new Date(Date.now() + 20).toISOString();
    const call = rejection(
      client.query('core.test.echo', { text: 'silent', _meta: { deadlineAt } }),
    );
    // Bounded, so a missed deadline fails here instead of at the Jest timeout.
    const settled = await Promise.race([call, sleep(500).then(() => null)]);
    const sessionOpen = !client.signal.aborted;
    await client.close();
    expect(settled).toMatchObject({
      kind: 'deadline_exceeded',
      retry: { kind: 'same_request' },
    });
    expect(sessionOpen).toBe(true);
  });
});

describe('createCanopyClient peer requests', () => {
  const ping = (server: CanopyFramedConnection, id: number): Promise<void> =>
    server.send({ jsonrpc: '2.0', id, method: 'core.test.ping', params: {} });

  it('holds the next reply until the core accepts the previous one', async () => {
    const { client, server } = await connectWide();
    let accept = (): void => {};
    const send = jest.spyOn(client.connection, 'send').mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          accept = resolve;
        }),
    );
    await ping(server, 101);
    await ping(server, 102);
    await sleep(30);
    expect(send.mock.calls.map(([reply]) => reply)).toEqual([
      expect.objectContaining({ id: 101 }),
    ]);
    accept();
    await sleep(30);
    expect(send.mock.calls[1]?.[0]).toEqual({
      jsonrpc: '2.0',
      id: 102,
      error: {
        code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
        message: 'Method not found.',
      },
    });
    await client.close();
  });

  it('closes without waiting on a reply the core never accepts', async () => {
    const { client, server } = await connectWide();
    jest
      .spyOn(client.connection, 'send')
      .mockImplementationOnce(() => new Promise<void>(() => {}));
    await ping(server, 101);
    await ping(server, 102);
    await sleep(30);
    const closed = client.close().then(() => 'closed');
    expect(await Promise.race([closed, sleep(500).then(() => 'stuck')])).toBe(
      'closed',
    );
  });
});

describe('createCanopyClient late replies', () => {
  interface Call {
    readonly id: number;
    readonly controller: AbortController;
    readonly settled: Promise<CanopyErrorPayload>;
  }

  /** Requests that never answer unless their text is `ok`; id 1 is initialize. */
  const hangingCore = (): Promise<{
    client: WideClient;
    server: CanopyFramedConnection;
    core: CanonicalCoreServer;
  }> =>
    connectWide({
      'core.test.echo': (params) =>
        params.text === 'ok'
          ? { text: 'ok', length: 2 }
          : new Promise(() => {}),
      'core.test.record': () => new Promise(() => {}),
    });

  /** Issues ids 2..count+1; `instructionId` is a keyed instruction. */
  const issue = (
    client: WideClient,
    count: number,
    instructionId?: number,
  ): Call[] =>
    Array.from({ length: count }, (_, index) => {
      const id = index + 2;
      const controller = new AbortController();
      const options = { signal: controller.signal };
      const settled = rejection(
        id === instructionId
          ? client.instruction(
              'core.test.record',
              { value: id },
              { ...options, metadata: { idempotencyKey: `key-${id}` } },
            )
          : client.query('core.test.echo', { text: `call-${id}` }, options),
      );
      return { id, controller, settled };
    });

  const receivedBy = async (
    core: CanonicalCoreServer,
    count: number,
  ): Promise<boolean> => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (core.requests.length >= count) return true;
      await sleep(10);
    }
    return false;
  };

  /** Distinct `kind/retry` outcomes, so 1,000+ settlements assert compactly. */
  const outcomes = async (
    calls: readonly Call[],
  ): Promise<string[] | string> => {
    const settled = await within(
      Promise.all(calls.map((call) => call.settled)),
    );
    return settled === 'timeout'
      ? settled
      : Array.from(
          new Set(settled.map(({ kind, retry }) => `${kind}/${retry.kind}`)),
        );
  };

  const ok = (client: WideClient): Promise<unknown> =>
    within(client.query('core.test.echo', { text: 'ok' }));

  it('rejects a duplicate initialize reply after more than 1,024 out-of-order cancellations', async () => {
    // Echo answers only `ok`; initialize is id 1, so calls take ids 2..1026.
    const { client, server, core } = await connectWide({
      'core.test.echo': ({ text }) =>
        text === 'ok' ? { text, length: 2 } : new Promise(() => {}),
    });
    const calls = Array.from({ length: 1_025 }, (_, index) => {
      const controller = new AbortController();
      const { signal } = controller;
      const outcome = rejection(
        client.query('core.test.echo', { text: `call-${index}` }, { signal }),
      ).then(({ kind, retry }) => `${kind}/${retry.kind}`);
      return { id: index + 2, controller, outcome };
    });
    const received = async (count: number): Promise<boolean> => {
      for (let i = 0; i < 200 && core.requests.length < count; i += 1)
        await sleep(10);
      return core.requests.length >= count;
    };
    try {
      expect(await received(calls.length + 1)).toBe(true);
      expect(core.requests.map(({ id }) => id)).toEqual([
        1,
        ...calls.map(({ id }) => id),
      ]);

      // Contiguous cancellations in any order collapse into one exact range.
      const [highest, ...rest] = [...calls].reverse();
      [
        highest,
        ...rest.filter(({ id }) => id % 2 === 0),
        ...rest.filter(({ id }) => id % 2 === 1).reverse(),
      ].forEach(({ controller }) => controller.abort());
      const outcomes = Promise.all(calls.map(({ outcome }) => outcome));
      expect(await within(outcomes.then((all) => new Set(all)))).toEqual(
        new Set(['cancelled/never']),
      );

      // Each abandoned id accepts one late reply and the session stays usable.
      const late = { text: 'late', length: 4 };
      for (const id of [highest.id, 2])
        await server.send({ jsonrpc: '2.0', id, result: late });
      const fresh = client.query('core.test.echo', { text: 'ok' });
      expect(await within(fresh)).toEqual({ text: 'ok', length: 2 });

      // Initialize completed and was never abandoned: a second reply fails closed.
      const probe = rejection(client.query('core.test.echo', { text: 'next' }));
      expect(await received(calls.length + 3)).toBe(true);
      await server.send({ jsonrpc: '2.0', id: 1, result: {} });
      expect(await within(probe)).toMatchObject({ kind: 'internal' });
      expect(client.signal.aborted).toBe(true);
      expect(client.connection.signal.aborted).toBe(true);
      expect(await within(core.done.then(() => 'closed'))).toBe('closed');
    } finally {
      await within(client.close());
      server.close();
      await within(Promise.allSettled(calls.map(({ outcome }) => outcome)));
    }
  });

  it.each([
    ['a second late reply to one abandoned id', 2],
    ['a reply to an id never issued', 10_000],
  ])(
    'fails closed on %s after out-of-order cancellations',
    async (_, replyId) => {
      const { client, server, core } = await hangingCore();
      const calls = issue(client, 1_025);
      try {
        expect(await receivedBy(core, calls.length + 1)).toBe(true);
        [
          ...calls.filter(({ id }) => id % 2 === 1).reverse(),
          ...calls.filter(({ id }) => id % 2 === 0),
        ].forEach(({ controller }) => controller.abort());
        expect(await outcomes(calls)).toEqual(['cancelled/never']);
        const late = (id: number): Promise<void> =>
          server.send({
            jsonrpc: '2.0',
            id,
            result: { text: 'late', length: 4 },
          });
        await late(2);
        expect(await ok(client)).toEqual({ text: 'ok', length: 2 });

        const probe = rejection(
          client.query('core.test.echo', { text: 'probe' }),
        );
        await late(replyId);
        expect(await within(probe)).toMatchObject({ kind: 'internal' });
        expect(client.signal.aborted).toBe(true);
        expect(client.connection.signal.aborted).toBe(true);
      } finally {
        await within(client.close());
        server.close();
        await within(Promise.allSettled(calls.map((call) => call.settled)));
      }
    },
  );

  it.each([
    ['abandoning another isolated call', 'abandon'],
    ['a late reply that splits a range', 'split'],
  ] as const)(
    'closes as resource_exhausted when %s exceeds 1,024 abandoned ranges',
    async (_, trigger) => {
      const { client, server, core } = await hangingCore();
      // Ids 2..2052: abandoned [2..4] plus even 6..2050 make 1,024 ranges,
      // separated by pending odd ids; 2051 is a keyed instruction and 2052
      // is the trigger.
      const calls = issue(client, 2_051, 2_051);
      const last = calls[calls.length - 1];
      const abandoned = calls.filter(
        (call) => call !== last && (call.id <= 4 || call.id % 2 === 0),
      );
      const pending = calls.filter(
        (call) => call !== last && !abandoned.includes(call),
      );
      try {
        expect(await receivedBy(core, calls.length + 1)).toBe(true);
        abandoned.reverse().forEach(({ controller }) => controller.abort());
        expect(await outcomes(abandoned)).toEqual(['cancelled/never']);
        expect(await ok(client)).toEqual({ text: 'ok', length: 2 });

        if (trigger === 'abandon') last.controller.abort();
        else
          await server.send({
            jsonrpc: '2.0',
            id: 3,
            result: { text: 'late', length: 4 },
          });

        expect(await outcomes([last])).toEqual([
          trigger === 'abandon'
            ? 'cancelled/never'
            : 'resource_exhausted/same_request',
        ]);
        expect(await outcomes(pending)).toEqual([
          'resource_exhausted/same_request',
          'resource_exhausted/same_idempotency_key',
        ]);
        expect(client.signal.aborted).toBe(true);
        expect(client.connection.signal.aborted).toBe(true);
        expect(await within(core.done.then(() => 'closed'))).toBe('closed');
        // Later calls fail locally with the close reason, retry per idempotency.
        expect(await outcomes(issue(client, 2, 3))).toEqual([
          'resource_exhausted/same_request',
          'resource_exhausted/same_idempotency_key',
        ]);
      } finally {
        await within(client.close());
        server.close();
        await within(Promise.allSettled(calls.map((call) => call.settled)));
      }
    },
  );
});
