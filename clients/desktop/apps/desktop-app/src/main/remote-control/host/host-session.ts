import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RemoteChannelDisposition } from '@canopy/desktop-shared/remote-control/channel-dispositions';
import type { BrowserWindow } from 'electron';
import { ChatEventInterestFilter } from '../../ipc/chat-event-interest';
import { getObservabilityService } from '../../observability';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import {
  compatibleRemoteVersions,
  describeLegacyControllerRefusal,
} from '../protocol-version';
import {
  AppAdvisorWindowStateParamsSchema,
  AccountProxySignInCallbackParamsSchema,
  DialogOpenResultSchema,
  HelloParamsSchema,
  FileReadParamsSchema,
  InvokeParamsSchema,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  RemoteProtocolMismatchError,
  RemoteChannelUnavailableError,
  UnknownRemoteMethodError,
  UploadPutParamsSchema,
  type AppAdvisorWindowParams,
  type AppAdvisorWindowStateParams,
  type AccountProxySignInCallbackParams,
  type AccountProxySignInOpenParams,
  type DialogOpenParams,
  type DialogOpenResult,
  type HelloResult,
  type RemoteVersion,
  type RemoteSessionEndReason,
} from '../remote-protocol';
import { RpcPeer } from '../transport/rpc-peer';
import type {
  SecureSession,
  SessionCloseReason,
} from '../transport/session-manager';
import type { HostBridge } from './bridge-window';
import type { HostFileReader } from './file-reads';
import type { MainWindowPushSource } from './main-window-pushes';
import { createPushForwarder, type PushForwarder } from './push-forwarder';
import { RemotePushSummaryAccumulator } from './push-summary';
import type { RemoteUploadStore } from './uploads';

export interface HostSessionOptions {
  session: SecureSession;
  /** One bridge per controller window, made on that window's first call. */
  createBridge: (surface: RemoteSurface) => Promise<HostBridge>;
  mainWindowPushes: MainWindowPushSource;
  uploads: RemoteUploadStore;
  /** Reads files the controller opens in its own default app. */
  readFile: HostFileReader;
  disposition: (channel: string) => RemoteChannelDisposition;
  /**
   * Whether the controller may still control this computer. Checked on every
   * request, so a revocation holds even if a session outlived it.
   */
  isAuthorized: () => boolean;
  /** This computer's version; a controller on another protocol is refused. */
  version: RemoteVersion;
  hello: () => Pick<HelloResult, 'name' | 'platform'>;
  onClose: (reason: SessionCloseReason) => void;
  /** The bridge warmed after hello could not start. */
  onBridgeError?: (error: unknown) => void;
  /** The controller's App Advisor window for this computer changed. */
  onAppAdvisorWindowState?: (state: AppAdvisorWindowStateParams) => void;
  /**
   * Hands this controller's account proxy sign-in redirect to the proxy.
   * Without it the host answers that it does not serve the method.
   */
  completeAccountProxySignIn?: (
    controllerDeviceId: string,
    callback: AccountProxySignInCallbackParams,
  ) => Promise<void>;
}

const APP_ADVISOR_WINDOW_TIMEOUT_MS = 15_000;

/**
 * One controller's live session on this computer: replays each controller
 * window's calls through its own bridge window and forwards this computer's
 * pushes back. Nothing is replayed or forwarded until the controller's hello
 * shows it speaks the same protocol version as this computer.
 */
export class RemoteHostSession {
  readonly rpc: RpcPeer;
  private readonly bridges = new Map<RemoteSurface, Promise<HostBridge>>();
  private readonly startedBridges = new Map<RemoteSurface, HostBridge>();
  private forwarder: PushForwarder | null = null;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly chatEventInterestFilter = new ChatEventInterestFilter();
  private closed = false;
  private readonly pushSummary = new RemotePushSummaryAccumulator(
    () => this.startedBridges.get('main')?.getChatInterest(),
    (remotePushSummary) => {
      try {
        getObservabilityService().recordAppDiagnostic({
          version: 1,
          timestamp: new Date().toISOString(),
          kind: 'remote_push_summary',
          remotePushSummary,
        });
      } catch {
        // A best-effort local diagnostic cannot hold a remote session open.
      }
    },
  );
  private compatible = false;
  private readonly closedListeners = new Set<() => void>();

  constructor(private readonly options: HostSessionOptions) {
    this.rpc = new RpcPeer(options.session, {
      onRequest: (method: string, params: unknown): Promise<unknown> =>
        this.handleRequest(method, params),
      onEvent: (name: string, payload: unknown): void =>
        this.handleEvent(name, payload),
    });
    this.rpc.onClose((reason) => this.handleClosed(reason));
    if (this.rpc.isClosed) this.pushSummary.close();
  }

