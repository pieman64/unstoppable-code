import { createServer, type Server } from 'node:net';
import { duplexPair, type Duplex } from 'node:stream';
import { createCanopyClient, type CanopyClient } from '@canopy/core-client';
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
  W5_RECORD_PORT_OPERATIONS,
} from '@canopy/core-runtime/node/w5/record-port';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  type CanopyCallerDescriptor,
} from '@canopy/protocol/canopy-core';

/*
 * W6g (CAN-5498) test harness: the daemon side of the W5 record port, a
 * core-runtime authority over a real W5 commit-log host, served through the
 * daemon control-stream code to framed clients over an in-memory duplex.
 * Shared by the Electron and CLI suites (W6h0, CAN-5554).
 */

export const W5_RECORD_TEST_AUTH = {
  secret: 'w5-record-port-test',
  dataRootHash: '0'.repeat(64),
};

/** The record-port client the Electron daemon-backed store takes. */
export type W5RecordPortClient = CanopyClient<
  typeof CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
  typeof CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  Record<never, never>
>;

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
  /**
   * A framed connection served as the daemon serves an interface peer: it may
   * take a client lease, and the record port answers only while it holds one.
   */
  serve(peer: {
    readonly clientInstanceId: string;
    readonly interfaceKind: CanopyCallerDescriptor['interfaceKind'];
    readonly principalId?: string;
  }): Promise<CanopyFramedConnection>;
  /** A subprocess peer on the same qualification runtime, without a production daemon. */
  listen(path: string): Promise<void>;
  close(): Promise<void>;
}

export async function startW5DaemonRecordHarness(options: {
  /**
   * The daemon's W5 host; its owner shuts it down. Absent, the daemon serves
   * no record port, as one without a W5 host.
   */
  readonly host?: W5CommitLogHostPort;
  /** The W5e slot: each caller's view of the host. */
  readonly portFor?: (caller: CanopyCallerDescriptor) => W5CommitLogHostPort;
  /** False: a reached daemon that serves no W5 records (CAN-5542 Q2). */
  readonly serveRecordPort?: boolean;
}): Promise<W5DaemonRecordHarness> {
  const { host, portFor } = options;
  const runtime = createRuntimeProfileGraph({
    profile: 'core',
    identity: { runtimeId: 'w6g-test', hostId: 'local', authorityId: 'w6g' },
    modules:
      host && options.serveRecordPort !== false
        ? [createW5RecordPortModule({ host, ...(portFor && { portFor }) })]
        : [],
    // As the daemon resolves every control-plane connection.
    principalFor: () => 'interface',
    phaseDeadlineMs: 5_000,
  });
  await runtime.start();
  const sessions: { close(): Promise<void> }[] = [];
  const clients: W5RecordPortClient[] = [];
  const servers: Server[] = [];
  const open = async (
    caller: CanopyCallerDescriptor,
    leaseBoundOperations?: readonly string[],
  ): Promise<CanopyFramedConnection> => {
    const [clientWire, serverWire] = duplexPair();
    sessions.push(
      serveCanopyControlStream({
        stream: byteStream(serverWire),
        auth: W5_RECORD_TEST_AUTH,
        dispatcher: runtime.dispatcher,
        operations: runtime.operations,
        caller,
        obligations: { hold: () => (): void => undefined },
        buildVersion: 'test',
        ...(leaseBoundOperations && { leaseBoundOperations }),
      }),
    );
    return createCanopyFramedConnection(clientWire, {
      role: 'client',
      auth: W5_RECORD_TEST_AUTH,
    });
  };
  return {
    runtime,
    async connect(
      clientInstanceId = 'electron-main',
    ): Promise<W5RecordPortClient> {
      const connection = await open({
        principalId: 'local-user',
        clientInstanceId,
        authorityId: 'w6g',
        interfaceKind: 'desktop',
        grants: ['core.runtime.read', ...W5_RECORD_PORT_GRANTS],
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
    serve: (peer) =>
      // The daemon's grants and lease binding for any same-user peer.
      open(
        {
          principalId: peer.principalId ?? 'local-user',
          clientInstanceId: peer.clientInstanceId,
          authorityId: 'w6g',
          interfaceKind: peer.interfaceKind,
          grants: [
            'core.runtime.read',
            'core.client.manage',
            ...W5_RECORD_PORT_GRANTS,
          ],
        },
        W5_RECORD_PORT_OPERATIONS,
      ),
    async listen(path: string): Promise<void> {
      const server = createServer((socket) => {
        sessions.push(
          serveCanopyControlStream({
            stream: byteStream(socket),
            auth: W5_RECORD_TEST_AUTH,
            dispatcher: runtime.dispatcher,
            operations: runtime.operations,
            caller: {
              principalId: 'local-user',
              clientInstanceId: 'cli-subprocess',
              authorityId: 'w6g',
              interfaceKind: 'cli',
              grants: [
                'core.runtime.read',
                'core.client.manage',
                ...W5_RECORD_PORT_GRANTS,
              ],
            },
            obligations: { hold: () => (): void => undefined },
            buildVersion: 'test',
            leaseBoundOperations: W5_RECORD_PORT_OPERATIONS,
          }),
        );
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(path, resolve);
      });
    },
    async close(): Promise<void> {
      await Promise.all(clients.splice(0).map((client) => client.close()));
      await Promise.all(sessions.splice(0).map((session) => session.close()));
      await Promise.all(
        servers
          .splice(0)
          .map(
            (server) =>
              new Promise<void>((resolve) => server.close(() => resolve())),
          ),
      );
      await runtime.shutdown('test');
    },
  };
}
