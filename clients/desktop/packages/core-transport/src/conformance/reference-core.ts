import { randomUUID } from 'node:crypto';

import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  CORE_TRANSPORT_QUERY_DEFINITIONS,
  CORE_TRANSPORT_STREAM_DEFINITIONS,
  CanopyStreamCursorSchema,
  composeCanopyOperationEnvelopes,
  encodeCanopyError,
  type CanopyErrorPayload,
  type CanopyEvent,
  type CanopyJsonRpcId,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';

import type { CanopyFramedConnection } from '../types';

export const REFERENCE_PROTOCOL_VERSIONS = [1];

const INITIALIZE = 'core.runtime.initialize';
const SUBSCRIBE = 'core.events.subscribe';
const initialize = composeCanopyOperationEnvelopes(
  INITIALIZE,
  CORE_TRANSPORT_QUERY_DEFINITIONS[INITIALIZE],
);
const subscribe = composeCanopyOperationEnvelopes(
  SUBSCRIBE,
  CORE_TRANSPORT_STREAM_DEFINITIONS[SUBSCRIBE],
);

export interface ReferenceCoreOptions {
  readonly daemonEpoch: string;
  /** Journal of sequenced events; resume serves entries after the cursor. */
  readonly journal: readonly CanopyEvent[];
  /** Delivers events appended after a subscription opens; returns an unlisten. */
  readonly onAppend?: (listener: (event: CanopyEvent) => void) => () => void;
}

function hasNumberArray(
  value: unknown,
): value is { protocolVersions: number[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'protocolVersions' in value &&
    Array.isArray(value.protocolVersions) &&
    value.protocolVersions.every((entry) => typeof entry === 'number')
  );
}

/**
 * A scripted core that plays the server end of a pair so binding cases can
 * exercise real envelopes. It is reference behavior for the kit, not the
 * daemon kernel (CAN-3727).
 */
export async function serveReferenceCore(
  connection: CanopyFramedConnection,
  options: ReferenceCoreOptions,
): Promise<void> {
  const reply = (id: CanopyJsonRpcId, result: unknown): Promise<void> =>
    connection.send({ jsonrpc: '2.0', id, result });
  const fail = (
    id: CanopyJsonRpcId,
    error: CanopyErrorPayload,
  ): Promise<void> =>
    connection.send({ jsonrpc: '2.0', id, error: encodeCanopyError(error) });
  for (;;) {
    const message = await connection.receive().catch(() => null);
    if (!message) return;
    if (!('method' in message) || !('id' in message)) continue;
    if (message.method === INITIALIZE) {
      initialize.request.parse(message);
      const client: unknown = message.params.client;
      const versions = hasNumberArray(client) ? client.protocolVersions : [];
      const selected = Math.max(
        ...versions.filter((version) =>
          REFERENCE_PROTOCOL_VERSIONS.includes(version),
        ),
      );
      if (!Number.isFinite(selected)) {
        await fail(message.id, {
          kind: 'failed_precondition',
          message:
            'Protocol version mismatch: restart the daemon or update this client.',
          code: 'core.runtime.invalidState',
          details: {
            supportedProtocolVersions: REFERENCE_PROTOCOL_VERSIONS,
            action: 'restart_or_update',
          },
          retry: { kind: 'never' },
        });
        connection.close();
        return;
      }
      await reply(message.id, {
        runtime: {
          runtimeId: 'runtime-1',
          hostId: 'host-1',
          authorityId: 'authority-1',
          profile: 'core+worker',
          daemonEpoch: options.daemonEpoch,
          protocolVersions: REFERENCE_PROTOCOL_VERSIONS,
          state: 'ready',
        },
        selectedProtocolVersion: selected,
        capabilities: [],
        limits: {},
        authentication: { required: true, methods: [] },
      });
    } else if (message.method === SUBSCRIBE) {
      subscribe.request.parse(message);
      const cursor = CanopyStreamCursorSchema.safeParse(message.params.cursor);
      const after = cursor.success ? cursor.data : null;
      const first = options.journal[0]?.cursor.sequence ?? 0;
      const head =
        options.journal[options.journal.length - 1]?.cursor.sequence ?? 0;
      if (
        after &&
        (after.daemonEpoch !== options.daemonEpoch ||
          after.sequence < first - 1 ||
          after.sequence > head)
      ) {
        await fail(message.id, {
          kind: 'failed_precondition',
          message: 'The cursor is no longer replayable; re-query state.',
          code: 'core.events.snapshotRequired',
          retry: { kind: 'after_refresh', resource: SUBSCRIBE },
        });
        continue;
      }
      const subscriptionId = `sub-${String(message.id)}`;
      const replay = options.journal.filter(
        (event) => !after || event.cursor.sequence > after.sequence,
      );
      const item = (event: CanopyEvent): Promise<void> =>
        connection.send({
          jsonrpc: '2.0',
          method: `${SUBSCRIBE}.item`,
          params: {
            subscriptionId,
            cursor: event.cursor,
            itemId: event.eventId,
            occurredAt: event.occurredAt,
            item: event,
          },
        });
      // Replay and listener registration share one turn, so no append is
      // missed or duplicated; one chain keeps live items after the replay.
      let delivery = reply(message.id, {
        subscriptionId,
        acceptedCursor: after,
      });
      for (const event of replay) delivery = delivery.then(() => item(event));
      delivery = delivery.catch(() => undefined);
      const unlisten = options.onAppend?.((event) => {
        delivery = delivery.then(() => item(event)).catch(() => undefined);
      });
      if (unlisten)
        connection.signal.addEventListener('abort', unlisten, { once: true });
      await delivery;
    } else {
      await connection.send({
        jsonrpc: '2.0',
        id: message.id,
        error: {
          code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
          message: `Unknown method ${message.method}.`,
        },
      });
    }
  }
}