  get controllerDeviceId(): string {
    return this.options.session.peerDeviceId;
  }

  /** Starts the main window's bridge and push forwarding. */
  start(): Promise<HostBridge> {
    return this.bridgeFor('main');
  }

  /**
   * The bridge for one controller window, started on first use once the
   * versions match. Its pushes go to that window only.
   */
  bridgeFor(surface: RemoteSurface): Promise<HostBridge> {
    const existing = this.bridges.get(surface);
    if (existing) return existing;
    if (!this.compatible) return Promise.reject(this.mismatchError());
    const forwarder = this.ensureForwarding();
    const bridge = this.options.createBridge(surface).then(
      (created) => {
        if (this.closed) {
          created.destroy();
          throw new Error('The remote session ended.');
        }
        this.startedBridges.set(surface, created);
        this.unsubscribers.push(
          created.onPush((channel, args) =>
            forwarder.offer(channel, args, surface),
          ),
          // A bridge that dies (its renderer crashed) cannot be reused: end
          // the session, and the controller reconnects to a fresh one.
          created.onClosed(() => this.rpc.close('protocol_error')),
        );
        return created;
      },
      (error: unknown) => {
        this.rpc.close('protocol_error');
        throw error;
      },
    );
    bridge.catch(() => undefined);
    this.bridges.set(surface, bridge);
    return bridge;
  }

  /** A started bridge's hidden window; main sends to it to reach that window. */
  bridgeWindow(surface: RemoteSurface): BrowserWindow | null {
    return this.startedBridges.get(surface)?.window ?? null;
  }

  /** Asks the controller to show, create or hide its App Advisor window. */
  async requestAppAdvisorWindow(
    params: AppAdvisorWindowParams,
  ): Promise<AppAdvisorWindowStateParams> {
    return AppAdvisorWindowStateParamsSchema.parse(
      await this.rpc.request(REMOTE_METHODS.appAdvisorWindow, params, {
        timeoutMs: APP_ADVISOR_WINDOW_TIMEOUT_MS,
      }),
    );
  }

  private ensureForwarding(): PushForwarder {
    if (this.forwarder) return this.forwarder;
    const forwarder = createPushForwarder(
      (channel, args, surface) => {
        if (this.options.disposition(channel) !== 'tunnel') return;
        this.forwardPush(channel, args, surface);
      },
      undefined,
      () => Array.from(this.bridges.keys()),
      () => this.pushSummary.duplicateDropped(),
    );
    this.forwarder = forwarder;
    this.unsubscribers.push(
      this.options.mainWindowPushes.subscribe((channel, args) =>
        forwarder.offer(channel, args),
      ),
    );
    return forwarder;
  }

  private forwardPush(
    channel: string,
    args: unknown[],
    surface?: RemoteSurface,
  ): void {
    if (
      channel === IPC_CHANNELS.chatEvent &&
      surface === undefined &&
      this.startedBridges.size > 1
    ) {
      for (const target of Array.from(this.startedBridges.keys())) {
        this.forwardPush(channel, args, target);
      }
      return;
    }
    const bridge = this.startedBridges.get(surface ?? 'main');
    const interest = bridge?.getChatInterest();
    if (
      channel === IPC_CHANNELS.chatEvent &&
      bridge &&
      this.chatEventInterestFilter.shouldDrop(bridge, interest, args[0])
    )
      return;
    let bytes = 0;
    const sent = this.rpc.notify(
      REMOTE_EVENTS.push,
      surface === undefined ? { channel, args } : { channel, args, surface },
      (serializedBytes) => {
        bytes = serializedBytes;
      },
    );
    if (sent)
      this.pushSummary.forwarded(channel, args, bytes, interest ?? null);
  }

  close(reason: SessionCloseReason): void {
    this.rpc.close(reason);
  }

  /** Ends the session on purpose and tells the controller not to come back. */
  end(reason: RemoteSessionEndReason): void {
    if (this.closed) return;
    this.rpc.notify(REMOTE_EVENTS.ended, { reason });
    this.rpc.close('revoked');
  }

  /** Shows a handler's file dialog on the controlling computer. */
  async showOpenDialog(params: DialogOpenParams): Promise<DialogOpenResult> {
    const result = DialogOpenResultSchema.parse(
      await this.rpc.request(REMOTE_METHODS.dialogOpen, params, {
        timeoutMs: null,
      }),
    );
    return result;
  }

  /**
   * Opens an account proxy sign-in page in the controller's browser, which
   * catches the redirect and sends it back with
   * `account-proxy.sign-in.callback`.
   */
  async openAccountProxySignIn(
    params: AccountProxySignInOpenParams,
  ): Promise<void> {
    if (!this.compatible) throw this.mismatchError();
    await this.rpc.request(REMOTE_METHODS.accountProxySignInOpen, params);
  }

