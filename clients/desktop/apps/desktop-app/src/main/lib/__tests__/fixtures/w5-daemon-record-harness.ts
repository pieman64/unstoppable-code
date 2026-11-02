import { duplexPair, type Duplex } from 'node:stream';
import { createCanopyClient } from '@canopy/core-client';
import {
  createRuntimeProfileGraph,
  type PlatformByteStream,
  type RuntimeProfileGraph,
} from '@canopy/core-runtime';
import { serveCanopyControlStream } from '@canopy/core-runtime/node';
import type { W5CommitLogHostPort } from '@canopy/core-runtime/node/w5/commit-log-file-store';
import {
  createW5RecordPortModule,
  W5_RECORD_PORT_GRANTS,
} from '@canopy/core-runtime/node/w5/record-port';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';
import type { W5RecordPortClient } from '../../w5-daemon-record-store';

/*
 * W6g (CAN-5498) test harness: the daemon side of the W5 record port, a
 * core-runtime authority over a real W5 commit-log host, served through the
 * daemon control-stream code to framed clients over an in-memory duplex.
 */

const AUTH = { secret: 'w5-record-port-test', dataRootHash: '0'.repeat(64) };

/** A platform byte stream over one end of an in-memory duplex. */
function byteStream(wire: Duplex): PlatformByteStream {
  const closed = new AbortController();
  wire.once('close', () => closed.abort());
  const chunks = wire[Symbol.asyncIterator]();
  return {
    signal: closed.signal,
    read: async (): Promise<Uint8Array | null> => {
      const next = await chunks.next();
      if (next.done) return null;
      const value: unknown = next.value;
      if (!(value instanceof Uint8Array)) throw new Error('Expected bytes');
      return value;
    },
    write: (bytes) =>
      new Promise<void>((resolve, reject) =>
        wire.write(bytes, (error) => (error ? reject(error) : resolve())),
      ),
    close: (): Promise<void> => {
      wire.destroy();
      return Promise.resolve();
    },
  };
}

export interface W5DaemonRecordHarness {
  readonly runtime: RuntimeProfileGraph;
  /** A new routed client, as another peer of the same daemon. */
  connect(clientInstanceId?: string): Promise<W5RecordPortClient>;
  close(): Promise<void>;
}

export async function startW5DaemonRecordHarness(options: {
  /** The daemon's W5 host; its owner shuts it down. */
  readonly host: W5CommitLogHostPort;
  /** The W5e slot: each caller's view of the host. */
  readonly portFor?: (caller: CanopyCallerDescriptor) => W5CommitLogHostPort;
}): Promise<W5DaemonRecordHarness> {
  const runtime = createRuntimeProfileGraph({
    profile: 'core',
    identity: { runtimeId: 'w6g-test', hostId: 'local', authorityId: 'w6g' },
    modules: [
      createW5RecordPortModule({
        host: options.host,
        ...(options.portFor && { portFor: options.portFor }),
      }),
    ],
    // As the daemon resolves every control-plane connection.
    principalFor: () => 'interface',
    phaseDeadlineMs: 5_000,
  });
  await runtime.start();
  const sessions: { close(): Promise<void> }[] = [];
  const clients: W5RecordPortClient[] = [];
  return {
    runtime,
    async connect(
      clientInstanceId = 'electron-main',
    ): Promise<W5RecordPortClient> {
      const [clientWire, serverWire] = duplexPair();
      sessions.push(
        serveCanopyControlStream({
          stream: byteStream(serverWire),
          auth: AUTH,
          dispatcher: runtime.dispatcher,
          operations: runtime.operations,
          caller: {
            principalId: 'local-user',
            clientInstanceId,
            authorityId: 'w6g',
            interfaceKind: 'desktop',
            grants: ['core.runtime.read', ...W5_RECORD_PORT_GRANTS],
          },
          obligations: { hold: () => (): void => undefined },
          buildVersion: 'test',
        }),
      );
      const connection = await createCanopyFramedConnection(clientWire, {
        role: 'client',
        auth: AUTH,
      });
      const client = await createCanopyClient({
        connection,
        clientName: 'w6g-test',
        clientVersion: '1',
        definitions: {
          queries: CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
          instructions: CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
          streams: {},
        },
      });
      clients.push(client);
      return client;
    },
    async close(): Promise<void> {
      await Promise.all(clients.splice(0).map((client) => client.close()));
      await Promise.all(sessions.splice(0).map((session) => session.close()));
      await runtime.shutdown('test');
    },
  };
}
