import { duplexPair } from 'node:stream';
import {
  createCanopyFramedConnection,
  encodeCanopyJsonFrame,
} from '@canopy/core-transport';
import type { CanopyFramedConnection } from '@canopy/core-transport/types';

/**
 * The L0 framed pair plus raw writes into the client's receiver. The
 * in-memory pair's `clientWire` writes toward the server, so it cannot
 * inject replies the client reads.
 */
export interface RawWirePair {
  readonly client: CanopyFramedConnection;
  readonly server: CanopyFramedConnection;
  /** Bytes as-is: split, oversized, truncated, or corrupt frames. */
  write(bytes: Uint8Array): void;
  /** Frames any JSON object, skipping envelope and frame-size validation. */
  writeFrame(value: object): void;
  /** Ends the core's side: the client reads EOF after the bytes already written. */
  end(): void;
  close(): Promise<void>;
}

const AUTH = { secret: 'raw-wire-secret', dataRootHash: '0'.repeat(64) };

export async function createRawWirePair(
  options: { maxFrameBytes?: number } = {},
): Promise<RawWirePair> {
  const [clientSide, serverSide] = duplexPair();
  const endBoth = (error: unknown): never => {
    clientSide.end();
    serverSide.end();
    throw error;
  };
  const [client, server] = await Promise.allSettled([
    createCanopyFramedConnection(clientSide, {
      role: 'client',
      auth: AUTH,
      maxFrameBytes: options.maxFrameBytes,
    }).catch(endBoth),
    createCanopyFramedConnection(serverSide, {
      role: 'server',
      auth: AUTH,
      maxFrameBytes: options.maxFrameBytes,
    }).catch(endBoth),
  ]);
  if (client.status === 'rejected') {
    if (server.status === 'fulfilled') server.value.close();
    throw client.reason;
  }
  if (server.status === 'rejected') {
    client.value.close();
    throw server.reason;
  }
  return {
    client: client.value,
    server: server.value,
    write: (bytes) => void serverSide.write(bytes),
    writeFrame: (value) =>
      void serverSide.write(
        encodeCanopyJsonFrame(value, Number.MAX_SAFE_INTEGER),
      ),
    end: () => void serverSide.end(),
    close: (): Promise<void> => {
      client.value.close();
      server.value.close();
      return Promise.resolve();
    },
  };
}
