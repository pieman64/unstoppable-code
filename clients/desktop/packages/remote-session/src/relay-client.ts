import {
  DEVICE_RELAY_CONNECT_PATH,
  DEVICE_RELAY_FEATURE_DEVICE_KIND,
  decodeDeviceRelayDataFrame,
  deviceRelaySubprotocols,
  encodeDeviceRelayDataFrame,
  parseDeviceRelayServerMessage,
  type DeviceKind,
  type DeviceRelayClientMessage,
  type DeviceRelayDeviceInfo,
  type DeviceRelayErrorCode,
  type DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import { MAX_MESSAGE_BYTES } from '@canopy/protocol/remote-control';
import { copyBytes, type Bytes } from './bytes';
import { RelayUnsupportedError } from './errors';
import { defaultScheduler, type SchedulerPort } from './scheduler';
import type { RelayTransport } from './session-manager';

/** The socket surface the relay client needs; hosts inject the factory. */
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

/** The structural part of the WHATWG `WebSocket` the default factory uses. */
interface WebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  send(data: string | Uint8Array<ArrayBuffer>): void;
  close(): void;
}

type WebSocketConstructorLike = new (
  url: string,
  protocols: string[],
) => WebSocketLike;

/**
 * A factory over a WHATWG `WebSocket` constructor: the browser or worker
 * global, or Node 22+'s global `WebSocket`.
 */
