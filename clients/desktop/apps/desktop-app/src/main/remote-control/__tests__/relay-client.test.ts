import type {
  DeviceRelayDeviceInfo,
  DeviceRelayServerMessage,
  DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import {
  decodeDeviceRelayDataFrame,
  deviceRelaySubprotocols,
  encodeDeviceRelayDataFrame,
} from '@canopy/protocol/device-relay';
import {
  reconnectDelayMs,
  RelayClient,
  type RelaySocket,
  type RelaySocketHandlers,
} from '../transport/relay-client';
import { flushRelay } from './in-memory-relay';

const SELF: DeviceRelayDeviceInfo = {
  deviceId: 'AAAAAAAAAAAAAAAAAAAAAA',
  name: 'laptop',
  platform: 'darwin',
  appVersion: '1.0.0',
  publicKey: 'A'.repeat(43),
  acceptsRemoteControl: false,
};
const PEER: DeviceRelayDeviceInfo = {
  ...SELF,
  deviceId: 'BBBBBBBBBBBBBBBBBBBBBB',
  name: 'desktop',
  acceptsRemoteControl: true,
};

class FakeSocket implements RelaySocket {
  bufferedAmount = 0;
  readonly sent: Array<string | Uint8Array> = [];
  closed = false;
  constructor(
    readonly url: string,
    readonly protocols: string[],
    readonly handlers: RelaySocketHandlers,
  ) {}
  transmit(data: string | Uint8Array<ArrayBuffer>): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  server(message: DeviceRelayServerMessage): void {
    this.handlers.onText(JSON.stringify(message));
  }
}

function createClient(
  options: {
    pingIntervalMs?: number;
    maxReconnectDelayMs?: number;
    readyTimeoutMs?: number;
    maxQueuedBytes?: number;
  } = {},
): {
  client: RelayClient;
  sockets: FakeSocket[];
  tokens: () => number;
} {
  const sockets: FakeSocket[] = [];
  let tokens = 0;
  const client = new RelayClient({
    fetchToken: (): Promise<DeviceRelayTokenResponse> => {
      tokens += 1;
      return Promise.resolve({
        token: `token-${tokens}`,
        relayUrl: 'wss://relay.example.test',
        expiresAt: new Date().toISOString(),
      });
    },
    deviceInfo: (): DeviceRelayDeviceInfo => SELF,
    createSocket: (
      url: string,
      protocols: string[],
      handlers: RelaySocketHandlers,
    ): RelaySocket => {
      const socket = new FakeSocket(url, protocols, handlers);
      sockets.push(socket);
      return socket;
    },
    minReconnectDelayMs: 1,
    maxReconnectDelayMs: options.maxReconnectDelayMs ?? 2,
    pingIntervalMs: options.pingIntervalMs,
    readyTimeoutMs: options.readyTimeoutMs,
    maxQueuedBytes: options.maxQueuedBytes,
  });
  return { client, sockets, tokens: () => tokens };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  expect(condition()).toBe(true);
}

/** Opens `socket` and lets the relay accept it with `peers`. */
function accept(
  socket: FakeSocket | undefined,
  peers: DeviceRelayDeviceInfo[],
): FakeSocket {
  if (!socket) throw new Error('No socket.');
  socket.handlers.onOpen();
  socket.server({ type: 'ready', deviceId: SELF.deviceId, peers });
  return socket;
}

describe('RelayClient', () => {
  it('authenticates, tracks peers and routes frames', async () => {
    const { client, sockets } = createClient();
    client.start();
    await flushRelay();
    const socket = sockets[0];
    if (!socket) throw new Error('No socket.');
    // The token travels in the upgrade, never in a message.
    expect(socket.url).toBe('wss://relay.example.test/v2/connect');
    expect(socket.protocols).toEqual(deviceRelaySubprotocols('token-1'));
    socket.handlers.onOpen();
    expect(JSON.parse(String(socket.sent[0]))).toEqual({
      type: 'hello',
      device: SELF,
    });
    expect(client.sendFrame(PEER.deviceId, new Uint8Array([1]))).toBe(false);
    socket.server({ type: 'ready', deviceId: SELF.deviceId, peers: [PEER] });
    expect(client.connectionStatus).toBe('connected');
    expect(client.peers).toEqual([PEER]);

    expect(client.sendFrame(PEER.deviceId, new Uint8Array([7]))).toBe(true);
    const outgoing = socket.sent[1];
    if (!(outgoing instanceof Uint8Array)) throw new Error('Expected binary.');
    expect(decodeDeviceRelayDataFrame(outgoing)?.deviceId).toBe(PEER.deviceId);

    const frames: Array<[string, number[]]> = [];
    client.onFrame((peer, payload) => frames.push([peer, Array.from(payload)]));
    socket.handlers.onBinary(
      encodeDeviceRelayDataFrame(PEER.deviceId, new Uint8Array([9, 9])),
    );
    expect(frames).toEqual([[PEER.deviceId, [9, 9]]]);

    const offline: string[] = [];
    client.onPeerOffline((peer) => offline.push(peer));
    socket.server({ type: 'peer.offline', deviceId: PEER.deviceId });
    expect(offline).toEqual([PEER.deviceId]);
    expect(client.peers).toEqual([]);
    client.stop();
  });

  it('reconnects with a fresh token after the socket closes', async () => {
    const { client, sockets } = createClient();
    client.start();
    await flushRelay();
    sockets[0]?.handlers.onOpen();
    sockets[0]?.server({
      type: 'ready',
      deviceId: SELF.deviceId,
      peers: [PEER],
    });
    sockets[0]?.handlers.onClose();
    expect(client.peers).toEqual([]);
    for (let attempt = 0; attempt < 50 && sockets.length < 2; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    expect(sockets).toHaveLength(2);
    client.stop();
  });

  it('reconnects at once on request, reporting its peers offline first', async () => {
    const { client, sockets, tokens } = createClient({
      maxReconnectDelayMs: 60_000,
    });
    client.start();
    await flushRelay();
    const first = accept(sockets[0], [PEER]);
    const offline: string[] = [];
    client.onPeerOffline((peer) => offline.push(peer));

    client.reconnectNow();
    expect(first.closed).toBe(true);
    expect(offline).toEqual([PEER.deviceId]);
    expect(client.connectionStatus).toBe('connecting');
    await flushRelay();
    expect(sockets).toHaveLength(2);
    expect(tokens()).toBe(2);
    // The old socket's late close does not start a third connection.
    first.handlers.onClose();
    await flushRelay();
    expect(sockets).toHaveLength(2);
    accept(sockets[1], [PEER]);
    expect(client.connectionStatus).toBe('connected');
    client.stop();
  });

  it('notices a socket that went silent and reconnects', async () => {
    const { client, sockets } = createClient({ pingIntervalMs: 5 });
    client.start();
    await flushRelay();
    accept(sockets[0], []);
    // No reply to three pings in a row: the socket is dead.
    await waitFor(() => sockets.length === 2);
    expect(sockets[0]?.closed).toBe(true);
    client.stop();
  });

  it('backs off when another connection takes its place', async () => {
    const { client, sockets } = createClient({ maxReconnectDelayMs: 300 });
    client.start();
    await flushRelay();
    const socket = accept(sockets[0], []);
    socket.server({
      type: 'error',
      code: 'replaced',
      message: 'Another connection for this device replaced this one.',
    });
    socket.handlers.onClose();
    await new Promise((resolve) => setTimeout(resolve, 60));
    // The maximum backoff, not the minimum, so two holders of one identity
    // do not take turns evicting each other.
    expect(sockets).toHaveLength(1);
    await waitFor(() => sockets.length === 2);
    client.stop();
  });

  it('reaches a relay that is back within seconds after a short outage', () => {
    const upper = (attempt: number): number =>
      reconnectDelayMs(attempt, 500, 30_000, () => 1);
    // Five failed attempts wait at most about 6.6 s in total, so a relay
    // back after a few seconds is reached within a few seconds.
    const firstFive = [0, 1, 2, 3, 4].reduce(
      (total, attempt) => total + upper(attempt),
      0,
    );
    expect(firstFive).toBeLessThan(7_000);
    expect(upper(20)).toBe(30_000);
    // Jitter spreads each wait over its upper half.
    expect(reconnectDelayMs(2, 500, 30_000, () => 0)).toBe(upper(2) / 2);
  });

  it('gives up on a relay that opens the socket but never says ready', async () => {
    const { client, sockets } = createClient({ readyTimeoutMs: 20 });
    client.start();
    await flushRelay();
    sockets[0]?.handlers.onOpen();
    await waitFor(() => sockets.length === 2);
    expect(sockets[0]?.closed).toBe(true);
    client.stop();
  });

  it('reports its peers offline when stopped', async () => {
    const { client, sockets } = createClient();
    client.start();
    await flushRelay();
    accept(sockets[0], [PEER]);
    const offline: string[] = [];
    client.onPeerOffline((peer) => offline.push(peer));
    client.stop();
    expect(offline).toEqual([PEER.deviceId]);
    expect(client.peers).toEqual([]);
  });

  it('queues frames while the socket is backed up and sends them in order', async () => {
    const { client, sockets } = createClient();
    client.start();
    await flushRelay();
    const socket = accept(sockets[0], [PEER]);
    const sentBefore = socket.sent.length;
    socket.bufferedAmount = 64 * 1024 * 1024;
    for (let index = 0; index < 5; index += 1) {
      expect(client.sendFrame(PEER.deviceId, new Uint8Array([index]))).toBe(
        true,
      );
    }
    // Nothing goes to a backed-up socket; nothing is dropped either.
    expect(socket.sent.length).toBe(sentBefore);
    socket.bufferedAmount = 0;
    await waitFor(() => socket.sent.length === sentBefore + 5);
    const payloads = socket.sent.slice(sentBefore).map((data) => {
      if (!(data instanceof Uint8Array)) throw new Error('Expected binary.');
      return Array.from(decodeDeviceRelayDataFrame(data)?.payload ?? []);
    });
    expect(payloads).toEqual([[0], [1], [2], [3], [4]]);
    client.stop();
  });

  it('refuses frames once its own queue is full', async () => {
    const { client, sockets } = createClient({ maxQueuedBytes: 100 });
    client.start();
    await flushRelay();
    const socket = accept(sockets[0], [PEER]);
    socket.bufferedAmount = 64 * 1024 * 1024;
    expect(client.sendFrame(PEER.deviceId, new Uint8Array(40))).toBe(true);
    expect(client.sendFrame(PEER.deviceId, new Uint8Array(40))).toBe(false);
    client.stop();
  });

  it('gives up on a socket whose upgrade never completes', async () => {
    const { client, sockets } = createClient({ readyTimeoutMs: 20 });
    client.start();
    await flushRelay();
    // The socket never opens.
    await waitFor(() => sockets.length === 2);
    expect(sockets[0]?.closed).toBe(true);
    client.stop();
  });
});