  /** Tells the controller to stop listening for that sign-in. */
  endAccountProxySignIn(state: string): void {
    if (this.closed) return;
    this.rpc.notify(REMOTE_EVENTS.accountProxySignInEnded, { state });
  }

  /** Called once when the session closes; at once if it already has. */
  onClosed(listener: () => void): () => void {
    if (this.closed) {
      listener();
      return () => undefined;
    }
    this.closedListeners.add(listener);
    return () => this.closedListeners.delete(listener);
  }

  /** Ends the session if the controller lost its authorization. */
  private ensureAuthorized(): boolean {
    if (this.options.isAuthorized()) return true;
    this.end('revoked');
    return false;
  }

  private async handleRequest(
    method: string,
    params: unknown,
  ): Promise<unknown> {
    if (!this.ensureAuthorized()) {
      throw new Error('This computer no longer allows remote control.');
    }
    switch (method) {
      case REMOTE_METHODS.hello:
        return this.handleHello(params);
      case REMOTE_METHODS.invoke: {
        if (!this.compatible) throw this.mismatchError();
        const { channel, args, surface } = InvokeParamsSchema.parse(params);
        if (this.options.disposition(channel) !== 'tunnel') {
          throw new RemoteChannelUnavailableError(channel);
        }
        const bridge = await this.bridgeFor(surface ?? 'main');
        return bridge.invoke(channel, args);
      }
      case REMOTE_METHODS.uploadPut: {
        if (!this.compatible) throw this.mismatchError();
        const { fileName, bytes } = UploadPutParamsSchema.parse(params);
        const path = await this.options.uploads.put(
          this.controllerDeviceId,
          fileName,
          bytes,
        );
        return { path };
      }
      case REMOTE_METHODS.fileRead:
        if (!this.compatible) throw this.mismatchError();
        return this.options.readFile(FileReadParamsSchema.parse(params));
      case REMOTE_METHODS.accountProxySignInCallback: {
        const complete = this.options.completeAccountProxySignIn;
        if (!complete) throw new UnknownRemoteMethodError(method);
        if (!this.compatible) throw this.mismatchError();
        await complete(
          this.controllerDeviceId,
          AccountProxySignInCallbackParamsSchema.parse(params),
        );
        return { accepted: true };
      }
      default:
        throw new UnknownRemoteMethodError(method);
    }
  }

  /**
   * Identifies this computer. A controller on another protocol version gets
   * the answer so it can say which computer to update, but is never served;
   * one that predates the check cannot read it and is refused outright.
   */
  private handleHello(params: unknown): HelloResult {
    const hello: HelloResult = {
      ...this.options.hello(),
      appVersion: this.options.version.appVersion,
      version: this.options.version,
    };
    const parsed = HelloParamsSchema.safeParse(params);
    if (!parsed.success) throw this.mismatchError();
    if (!compatibleRemoteVersions(parsed.data.version, this.options.version)) {
      return hello;
    }
    this.compatible = true;
    // Warm the bridge so the controller's first calls do not wait for it.
    this.start().catch((error: unknown) => this.options.onBridgeError?.(error));
    return hello;
  }

  private mismatchError(): RemoteProtocolMismatchError {
    return new RemoteProtocolMismatchError(
      describeLegacyControllerRefusal(
        this.options.hello().name,
        this.options.version,
      ),
    );
  }

  private handleEvent(name: string, payload: unknown): void {
    if (!this.compatible) return;
    if (!this.ensureAuthorized()) return;
    if (name === REMOTE_EVENTS.appAdvisorWindowState) {
      const state = AppAdvisorWindowStateParamsSchema.safeParse(payload);
      if (state.success) this.options.onAppAdvisorWindowState?.(state.data);
      return;
    }
    if (name !== REMOTE_EVENTS.ipcSend) return;
    const parsed = InvokeParamsSchema.safeParse(payload);
    if (!parsed.success) return;
    const { channel, args, surface } = parsed.data;
    if (this.options.disposition(channel) !== 'tunnel') return;
    void this.bridgeFor(surface ?? 'main').then(
      (bridge) => bridge.post(channel, args),
      () => undefined,
    );
  }

  private handleClosed(reason: SessionCloseReason): void {
    if (this.closed) return;
    this.closed = true;
    this.pushSummary.close();
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers.length = 0;
    for (const bridge of Array.from(this.bridges.values())) {
      void bridge.then(
        (created) => created.destroy(),
        () => undefined,
      );
    }
    for (const listener of Array.from(this.closedListeners)) listener();
    this.closedListeners.clear();
    this.options.onClose(reason);
  }
}