export function createWebSocketRelaySocketFactory(
  WebSocketConstructor: WebSocketConstructorLike,
): RelaySocketFactory {
  return (url, protocols, handlers) => {
    const socket = new WebSocketConstructor(url, protocols);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => handlers.onOpen());
    socket.addEventListener('message', (event) => {
      const data: unknown =
        typeof event === 'object' && event !== null
          ? Reflect.get(event, 'data')
          : undefined;
      if (typeof data === 'string') handlers.onText(data);
      else if (data instanceof ArrayBuffer)
        handlers.onBinary(new Uint8Array(data));
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
}

export type RelayConnectionStatus =
  | 'stopped'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'unavailable'
  /** The relay lacks a required feature; stopped until `start()` again. */
  | 'unsupported'
  /** `mintToken` failed in a way the host marked permanent; stopped. */
  | 'failed';

export interface RelayClientOptions {
  /** This client's device kind; minted into every token and sent in hello. */
  kind: DeviceKind;
  /**
   * Mints a fresh relay token for `kind`. Called for every connection
   * attempt; a token is never reused across reconnects.
   */
  mintToken: (kind: DeviceKind) => Promise<DeviceRelayTokenResponse>;
  /** This device as announced to the relay (its `kind` is set from `kind`). */
  deviceInfo: () => Omit<DeviceRelayDeviceInfo, 'kind'>;
  createSocket: RelaySocketFactory;
  /**
   * Whether a `mintToken` failure is worth retrying. Return false for
   * permanent refusals (entitlement denied, signed out) to stop with
   * `failed`. Defaults to retrying.
   */
  isRetryableTokenError?: (error: unknown) => boolean;
  onStatusChange?: (status: RelayConnectionStatus, detail?: string) => void;
  /**
   * The relay reported an error, for example `too_many_devices` when the
   * account already has the most devices connected. The client still
   * handles it (reconnecting with a fresh token where that can help).
   */
  onRelayError?: (code: DeviceRelayErrorCode, message: string) => void;
  onPeersChange?: (peers: ReadonlyArray<DeviceRelayDeviceInfo>) => void;
  scheduler?: SchedulerPort;
  minReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  pingIntervalMs?: number;
  readyTimeoutMs?: number;
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
export const RELAY_PING_INTERVAL_MS = 10_000;
export const RELAY_READY_TIMEOUT_MS = 15_000;
export const RELAY_MIN_RECONNECT_DELAY_MS = 500;
export const RELAY_MAX_RECONNECT_DELAY_MS = 30_000;
/** Backoff growth per failed attempt, as the desktop uses. */
export const RELAY_RECONNECT_BACKOFF_FACTOR = 1.5;
/** Failed attempts after which the relay is reported unavailable. */
const ATTEMPTS_BEFORE_UNAVAILABLE = 5;
/** Pings without any reply after which the socket counts as dead. */
const MISSED_PINGS_BEFORE_RECONNECT = 3;

/**
 * Delay before reconnect attempt `attempt` (0-based): exponential with
 * factor 1.5 between `min` and `max`, jittered over its upper half.
 */
export function reconnectDelayMs(
  attempt: number,
  min: number,
  max: number,
  random: () => number = Math.random,
): number {
  const base = Math.min(max, min * RELAY_RECONNECT_BACKOFF_FACTOR ** attempt);
  return base / 2 + random() * (base / 2);
}

function relayConnectUrl(relayUrl: string): string {
  const url = new URL(relayUrl);
  url.pathname = DEVICE_RELAY_CONNECT_PATH;
  return url.toString();
}

/**
 * This device's outbound connection to the device relay: a fresh token per
 * connection, authentication, presence, frame routing, keepalive and
 * reconnect with jittered backoff (0.5 s to 30 s, ×1.5), ported from the
 * desktop. A portable client also requires the relay to advertise
 * `device-kind` in `ready.features`; without it the client stops with
 * `unsupported` instead of running on a relay that ignores its kind.
 */
export class RelayClient implements RelayTransport {
  private socket: RelaySocket | null = null;
  private status: RelayConnectionStatus = 'stopped';
  private readonly peerMap = new Map<string, DeviceRelayDeviceInfo>();
  private readonly frameListeners = new Set<
    (peerDeviceId: string, payload: Uint8Array) => void
  >();
  private readonly offlineListeners = new Set<(peerDeviceId: string) => void>();
  private readonly undeliverableListeners = new Set<
    (peerDeviceId: string) => void
  >();
  private reconnectTimer: unknown = null;
  private pingTimer: unknown = null;
  private readyTimer: unknown = null;
  private drainTimer: unknown = null;
  private readonly outbound: Bytes[] = [];
  private outboundBytes = 0;
  private attempt = 0;
  private generation = 0;
  private authenticated = false;
  /** Another connection took this device's place: wait the longest backoff. */
  private contested = false;
  private lastInboundAt = 0;
  private lastErrorValue: Error | null = null;
  private readonly scheduler: SchedulerPort;

  constructor(private readonly options: RelayClientOptions) {
    this.scheduler = options.scheduler ?? defaultScheduler;
  }

  get connectionStatus(): RelayConnectionStatus {
    return this.status;
  }

  /** Why the client stopped with `unsupported` or `failed`, if it did. */
  get lastError(): Error | null {
    return this.lastErrorValue;
  }

  get peers(): ReadonlyArray<DeviceRelayDeviceInfo> {
    return Array.from(this.peerMap.values());
  }

  getPeer(deviceId: string): DeviceRelayDeviceInfo | null {
    return this.peerMap.get(deviceId) ?? null;
  }

  start(): void {
    if (
      this.status !== 'stopped' &&
      this.status !== 'unsupported' &&
      this.status !== 'failed'
    ) {
      return;
    }
    this.lastErrorValue = null;
    this.attempt = 0;
    this.setStatus('connecting');
    void this.connect();
  }

  stop(): void {
    this.halt('stopped');
  }

  private halt(status: RelayConnectionStatus, detail?: string): void {
    this.generation += 1;
    this.clearTimers();
    this.closeSocket();
    this.dropPeers();
    this.attempt = 0;
    this.setStatus(status, detail);
  }

  /** Drops the connection and reconnects at once with a fresh token. */
  reconnectNow(): void {
    if (
      this.status === 'stopped' ||
      this.status === 'unsupported' ||
      this.status === 'failed'
    ) {
      return;
    }
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
    this.sendControl({ type: 'device.update', device: this.deviceInfo() });
  }

  private deviceInfo(): DeviceRelayDeviceInfo {
    return { ...this.options.deviceInfo(), kind: this.options.kind };
  }

  /**
   * Sends a frame, or queues it behind earlier ones while the socket is
   * backed up. Returns false only when not connected or the queue is full.
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
    if (this.drainTimer !== null) return;
    this.drainTimer = this.scheduler.setTimeout(() => {
      this.drainTimer = null;
      this.drain();
    }, DRAIN_POLL_MS);
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
    if (this.drainTimer !== null) this.scheduler.clearTimeout(this.drainTimer);
    this.drainTimer = null;
  }

  onFrame(
    listener: (peerDeviceId: string, payload: Uint8Array) => void,
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
      // A fresh token for every attempt; none is kept between attempts.
      token = await this.options.mintToken(this.options.kind);
      const expiresAt = Date.parse(token.expiresAt);
      if (!Number.isNaN(expiresAt) && expiresAt <= this.scheduler.now()) {
        throw new Error('The relay token is already expired.');
      }
    } catch (error) {
      if (generation !== this.generation) return;
      const retryable = this.options.isRetryableTokenError?.(error) ?? true;
      if (!retryable) {
        this.lastErrorValue =
          error instanceof Error ? error : new Error('Relay token refused.');
        this.halt('failed', this.lastErrorValue.message);
        return;
      }
      this.scheduleReconnect(
        error instanceof Error ? error.message : 'Relay is unavailable.',
      );
      return;
    }
    if (generation !== this.generation) return;
    this.authenticated = false;
    try {
      // The deadline also covers an upgrade that never completes.
      this.startReadyTimer(generation);
      this.socket = this.options.createSocket(
        relayConnectUrl(token.relayUrl),
        deviceRelaySubprotocols(token.token),
        {
          onOpen: () => {
            if (generation !== this.generation) return;
            this.lastInboundAt = this.scheduler.now();
            this.startReadyTimer(generation);
            this.sendControl({ type: 'hello', device: this.deviceInfo() });
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
    this.lastInboundAt = this.scheduler.now();
    const message = parseDeviceRelayServerMessage(text);
    if (message === null) return;
    switch (message.type) {
      case 'ready': {
        this.clearReadyTimer();
        if (
          !(message.features ?? []).includes(DEVICE_RELAY_FEATURE_DEVICE_KIND)
        ) {
          this.lastErrorValue = new RelayUnsupportedError(
            DEVICE_RELAY_FEATURE_DEVICE_KIND,
          );
          this.halt('unsupported', this.lastErrorValue.message);
          return;
        }
        this.authenticated = true;
        this.attempt = 0;
        this.contested = false;
        this.peerMap.clear();
        for (const peer of message.peers) this.peerMap.set(peer.deviceId, peer);
        this.startPing();
        this.setStatus('connected');
        this.options.onPeersChange?.(this.peers);
        return;
      }
      case 'peer.online':
        this.peerMap.set(message.peer.deviceId, message.peer);
        this.options.onPeersChange?.(this.peers);
        return;
      case 'peer.offline':
        this.removePeer(message.deviceId);
        return;
      case 'undeliverable':
        for (const listener of Array.from(this.undeliverableListeners))
          listener(message.deviceId);
        return;
      case 'pong':
        return;
      case 'error':
        this.handleRelayError(message.code, message.message);
        return;
    }
  }

  private handleRelayError(code: DeviceRelayErrorCode, message: string): void {
    this.options.onRelayError?.(code, message);
    if (code === 'rate_limited' || code === 'invalid_message') return;
    if (code === 'replaced' || code === 'too_many_devices')
      this.contested = true;
    // The relay closes the socket after these; the close handler retries
    // with a fresh token.
    this.setStatus('reconnecting', message);
  }

  private handleBinary(bytes: Uint8Array): void {
    this.lastInboundAt = this.scheduler.now();
    if (!this.authenticated) return;
    const frame = decodeDeviceRelayDataFrame(bytes);
    if (frame === null) return;
    const payload = copyBytes(frame.payload);
    for (const listener of Array.from(this.frameListeners))
      listener(frame.deviceId, payload);
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
    if (this.pingTimer !== null) {
      this.scheduler.clearInterval(this.pingTimer);
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
    if (
      this.status === 'stopped' ||
      this.status === 'unsupported' ||
      this.status === 'failed'
    ) {
      return;
    }
    this.closeSocket();
    const min =
      this.options.minReconnectDelayMs ?? RELAY_MIN_RECONNECT_DELAY_MS;
    const max =
      this.options.maxReconnectDelayMs ?? RELAY_MAX_RECONNECT_DELAY_MS;
    const random = (): number => this.scheduler.random();
    const delay = this.contested
      ? reconnectDelayMs(0, max, max, random)
      : reconnectDelayMs(this.attempt, min, max, random);
    this.attempt += 1;
    this.setStatus(
      this.attempt > ATTEMPTS_BEFORE_UNAVAILABLE
        ? 'unavailable'
        : 'reconnecting',
      detail,
    );
    if (this.reconnectTimer !== null)
      this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = this.scheduler.setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer !== null) this.scheduler.clearInterval(this.pingTimer);
    const interval = this.options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
    this.pingTimer = this.scheduler.setInterval(() => {
      // Wall-clock, so a socket that silently died while the device slept is
      // noticed on the first tick after waking.
      if (
        this.scheduler.now() - this.lastInboundAt >
        interval * MISSED_PINGS_BEFORE_RECONNECT
      ) {
        this.generation += 1;
        this.closeSocket();
        this.handleSocketClosed();
        return;
      }
      this.sendControl({ type: 'ping', sentAt: this.scheduler.now() });
    }, interval);
  }

  /** A relay that accepts the socket but never says ready is as dead. */
  private startReadyTimer(generation: number): void {
    this.clearReadyTimer();
    this.readyTimer = this.scheduler.setTimeout(() => {
      this.readyTimer = null;
      if (generation !== this.generation || this.authenticated) return;
      this.generation += 1;
      this.closeSocket();
      this.handleSocketClosed();
    }, this.options.readyTimeoutMs ?? RELAY_READY_TIMEOUT_MS);
  }

  private clearReadyTimer(): void {
    if (this.readyTimer !== null) this.scheduler.clearTimeout(this.readyTimer);
    this.readyTimer = null;
  }

  private clearTimers(): void {
    this.clearReadyTimer();
    if (this.reconnectTimer !== null)
      this.scheduler.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.pingTimer !== null) this.scheduler.clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private closeSocket(): void {
    const socket = this.socket;
    this.socket = null;
    // Queued frames belong to sessions that end with this socket.
    this.clearOutbound();
    this.authenticated = false;
    if (!socket) return;
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
