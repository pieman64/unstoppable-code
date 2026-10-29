import { createInMemoryFramedPair } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CORE_TRANSPORT_INSTRUCTION_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CanopyEventSchema,
  CoreEventsAckParamsSchema,
  CoreEventsSubscribeParamsSchema,
  encodeCanopyError,
  type CanopyErrorPayload,
  type CanopyEvent,
  type CanopyJsonRpcMessage,
  type CanopyJsonRpcRequest,
  type CanopyStreamCursor,
  type CanopyWorkspaceScope,
} from '@canopy/protocol/canopy-core';
import type { z } from 'zod';

import { createCanopyClient } from '../../index';
import type { CanopyClient } from '../../types';
import { canonicalInitializeResult } from './canonical-core';

export const EVENT_DEFINITIONS = {
  queries: {},
  instructions: {
    'core.events.ack':
      CORE_TRANSPORT_INSTRUCTION_DEFINITIONS['core.events.ack'],
  },
  streams: {
    'core.events.subscribe':
      CORE_TRANSPORT_STREAM_DEFINITIONS['core.events.subscribe'],
  },
};

export type EventsClient = CanopyClient<
  typeof EVENT_DEFINITIONS.queries,
  typeof EVENT_DEFINITIONS.instructions,
  typeof EVENT_DEFINITIONS.streams
>;
type SubscribeParams = z.output<typeof CoreEventsSubscribeParamsSchema>;
type AckParams = z.output<typeof CoreEventsAckParamsSchema>;

export interface EventsCoreOptions {
  readonly authorityId?: string;
  readonly daemonEpoch?: string;
  /** How an expired or foreign cursor fails; defaults to `open`. */
  readonly snapshotRequired?: 'open' | 'end';
}

export interface EventsCore {
  connect(): Promise<EventsClient>;
  append(
    name: string,
    payload?: CanopyEvent['payload'],
    scope?: CanopyWorkspaceScope,
  ): Promise<CanopyEvent>;
  /** The head cursor of the current epoch. */
  cursor(): CanopyStreamCursor;
  /** Drops retained events through `sequence`; older cursors need a snapshot. */
  expireThrough(sequence: number): void;
  /** Drops every connection and starts an empty journal under a new epoch. */
  restart(daemonEpoch: string): void;
  close(): Promise<void>;
  /** Parsed params of every accepted-shape subscribe, in arrival order. */
  readonly subscriptions: readonly SubscribeParams[];
  /** Params of every accepted ack, in arrival order. */
  readonly acknowledgements: readonly AckParams[];
}

interface Subscription {
  readonly params: SubscribeParams;
  lastSent: number;
  acked: number;
}

interface Connection {
  readonly server: CanopyFramedConnection;
  readonly subs: Map<string, Subscription>;
  chain: Promise<void>;
}

const fail = (
  kind: CanopyErrorPayload['kind'],
  code: NonNullable<CanopyErrorPayload['code']>,
  message: string,
): CanopyErrorPayload => ({ kind, code, message, retry: { kind: 'never' } });

function matches(params: SubscribeParams, event: CanopyEvent): boolean {
  const family = params.families.some((prefix) =>
    prefix.endsWith('.')
      ? event.name.startsWith(prefix)
      : event.name === prefix || event.name.startsWith(`${prefix}.`),
  );
  const scope: Record<string, string | undefined> = event.scope;
  return (
    family &&
    Object.entries(params.scope ?? {}).every(
      ([key, value]) => value === undefined || scope[key] === value,
    )
  );
}

