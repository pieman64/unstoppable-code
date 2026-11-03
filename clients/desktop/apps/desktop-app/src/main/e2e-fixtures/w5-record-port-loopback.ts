import { duplexPair, type Duplex } from 'node:stream';
import { createCanopyClient } from '@canopy/core-client';
import {
  createRuntimeProfileGraph,
  type PlatformByteStream,
  type RuntimeProfileGraph,
} from '@canopy/core-runtime';
import { serveCanopyControlStream } from '@canopy/core-runtime/node';
import {
  createW5RecordPortModule,
  W5_RECORD_PORT_GRANTS,
  type W5RecordAuthorityOptions,
} from '@canopy/core-runtime/node/w5/record-port';
import { createCanopyFramedConnection } from '@canopy/core-transport';
import {
  CORE_WORKSPACE_RECORDS_INSTRUCTION_DEFINITIONS,
  CORE_WORKSPACE_RECORDS_QUERY_DEFINITIONS,
} from '@canopy/protocol/canopy-core';
import type { W5RecordPortClient } from '../lib/w5-daemon-record-store';

/*
 * W6g (CAN-5498) loopback: the daemon side of the W5 record port, a
 * core-runtime authority over a real W5 commit-log host, served through the
 * daemon control-stream code to framed clients over an in-memory duplex. It
 * runs in the caller's process with no socket. The E2E-only performance arm
 * (CAN-5532) composes it; production never does. The shared W6g test harness
 * stays separate: desktop-shared permits these client imports only in tests.
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

export interface W5RecordPortLoopback {
  readonly runtime: RuntimeProfileGraph;
  /** A new routed client, as another peer of the same daemon. */
  connect(clientInstanceId?: string): Promise<W5RecordPortClient>;
  close(): Promise<void>;
}

/** Starts the record-port authority built from `authority`. */
export async function startW5RecordPortLoopback(
  authority: W5RecordAuthorityOptions,
): Promise<W5RecordPortLoopback> {
  const runtime = createRuntimeProfileGraph({
    profile: 'core',
    identity: { runtimeId: 'w6g-test', hostId: 'local', authorityId: 'w6g' },
    modules: [createW5RecordPortModule(authority)],
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
