import {
  DEVICE_RELAY_CONNECT_PATH,
  decodeDeviceRelayDataFrame,
  deviceRelaySubprotocols,
  encodeDeviceRelayDataFrame,
  parseDeviceRelayServerMessage,
  type DeviceRelayClientMessage,
  type DeviceRelayDeviceInfo,
  type DeviceRelayErrorCode,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import { MAX_MESSAGE_BYTES } from './message-codec';
import type { RelayTransport } from './session-manager';

/** The relay connection as the remote-control service uses it. */
export interface RemoteRelay extends RelayTransport {
  readonly connectionStatus: RelayConnectionStatus;
  readonly peers: ReadonlyArray<DeviceRelayDeviceInfo>;
  /**
   * Features the relay advertised in its last `ready`, empty while not
   * connected. `device-kind` means presence kinds are token-authenticated.
   */
  readonly features: ReadonlyArray<string>;
  start(): void;
  stop(): void;
  announce(): void;
  /**
   * Drops the current connection and connects again at once, for when the
   * network may have changed under it (wake from sleep, network change).
   */
  reconnectNow(): void;
}

/** The socket surface the relay client needs; tests supply a fake. */
export interface RelaySocket {
  readonly bufferedAmount: number;
  transmit(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

export interface RelaySocketHandlers {
  onOpen(): void;
  onText(text: string): void;
  onBinary(bytes: Uint8Array): void;
  onClose(): void;
}

/**
 * Opens a socket to `url` offering `protocols`, which carry the relay token
 * (the relay authenticates before the upgrade).
 */
export type RelaySocketFactory = (
  url: string,
  protocols: string[],
  handlers: RelaySocketHandlers,
) => RelaySocket;

export const createWebSocketRelaySocket: RelaySocketFactory = (
  url,
  protocols,
  handlers,
) => {
  const socket = new WebSocket(url, protocols);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('open', () => handlers.onOpen());
  socket.addEventListener('message', (event: MessageEvent<unknown>) => {
    const { data } = event;
    if (typeof data === 'string') {
      handlers.onText(data);
    } else if (data instanceof ArrayBuffer) {
      handlers.onBinary(new Uint8Array(data));
    }
  });
  socket.addEventListener('close', () => handlers.onClose());
  socket.addEventListener('error', () => {
    // A close event always follows; reconnect is driven from there.
  });
  return {
    get bufferedAmount(): number {
      return socket.bufferedAmount;
    },
    transmit: (data) => socket.send(data),
    close: () => socket.close(),
  };
};

export type RelayConnectionStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable';

export interface RelayClientOptions {
  fetchToken: () => Promise<DeviceRelayTokenResponse>;
  deviceInfo: () => DeviceRelayDeviceInfo;
  createSocket?: RelaySocketFactory;
  onStatusChange?: (status: RelayConnectionStatus, detail?: string) => void;
  onPeersChange?: (peers: ReadonlyArray<DeviceRelayDeviceInfo>) => void;
  /** Backoff bounds, overridable for tests. */
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
  /** How long an open socket may wait for the relay's `ready`. */
  readyTimeoutMs?: number;
  /** Frames this client may hold while the socket is backed up. */
  maxQueuedBytes?: number;
}

/**
 * Bytes the socket may hold before frames wait in this client's own queue,
 * which drains as the socket does. Frames are never sent out of order or
 * dropped for backpressure: the encrypted sessions do not tolerate gaps.
 */
const SOCKET_HIGH_WATER_BYTES = 8 * 1024 * 1024;
/** Room for two of the largest messages in flight. */
const DEFAULT_MAX_QUEUED_BYTES = 2 * MAX_MESSAGE_BYTES;
const DRAIN_POLL_MS = 10;
const DEFAULT_PING_INTERVAL_MS = 10_000;
const DEFAULT_READY_TIMEOUT_MS = 15_000;
const DEFAULT_MIN_RECONNECT_DELAY_MS = 500;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
/**
 * Backoff growth per failed attempt. Gentler than doubling, so a relay that
 * is back after a few seconds (a deploy, a restart) is reached within a few
 * seconds too, while a long outage still settles at the maximum.
 */
const RECONNECT_BACKOFF_FACTOR = 1.5;
/** Failed attempts after which the relay is reported unavailable. */
const ATTEMPTS_BEFORE_UNAVAILABLE = 5;

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential with
 * factor 1.5 between `min` and `max`, with jitter over its upper half so
 * devices that lost the relay together do not return in step.
 */
export function reconnectDelayMs(
  attempt: number,
  min: number,
  max: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(max, min * RECONNECT_BACKOFF_FACTOR ** attempt);
  return base / 2 + random() * (base / 2);
}
/** Pings without any reply after which the socket counts as dead. */
const MISSED_PINGS_BEFORE_RECONNECT = 3;

function relayConnectUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.pathname = DEVICE_RELAY_CONNECT_PATH;
  return url.toString();
}

/**
 * Holds this device's outbound connection to the device relay: token
 * refresh, authentication, presence of the account's other devices, frame
 * routing, keepalive and reconnect with jittered backoff.
 *
 * Every connection fetches a fresh token. Whatever ends a connection (a
 * refused upgrade, a relay restart, a dead network noticed by missed pings,
 * a relay error) takes the same path: peers are reported offline, so the
 * sessions over them end, and the client reconnects with backoff.
 */
export class RelayClient implements RelayTransport {
  private socket: RelaySocket | null = null;
  private status: RelayConnectionStatus = 'stopped';
  private readonly peerMap = new Map<string, DeviceRelayDeviceInfo>();
  private relayFeatures: ReadonlyArray<string> = [];
  private readonly frameListeners = new Set<
    (peerDeviceId: string, payload: Buffer) => void
  >();
  private readonly offlineListeners = new Set<(peerDeviceId: string) => void>();
  private readonly undeliverableListeners = new Set<
    (peerDeviceId: string) => void
  >();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly outbound: Uint8Array<ArrayBuffer>[] = [];
  private outboundBytes = 0;
  private attempt = 0;
  private generation = 0;
  private authenticated = false;
  /**
   * The relay said another connection took this device's place: wait the
   * longest backoff, so two holders of one identity do not take turns.
   */
  private contested = false;
  private lastInboundAt = 0;

  constructor(private readonly options: RelayClientOptions) {}

  get connectionStatus(): RelayConnectionStatus {
    return this.status;
  }

  get peers(): ReadonlyArray<DeviceRelayDeviceInfo> {
    return Array.from(this.peerMap.values());
  }

  get features(): ReadonlyArray<string> {
    return this.relayFeatures;
  }

  getPeer(deviceId: string): DeviceRelayDeviceInfo | null {
    return this.peerMap.get(deviceId) ?? null;
  }

  start(): void {
    if (this.status !== 'stopped') return;
    this.setStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.dropPeers();
    this.attempt = 0;
    this.setStatus('stopped');
  }

  reconnectNow(): void {
    if (this.status === 'stopped') return;
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.dropPeers();
    this.attempt = 0;
    this.setStatus('connecting');
    void this.connect();
  }

  /** Re-announces this device after a settings change. */
  announce(): void {
    if (!this.authenticated) return;
    this.sendControl({
      type: 'device.update',
      device: this.options.deviceInfo(),
    });
  }

  /**
   * Sends a frame, or queues it behind earlier ones while the socket is
   * backed up. Returns false only when not connected or when this client's
   * own queue is full.
   */
  sendFrame(peerDeviceId: string, payload: Uint8Array): boolean {
    const socket = this.socket;
    if (!socket || !this.authenticated) return false;
    const frame = encodeDeviceRelayDataFrame(peerDeviceId, payload);
    if (
      this.outbound.length === 0 &&
      socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES
    ) {
      socket.transmit(frame);
      return true;
    }
    const maxQueued = this.options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES;
    if (this.outboundBytes + frame.byteLength > maxQueued) return false;
    this.outbound.push(frame);
    this.outboundBytes += frame.byteLength;
    this.scheduleDrain();
    return true;
  }

  /** WebSocket has no drain event: poll until the socket takes the queue. */
  private scheduleDrain(): void {
    if (this.drainTimer) return;
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, DRAIN_POLL_MS);
    this.drainTimer.unref?.();
  }

  private drain(): void {
    const socket = this.socket;
    if (!socket || !this.authenticated) {
      this.clearOutbound();
      return;
    }
    while (
      this.outbound.length > 0 &&
      socket.bufferedAmount <= SOCKET_HIGH_WATER_BYTES
    ) {
      const frame = this.outbound.shift();
      if (frame === undefined) break;
      this.outboundBytes -= frame.byteLength;
      socket.transmit(frame);
    }
    if (this.outbound.length > 0) this.scheduleDrain();
  }

  private clearOutbound(): void {
    this.outbound.length = 0;
    this.outboundBytes = 0;
    if (this.drainTimer) clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  onFrame(
    listener: (peerDeviceId: string, payload: Buffer) => void,
  ): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onPeerOffline(listener: (peerDeviceId: string) => void): () => void {
    this.offlineListeners.add(listener);
    return () => this.offlineListeners.delete(listener);
  }

  onUndeliverable(listener: (peerDeviceId: string) => void): () => void {
    this.undeliverableListeners.add(listener);
    return () => this.undeliverableListeners.delete(listener);
  }

  private setStatus(status: RelayConnectionStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
    this.status = status;
    this.options.onStatusChange?.(status, detail);
  }

  private async connect(): Promise<void> {
    const generation = this.generation;
    let token: DeviceRelayTokenResponse;
    try {
      token = await this.options.fetchToken();
    } catch (error) {
      if (generation !== this.generation) return;
      this.scheduleReconnect(
        error instanceof Error ? error.message : 'Relay is unavailable.',
      );
      return;
    }
    if (generation !== this.generation) return;
    const createSocket =
      this.options.createSocket ?? createWebSocketRelaySocket;
    this.authenticated = false;
    try {
      // The deadline also covers an upgrade that never completes.
      this.startReadyTimer(generation);
      this.socket = createSocket(
        relayConnectUrl(token.relayUrl),
        deviceRelaySubprotocols(token.token),
        {
          onOpen: () => {
            if (generation !== this.generation) return;
            this.lastInboundAt = Date.now();
            // A fresh deadline once open: the relay has this long to say ready.
            this.startReadyTimer(generation);
            this.sendControl({
              type: 'hello',
              device: this.options.deviceInfo(),
            });
          },
          onText: (text) => {
            if (generation === this.generation) this.handleText(text);
          },
          onBinary: (bytes) => {
            if (generation === this.generation) this.handleBinary(bytes);
          },
          onClose: () => {
            if (generation === this.generation) this.handleSocketClosed();
          },
        },
      );
    } catch (error) {
      this.clearReadyTimer();
      this.scheduleReconnect(
        error instanceof Error ? error.message : 'Relay connection failed.',
      );
    }
  }

  private sendControl(message: DeviceRelayClientMessage): void {
    this.socket?.transmit(JSON.stringify(message));
  }

  private handleText(text: string): void {
    this.lastInboundAt = Date.now();
    const message = parseDeviceRelayServerMessage(text);
    if (message === null) return;
    switch (message.type) {
      case 'ready':
        this.clearReadyTimer();
        this.authenticated = true;
        this.attempt = 0;
        this.contested = false;
        this.relayFeatures = message.features ?? [];
        this.peerMap.clear();
        for (const peer of message.peers) this.peerMap.set(peer.deviceId, peer);
        this.startPing();
        this.setStatus('connected');
        this.options.onPeersChange?.(this.peers);
        return;
      case 'peer.online':
        this.peerMap.set(message.peer.deviceId, message.peer);
        this.options.onPeersChange?.(this.peers);
        return;
      case 'peer.offline':
        this.removePeer(message.deviceId);
        return;
      case 'undeliverable':
        for (const listener of Array.from(this.undeliverableListeners)) {
          listener(message.deviceId);
        }
        return;
      case 'pong':
        return;
      case 'error':
        this.handleRelayError(message.code, message.message);
        return;
    }
  }

  private handleRelayError(code: DeviceRelayErrorCode, message: string): void {
    if (code === 'rate_limited' || code === 'invalid_message') return;
    if (code === 'replaced' || code === 'too_many_devices') {
      this.contested = true;
    }
    // The relay closes the socket after these; the close handler retries
    // with a fresh token.
    this.setStatus('reconnecting', message);
  }

  private handleBinary(bytes: Uint8Array): void {
    this.lastInboundAt = Date.now();
    if (!this.authenticated) return;
    const frame = decodeDeviceRelayDataFrame(bytes);
    if (frame === null) return;
    const payload = Buffer.from(
      frame.payload.buffer,
      frame.payload.byteOffset,
      frame.payload.byteLength,
    );
    for (const listener of Array.from(this.frameListeners)) {
      listener(frame.deviceId, payload);
    }
  }

  private removePeer(deviceId: string): void {
    if (!this.peerMap.delete(deviceId)) return;
    for (const listener of Array.from(this.offlineListeners))
      listener(deviceId);
    this.options.onPeersChange?.(this.peers);
  }

  private handleSocketClosed(): void {
    this.clearReadyTimer();
    this.clearOutbound();
    this.socket = null;
    this.authenticated = false;
    this.relayFeatures = [];
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    this.dropPeers();
    this.scheduleReconnect();
  }

  private dropPeers(): void {
    for (const deviceId of Array.from(this.peerMap.keys()))
      this.removePeer(deviceId);
  }

  private scheduleReconnect(detail?: string): void {
    if (this.status === 'stopped') return;
    this.closeSocket();
    const min =
      this.options.minReconnectDelayMs ?? DEFAULT_MIN_RECONNECT_DELAY_MS;
    const max =
      this.options.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    const delay = this.contested
      ? reconnectDelayMs(0, max, max)
      : reconnectDelayMs(this.attempt, min, max);
    this.attempt += 1;
    this.setStatus(
      this.attempt > ATTEMPTS_BEFORE_UNAVAILABLE
        ? 'unavailable'
        : 'reconnecting',
      detail,
    );
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    const interval = this.options.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS;
    this.pingTimer = setInterval(() => {
      // Wall-clock, so a socket that silently died while the computer slept
      // is noticed on the first tick after waking.
      if (
        Date.now() - this.lastInboundAt >
        interval * MISSED_PINGS_BEFORE_RECONNECT
      ) {
        this.generation += 1;
        this.closeSocket();
        this.handleSocketClosed();
        return;
      }
      this.sendControl({ type: 'ping', sentAt: Date.now() });
    }, interval);
    this.pingTimer.unref?.();
  }

  /**
   * A relay that accepts the socket but never says ready is as dead as one
   * that refuses it: give up and reconnect.
   */
  private startReadyTimer(generation: number): void {
    this.clearReadyTimer();
    this.readyTimer = setTimeout(() => {
      this.readyTimer = null;
      if (generation !== this.generation || this.authenticated) return;
      this.generation += 1;
      this.closeSocket();
      this.handleSocketClosed();
    }, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    this.readyTimer.unref?.();
  }

  private clearReadyTimer(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearTimers(): void {
    this.clearReadyTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    // Queued frames belong to sessions that end with this socket.
    this.clearOutbound();
    this.authenticated = false;
    this.relayFeatures = [];
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