function referenceJournal(
  daemonEpoch: string,
  count: number,
  firstSequence = 1,
): CanopyEvent[] {
  return Array.from({ length: count }, (_, index) => {
    const sequence = firstSequence + index;
    return {
      cursor: { daemonEpoch, sequence },
      eventId: `event-${sequence}`,
      name: 'core.chat.updated',
      scope: { chatId: 'chat-1' },
      occurredAt: '2026-10-06T12:00:00Z',
      payload: { sequence },
    };
  });
}

export interface ReferenceJournal {
  readonly daemonEpoch: string;
  serve(connection: CanopyFramedConnection): void;
  append(count: number): Promise<CanopyStreamCursor[]>;
  expire(): Promise<CanopyStreamCursor>;
  close(): Promise<void>;
}

/** A fresh live journal with its own epoch; appends reach open subscriptions. */
export function startReferenceJournal(): ReferenceJournal {
  const daemonEpoch = `reference:${randomUUID()}`;
  const journal: CanopyEvent[] = [];
  const listeners = new Set<(event: CanopyEvent) => void>();
  const connections = new Set<CanopyFramedConnection>();
  let head = 0;
  const append = (count: number): Promise<CanopyStreamCursor[]> => {
    const events = referenceJournal(daemonEpoch, count, head + 1);
    head += count;
    for (const event of events) {
      journal.push(event);
      listeners.forEach((listener) => listener(event));
    }
    return Promise.resolve(events.map(({ cursor }) => cursor));
  };
  return {
    daemonEpoch,
    serve(connection): void {
      connections.add(connection);
      void serveReferenceCore(connection, {
        daemonEpoch,
        journal,
        onAppend: (listener): (() => void) => {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      });
    },
    append,
    async expire(): Promise<CanopyStreamCursor> {
      // Retains only the newest of three appends, so the oldest is evicted.
      await append(3);
      journal.splice(0, journal.length - 1);
      return { daemonEpoch, sequence: head - 2 };
    },
    close(): Promise<void> {
      connections.forEach((connection) => connection.close());
      listeners.clear();
      return Promise.resolve();
    },
  };
}
