// Client-side HTTP binding conformance (doc 05): the real `connectCanopyHttp`
// against a test-only server that speaks the web core's POST plus SSE
// contract (`apps/web/src/app/api/cloud/core/connections`) and hands each
// message to a framed server end. The web core's own routes, lease store and
// pushes are covered by its PostgreSQL suite (`pnpm run test:web-core-integration`).
import {
  parseCanopyJsonRpcMessage,
  type CanopyJsonRpcMessage,
} from '@canopy/protocol/canopy-core';

import { connectCanopyHttp } from '../../http';
import {
  createInMemoryFramedPair,
  type CanopyFramedPair,
} from '../../in-memory';
import type { CanopyConformancePairOptions } from '../../conformance';
import type { CanopyFramedConnection } from '../../types';

const ENDPOINT = '/api/cloud/core/connections';

interface BridgedConnection {
  /** The bridge's end of the in-memory pair whose other end is `server`. */
  readonly relay: CanopyFramedConnection;
  /** POSTed requests awaiting their reply, by id. */
  readonly replies: Map<
    unknown,
    (message: CanopyJsonRpcMessage | null) => void
  >;
  /** Everything else the server sends, in order, as SSE events 1, 2, … */
  readonly pushes: CanopyJsonRpcMessage[];
  readonly wake: Set<() => void>;
}

const sse = (id: number, message: CanopyJsonRpcMessage): string =>
  `id: ${id}\ndata: ${JSON.stringify(message)}\n\n`;

/** One HTTP pair: `client` is `connectCanopyHttp`, `server` a framed end. */
export async function createHttpFramedPair(
  options: CanopyConformancePairOptions = {},
): Promise<CanopyFramedPair> {
  // Every pair option tunes the byte wire, auth or buffering HTTP lacks; fail
  // closed rather than silently pass a case that set one.
  if (Object.values(options).some((value) => value !== undefined))
    throw new Error('HTTP pairs take no pair options.');
  const inner = await createInMemoryFramedPair();
  const connections = new Map<string, BridgedConnection>();
  const wakeAll = (bridged: BridgedConnection): void => {
    bridged.wake.forEach((wake) => wake());
    bridged.wake.clear();
  };
  const gone = (): Response =>
    Response.json({ error: 'not found' }, { status: 404 });

  const end = (id: string, bridged: BridgedConnection): void => {
    connections.delete(id);
    bridged.relay.close();
    bridged.replies.forEach((reply) => reply(null));
    bridged.replies.clear();
    wakeAll(bridged);
  };

  const bridge = (id: string): BridgedConnection => {
    const bridged: BridgedConnection = {
      relay: inner.client,
      replies: new Map(),
      pushes: [],
      wake: new Set(),
    };
    void (async (): Promise<void> => {
      for (;;) {
        const message = await bridged.relay.receive().catch(() => null);
        if (!message) break;
        const reply =
          'id' in message && !('method' in message)
            ? bridged.replies.get(message.id)
            : undefined;
        if (reply && 'id' in message) {
          bridged.replies.delete(message.id);
          reply(message);
        } else bridged.pushes.push(message);
        wakeAll(bridged);
      }
      // The server end closed: the connection is gone, as a lapsed one is.
      end(id, bridged);
    })();
    return bridged;
  };

  const events = (
    bridged: BridgedConnection,
    id: string,
    after: number,
    signal: AbortSignal | null | undefined,
  ): Response => {
    let sent = after;
    // An aborted read ends its stream, as real fetch does.
    signal?.addEventListener('abort', () => wakeAll(bridged), { once: true });
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      pull: async (controller): Promise<void> => {
        while (sent >= bridged.pushes.length) {
          if (!connections.has(id) || signal?.aborted)
            return controller.close();
          await new Promise<void>((resolve) => bridged.wake.add(resolve));
        }
        sent += 1;
        controller.enqueue(encoder.encode(sse(sent, bridged.pushes[sent - 1])));
      },
    });
    return new Response(body, {
      headers: { 'content-type': 'text/event-stream' },
    });
  };

  const fetch = async (path: string, init?: RequestInit): Promise<Response> => {
    if (path === ENDPOINT)
      return connections.size > 0
        ? Response.json({ error: 'one connection per pair' }, { status: 409 })
        : (connections.set('c-1', bridge('c-1')),
          Response.json({ connectionId: 'c-1' }, { status: 201 }));
    const [id, leg] = path.slice(ENDPOINT.length + 1).split('/');
    const bridged = connections.get(id);
    if (!bridged) return gone();
    if (leg === 'events') {
      const header = new Headers(init?.headers).get('last-event-id');
      return events(bridged, id, Number(header ?? 0), init?.signal);
    }
    if (init?.method === 'DELETE') {
      end(id, bridged);
      return new Response(null, { status: 204 });
    }
    const body: unknown = JSON.parse(
      typeof init?.body === 'string' ? init.body : 'null',
    );
    const parsed = parseCanopyJsonRpcMessage(body);
    if (!parsed.success)
      return Response.json({ error: 'bad request' }, { status: 400 });
    const { message } = parsed;
    if (!('method' in message && 'id' in message)) {
      await bridged.relay.send(message);
      return new Response(null, { status: 202 });
    }
    const reply = new Promise<CanopyJsonRpcMessage | null>((resolve) =>
      bridged.replies.set(message.id, resolve),
    );
    await bridged.relay.send(message);
    const answered = await reply;
    return answered ? Response.json(answered) : gone();
  };

  const client = await connectCanopyHttp({ endpoint: ENDPOINT, fetch });
  const clientWire = {
    write: (): never => {
      throw new Error('HTTP has no byte wire.');
    },
  };
  return { client, server: inner.server, clientWire };
}