/** A bounded in-memory events journal served over real framed pairs. */
export function createEventsCore(options: EventsCoreOptions = {}): EventsCore {
  const mode = options.snapshotRequired ?? 'open';
  let epoch = options.daemonEpoch ?? 'epoch-1';
  let sequence = 0;
  let expired = 0;
  let nextSub = 0;
  let journal: CanopyEvent[] = [];
  const connections = new Set<Connection>();
  const clients = new Set<EventsClient>();
  const subscriptions: SubscribeParams[] = [];
  const acknowledgements: AckParams[] = [];

  const push = (conn: Connection, message: CanopyJsonRpcMessage): void => {
    conn.chain = conn.chain
      .then(() => conn.server.send(message))
      .catch(() => {});
  };
  const deliver = (conn: Connection, id: string, event: CanopyEvent): void => {
    const sub = conn.subs.get(id);
    if (!sub || !matches(sub.params, event)) return;
    sub.lastSent = event.cursor.sequence;
    push(conn, {
      jsonrpc: '2.0',
      method: 'core.events.subscribe.item',
      params: {
        subscriptionId: id,
        cursor: event.cursor,
        itemId: event.eventId,
        occurredAt: event.occurredAt,
        item: event,
      },
    });
  };

  const subscribe = (conn: Connection, request: CanopyJsonRpcRequest): void => {
    const { id } = request;
    const parsed = CoreEventsSubscribeParamsSchema.safeParse(request.params);
    if (!parsed.success) {
      const error = fail(
        'invalid_argument',
        'core.events.invalidState',
        'Bad subscribe params.',
      );
      return push(conn, {
        jsonrpc: '2.0',
        id,
        error: encodeCanopyError(error),
      });
    }
    const params = parsed.data;
    subscriptions.push(params);
    const from = params.cursor ?? null;
    const subscriptionId = `events-sub-${(nextSub += 1)}`;
    if (
      from &&
      (from.daemonEpoch !== epoch ||
        from.sequence < expired ||
        from.sequence > sequence)
    ) {
      const error = fail(
        'failed_precondition',
        'core.events.snapshotRequired',
        'Cursor is expired or foreign; re-query a snapshot.',
      );
      if (mode === 'open')
        return push(conn, {
          jsonrpc: '2.0',
          id,
          error: encodeCanopyError(error),
        });
      push(conn, {
        jsonrpc: '2.0',
        id,
        result: { subscriptionId, acceptedCursor: null },
      });
      return push(conn, {
        jsonrpc: '2.0',
        method: 'core.events.subscribe.end',
        params: {
          subscriptionId,
          cursor: { daemonEpoch: epoch, sequence },
          outcome: 'error',
          error,
        },
      });
    }
    const start = from?.sequence ?? 0;
    conn.subs.set(subscriptionId, { params, lastSent: start, acked: start });
    push(conn, {
      jsonrpc: '2.0',
      id,
      result: { subscriptionId, acceptedCursor: from },
    });
    for (const event of journal)
      if (event.cursor.sequence > start) deliver(conn, subscriptionId, event);
  };

  const ack = (conn: Connection, request: CanopyJsonRpcRequest): void => {
    const { id } = request;
    const reject = (...args: Parameters<typeof fail>): void =>
      push(conn, {
        jsonrpc: '2.0',
        id,
        error: encodeCanopyError(fail(...args)),
      });
    const parsed = CoreEventsAckParamsSchema.safeParse(request.params);
    if (!parsed.success)
      return reject(
        'invalid_argument',
        'core.events.invalidState',
        'Bad ack params.',
      );
    const { cursor } = parsed.data;
    const sub = conn.subs.get(parsed.data.subscriptionId);
    if (!sub)
      return reject(
        'not_found',
        'core.events.notFound',
        'Unknown subscription.',
      );
    if (cursor.daemonEpoch !== epoch)
      return reject(
        'failed_precondition',
        'core.events.revisionConflict',
        'Ack is from another epoch.',
      );
    if (cursor.sequence < sub.acked)
      return reject(
        'failed_precondition',
        'core.events.invalidState',
        'Ack moves backwards.',
      );
    if (cursor.sequence > sub.lastSent)
      return reject(
        'failed_precondition',
        'core.events.invalidState',
        'Ack is beyond the delivered cursor.',
      );
    sub.acked = cursor.sequence;
    acknowledgements.push(parsed.data);
    push(conn, { jsonrpc: '2.0', id, result: { acknowledgedCursor: cursor } });
  };

  const serve = async (conn: Connection): Promise<void> => {
    const base = canonicalInitializeResult();
    const initialize = canonicalInitializeResult({
      runtime: {
        ...base.runtime,
        authorityId: options.authorityId ?? 'authority-1',
        daemonEpoch: epoch,
      },
      capabilities: {
        operations: ['core.runtime.initialize', 'core.events.ack'],
        events: [],
        streams: ['core.events.subscribe'],
      },
    });
    for (;;) {
      const message = await conn.server.receive().catch(() => null);
      if (!message) break;
      if (!('method' in message) || !('id' in message)) continue;
      const { id, method } = message;
      if (method === 'core.runtime.initialize')
        push(conn, { jsonrpc: '2.0', id, result: initialize });
      else if (method === 'core.events.subscribe') subscribe(conn, message);
      else if (method === 'core.events.ack') ack(conn, message);
      else
        push(conn, {
          jsonrpc: '2.0',
          id,
          error: {
            code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
            message: `Unknown method ${method}.`,
          },
        });
    }
    connections.delete(conn);
  };

  const dropConnections = (): void => {
    for (const conn of Array.from(connections)) {
      connections.delete(conn);
      conn.server.close();
    }
  };

  return {
    subscriptions,
    acknowledgements,
    async connect(): Promise<EventsClient> {
      const pair = await createInMemoryFramedPair();
      const conn: Connection = {
        server: pair.server,
        subs: new Map(),
        chain: Promise.resolve(),
      };
      connections.add(conn);
      void serve(conn);
      const client = await createCanopyClient({
        connection: pair.client,
        clientName: 'events-core-test',
        clientVersion: '1.0.0',
        definitions: EVENT_DEFINITIONS,
      });
      clients.add(client);
      return client;
    },
    async append(name, payload = {}, scope = {}): Promise<CanopyEvent> {
      sequence += 1;
      const event = CanopyEventSchema.parse({
        cursor: { daemonEpoch: epoch, sequence },
        eventId: `event-${epoch}-${sequence}`,
        name,
        scope,
        occurredAt: new Date().toISOString(),
        payload,
      });
      journal.push(event);
      for (const conn of Array.from(connections))
        for (const id of Array.from(conn.subs.keys())) deliver(conn, id, event);
      await Promise.all(Array.from(connections).map((conn) => conn.chain));
      return event;
    },
    cursor: (): CanopyStreamCursor => ({ daemonEpoch: epoch, sequence }),
    expireThrough(through): void {
      expired = Math.max(expired, Math.min(through, sequence));
      journal = journal.filter((event) => event.cursor.sequence > expired);
    },
    restart(daemonEpoch): void {
      dropConnections();
      epoch = daemonEpoch;
      sequence = 0;
      expired = 0;
      journal = [];
    },
    async close(): Promise<void> {
      await Promise.all(Array.from(clients).map((client) => client.close()));
      clients.clear();
      dropConnections();
    },
  };
}
