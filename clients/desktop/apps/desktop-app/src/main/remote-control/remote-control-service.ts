import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  DevicePlatform,
  DeviceRelayDeviceInfo,
  DeviceRelayTokenResponse,
} from '@canopy/protocol/device-relay';
import { getRemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type {
  RemoteControlForgetDeviceRequest,
  RemoteControlRespondToPairingRequest,
  RemoteControlState,
  RemoteIncomingPairing,
  RemoteOutgoingPairing,
} from '@canopy/desktop-shared/types';
import {
  RemoteHostConnection,
  type PinnedHostSession,
} from './client/host-connection';
import {
  assertSafeToOpen,
  copyRemoteFile,
  parseFileOpenTarget,
  remoteImageForLocalOpen,
} from './client/remote-file-opens';
import type { RemoteControlWindows } from './client/remote-windows';
import type { DeviceKeyPair } from './crypto/device-key';
import type { HandshakePurpose } from './crypto/handshake';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import type { RemoteAppAdvisorSurface } from './host/app-advisor-surface';
import type { HostBridge } from './host/bridge-window';
import type { HostFileReader } from './host/file-reads';
import { RemoteHostSession } from './host/host-session';
import type { MainWindowPushSource } from './host/main-window-pushes';
import type { RemoteUploadStore } from './host/uploads';
import {
  upsertPairedDevice,
  type PairedDevice,
  type RemoteAccessStore,
} from './remote-access-store';
import {
  PairRequestParamsSchema,
  PairRequestResultSchema,
  REMOTE_METHODS,
  RemoteChannelUnavailableError,
  isUnknownRemoteMethodError,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenResult,
  type HelloResult,
  type PairRequestResult,
  type RemoteVersion,
  type RemoteSessionEndReason,
} from './remote-protocol';
import type {
  RelayConnectionStatus,
  RemoteRelay,
} from './transport/relay-client';
import { RpcPeer } from './transport/rpc-peer';
import {
  RemoteSessionManager,
  type SecureSession,
} from './transport/session-manager';

export type { RemoteControlWindows, RemoteRelay };

/** The part of `RemoteAccountProxySignIns` a host connection drives. */
export interface AccountProxySignInListener {
  open(params: AccountProxySignInOpenParams): Promise<void>;
  end(state: string): void;
  closeAll(): void;
}

export interface RemoteRelayFactoryOptions {
  fetchToken: () => Promise<DeviceRelayTokenResponse>;
  deviceInfo: () => DeviceRelayDeviceInfo;
  onStatusChange: (status: RelayConnectionStatus, detail?: string) => void;
  onPeersChange: () => void;
}

export interface RemoteControlServiceDeps {
  store: RemoteAccessStore;
  createRelay: (options: RemoteRelayFactoryOptions) => RemoteRelay;
  fetchToken: (deviceId: string) => Promise<DeviceRelayTokenResponse>;
  isFeatureEnabled: () => boolean;
  /**
   * A stable key for the signed-in account, or null when signed out. The
   * relay and every session belong to the account they started under.
   */
  signedInAccount: () => string | null;
  deviceName: () => string;
  platform: DevicePlatform;
  /** This computer's version; sessions need the same protocol on both sides. */
  version: RemoteVersion;
  createBridge: (
    controllerDeviceId: string,
    surface: RemoteSurface,
  ) => Promise<HostBridge>;
  /**
   * The App Advisor window a controller shows for this computer, made per
   * session. Absent in tests that do not exercise App Advisor.
   */
  createAppAdvisorSurface?: (
    session: RemoteHostSession,
  ) => RemoteAppAdvisorSurface;
  mainWindowPushes: MainWindowPushSource;
  uploads: RemoteUploadStore;
  /** Serves controllers' reads of files they open in their own apps. */
  readHostFile: HostFileReader;
  /** Copies of the controlled computers' files opened on this one. */
  openedFiles: RemoteUploadStore;
  /** Marks a copy the way the OS marks a download; failing refuses the open. */
  markDownloaded: (path: string) => Promise<void>;
  /** Opens a file on this computer in its default app. */
  openLocalFile: (path: string) => Promise<void>;
  /** Bytes per `file.read`; tests shorten it. */
  fileReadChunkBytes?: number;
  /** Hands a controller's account proxy sign-in redirect to the proxy here. */
  completeAccountProxySignIn?: (
    controllerDeviceId: string,
    callback: AccountProxySignInCallbackParams,
  ) => Promise<void>;
  /**
   * Account proxy sign-ins a controlled computer opens in this computer's
   * browser, one set per controlled computer.
   */
  createAccountProxySignIns?: (options: {
    forward: (callback: AccountProxySignInCallbackParams) => Promise<void>;
  }) => AccountProxySignInListener;
  windows: RemoteControlWindows;
  broadcastState: (state: RemoteControlState) => void;
  log?: (message: string, context?: unknown) => void;
  now?: () => number;
  /** How long a discovery request keeps the relay up; tests shorten it. */
  discoveryWindowMs?: number;
}

const DISCOVERY_WINDOW_MS = 5 * 60_000;
const PAIRING_DECISION_TIMEOUT_MS = 3 * 60_000;

interface IncomingPairingEntry {
  view: RemoteIncomingPairing;
  publicKey: string;
  decide: (approve: boolean) => void;
}

interface OutgoingPairingEntry {
  view: RemoteOutgoingPairing;
  rpc: RpcPeer | null;
  cancelled: boolean;
  /**
   * Set once the other computer approves. Approval is the decision to pair,
   * so from then on the pairing finishes even if cancelled; forgetting the
   * computer is the way to undo it.
   */
  committed: boolean;
}

export class RemoteControlService {
  private relay: RemoteRelay | null = null;
  private sessions: RemoteSessionManager | null = null;
  private relayAccount: string | null = null;
  private relayStatus: RelayConnectionStatus = 'stopped';
  private relayDetail: string | null = null;
  private discoveryUntil = 0;
  private discoveryTimer: ReturnType<typeof setTimeout> | null = null;
  private reconcileChain: Promise<void> = Promise.resolve();
  private readonly hostSessions = new Set<RemoteHostSession>();
  private readonly appAdvisorSurfaces = new Map<
    RemoteHostSession,
    RemoteAppAdvisorSurface
  >();
  private readonly connections = new Map<string, RemoteHostConnection>();
  private readonly incoming = new Map<string, IncomingPairingEntry>();
  private outgoing: OutgoingPairingEntry | null = null;
  /**
   * Revocations whose save is still queued. Refused at once, so a device
   * cannot slip back in before the settings cache catches up.
   */
  private readonly revokingControllers = new Set<string>();
  private disallowingIncoming = 0;
  private settingsCache: { allowIncoming: boolean } = { allowIncoming: false };
  private identityCache: { deviceId: string; publicKey: string } | null = null;
  private broadcastScheduled = false;
  private disposed = false;

  constructor(private readonly deps: RemoteControlServiceDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async initialize(): Promise<void> {
    await this.refreshCaches();
    await this.deps.uploads.pruneExpired().catch(() => undefined);
    await this.deps.openedFiles.pruneExpired().catch(() => undefined);
    await this.reconcile();
  }

  /**
   * Re-evaluates whether the relay should run; call on any input change.
   * Runs one at a time, so overlapping calls never start two relays.
   */
  reconcile(): Promise<void> {
    const run = this.reconcileChain.then(() => this.reconcileNow());
    this.reconcileChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async reconcileNow(): Promise<void> {
    if (this.disposed) return;
    const settings = await this.refreshCaches();
    const account = this.deps.signedInAccount();
    // Another account signed in: nothing set up under the old one survives.
    if (this.relay && this.relayAccount !== account) {
      this.cancelOutgoing();
      this.stopRelay();
    }
    const wanted =
      this.deps.isFeatureEnabled() &&
      account !== null &&
      (settings.allowIncoming ||
        settings.pairedHosts.length > 0 ||
        this.discoveryUntil > this.now() ||
        this.pairingInProgress());
    if (wanted && account !== null && !this.relay) {
      await this.startRelay(account);
    } else if (!wanted && this.relay) {
      this.stopRelay();
    } else if (this.relay) {
      this.relay.announce();
    } else if (!wanted) {
      this.relayStatus = 'stopped';
      this.relayDetail = null;
    }
    this.scheduleBroadcast();
  }

  /** A finished pairing stays on screen but no longer needs the relay. */
  private pairingInProgress(): boolean {
    const status = this.outgoing?.view.status;
    return status === 'connecting' || status === 'awaiting-approval';
  }

  dispose(): void {
    this.disposed = true;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = null;
    this.stopRelay();
  }

  private async refreshCaches(): Promise<
    Awaited<ReturnType<RemoteAccessStore['read']>>
  > {
    const settings = await this.deps.store.read();
    this.settingsCache = { allowIncoming: settings.allowIncoming };
    return settings;
  }

  /**
   * Loads or creates this device's key. Deferred until remote control is
   * used, so startup never touches the OS keychain for people who don't.
   */
  private async ensureIdentity(): Promise<DeviceKeyPair> {
    const identity = await this.deps.store.identity();
    this.identityCache = {
      deviceId: identity.deviceId,
      publicKey: identity.publicKey,
    };
    return identity;
  }

  private async startRelay(account: string): Promise<void> {
    let identity: DeviceKeyPair;
    try {
      identity = await this.ensureIdentity();
    } catch (error) {
      this.relayStatus = 'unavailable';
      this.relayDetail =
        error instanceof Error
          ? error.message
          : 'Remote control is unavailable.';
      this.deps.log?.('Remote control identity is unavailable', error);
      return;
    }
    if (this.disposed) return;
    const relay = this.deps.createRelay({
      fetchToken: () => this.deps.fetchToken(identity.deviceId),
      deviceInfo: () => this.deviceInfo(),
      onStatusChange: (status, detail) => {
        this.relayStatus = status;
        this.relayDetail = detail ?? null;
        if (status === 'connected') this.retryHostConnections();
        this.scheduleBroadcast();
      },
      onPeersChange: () => {
        this.retryHostConnections();
        this.scheduleBroadcast();
      },
    });
    this.relay = relay;
    this.relayAccount = account;
    this.sessions = new RemoteSessionManager({
      transport: relay,
      identity: (): DeviceKeyPair => identity,
      authorize: (
        purpose: HandshakePurpose,
        initiatorKey: string,
        peerDeviceId: string,
      ): boolean => this.authorize(purpose, initiatorKey, peerDeviceId),
      onIncomingSession: (session: SecureSession): void =>
        this.handleIncomingSession(session),
    });
    relay.start();
  }

  /**
   * The computer woke from sleep: its relay socket may have died silently
   * meanwhile. Reconnecting now ends every session over it at once (peers
   * go offline, then online), so host windows come back without waiting for
   * a keepalive to time out.
   */
  handleSystemResume(): void {
    this.relay?.reconnectNow();
  }

  /** Reconnects every wanted host connection whose host is online now. */
  private retryHostConnections(): void {
    const online = new Set(
      (this.relay?.peers ?? []).map((peer) => peer.deviceId),
    );
    this.connections.forEach((connection, deviceId) => {
      if (online.has(deviceId)) connection.retryNow();
    });
  }

  private stopRelay(): void {
    // A window left without its connection could never reconnect; close it.
    for (const [deviceId, connection] of Array.from(this.connections)) {
      connection.release();
      this.deps.windows.close(deviceId);
    }
    this.connections.clear();
    for (const session of Array.from(this.hostSessions))
      session.close('shutdown');
    for (const entry of Array.from(this.incoming.values())) entry.decide(false);
    // A finished pairing's outcome stays on screen.
    if (this.pairingInProgress()) this.cancelOutgoing();
    this.sessions?.dispose();
    this.sessions = null;
    this.relay?.stop();
    this.relay = null;
    this.relayAccount = null;
    this.relayStatus = 'stopped';
    this.relayDetail = null;
    this.scheduleBroadcast();
  }

  private deviceInfo(): DeviceRelayDeviceInfo {
    const identity = this.identityOrThrow();
    return {
      deviceId: identity.deviceId,
      name: this.deps.deviceName(),
      platform: this.deps.platform,
      appVersion: this.deps.version.appVersion,
      publicKey: identity.publicKey,
      acceptsRemoteControl: this.settingsCache.allowIncoming,
    };
  }

  private identityOrThrow(): { deviceId: string; publicKey: string } {
    if (!this.identityCache) {
      throw new Error('Remote control identity is not loaded.');
    }
    return this.identityCache;
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  async getState(
    request: { discover?: boolean } = {},
  ): Promise<RemoteControlState> {
    if (request.discover) {
      const windowMs = this.deps.discoveryWindowMs ?? DISCOVERY_WINDOW_MS;
      this.discoveryUntil = this.now() + windowMs;
      // Let a relay started only for discovery stop when the window ends.
      if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
      this.discoveryTimer = setTimeout(() => {
        this.discoveryTimer = null;
        // Timers may fire a moment before the clock reads the deadline.
        this.discoveryUntil = 0;
        void this.reconcile().catch(() => undefined);
      }, windowMs);
      this.discoveryTimer.unref?.();
      await this.reconcile();
    }
    return this.snapshot();
  }

  private async snapshot(): Promise<RemoteControlState> {
    const settings = await this.refreshCaches();
    const identity = this.identityCache;
    const peers = new Map(
      (this.relay?.peers ?? []).map((peer) => [peer.deviceId, peer]),
    );
    const connectedControllers = new Set(
      Array.from(this.hostSessions).map(
        (session) => session.controllerDeviceId,
      ),
    );
    const pairedHostIds = new Set(
      settings.pairedHosts.map((host) => host.deviceId),
    );
    return {
      available: this.deps.isFeatureEnabled(),
      signedIn: this.deps.signedInAccount() !== null,
      relayStatus: this.relayStatus,
      relayDetail: this.relayDetail,
      // Null until remote control is first used and the key exists.
      thisDevice: identity
        ? {
            deviceId: identity.deviceId,
            name: this.deps.deviceName(),
            platform: this.deps.platform,
          }
        : null,
      allowIncoming: settings.allowIncoming,
      hosts: settings.pairedHosts.map((host) => {
        const connection = this.connections.get(host.deviceId);
        const peer = peers.get(host.deviceId);
        return {
          deviceId: host.deviceId,
          name: peer?.name ?? host.name,
          platform: peer?.platform ?? host.platform,
          pairedAt: host.pairedAt,
          online: peer !== undefined && peer.acceptsRemoteControl,
          connection: connection?.status ?? 'idle',
          error: connection?.error ?? null,
          ended: connection?.ended ?? false,
        };
      }),
      controllers: settings.pairedControllers.map((controller) => {
        const peer = peers.get(controller.deviceId);
        return {
          deviceId: controller.deviceId,
          name: peer?.name ?? controller.name,
          platform: peer?.platform ?? controller.platform,
          pairedAt: controller.pairedAt,
          online: peer !== undefined,
          connected: connectedControllers.has(controller.deviceId),
        };
      }),
      discoverable: Array.from(peers.values())
        .filter(
          (peer) =>
            peer.acceptsRemoteControl && !pairedHostIds.has(peer.deviceId),
        )
        .map((peer) => ({
          deviceId: peer.deviceId,
          name: peer.name,
          platform: peer.platform,
        })),
      outgoingPairing: this.outgoing ? { ...this.outgoing.view } : null,
      incomingPairings: Array.from(this.incoming.values()).map((entry) => ({
        ...entry.view,
      })),
    };
  }

  private scheduleBroadcast(): void {
    if (this.broadcastScheduled || this.disposed) return;
    this.broadcastScheduled = true;
    setImmediate(() => {
      this.broadcastScheduled = false;
      void this.snapshot().then(
        (state) => this.deps.broadcastState(state),
        () => undefined,
      );
    });
  }

  // -------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------

  async setAllowIncoming(allow: boolean): Promise<RemoteControlState> {
    const saving = this.deps.store.update((current) => ({
      ...current,
      allowIncoming: allow,
    }));
    if (!allow) {
      // Revocation takes effect at once, without waiting for the save, and
      // holds even if saving fails; the error still reaches the caller.
      this.disallowingIncoming += 1;
      this.settingsCache = { allowIncoming: false };
      this.endAllControl();
    }
    try {
      await saving;
    } finally {
      this.settingsCache = { allowIncoming: allow };
      if (!allow) {
        // The cache now refuses on its own; drop anything that got through.
        this.endAllControl();
        this.disallowingIncoming -= 1;
      }
    }
    await this.reconcile();
    return this.snapshot();
  }

  async forgetDevice(
    request: RemoteControlForgetDeviceRequest,
  ): Promise<RemoteControlState> {
    if (request.role === 'host') {
      try {
        await this.deps.store.update((current) => ({
          ...current,
          pairedHosts: current.pairedHosts.filter(
            (host) => host.deviceId !== request.deviceId,
          ),
        }));
      } finally {
        // The pairing is already gone from the cache; drop its connection
        // too, even if saving failed.
        this.connections.get(request.deviceId)?.release();
        this.connections.delete(request.deviceId);
        this.deps.windows.close(request.deviceId);
      }
    } else {
      const saving = this.deps.store.update((current) => ({
        ...current,
        pairedControllers: current.pairedControllers.filter(
          (controller) => controller.deviceId !== request.deviceId,
        ),
      }));
      // Cut the controller off at once, not once the save lands, and even if
      // saving fails.
      this.revokingControllers.add(request.deviceId);
      this.closeControllerSessions(request.deviceId, 'revoked');
      try {
        await saving;
      } finally {
        this.closeControllerSessions(request.deviceId, 'revoked');
        this.revokingControllers.delete(request.deviceId);
      }
    }
    await this.reconcile();
    return this.snapshot();
  }

  /**
   * Ends the controller's current session. It stays paired, but does not
   * reconnect on its own: it waits until its user opens this computer again.
   */
  async disconnectController(deviceId: string): Promise<RemoteControlState> {
    this.closeControllerSessions(deviceId, 'disconnected');
    return this.snapshot();
  }

  private endAllControl(): void {
    for (const session of Array.from(this.hostSessions)) session.end('revoked');
    for (const entry of Array.from(this.incoming.values())) entry.decide(false);
  }

  private closeControllerSessions(
    deviceId: string,
    reason: RemoteSessionEndReason,
  ): void {
    for (const session of Array.from(this.hostSessions)) {
      if (session.controllerDeviceId === deviceId) session.end(reason);
    }
  }

  // -------------------------------------------------------------------------
  // Host side: this computer being controlled
  // -------------------------------------------------------------------------

  private authorize(
    purpose: 'control' | 'pair',
    initiatorKey: string,
    peerDeviceId: string,
  ): boolean {
    // Synchronous: uses the settings snapshot refreshed on every change.
    if (this.disallowingIncoming > 0) return false;
    const settings = this.deps.store.peek();
    if (!settings?.allowIncoming) return false;
    if (purpose === 'pair') return true;
    if (this.revokingControllers.has(peerDeviceId)) return false;
    return settings.pairedControllers.some(
      (controller) =>
        controller.deviceId === peerDeviceId &&
        controller.publicKey === initiatorKey,
    );
  }

  private handleIncomingSession(session: SecureSession): void {
    if (session.purpose === 'pair') {
      this.handleIncomingPairing(session);
      return;
    }
    // Authorized at the handshake, but revoked while it finished.
    if (
      !this.authorize(
        'control',
        session.handshake.peerPublicKey,
        session.peerDeviceId,
      )
    ) {
      session.close('closed');
      return;
    }
    let appAdvisor: RemoteAppAdvisorSurface | null = null;
    const hostSession = new RemoteHostSession({
      session,
      createBridge: (surface: RemoteSurface): Promise<HostBridge> =>
        this.deps.createBridge(session.peerDeviceId, surface),
      onAppAdvisorWindowState: (state): void => appAdvisor?.applyState(state),
      mainWindowPushes: this.deps.mainWindowPushes,
      uploads: this.deps.uploads,
      readFile: this.deps.readHostFile,
      disposition: getRemoteChannelDisposition,
      isAuthorized: (): boolean =>
        this.authorize(
          'control',
          session.handshake.peerPublicKey,
          session.peerDeviceId,
        ),
      version: this.deps.version,
      hello: (): Pick<HelloResult, 'name' | 'platform'> => ({
        name: this.deps.deviceName(),
        platform: this.deps.platform,
      }),
      onClose: (): void => {
        this.hostSessions.delete(hostSession);
        this.appAdvisorSurfaces.delete(hostSession);
        this.scheduleBroadcast();
      },
      onBridgeError: (error: unknown): void => {
        this.deps.log?.('Remote control bridge failed to start', error);
      },
      ...(this.deps.completeAccountProxySignIn
        ? { completeAccountProxySignIn: this.deps.completeAccountProxySignIn }
        : {}),
    });
    this.hostSessions.add(hostSession);
    appAdvisor = this.deps.createAppAdvisorSurface?.(hostSession) ?? null;
    if (appAdvisor) this.appAdvisorSurfaces.set(hostSession, appAdvisor);
    this.deps.log?.('Remote control session started', {
      controllerDeviceId: session.peerDeviceId,
    });
    this.scheduleBroadcast();
  }

  /** A connected controller's App Advisor window, for its calls and tools. */
  appAdvisorSurfaceForController(
    deviceId: string,
  ): RemoteAppAdvisorSurface | null {
    const session = this.hostSessionForController(deviceId);
    return session ? (this.appAdvisorSurfaces.get(session) ?? null) : null;
  }

  /** The live session behind a bridge, for its dialog requests. */
  hostSessionForController(deviceId: string): RemoteHostSession | null {
    for (const session of Array.from(this.hostSessions)) {
      if (session.controllerDeviceId === deviceId) return session;
    }
    return null;
  }

  private handleIncomingPairing(session: SecureSession): void {
    const pairingId = randomUUID();
    let requested = false;
    const rpc = new RpcPeer(session, {
      onEvent: (): void => undefined,
      onRequest: async (method: string, params: unknown): Promise<unknown> => {
        if (method !== REMOTE_METHODS.pairRequest) {
          throw new Error(`Unknown remote method ${method}.`);
        }
        if (requested) {
          throw new Error('This connection already asked to pair.');
        }
        requested = true;
        const request = PairRequestParamsSchema.parse(params);
        let stopWatchingClose = (): void => undefined;
        const approved = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(
            () => resolve(false),
            PAIRING_DECISION_TIMEOUT_MS,
          );
          this.incoming.set(pairingId, {
            view: {
              pairingId,
              deviceId: session.peerDeviceId,
              name: request.name,
              platform: request.platform,
              code: session.handshake.shortAuthenticationString,
            },
            publicKey: session.handshake.peerPublicKey,
            decide: (approve) => {
              clearTimeout(timer);
              resolve(approve);
            },
          });
          stopWatchingClose = rpc.onClose(() => {
            clearTimeout(timer);
            resolve(false);
          });
          this.scheduleBroadcast();
        });
        stopWatchingClose();
        this.incoming.delete(pairingId);
        this.scheduleBroadcast();
        // The other computer saves the pairing only once it hears the answer;
        // after the connection closes it never will, so neither does this one.
        if (approved && !rpc.isClosed) {
          await this.deps.store.update((current) =>
            rpc.isClosed
              ? current
              : {
                  ...current,
                  pairedControllers: upsertPairedDevice(
                    current.pairedControllers,
                    {
                      deviceId: session.peerDeviceId,
                      name: request.name,
                      platform: request.platform,
                      publicKey: session.handshake.peerPublicKey,
                      pairedAt: new Date(this.now()).toISOString(),
                    },
                  ),
                },
          );
        }
        const result: PairRequestResult = {
          approved,
          name: this.deps.deviceName(),
          platform: this.deps.platform,
        };
        return result;
      },
    });
  }

  async respondToPairing(
    request: RemoteControlRespondToPairingRequest,
  ): Promise<RemoteControlState> {
    this.incoming.get(request.pairingId)?.decide(request.approve);
    return this.snapshot();
  }

  // -------------------------------------------------------------------------
  // Controller side: this computer controlling paired ones
  // -------------------------------------------------------------------------

  async startPairing(deviceId: string): Promise<RemoteControlState> {
    this.cancelOutgoing();
    const peer = this.relay?.peers.find((entry) => entry.deviceId === deviceId);
    const sessions = this.sessions;
    if (!peer || !sessions) {
      throw new Error('That computer is not online.');
    }
    const entry: OutgoingPairingEntry = {
      view: {
        deviceId,
        name: peer.name,
        platform: peer.platform,
        status: 'connecting',
        code: null,
        error: null,
      },
      rpc: null,
      cancelled: false,
      committed: false,
    };
    this.outgoing = entry;
    this.scheduleBroadcast();
    void this.runOutgoingPairing(entry, sessions);
    return this.snapshot();
  }

  private async runOutgoingPairing(
    entry: OutgoingPairingEntry,
    sessions: RemoteSessionManager,
  ): Promise<void> {
    const update = (patch: Partial<RemoteOutgoingPairing>): void => {
      if (this.outgoing !== entry) return;
      entry.view = { ...entry.view, ...patch };
      this.scheduleBroadcast();
    };
    try {
      const session = await sessions.connect({
        peerDeviceId: entry.view.deviceId,
        purpose: 'pair',
        pinnedPeerPublicKey: null,
      });
      if (entry.cancelled) {
        session.close('closed');
        return;
      }
      const rpc = new RpcPeer(session, {
        onEvent: (): void => undefined,
        onRequest: (): Promise<unknown> =>
          Promise.reject(new Error('Not supported.')),
      });
      entry.rpc = rpc;
      update({
        status: 'awaiting-approval',
        code: session.handshake.shortAuthenticationString,
      });
      const result = PairRequestResultSchema.parse(
        await rpc.request(
          REMOTE_METHODS.pairRequest,
          { name: this.deps.deviceName(), platform: this.deps.platform },
          { timeoutMs: PAIRING_DECISION_TIMEOUT_MS + 10_000 },
        ),
      );
      rpc.close('closed');
      if (!result.approved) {
        update({ status: 'rejected' });
        return;
      }
      if (entry.cancelled) return;
      entry.committed = true;
      await this.deps.store.update((current) => ({
        ...current,
        pairedHosts: upsertPairedDevice(current.pairedHosts, {
          deviceId: session.peerDeviceId,
          name: result.name,
          platform: result.platform,
          publicKey: session.handshake.peerPublicKey,
          pairedAt: new Date(this.now()).toISOString(),
        }),
      }));
      update({ status: 'approved', name: result.name });
    } catch (error) {
      if (entry.cancelled) return;
      update({
        status: 'failed',
        error:
          error instanceof Error ? error.message : 'Pairing did not finish.',
      });
    } finally {
      await this.reconcile();
    }
  }

  private cancelOutgoing(): void {
    const entry = this.outgoing;
    if (!entry) return;
    if (entry.committed) {
      // An approved pairing is already decided: while it saves, it finishes
      // and stays shown; once it has an outcome, this only dismisses it.
      if (entry.view.status !== 'awaiting-approval') this.outgoing = null;
      return;
    }
    entry.cancelled = true;
    entry.rpc?.close('closed');
    this.outgoing = null;
  }

  async cancelPairing(): Promise<RemoteControlState> {
    this.cancelOutgoing();
    await this.reconcile();
    return this.snapshot();
  }

  async openMachine(deviceId: string | null): Promise<void> {
    if (deviceId === null) {
      this.deps.windows.focusLocal();
      return;
    }
    const settings = await this.deps.store.read();
    const host = settings.pairedHosts.find(
      (entry) => entry.deviceId === deviceId,
    );
    if (!host) throw new Error('That computer is not paired.');
    this.connectionFor(host).keepConnected();
    this.deps.windows.open(host);
    this.scheduleBroadcast();
  }

  /** Called when a remote window closes. */
  releaseMachine(deviceId: string): void {
    this.connections.get(deviceId)?.release();
    this.connections.delete(deviceId);
    this.scheduleBroadcast();
  }

  private connectionFor(host: PairedDevice): RemoteHostConnection {
    const existing = this.connections.get(host.deviceId);
    if (existing) return existing;
    const signIns =
      this.deps.createAccountProxySignIns?.({
        forward: (callback): Promise<void> =>
          connection.sendAccountProxySignInCallback(callback),
      }) ?? null;
    const connection: RemoteHostConnection = new RemoteHostConnection({
      version: this.deps.version,
      connect: (): Promise<SecureSession> => {
        const sessions = this.sessions;
        if (!sessions) {
          return Promise.reject(new Error('Remote control is turned off.'));
        }
        return sessions.connect({
          peerDeviceId: host.deviceId,
          purpose: 'control',
          pinnedPeerPublicKey: host.publicKey,
        });
      },
      onPush: (channel, args, surface) =>
        this.deps.windows.deliverPush(host.deviceId, channel, args, surface),
      onAppAdvisorWindow: (params) =>
        this.deps.windows.appAdvisorWindow(host.deviceId, params),
      onDialogOpen: (params): Promise<DialogOpenResult> =>
        this.deps.windows.showDialog(
          host.deviceId,
          params,
          (fileName, bytes): Promise<string> =>
            connection.upload(fileName, bytes),
        ),
      onStatusChange: () => this.scheduleBroadcast(),
      onReconnected: () => this.deps.windows.reload(host.deviceId),
      ...(signIns
        ? {
            onAccountProxySignInOpen: (params): Promise<void> =>
              signIns.open(params),
            onAccountProxySignInEnded: (state: string): void =>
              signIns.end(state),
            onSessionEnded: (): void => signIns.closeAll(),
          }
        : {}),
    });
    this.connections.set(host.deviceId, connection);
    return connection;
  }

  private connectionForDevice(deviceId: string): RemoteHostConnection {
    const connection = this.connections.get(deviceId);
    if (!connection) {
      throw new Error('This window is not connected to another computer.');
    }
    return connection;
  }

  /** A computer's App Advisor window here opened, closed, or changed focus. */
  reportAppAdvisorWindowState(
    deviceId: string,
    state: AppAdvisorWindowStateParams,
  ): void {
    this.connections.get(deviceId)?.reportAppAdvisorWindowState(state);
  }

  /** A remote window's tunneled call. */
  invoke(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): Promise<unknown> {
    if (channel === IPC_CHANNELS.fileOpenExternal) {
      return this.openFileLocally(deviceId, args);
    }
    if (getRemoteChannelDisposition(channel) !== 'tunnel') {
      return Promise.reject(new RemoteChannelUnavailableError(channel));
    }
    return this.connectionForDevice(deviceId).invoke(channel, args, surface);
  }

  /**
   * Opening a file in its default app would happen on the controlled
   * computer's screen, so the file opens in this computer's default app
   * instead, from a copy read through the session and stored here.
   */
  private async openFileLocally(
    deviceId: string,
    args: unknown[],
  ): Promise<void> {
    const target = parseFileOpenTarget(args);
    // One session carries the whole copy: if the window closes or the session
    // drops, the copy fails instead of reconnecting, and nothing opens.
    const session = await this.connectionForDevice(deviceId).pinSession();
    let path: string;
    try {
      path = await copyRemoteFile({
        deviceId,
        target,
        read: (params) => session.readFile(params),
        store: this.deps.openedFiles,
        ...(this.deps.fileReadChunkBytes === undefined
          ? {}
          : { chunkBytes: this.deps.fileReadChunkBytes }),
      });
    } catch (error) {
      if (!isUnknownRemoteMethodError(error, REMOTE_METHODS.fileRead)) {
        throw error;
      }
      path = await this.copyRemotePreviewImage(
        deviceId,
        session,
        target.absolutePath,
      );
    }
    try {
      assertSafeToOpen(basename(path));
      await this.deps.markDownloaded(path);
      if (!session.active) {
        throw new Error(
          `Couldn't open ${basename(path)} because the other computer disconnected.`,
        );
      }
    } catch (error) {
      await this.deps.openedFiles.remove(path);
      throw error;
    }
    await this.deps.openLocalFile(path);
  }

  /**
   * A host released before `file.read` can still send a picture of up to
   * 5 MB through its preview; anything else stays unavailable there.
   */
  private async copyRemotePreviewImage(
    deviceId: string,
    session: PinnedHostSession,
    absolutePath: string,
  ): Promise<string> {
    const preview = await session.invoke(IPC_CHANNELS.fileReadPreview, [
      { absolutePath },
    ]);
    const image = remoteImageForLocalOpen(preview);
    if (!image) {
      throw new RemoteChannelUnavailableError(IPC_CHANNELS.fileOpenExternal);
    }
    return this.deps.openedFiles.put(deviceId, image.fileName, image.bytes);
  }

  post(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface: RemoteSurface = 'main',
  ): void {
    if (getRemoteChannelDisposition(channel) !== 'tunnel') return;
    this.connections.get(deviceId)?.post(channel, args, surface);
  }

  /** Sends a file from this computer; returns its path on the other one. */
  upload(
    deviceId: string,
    fileName: string,
    bytes: Uint8Array,
  ): Promise<string> {
    return this.connectionForDevice(deviceId).upload(fileName, bytes);
  }
}
