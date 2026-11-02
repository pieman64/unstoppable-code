import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CanopyStreamCursorSchema,
  composeCanopyOperationEnvelopes,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import type {
  CanopyFramedConnection,
  CanopyJournalConformanceTarget,
  CanopyJournalConformanceInstance,
} from '@canopy/core-transport';
import type { RuntimeHealthCheck } from '@canopy/core-runtime';
import {
  createDesktopRuntime,
  type DesktopCanopyDispatcher,
} from '../desktop-runtime';

const HEALTH = 'core.runtime.health.get';
const EVENTS = 'core.runtime.events';
const health = composeCanopyOperationEnvelopes(
  HEALTH,
  CORE_TRANSPORT_QUERY_DEFINITIONS[HEALTH],
);
const events = composeCanopyOperationEnvelopes(
  EVENTS,
  CORE_TRANSPORT_STREAM_DEFINITIONS[EVENTS],
);
export const framedCaller: CanopyCallerDescriptor = {
  principalId: 'local-desktop-user',
  clientInstanceId: 'framed-test',
  authorityId: 'local-desktop',
  interfaceKind: 'desktop',
  grants: ['core.runtime.read'],
};

// Test projection only; this does not install a product transport or handler.
export async function serveFramedRuntime(
  runtime: DesktopCanopyDispatcher,
  server: CanopyFramedConnection,
): Promise<void> {
  const handles = new Set<{ close(): void }>();
  const dispose = (): void => {
    handles.forEach((handle) => handle.close());
    handles.clear();
  };
  server.signal.addEventListener('abort', dispose, { once: true });
  let delivery = Promise.resolve();
  const send = (message: CanopyJsonRpcMessage): Promise<void> => {
    delivery = delivery
      .then(() => server.send(message))
      .catch(() => {
        server.close();
        dispose();
      });
    return delivery;
  };
  try {
    while (!server.signal.aborted) {
      const message = await server.receive().catch(() => null);
      if (!message) break;
      if (!('method' in message) || !('id' in message)) continue;
      const { id } = message;
      try {
        if (message.method === HEALTH) {
          health.request.parse(message);
          const result = await runtime.query(
            HEALTH,
            {},
            { caller: framedCaller },
          );
          await send({ jsonrpc: '2.0', id, result });
        } else if (message.method === EVENTS) {
          events.request.parse(message);
          const cursor = CanopyStreamCursorSchema.nullable()
            .optional()
            .parse(message.params.cursor);
          const handle = await runtime.openStream(
            EVENTS,
            { cursor },
            { caller: framedCaller },
          );
          if (server.signal.aborted) {
            handle.close();
            break;
          }
          handles.add(handle);
          const { subscriptionId } = handle.openResult;
          await send({ jsonrpc: '2.0', id, result: handle.openResult });
          handle.onFrame((frame) => {
            void send(
              frame.kind === 'item'
                ? {
                    jsonrpc: '2.0',
                    method: `${EVENTS}.item`,
                    params: {
                      subscriptionId,
                      cursor: frame.cursor,
                      itemId: `${frame.cursor.daemonEpoch}#${frame.cursor.sequence}`,
                      occurredAt: new Date().toISOString(),
                      item: frame.item,
                    },
                  }
                : {
                    jsonrpc: '2.0',
                    method: `${EVENTS}.end`,
                    params: {
                      subscriptionId,
                      cursor: frame.cursor,
                      outcome: frame.outcome,
                      error: frame.error,
                    },
                  },
            );
            if (frame.kind === 'end') handles.delete(handle);
          });
        } else {
          await send({
            jsonrpc: '2.0',
            id,
            error: {
              code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
              message: `Unknown method ${message.method}.`,
            },
          });
        }
      } catch (error) {
        await send({
          jsonrpc: '2.0',
          id,
          error: encodeCanopyError({
            kind: 'invalid_argument',
            message:
              error instanceof Error ? error.message : 'Invalid request.',
            retry: { kind: 'never' },
          }),
        });
      }
    }
  } finally {
    server.signal.removeEventListener('abort', dispose);
    dispose();
  }
}

export const desktopJournalTarget: CanopyJournalConformanceTarget = {
  name: 'desktop core.runtime.events',
  method: EVENTS,
  async start(): Promise<CanopyJournalConformanceInstance> {
    let status: RuntimeHealthCheck['status'] = 'pass';
    const runtime = createDesktopRuntime({
      runtimeServices: [
        {
          name: 'journal-conformance',
          plane: 'core',
          health: (): RuntimeHealthCheck => ({
            name: 'journal-conformance',
            status,
            message: null,
          }),
        },
      ],
    });
    const readHealth = (): ReturnType<typeof runtime.query<typeof HEALTH>> =>
      runtime.query(HEALTH, {}, { caller: framedCaller });
    try {
      let snapshot = await readHealth();
      for (
        let attempt = 0;
        snapshot.runtime.state === 'starting' && attempt < 20;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        snapshot = await readHealth();
      }
      if (snapshot.runtime.state !== 'ready')
        throw new Error('Desktop runtime did not become ready.');
      const { daemonEpoch } = snapshot.runtime;
      const cursors: CanopyStreamCursor[] = [];
      const observer = await runtime.openStream(
        EVENTS,
        { cursor: null },
        {
          caller: framedCaller,
          onFrame: (frame): void => {
            if (frame.kind === 'item') cursors.push({ ...frame.cursor });
          },
        },
      );
      const append = async (count: number): Promise<CanopyStreamCursor[]> => {
        const before = cursors.length;
        for (let index = 0; index < count; index += 1) {
          status = status === 'pass' ? 'warn' : 'pass';
          await readHealth();
        }
        const added = cursors.slice(before);
        if (added.length !== count)
          throw new Error(
            'Health changes did not produce the requested journal events.',
          );
        return added;
      };
      return {
        daemonEpoch,
        serve: (server): void => {
          void serveFramedRuntime(runtime, server);
        },
        append,
        async expire(): Promise<CanopyStreamCursor> {
          const oldest = cursors[0];
          if (!oldest) throw new Error('The ready event is missing.');
          // Probe real retention rather than assuming the journal's private cap.
          for (let batch = 0; batch < 32; batch += 1) {
            await append(128);
            let expired = false;
            const probe = await runtime.openStream(
              EVENTS,
              { cursor: oldest },
              {
                caller: framedCaller,
                onFrame: (frame): void => {
                  if (
                    frame.kind === 'end' &&
                    frame.error?.code === 'core.runtime.snapshotRequired'
                  )
                    expired = true;
                },
              },
            );
            probe.close();
            if (expired) return { ...oldest };
          }
          throw new Error(
            'Journal history did not expire within the bounded test workload.',
          );
        },
        async close(): Promise<void> {
          observer.close();
          await runtime.shutdown();
        },
      };
    } catch (error) {
      await runtime.shutdown();
      throw error;
    }
  },
};
