import { duplexPair } from 'node:stream';

import { CanopyTransportError } from './codec';
import {
  createCanopyFramedConnection,
  type CanopyFramedConnectionOptions,
} from './connection';
import type { CanopyFramedConnection } from './types';

export interface CanopyInMemoryFramedPairOptions {
  readonly secret?: string;
  readonly dataRootHash?: string;
  /** Overrides the client's secret, e.g. to exercise authentication failure. */
  readonly clientSecret?: string;
  /** Overrides the client's expected data root, e.g. to exercise a foreign daemon. */
  readonly clientDataRootHash?: string;
  readonly maxFrameBytes?: number;
  readonly maxBufferedMessages?: number;
  readonly maxBufferedBytes?: number;
}

export interface CanopyFramedPair {
  readonly client: CanopyFramedConnection;
  readonly server: CanopyFramedConnection;
  /** Raw client-side byte writer, for partial and malformed frame cases. */
  readonly clientWire: { write(chunk: Uint8Array): unknown };
}

const DEFAULT_DATA_ROOT_HASH = '0'.repeat(64);

/**
 * Two connected ends whose bytes pass through the real codec and handshake.
 * Rejects with the client's error when authentication fails.
 */
export async function createInMemoryFramedPair(
  options: CanopyInMemoryFramedPairOptions = {},
): Promise<CanopyFramedPair> {
  const [clientWire, serverWire] = duplexPair();
  const secret = options.secret ?? 'in-memory-secret';
  const dataRootHash = options.dataRootHash ?? DEFAULT_DATA_ROOT_HASH;
  const shared: Omit<CanopyFramedConnectionOptions, 'role' | 'auth'> = {
    maxFrameBytes: options.maxFrameBytes,
    maxBufferedMessages: options.maxBufferedMessages,
    maxBufferedBytes: options.maxBufferedBytes,
  };
  // A side that fails, even before any I/O, ends both wires so the other
  // side's handshake fails now rather than at its timeout.
  const endBoth = (error: unknown): never => {
    clientWire.end();
    serverWire.end();
    throw error;
  };
  const [client, server] = await Promise.allSettled([
    createCanopyFramedConnection(clientWire, {
      ...shared,
      role: 'client',
      auth: {
        secret: options.clientSecret ?? secret,
        dataRootHash: options.clientDataRootHash ?? dataRootHash,
      },
    }).catch(endBoth),
    createCanopyFramedConnection(serverWire, {
      ...shared,
      role: 'server',
      auth: { secret, dataRootHash },
    }).catch(endBoth),
  ]);
  if (client.status === 'rejected') {
    if (server.status === 'fulfilled') server.value.close();
    throw toTransportError(client.reason);
  }
  if (server.status === 'rejected') {
    client.value.close();
    throw toTransportError(server.reason);
  }
  return { client: client.value, server: server.value, clientWire };
}

function toTransportError(reason: unknown): CanopyTransportError {
  return reason instanceof CanopyTransportError
    ? reason
    : new CanopyTransportError({
        kind: 'internal',
        message: 'In-memory pair failed.',
        retry: { kind: 'never' },
      });
}
