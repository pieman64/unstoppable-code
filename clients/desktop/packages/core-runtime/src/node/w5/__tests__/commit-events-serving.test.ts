import { join } from 'node:path';
import {
  createInMemoryFramedPair,
  runCanopyJournalConformance,
  type CanopyFramedConnection,
  type CanopyJournalConformanceInstance,
  type CanopyJournalConformanceTarget,
} from '@canopy/core-transport';
import {
  CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES,
  encodeCanopyError,
  type CanopyCallerDescriptor,
  type CanopyJsonRpcMessage,
  type CanopyStreamCursor,
} from '@canopy/protocol/canopy-core';
import { createCoreEventsModule } from '../../../kernel/core-events-module';
import {
  createRuntimeProfileGraph,
  type RuntimeProfileGraph,
} from '../../../kernel/runtime-profile-graph';
import { CanopyOperationError } from '../../../runtime/errors';
import { createW5CommitEventSource } from '../commit-events';
import type { W5CommitLogHostPort } from '../commit-log-file-store';

const ROOT = join('/data', 'workspaces');
const caller: CanopyCallerDescriptor = {
  principalId: 'local-user',
  clientInstanceId: 'framed-events',
  authorityId: 'authority',
  interfaceKind: 'desktop',
  grants: ['core.runtime.read', 'core.events.read'],
};

/** A host whose every commit applies, in call order. */
function appliedHost(): W5CommitLogHostPort {
  let commitId = 0;
  const unused = (): Promise<never> => Promise.reject(new Error('unused'));
  return {
    root: ROOT,
    recoveryReport: unused,
    commit: (request) => {
      commitId += 1;
      return Promise.resolve({
        status: 'applied',
        commitId,
        revisions: Object.fromEntries(
          request.advance.map((resource) => [
            resource.kind === 'workspaces'
              ? 'workspaces'
              : `${resource.kind}:${resource.workspaceId}`,
            commitId,
          ]),
        ),
      });
    },
    lookupReceipt: unused,
    reserve: unused,
    updateReservationDiagnostics: unused,
    releaseReservation: unused,
    markReservationRecoveryRequired: unused,
    revision: unused,
    capture: unused,
  };
}

// Test projection of the two event operations onto one framed connection.
async function serveEvents(
  graph: RuntimeProfileGraph,
  server: CanopyFramedConnection,
): Promise<void> {
  const handles = new Set<{ close(): void }>();
  let delivery = Promise.resolve();
  const send = (message: CanopyJsonRpcMessage): Promise<void> => {
    delivery = delivery
      .then(() => server.send(message))
      .catch(() => server.close());
    return delivery;
  };
  try {
    for (;;) {
      const message = await server.receive().catch(() => null);
      if (!message) break;
      if (!('method' in message) || !('id' in message)) continue;
      const { id, method, params } = message;
      try {
        if (method === 'core.events.subscribe') {
          const handle = await graph.dispatcher.openStream(method, params, {
            caller,
          });
          handles.add(handle);
          const { subscriptionId } = handle.openResult;
          await send({ jsonrpc: '2.0', id, result: handle.openResult });
          handle.onFrame((frame) => {
            void send({
              jsonrpc: '2.0',
              method: `${method}.${frame.kind}`,
              params:
                frame.kind === 'item'
                  ? {
                      subscriptionId,
                      cursor: frame.cursor,
                      itemId: `${frame.cursor.daemonEpoch}#${frame.cursor.sequence}`,
                      occurredAt: new Date().toISOString(),
                      item: frame.item,
                    }
                  : {
                      subscriptionId,
                      cursor: frame.cursor,
                      outcome: frame.outcome,
                      error: frame.error,
                    },
            });
          });
        } else if (method === 'core.events.ack') {
          const result = await graph.dispatcher.instruction(method, params, {
            caller,
          });
          await send({ jsonrpc: '2.0', id, result });
        } else {
          await send({
            jsonrpc: '2.0',
            id,
            error: {
              code: CANOPY_JSON_RPC_PROTOCOL_ERROR_CODES.methodNotFound,
              message: `Unknown method ${method}.`,
            },
          });
        }
      } catch (error) {
        await send({
          jsonrpc: '2.0',
          id,
          error: encodeCanopyError(
            error instanceof CanopyOperationError
              ? error.payload
              : {
                  kind: 'internal',
                  message: 'Failed.',
                  retry: { kind: 'never' },
                },
          ),
        });
      }
    }
  } finally {
    handles.forEach((handle) => handle.close());
  }
}

const MAX_ENTRIES = 8;

const target: CanopyJournalConformanceTarget = {
  name: 'daemon W5 commit events',
  method: 'core.events.subscribe',
  params: { families: ['core.workspace'] },
  async start(): Promise<CanopyJournalConformanceInstance> {
    const daemonEpoch = `runtime:${crypto.randomUUID()}`;
    const events = createW5CommitEventSource({
      host: appliedHost(),
      epoch: daemonEpoch,
      maxEntries: MAX_ENTRIES,
    });
    const graph = createRuntimeProfileGraph({
      profile: 'core',
      daemonEpoch,
      modules: [
        createCoreEventsModule({
          journal: events.journal,
          families: ['core.workspace'],
        }),
      ],
      identity: { runtimeId: 'runtime', hostId: 'host', authorityId: 'a' },
      principalFor: () => 'interface',
      phaseDeadlineMs: 1000,
      shutdownTimeoutMs: 50,
    });
    await graph.start();
    const port = events.port();
    const append = async (count: number): Promise<CanopyStreamCursor[]> => {
      const cursors: CanopyStreamCursor[] = [];
      for (let index = 0; index < count; index += 1) {
        await port.commit({
          operation: 'test.write',
          advance: [{ kind: 'worktrees', workspaceId: 'ws-1' }],
          files: [],
          outcome: null,
        });
        const head = events.journal.head();
        if (!head) throw new Error('No journal entry was appended.');
        cursors.push(head);
      }
      return cursors;
    };
    return {
      daemonEpoch,
      serve: (server): void => void serveEvents(graph, server),
      append,
      async expire(): Promise<CanopyStreamCursor> {
        const [first] = await append(1);
        await append(MAX_ENTRIES + 1);
        if (!first) throw new Error('No cursor.');
        return first;
      },
      close: async (): Promise<void> => {
        await graph.shutdown('test');
      },
    };
  },
};

runCanopyJournalConformance({
  name: 'in-memory framing',
  createPair: createInMemoryFramedPair,
  target,
  describe,
  it,
});
