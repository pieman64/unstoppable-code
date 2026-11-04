import type {
  PairingTelemetryAttempt,
  PairingTelemetryContext,
  PairingTelemetryOutcome,
  PairingTelemetryRecorder,
} from '@canopy/desktop-instrumentation/pairing';
import { getSecretStoragePolicy } from '../../lib/secure-storage-policy';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@canopy/desktop-shared/types';
import type { RemoteControlState } from '@canopy/desktop-shared/types';
import type { DeviceRelayTokenResponse } from '@canopy/protocol/device-relay';
import {
  getRemoteChannelDisposition,
  getRemoteChannelDispositions,
} from '@canopy/desktop-shared/remote-control/channel-dispositions';
import { createHostFileReader, type HostFileReader } from '../host/file-reads';
import { RemoteUploadStore } from '../host/uploads';
import { RemoteAccessStore } from '../remote-access-store';
import {
  RemoteControlService,
  type RemoteControlWindows,
  type RemoteRelay,
  type RemoteRelayFactoryOptions,
} from '../remote-control-service';
import type {
  AppAdvisorWindowParams,
  AppAdvisorWindowStateParams,
  DialogOpenParams,
  DialogOpenResult,
  RemoteVersion,
} from '../remote-protocol';
import type { PairedDevice } from '../remote-access-store';
import {
  flushRelay,
  InMemoryRelayEndpoint,
  InMemoryRelayHub,
} from './in-memory-relay';
import type { RemoteSurface } from '@canopy/desktop-shared/remote-control/surfaces';
import { RemoteAppAdvisorSurface } from '../host/app-advisor-surface';
import type { HostBridge } from '../host/bridge-window';
import { FakeBridge, FakeMainWindow, TEST_VERSION } from './host-fakes';
import { createTestDevice } from './session-pair';
import { RpcPeer } from '../transport/rpc-peer';
import {
  REMOTE_FILE_OPEN_MAX_BYTES,
  REMOTE_METHODS,
  REMOTE_PROTOCOL_VERSION,
} from '../remote-protocol';
import * as atomicFile from '../../lib/atomic-file';

jest.mock('../../lib/atomic-file', () => {
  const actual: typeof atomicFile = jest.requireActual('../../lib/atomic-file');
  return {
    ...actual,
    writeFileAtomically: jest.fn(actual.writeFileAtomically),
  };
});

const writeMock = jest.mocked(atomicFile.writeFileAtomically);
const realWrite: typeof atomicFile.writeFileAtomically = jest.requireActual<
  typeof atomicFile
>('../../lib/atomic-file').writeFileAtomically;

const TUNNEL_CHANNEL = IPC_CHANNELS.chatSendMessage;
/** Small parts, so copies span several reads without megabytes of work. */
const TEST_FILE_READ_CHUNK_BYTES = 16 * 1024;
const LOCAL_CHANNEL = IPC_CHANNELS.updateEvent;

function firstChannelWith(disposition: 'blocked' | 'local'): string {
  for (const [channel, value] of Array.from(getRemoteChannelDispositions())) {
    if (value === disposition) return channel;
  }
  throw new Error(`No ${disposition} channel.`);
}

class FakeWindows implements RemoteControlWindows {
  readonly opened: string[] = [];
  readonly pushes: Array<{
    deviceId: string;
    channel: string;
    args: unknown[];
    surface?: RemoteSurface;
  }> = [];
  readonly appAdvisorRequests: Array<{
    deviceId: string;
    params: AppAdvisorWindowParams;
  }> = [];
  readonly reloads: string[] = [];
  readonly closed: string[] = [];
  focusedLocal = 0;
  dialogResult: DialogOpenResult = { canceled: true, filePaths: [] };
  dialogRequests: DialogOpenParams[] = [];

  open(host: PairedDevice): void {
    this.opened.push(host.deviceId);
  }
  close(deviceId: string): void {
    this.closed.push(deviceId);
  }
  focusLocal(): void {
    this.focusedLocal += 1;
  }
  deliverPush(
    deviceId: string,
    channel: string,
    args: unknown[],
    surface?: RemoteSurface,
  ): void {
    this.pushes.push({
      deviceId,
      channel,
      args,
      ...(surface === undefined ? {} : { surface }),
    });
  }
  appAdvisorWindow(
    deviceId: string,
    params: AppAdvisorWindowParams,
  ): Promise<AppAdvisorWindowStateParams> {
    this.appAdvisorRequests.push({ deviceId, params });
    return Promise.resolve({
      open: params.action === 'open',
      focused: params.action === 'open' && params.focus !== false,
    });
  }
  reload(deviceId: string): void {
    this.reloads.push(deviceId);
  }
  showDialog(
    _deviceId: string,
    params: DialogOpenParams,
  ): Promise<DialogOpenResult> {
    this.dialogRequests.push(params);
    return Promise.resolve(this.dialogResult);
  }
}

interface Machine {
  pairingTelemetry: Array<{
    context: PairingTelemetryContext;
    outcomes: PairingTelemetryOutcome[];
  }>;
  name: string;
  service: RemoteControlService;
  store: RemoteAccessStore;
  endpoint: () => InMemoryRelayEndpoint | null;
  bridges: FakeBridge[];
  bridgeSurfaces: RemoteSurface[];
  /** Commands each App Advisor open request resolved to. */
  appAdvisorCommands: unknown[];
  mainWindow: FakeMainWindow;
  windows: FakeWindows;
  states: RemoteControlState[];
  /** Files the machine opened in its own default apps. */
  openedLocally: string[];
  /** Files the machine marked as downloaded before opening them. */
  marked: string[];
  dir: string;
  /** Every relay connection the machine started, oldest first. */
  relays: InMemoryRelayEndpoint[];
  /** The signed-in account; set to switch accounts. */
  account: { current: string | null };
  /** Whether remote control is available; set to turn it off. */
  feature: { enabled: boolean };
}

interface MachineOptions {
  recordPairing?: PairingTelemetryRecorder;
  existingDir?: string;
  discoveryWindowMs?: number;
  version?: RemoteVersion;
  /** Serves `file.read` as this computer; defaults to a real reader. */
  readHostFile?: HostFileReader;
  markDownloaded?: (path: string) => Promise<void>;
}

const tempDirs: string[] = [];
const services: RemoteControlService[] = [];
const stores: RemoteAccessStore[] = [];

/** A computer; pass the `dir` of an earlier one to start it again. */
function createMachine(
  hub: InMemoryRelayHub,
  name: string,
  options: MachineOptions = {},
): Machine {
  const { existingDir } = options;
  const dir =
    existingDir ?? mkdtempSync(join(tmpdir(), `remote-control-${name}-`));
  if (existingDir === undefined) tempDirs.push(dir);
  const store = new RemoteAccessStore({
    settingsPath: join(dir, 'remote-control.json'),
    identityPath: join(dir, 'identity.key'),
    secretStorage: getSecretStoragePolicy(),
  });
  stores.push(store);
  const bridges: FakeBridge[] = [];
  const bridgeSurfaces: RemoteSurface[] = [];
  const appAdvisorCommands: unknown[] = [];
  const mainWindow = new FakeMainWindow();
  const windows = new FakeWindows();
  const states: RemoteControlState[] = [];
  const openedLocally: string[] = [];
  const marked: string[] = [];
  let endpoint: InMemoryRelayEndpoint | null = null;
  const relays: InMemoryRelayEndpoint[] = [];
  const account: { current: string | null } = { current: 'account-1' };
  const feature = { enabled: true };
  const pairingTelemetry: Machine['pairingTelemetry'] = [];
  const service = new RemoteControlService({
    recordPairing:
      options.recordPairing ??
      ((context): PairingTelemetryAttempt => {
        const outcomes: PairingTelemetryOutcome[] = [];
        pairingTelemetry.push({ context, outcomes });
        return {
          end: (outcome): void => {
            outcomes.push(outcome);
          },
        };
      }),
    store,
    createRelay: (options: RemoteRelayFactoryOptions): RemoteRelay => {
      endpoint = new InMemoryRelayEndpoint(
        hub,
        options.deviceInfo,
        options.onPeersChange,
      );
      relays.push(endpoint);
      return endpoint;
    },
    fetchToken: (): Promise<DeviceRelayTokenResponse> =>
      Promise.reject(new Error('unused')),
    isFeatureEnabled: (): boolean => feature.enabled,
    signedInAccount: (): string | null => account.current,
    deviceName: (): string => name,
    platform: 'darwin',
    version: options.version ?? TEST_VERSION,
    createBridge: (
      _controllerDeviceId: string,
      surface: RemoteSurface,
    ): Promise<HostBridge> => {
      const bridge = new FakeBridge();
      bridges.push(bridge);
      bridgeSurfaces.push(surface);
      return Promise.resolve(bridge);
    },
    createAppAdvisorSurface: (session): RemoteAppAdvisorSurface =>
      new RemoteAppAdvisorSurface({
        controllerDeviceId: session.controllerDeviceId,
        bridgeFor: (surface) => session.bridgeFor(surface),
        bridgeWindow: (surface) => session.bridgeWindow(surface),
        requestWindow: (params) => session.requestAppAdvisorWindow(params),
        sendRequestCommands: (request, send): Promise<void> => {
          if (request?.chatId)
            send({ type: 'select_chat', chatId: request.chatId });
          return Promise.resolve();
        },
        sendToWindow: (_window, channel, payload): void => {
          if (channel === IPC_CHANNELS.appAdvisorWindowCommand) {
            appAdvisorCommands.push(payload);
          }
        },
        redeliverQuestions: () => undefined,
      }),
    mainWindowPushes: mainWindow,
    uploads: new RemoteUploadStore(join(dir, 'uploads')),
    readHostFile:
      options.readHostFile ??
      createHostFileReader({
        authorize: () => Promise.resolve(null),
        maxBytes: REMOTE_FILE_OPEN_MAX_BYTES,
      }),
    openedFiles: new RemoteUploadStore(join(dir, 'opened-files')),
    markDownloaded:
      options.markDownloaded ??
      ((path: string): Promise<void> => {
        marked.push(path);
        return Promise.resolve();
      }),
    fileReadChunkBytes: TEST_FILE_READ_CHUNK_BYTES,
    openLocalFile: (path: string): Promise<void> => {
      openedLocally.push(path);
      return Promise.resolve();
    },
    windows,
    broadcastState: (state: RemoteControlState): void => {
      states.push(state);
    },
    ...(options.discoveryWindowMs === undefined
      ? {}
      : { discoveryWindowMs: options.discoveryWindowMs }),
  });
  services.push(service);
  return {
    pairingTelemetry,
    name,
    service,
    store,
    endpoint: () => endpoint,
    bridges,
    bridgeSurfaces,
    appAdvisorCommands,
    mainWindow,
    windows,
    states,
    openedLocally,
    marked,
    dir,
    relays,
    account,
    feature,
  };
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  accept: (value: T) => boolean,
  timeoutMs = 4_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() > deadline) throw new Error('Condition not reached.');
    await flushRelay(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function pair(controller: Machine, host: Machine): Promise<void> {
  await host.service.setAllowIncoming(true);
  const hostId = (await host.store.identity()).deviceId;
  await waitFor(
    () => controller.service.getState({ discover: true }),
    (state) => state.discoverable.some((device) => device.deviceId === hostId),
  );
  await controller.service.startPairing(hostId);
  const hostState = await waitFor(
    () => host.service.getState(),
    (state) => state.incomingPairings.length === 1,
  );
  const controllerState = await waitFor(
    () => controller.service.getState(),
    (state) => state.outgoingPairing?.status === 'awaiting-approval',
  );
  const incoming = hostState.incomingPairings[0];
  if (!incoming) throw new Error('No incoming pairing.');
  expect(incoming.code).toMatch(/^\d{6}$/);
  expect(controllerState.outgoingPairing?.code).toBe(incoming.code);
  expect(incoming.name).toBe(controller.name);
  await host.service.respondToPairing({
    pairingId: incoming.pairingId,
    approve: true,
  });
  await waitFor(
    () => controller.service.getState(),
    (state) => state.outgoingPairing?.status === 'approved',
  );
}

afterEach(async () => {
  for (const service of services.splice(0)) service.dispose();
  // A save still running would write into a directory removed below.
  await Promise.all(stores.splice(0).map((store) => store.whenIdle()));
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('RemoteControlService', () => {
  it('stays off the relay until remote control is used', async () => {
    const hub = new InMemoryRelayHub();
    const machine = createMachine(hub, 'idle');
    await machine.service.initialize();
    expect(machine.endpoint()).toBeNull();
    const state = await machine.service.getState();
    expect(state.relayStatus).toBe('stopped');
    expect(state.allowIncoming).toBe(false);
    // Startup and state reads never create the key or touch the keychain.
    expect(state.thisDevice).toBeNull();
    expect(existsSync(join(machine.dir, 'identity.key'))).toBe(false);
  });

  it('pairs two computers after approval on the controlled one', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);

    expect(laptop.pairingTelemetry).toEqual([
      {
        context: {
          pairing_kind: 'computer_outgoing',
          pairing_entry: 'pair_computer_dialog',
          peer_platform: 'darwin',
        },
        outcomes: ['approved'],
      },
    ]);
    expect(desktop.pairingTelemetry).toEqual([
      {
        context: {
          pairing_kind: 'computer_incoming',
          pairing_entry: 'incoming_prompt',
          peer_platform: 'darwin',
        },
        outcomes: ['approved'],
      },
    ]);
    await laptop.service.cancelPairing();
    expect(laptop.pairingTelemetry[0]?.outcomes).toEqual(['approved']);
    const laptopState = await laptop.service.getState();
    const desktopState = await desktop.service.getState();
    expect(laptopState.hosts).toEqual([
      expect.objectContaining({ name: 'desktop', online: true }),
    ]);
    expect(desktopState.controllers).toEqual([
      expect.objectContaining({ name: 'laptop', online: true }),
    ]);
    const pinned = await laptop.store.read();
    expect(pinned.pairedHosts[0]?.publicKey).toBe(
      (await desktop.store.identity()).publicKey,
    );
  });

  it('does not pair when the controlled computer declines', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    await laptop.service.startPairing(desktopId);
    const incoming = await waitFor(
      () => desktop.service.getState(),
      (state) => state.incomingPairings.length === 1,
    );
    await desktop.service.respondToPairing({
      pairingId: incoming.incomingPairings[0]?.pairingId ?? '',
      approve: false,
    });
    await waitFor(
      () => laptop.service.getState(),
      (state) => state.outgoingPairing?.status === 'rejected',
    );
    expect(laptop.pairingTelemetry[0]?.outcomes).toEqual(['rejected']);
    expect(desktop.pairingTelemetry[0]?.outcomes).toEqual(['declined']);
    expect((await laptop.store.read()).pairedHosts).toEqual([]);
    expect((await desktop.store.read()).pairedControllers).toEqual([]);
  });

  it('tunnels calls and pushes once the computer is opened', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;

    await laptop.service.openMachine(desktopId);
    expect(laptop.windows.opened).toEqual([desktopId]);
    const result = await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, [
      { text: 'hi', at: new Date(0), bytes: new Uint8Array([1, 2]) },
    ]);
    expect(result).toEqual({
      echoed: TUNNEL_CHANNEL,
      args: [{ text: 'hi', at: new Date(0), bytes: new Uint8Array([1, 2]) }],
    });
    const bridge = desktop.bridges[0];
    if (!bridge) throw new Error('No bridge.');

    // A broadcast reaches both the app window and the bridge in one tick
    // with the same arguments; the controller must see it once.
    const payload = { chatId: 'c1' };
    desktop.mainWindow.publish(IPC_CHANNELS.chatEvent, [payload]);
    bridge.push(IPC_CHANNELS.chatEvent, [payload]);
    // A reply addressed only to the bridge is forwarded too.
    bridge.push(IPC_CHANNELS.scriptOutput, [{ line: 'x' }]);
    // This computer's own window events are not.
    desktop.mainWindow.publish(LOCAL_CHANNEL, [{ type: 'available' }]);
    await waitFor(
      () => laptop.windows.pushes.length,
      (count) => count >= 2,
    );
    await flushRelay();
    expect(laptop.windows.pushes.map((push) => push.channel)).toEqual([
      IPC_CHANNELS.chatEvent,
      IPC_CHANNELS.scriptOutput,
    ]);

    laptop.service.post(desktopId, TUNNEL_CHANNEL, ['fire']);
    await waitFor(
      () => bridge.posts.length,
      (count) => count === 1,
    );
  });

  it('pairs across protocol versions but will not control an incompatible computer', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop', {
      version: {
        protocolVersion: TEST_VERSION.protocolVersion + 1,
        appVersion: '1.1.0',
      },
    });
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const expected =
      "desktop runs version 1.1.0, which this computer (version 1.0.0) can't control. Update this computer to connect.";

    await laptop.service.openMachine(desktopId);
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow(expected);
    const state = await waitFor(
      () => laptop.service.getState(),
      (current) => current.hosts[0]?.connection === 'error',
    );
    expect(state.hosts[0]).toMatchObject({ ended: true, error: expected });
    expect(desktop.bridges).toHaveLength(0);
  });

  it.each([
    ['controller', 'this computer', 4],
    ['controller', 'this computer', 6],
    ['controller', 'this computer', 8],
    ['controller', 'this computer', 9],
    ['host', 'desktop', 4],
    ['host', 'desktop', 6],
    ['host', 'desktop', 8],
    ['host', 'desktop', 9],
    ['controller', 'this computer', 10],
    ['host', 'desktop', 10],
    ['controller', 'this computer', 11],
    ['host', 'desktop', 11],
  ] as const)(
    'refuses an incompatible %s (update %s, protocol %s) before a bridge opens',
    async (olderSide, update, protocolVersion) => {
      // Protocol 7 retires checklist channels; protocol 9 adds receipt-bound
      // skill replacement; protocol 10 adds a Labs flag key; protocol 11
      // keeps stored secrets out of environment and run-value replies;
      // protocol 12 does the same for MCP server load and save.
      // Negotiate before dispatching incompatible requests.
      expect(REMOTE_PROTOCOL_VERSION).toBeGreaterThan(protocolVersion);
      const hub = new InMemoryRelayHub();
      const older = { protocolVersion, appVersion: '0.9.0' };
      const laptop = createMachine(
        hub,
        'laptop',
        olderSide === 'controller' ? { version: older } : {},
      );
      const desktop = createMachine(
        hub,
        'desktop',
        olderSide === 'host' ? { version: older } : {},
      );
      await laptop.service.initialize();
      await desktop.service.initialize();
      await pair(laptop, desktop);
      const desktopId = (await desktop.store.identity()).deviceId;
      const laptopVersion = olderSide === 'controller' ? '0.9.0' : '1.0.0';
      const desktopVersion = olderSide === 'host' ? '0.9.0' : '1.0.0';
      const expected = `desktop runs version ${desktopVersion}, which this computer (version ${laptopVersion}) can't control. Update ${update} to connect.`;

      await laptop.service.openMachine(desktopId);
      await expect(
        laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
      ).rejects.toThrow(expected);
      const state = await waitFor(
        () => laptop.service.getState(),
        (current) => current.hosts[0]?.connection === 'error',
      );
      expect(state.hosts[0]).toMatchObject({ ended: true, error: expected });
      expect(desktop.bridges).toHaveLength(0);
    },
  );

  it('reconnects as soon as the computer is back, not after the backoff', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    const endpoint = desktop.endpoint();
    if (!endpoint) throw new Error('No relay endpoint.');
    endpoint.stop();
    await waitFor(
      () => laptop.service.getState(),
      (state) => state.hosts[0]?.connection !== 'connected',
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    const backAt = Date.now();
    endpoint.start();
    await waitFor(
      () => laptop.service.getState(),
      (state) => state.hosts[0]?.connection === 'connected',
      // Under the 1 s minimum backoff: only an immediate retry gets here.
      800,
    );
    expect(Date.now() - backAt).toBeLessThan(800);
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, ['after']),
    ).resolves.toMatchObject({ args: ['after'] });
    expect(laptop.windows.reloads).toEqual([desktopId]);
  });

  it('reconnects its host windows when the computer wakes from sleep', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    const bridgesBefore = desktop.bridges.length;

    laptop.service.handleSystemResume();
    await waitFor(
      () => laptop.windows.reloads.length,
      (count) => count === 1,
    );
    expect(laptop.windows.reloads).toEqual([desktopId]);
    // A fresh session, so the host made a fresh bridge.
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, ['awake']),
    ).resolves.toMatchObject({ args: ['awake'] });
    expect(desktop.bridges.length).toBeGreaterThan(bridgesBefore);
  });

  it('recovers when the other computer restarted without ever going offline', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);

    // Power loss: the desktop's process ends without a word, and a new one
    // with the same identity takes its relay place before the relay noticed
    // the old one was gone, so the laptop never sees it offline.
    const lost = desktop.endpoint();
    if (!lost) throw new Error('No relay endpoint.');
    lost.online = false;
    const restarted = createMachine(hub, 'desktop', {
      existingDir: desktop.dir,
    });
    await restarted.service.initialize();

    // The laptop's next message reaches a computer with no such session,
    // which says so; the laptop reconnects and reloads the window.
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, ['stale']),
    ).rejects.toThrow();
    await waitFor(
      () => laptop.windows.reloads.length,
      (count) => count === 1,
    );
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, ['fresh']),
    ).resolves.toMatchObject({ args: ['fresh'] });
    expect(restarted.bridges).toHaveLength(1);
  });

  it('refuses blocked channels on both computers', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    const blocked = firstChannelWith('blocked');
    expect(getRemoteChannelDisposition(blocked)).toBe('blocked');
    await expect(laptop.service.invoke(desktopId, blocked, [])).rejects.toThrow(
      'not available while controlling another computer',
    );
    await expect(
      laptop.service.invoke(desktopId, 'not:a-real-channel', []),
    ).rejects.toThrow('not available');
  });

  it('stores uploaded files on the controlled computer and returns their path', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);

    const [first, second] = await Promise.all([
      laptop.service.upload(
        desktopId,
        'notes.txt',
        new TextEncoder().encode('hello'),
      ),
      laptop.service.upload(
        desktopId,
        'notes.txt',
        new TextEncoder().encode('again'),
      ),
    ]);

    expect(first).toContain(join(desktop.dir, 'uploads'));
    // Same name, separate files: neither upload overwrites the other.
    expect(second).not.toBe(first);
    expect(readFileSync(first, 'utf8')).toBe('hello');
    expect(readFileSync(second, 'utf8')).toBe('again');
    // The path is then used as is, like any path on that computer.
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, [
      { filePaths: [first] },
    ]);
    expect(desktop.bridges[0]?.invocations.at(-1)?.args).toEqual([
      { filePaths: [first] },
    ]);
  });

  it('opens a file from the controlled computer on the controller', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    // A document, which a preview never carries, spanning several reads.
    const document = randomBytes(2 * TEST_FILE_READ_CHUNK_BYTES + 123);
    const absolutePath = join(desktop.dir, 'report.pdf');
    writeFileSync(absolutePath, document);

    await laptop.service.invoke(desktopId, IPC_CHANNELS.fileOpenExternal, [
      { absolutePath },
    ]);

    // The controlled computer only reads the file; nothing opens on its screen.
    expect(desktop.bridges.flatMap((bridge) => bridge.invocations)).toEqual([]);
    expect(desktop.openedLocally).toEqual([]);
    const [opened] = laptop.openedLocally;
    if (!opened) throw new Error('Nothing opened.');
    expect(opened.startsWith(join(laptop.dir, 'opened-files', desktopId))).toBe(
      true,
    );
    expect(opened.endsWith('report.pdf')).toBe(true);
    expect(laptop.marked).toEqual([opened]);
    expect(readFileSync(opened).equals(document)).toBe(true);
    expect((statSync(opened).mode % 0o1000).toString(8)).toBe('600');
  });

  it('opens pictures through previews on computers without file reads', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    // Hosts released before file reads answer with this message alone.
    const desktop = createMachine(hub, 'desktop', {
      readHostFile: () =>
        Promise.reject(new Error('Unknown remote method file.read.')),
    });
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    const bridge = desktop.bridges[0];
    if (!bridge) throw new Error('No bridge.');
    const pixels = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    const picture = '/Users/host/snapper.png';
    const document = '/Users/host/report.pdf';
    bridge.handler = (_channel, args): Promise<unknown> =>
      Promise.resolve(
        JSON.stringify(args) === JSON.stringify([{ absolutePath: picture }])
          ? {
              kind: 'image',
              content: `data:image/png;base64,${Buffer.from(pixels).toString('base64')}`,
              filename: 'snapper.png',
              sizeBytes: pixels.byteLength,
              truncated: false,
              modifiedAtMs: 0,
            }
          : {
              kind: 'unsupported',
              content: '',
              filename: 'report.pdf',
              sizeBytes: 9,
              truncated: false,
              modifiedAtMs: 0,
            },
      );

    await laptop.service.invoke(desktopId, IPC_CHANNELS.fileOpenExternal, [
      { absolutePath: picture },
    ]);
    await expect(
      laptop.service.invoke(desktopId, IPC_CHANNELS.fileOpenExternal, [
        { absolutePath: document },
      ]),
    ).rejects.toThrow('not available while controlling another computer');

    expect(bridge.invocations.slice(-2)).toEqual([
      {
        channel: IPC_CHANNELS.fileReadPreview,
        args: [{ absolutePath: picture }],
      },
      {
        channel: IPC_CHANNELS.fileReadPreview,
        args: [{ absolutePath: document }],
      },
    ]);
    expect(laptop.openedLocally).toHaveLength(1);
    const [opened] = laptop.openedLocally;
    if (!opened) throw new Error('Nothing opened.');
    expect(laptop.marked).toEqual([opened]);
    expect(new Uint8Array(readFileSync(opened))).toEqual(pixels);
  });

  it('abandons a copy when the window closes partway, without reconnecting', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const reader = createHostFileReader({
      authorize: () => Promise.resolve(null),
      maxBytes: REMOTE_FILE_OPEN_MAX_BYTES,
    });
    const reads: number[] = [];
    let desktopId = '';
    const desktop = createMachine(hub, 'desktop', {
      readHostFile: (params) => {
        reads.push(params.offset);
        // The window closes while the second part is on its way.
        if (params.offset > 0) laptop.service.releaseMachine(desktopId);
        return reader(params);
      },
    });
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    const absolutePath = join(desktop.dir, 'report.pdf');
    writeFileSync(absolutePath, randomBytes(3 * TEST_FILE_READ_CHUNK_BYTES));
    const controllerConnected = async (): Promise<boolean> =>
      (await desktop.service.getState()).controllers.some(
        (controller) => controller.connected,
      );

    await expect(
      laptop.service.invoke(desktopId, IPC_CHANNELS.fileOpenExternal, [
        { absolutePath },
      ]),
    ).rejects.toThrow('connection to the other computer closed');
    await waitFor(controllerConnected, (connected) => !connected);
    await flushRelay(4);

    expect(reads).toEqual([0, TEST_FILE_READ_CHUNK_BYTES]);
    expect(await controllerConnected()).toBe(false);
    expect(laptop.openedLocally).toEqual([]);
    expect(laptop.marked).toEqual([]);
    expect(readdirSync(join(laptop.dir, 'opened-files', desktopId))).toEqual(
      [],
    );
  });

  it('refuses files that are too large, run programs or cannot be marked', async () => {
    const hub = new InMemoryRelayHub();
    const markDownloaded = jest.fn(
      (): Promise<void> => Promise.reject(new Error('Could not mark.')),
    );
    const laptop = createMachine(hub, 'laptop', { markDownloaded });
    const desktop = createMachine(hub, 'desktop', {
      readHostFile: createHostFileReader({
        authorize: () => Promise.resolve(null),
        maxBytes: 8,
      }),
    });
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    const open = (request: unknown): Promise<unknown> =>
      laptop.service.invoke(desktopId, IPC_CHANNELS.fileOpenExternal, [
        request,
      ]);
    const large = join(desktop.dir, 'movie.mov');
    writeFileSync(large, Buffer.alloc(9));
    const small = join(desktop.dir, 'notes.txt');
    writeFileSync(small, 'notes');

    await expect(open({ absolutePath: large })).rejects.toThrow(
      "Couldn't open movie.mov. Files over",
    );
    await expect(
      open({ absolutePath: join(desktop.dir, 'setup.exe') }),
    ).rejects.toThrow('can run programs');
    await expect(open({})).rejects.toThrow('Invalid file.');
    await expect(open({ absolutePath: small })).rejects.toThrow(
      'Could not mark.',
    );

    expect(markDownloaded).toHaveBeenCalledTimes(1);
    expect(laptop.openedLocally).toEqual([]);
    expect(readdirSync(join(laptop.dir, 'opened-files', desktopId))).toEqual(
      [],
    );
  });

  it('runs App Advisor for the controlled computer in a window on the controller', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);

    // The laptop's sidebar asks the desktop to open App Advisor.
    const surface = desktop.service.appAdvisorSurfaceForController(laptopId);
    if (!surface) throw new Error('No App Advisor surface.');
    await expect(
      surface.openAppAdvisorWindow({ chatId: 'chat-1', focus: true }),
    ).resolves.toEqual({ open: true, focused: true, layout: 'full' });
    expect(laptop.windows.appAdvisorRequests).toEqual([
      { deviceId: desktopId, params: { action: 'ensure' } },
      { deviceId: desktopId, params: { action: 'open', focus: true } },
    ]);
    expect(desktop.bridgeSurfaces).toEqual(['main', 'app-advisor']);
    expect(desktop.appAdvisorCommands).toEqual([
      { type: 'select_chat', chatId: 'chat-1' },
    ]);

    // The App Advisor window's own calls reach the desktop's App Advisor
    // bridge, and that bridge's pushes reach only that window.
    await laptop.service.invoke(
      desktopId,
      TUNNEL_CHANNEL,
      ['ready'],
      'app-advisor',
    );
    expect(desktop.bridges[1]?.invocations).toEqual([
      { channel: TUNNEL_CHANNEL, args: ['ready'] },
    ]);
    const request = { kind: 'get_current_ui_state', requestId: 'r1' };
    desktop.bridges[1]?.push(IPC_CHANNELS.appAdvisorToolRequest, [request]);
    await waitFor(
      () => laptop.windows.pushes,
      (pushes) =>
        pushes.some(
          (push) => push.channel === IPC_CHANNELS.appAdvisorToolRequest,
        ),
    );
    expect(
      laptop.windows.pushes.filter(
        (push) => push.channel === IPC_CHANNELS.appAdvisorToolRequest,
      ),
    ).toEqual([
      {
        deviceId: desktopId,
        channel: IPC_CHANNELS.appAdvisorToolRequest,
        args: [request],
        surface: 'app-advisor',
      },
    ]);

    // Closing it on the laptop is reported back to the desktop.
    laptop.service.reportAppAdvisorWindowState(desktopId, {
      open: false,
      focused: false,
    });
    await waitFor(
      () => surface.getAppAdvisorWindowState(),
      (state) => !state.open,
    );
  });

  it('shows dialogs raised on the controlled computer on the controller', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    laptop.windows.dialogResult = {
      canceled: false,
      filePaths: ['/Users/me/repo'],
    };
    const session = desktop.service.hostSessionForController(laptopId);
    if (!session) throw new Error('No host session.');
    await expect(
      session.showOpenDialog({
        title: 'Select local repository',
        properties: ['openDirectory'],
      }),
    ).resolves.toEqual({ canceled: false, filePaths: ['/Users/me/repo'] });
    expect(laptop.windows.dialogRequests).toEqual([
      { title: 'Select local repository', properties: ['openDirectory'] },
    ]);
  });

  it('cuts off a controller when the controlled computer forgets it', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    await desktop.service.forgetDevice({
      deviceId: laptopId,
      role: 'controller',
    });
    await flushRelay();
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow();
  });

  it('cuts off a forgotten computer even when saving that fails', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    jest
      .spyOn(laptop.store, 'update')
      .mockRejectedValueOnce(new Error('Disk full.'));
    await expect(
      laptop.service.forgetDevice({ deviceId: desktopId, role: 'host' }),
    ).rejects.toThrow('Disk full.');
    expect(laptop.windows.closed).toEqual([desktopId]);
    await waitFor(
      () => desktop.service.hostSessionForController(laptopId),
      (session) => session === null,
    );
  });

  it('stops the relay after a declined pairing once discovery ends', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop', { discoveryWindowMs: 50 });
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    await laptop.service.startPairing(desktopId);
    const incoming = await waitFor(
      () => desktop.service.getState(),
      (state) => state.incomingPairings.length === 1,
    );
    await desktop.service.respondToPairing({
      pairingId: incoming.incomingPairings[0]?.pairingId ?? '',
      approve: false,
    });
    await waitFor(
      () => laptop.service.getState(),
      (state) => state.outgoingPairing?.status === 'rejected',
    );
    await waitFor(
      () => laptop.relays[0]?.connectionStatus,
      (status) => status === 'stopped',
    );
    // The outcome stays visible after the relay stops.
    expect((await laptop.service.getState()).outgoingPairing?.status).toBe(
      'rejected',
    );
  });

  it('clears a finished pairing when dismissed and keeps the computer paired', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const dismissed = await laptop.service.cancelPairing();
    expect(dismissed.outgoingPairing).toBeNull();
    expect(dismissed.hosts.map((host) => host.deviceId)).toEqual([desktopId]);
  });

  it('does not pair when cancelled before the other computer answers', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    await laptop.service.startPairing(desktopId);
    const incoming = await waitFor(
      () => desktop.service.getState(),
      (state) => state.incomingPairings.length === 1,
    );
    const cancelled = await laptop.service.cancelPairing();
    expect(cancelled.outgoingPairing).toBeNull();
    // The request ends on the other computer, and a late approval pairs nothing.
    await waitFor(
      () => desktop.service.getState(),
      (state) => state.incomingPairings.length === 0,
    );
    await desktop.service.respondToPairing({
      pairingId: incoming.incomingPairings[0]?.pairingId ?? '',
      approve: true,
    });
    await flushRelay(4);
    await desktop.store.whenIdle();
    expect(laptop.pairingTelemetry[0]?.outcomes).toEqual(['cancelled']);
    expect(desktop.pairingTelemetry[0]?.outcomes).toEqual(['failed']);
    expect((await laptop.store.read()).pairedHosts).toEqual([]);
    expect((await desktop.store.read()).pairedControllers).toEqual([]);
  });

  it('does not save an approval whose pairing was cancelled while it waited to save', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    await laptop.service.startPairing(desktopId);
    const incoming = await waitFor(
      () => desktop.service.getState(),
      (state) => state.incomingPairings.length === 1,
    );
    let releaseWrite = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writing = false;
    writeMock.mockImplementation(async (...args) => {
      if (!writing && String(args[0]).startsWith(desktop.dir)) {
        writing = true;
        await writeGate;
      }
      return realWrite(...args);
    });
    try {
      // An earlier save is still running, so the pairing's save queues.
      const savingSetting = desktop.service.setAllowIncoming(true);
      await waitFor(
        () => writing,
        (started) => started,
      );
      await laptop.service.cancelPairing();
      // Approved before the cancel reaches this computer.
      await desktop.service.respondToPairing({
        pairingId: incoming.incomingPairings[0]?.pairingId ?? '',
        approve: true,
      });
      await flushRelay(4);
      releaseWrite();
      await savingSetting;
      await desktop.store.whenIdle();
      expect((await desktop.store.read()).pairedControllers).toEqual([]);
      expect((await laptop.store.read()).pairedHosts).toEqual([]);
    } finally {
      releaseWrite();
      writeMock.mockImplementation(realWrite);
    }
  });

  it('keeps a pairing the other computer approved even if cancelled', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    let releaseWrite = (): void => undefined;
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    let writing = false;
    writeMock.mockImplementation(async (...args) => {
      if (!writing && String(args[0]).startsWith(laptop.dir)) {
        writing = true;
        await writeGate;
      }
      return realWrite(...args);
    });
    try {
      await laptop.service.startPairing(desktopId);
      const incoming = await waitFor(
        () => desktop.service.getState(),
        (state) => state.incomingPairings.length === 1,
      );
      await desktop.service.respondToPairing({
        pairingId: incoming.incomingPairings[0]?.pairingId ?? '',
        approve: true,
      });
      await waitFor(
        () => writing,
        (started) => started,
      );
      // Approval is the decision; cancelling now does not undo it.
      await laptop.service.cancelPairing();
      releaseWrite();
      const state = await waitFor(
        () => laptop.service.getState(),
        (current) => current.outgoingPairing?.status === 'approved',
      );
      expect(state.hosts.map((host) => host.deviceId)).toEqual([desktopId]);
      expect(
        (await laptop.store.read()).pairedHosts.map((host) => host.deviceId),
      ).toEqual([desktopId]);
    } finally {
      writeMock.mockImplementation(realWrite);
    }
  });

  it('takes one pairing request per session', async () => {
    const hub = new InMemoryRelayHub();
    const desktop = createMachine(hub, 'desktop');
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    const probe = createTestDevice(hub, 'probe');
    const session = await probe.manager.connect({
      peerDeviceId: desktopId,
      purpose: 'pair',
      pinnedPeerPublicKey: null,
    });
    const rpc = new RpcPeer(session, {
      onEvent: (): void => undefined,
      onRequest: (): Promise<unknown> => Promise.reject(new Error('unused')),
    });
    const request = { name: 'probe', platform: 'linux' };
    const first = rpc.request(REMOTE_METHODS.pairRequest, request);
    // Settled below; keeps a failing run from crashing the worker.
    first.catch(() => undefined);
    const state = await waitFor(
      () => desktop.service.getState(),
      (current) => current.incomingPairings.length === 1,
    );
    await expect(
      rpc.request(REMOTE_METHODS.pairRequest, request, { timeoutMs: 1_000 }),
    ).rejects.toThrow('already');
    await desktop.service.respondToPairing({
      pairingId: state.incomingPairings[0]?.pairingId ?? '',
      approve: false,
    });
    await expect(first).resolves.toEqual(
      expect.objectContaining({ approved: false }),
    );
    expect((await desktop.service.getState()).incomingPairings).toEqual([]);
    rpc.close('closed');
  });

  async function expectCutOffBeforeSave(
    revoke: (desktop: Machine, laptopId: string) => Promise<unknown>,
  ): Promise<void> {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    expect(desktop.service.hostSessionForController(laptopId)).not.toBeNull();
    let releaseSave = (): void => undefined;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const realUpdate = desktop.store.update.bind(desktop.store);
    jest
      .spyOn(desktop.store, 'update')
      .mockImplementationOnce(async (mutate) => {
        await saveGate;
        return realUpdate(mutate);
      });
    const revoking = revoke(desktop, laptopId);
    await flushRelay(2);
    // The save is still pending, but the session is already gone.
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    // Reconnecting before the save lands is refused too.
    await laptop.service.openMachine(desktopId);
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow();
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    releaseSave();
    await revoking;
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
  }

  it('cuts a forgotten controller off before the change is saved', async () => {
    await expectCutOffBeforeSave((desktop, laptopId) =>
      desktop.service.forgetDevice({ deviceId: laptopId, role: 'controller' }),
    );
  });

  it('ends sessions when incoming control turns off, before saving', async () => {
    await expectCutOffBeforeSave((desktop) =>
      desktop.service.setAllowIncoming(false),
    );
  });

  it('refuses control from a computer that never paired', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const stranger = createMachine(hub, 'stranger');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await stranger.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    // The stranger copies the laptop's pairing record (public data only).
    const laptopRecord = await laptop.store.read();
    await stranger.store.update((current) => ({
      ...current,
      pairedHosts: laptopRecord.pairedHosts,
    }));
    await stranger.service.reconcile();
    await stranger.service.openMachine(desktopId);
    await expect(
      stranger.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow('has not allowed that device');
    expect(desktop.bridges).toHaveLength(0);
  });

  it('ends the session when a relay tampers with encrypted frames', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    hub.tap = (_from: string, _to: string, payload: Buffer): Buffer | null => {
      // Flip a ciphertext byte in data envelopes (type 0x20).
      if (payload[0] !== 0x20) return payload;
      const copy = Buffer.from(payload);
      const index = copy.byteLength - 1;
      copy[index] = (copy[index] ?? 0) ^ 0xff;
      return copy;
    };
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow();
    expect(desktop.bridges[0]?.invocations).toHaveLength(1);
  });

  it('starts one relay however many changes arrive at once', async () => {
    const hub = new InMemoryRelayHub();
    const desktop = createMachine(hub, 'desktop');
    await desktop.store.update((current) => ({
      ...current,
      allowIncoming: true,
    }));
    await Promise.all([
      desktop.service.initialize(),
      desktop.service.reconcile(),
      desktop.service.reconcile(),
      desktop.service.getState({ discover: true }),
    ]);
    expect(desktop.relays).toHaveLength(1);
  });

  it('ends every session when another account signs in', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    const firstRelay = desktop.relays[0];
    expect(desktop.service.hostSessionForController(laptopId)).not.toBeNull();

    desktop.account.current = 'account-2';
    await desktop.service.reconcile();

    expect(firstRelay?.connectionStatus).toBe('stopped');
    expect(desktop.bridges[0]?.destroyed).toBe(true);
    expect(desktop.relays).toHaveLength(2);
  });

  it('closes windows for other computers when another account signs in', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);

    laptop.account.current = 'account-2';
    await laptop.service.reconcile();

    expect(laptop.windows.closed).toContain(desktopId);
  });

  it('ends sessions, closes windows and goes offline when the feature turns off', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    expect(desktop.service.hostSessionForController(laptopId)).not.toBeNull();

    desktop.feature.enabled = false;
    await desktop.service.reconcile();
    laptop.feature.enabled = false;
    await laptop.service.reconcile();

    expect(desktop.relays[0]?.connectionStatus).toBe('stopped');
    expect(desktop.bridges[0]?.destroyed).toBe(true);
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    expect(laptop.relays[0]?.connectionStatus).toBe('stopped');
    expect(laptop.windows.closed).toContain(desktopId);
    const state = await desktop.service.getState();
    expect(state.available).toBe(false);
  });

  it('stops a relay started only for discovery once the window ends', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop', { discoveryWindowMs: 30 });
    await laptop.service.initialize();
    await laptop.service.getState({ discover: true });
    expect(laptop.relays[0]?.connectionStatus).toBe('connected');
    await waitFor(
      () => laptop.relays[0]?.connectionStatus,
      (status) => status === 'stopped',
    );
    expect(laptop.relays).toHaveLength(1);
  });

  it('does not reconnect after the controlled computer disconnects it', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);

    await desktop.service.disconnectController(laptopId);
    const state = await waitFor(
      () => laptop.service.getState(),
      (next) => next.hosts[0]?.connection === 'error',
    );
    expect(state.hosts[0]?.error).toBe(
      'The other computer ended this session.',
    );
    expect(state.hosts[0]?.ended).toBe(true);
    // Coming online again, which retries other connections, changes nothing.
    laptop.relays[0]?.announce();
    desktop.relays[0]?.announce();
    await flushRelay();
    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow('ended this session');
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();

    // Opening the computer again reconnects.
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    expect(desktop.service.hostSessionForController(laptopId)).not.toBeNull();
    const reopened = await laptop.service.getState();
    expect(reopened.hosts[0]?.ended).toBe(false);
  });

  it('closes a session that finishes connecting after its window closed', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;

    await laptop.service.openMachine(desktopId);
    laptop.service.releaseMachine(desktopId);
    await flushRelay(60);

    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    const state = await laptop.service.getState();
    expect(state.hosts[0]?.connection).toBe('idle');
  });

  it.each(['turn off incoming control', 'forget the controller'])(
    'ends live sessions when it cannot save, to %s',
    async (action) => {
      const hub = new InMemoryRelayHub();
      const laptop = createMachine(hub, 'laptop');
      const desktop = createMachine(hub, 'desktop');
      await laptop.service.initialize();
      await desktop.service.initialize();
      await pair(laptop, desktop);
      const desktopId = (await desktop.store.identity()).deviceId;
      const laptopId = (await laptop.store.identity()).deviceId;
      await laptop.service.openMachine(desktopId);
      await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
      // The settings file becomes unwritable: a directory in its place.
      const settingsPath = join(desktop.dir, 'remote-control.json');
      rmSync(settingsPath);
      mkdirSync(settingsPath);

      const revoke =
        action === 'turn off incoming control'
          ? desktop.service.setAllowIncoming(false)
          : desktop.service.forgetDevice({
              deviceId: laptopId,
              role: 'controller',
            });
      await expect(revoke).rejects.toThrow();
      await flushRelay();

      expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
      await expect(
        laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
      ).rejects.toThrow();
    },
  );

  it('refuses requests from a session whose controller lost its pairing', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    const laptopId = (await laptop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
    // Revoked behind the service's back: no session is told directly.
    await desktop.store.update((current) => ({
      ...current,
      pairedControllers: [],
    }));

    await expect(
      laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []),
    ).rejects.toThrow();
    await flushRelay();
    expect(desktop.service.hostSessionForController(laptopId)).toBeNull();
    expect(desktop.bridges[0]?.invocations).toHaveLength(1);
  });

  it('starts a fresh session when the bridge on the controlled computer dies', async () => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    const desktopId = (await desktop.store.identity()).deviceId;
    await laptop.service.openMachine(desktopId);
    await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);

    // The bridge's renderer crashes.
    desktop.bridges[0]?.destroy();

    await waitFor(
      async () => {
        try {
          await laptop.service.invoke(desktopId, TUNNEL_CHANNEL, []);
          return true;
        } catch {
          return false;
        }
      },
      (ok) => ok,
    );
    expect(desktop.bridges).toHaveLength(2);
    expect(desktop.bridges[1]?.invocations).toHaveLength(1);
  });
});

it.each(['start', 'end'] as const)(
  'pairing survives throwing telemetry %s callbacks',
  async (phase) => {
    const hub = new InMemoryRelayHub();
    const recordPairing: PairingTelemetryRecorder =
      (): PairingTelemetryAttempt => {
        if (phase === 'start') throw new Error('telemetry start');
        return {
          end: (): void => {
            throw new Error('telemetry end');
          },
        };
      };
    const laptop = createMachine(hub, 'laptop', { recordPairing });
    const desktop = createMachine(hub, 'desktop', { recordPairing });
    await laptop.service.initialize();
    await desktop.service.initialize();
    await pair(laptop, desktop);
    expect((await laptop.store.read()).pairedHosts).toHaveLength(1);
    expect((await desktop.store.read()).pairedControllers).toHaveLength(1);
  },
);

it.each(['timeout', 'decline'] as const)(
  'keeps the first incoming %s outcome when callbacks race cleanup',
  async (first) => {
    const hub = new InMemoryRelayHub();
    const laptop = createMachine(hub, 'laptop');
    const desktop = createMachine(hub, 'desktop');
    await laptop.service.initialize();
    await desktop.service.initialize();
    await desktop.service.setAllowIncoming(true);
    const desktopId = (await desktop.store.identity()).deviceId;
    await waitFor(
      () => laptop.service.getState({ discover: true }),
      (state) => state.discoverable.length === 1,
    );
    const timers = jest.spyOn(globalThis, 'setTimeout');
    try {
      await laptop.service.startPairing(desktopId);
      const pending = await waitFor(
        () => desktop.service.getState(),
        (state) => state.incomingPairings.length === 1,
      );
      const timer = timers.mock.calls.find((call) => call[1] === 3 * 60_000);
      if (!timer) throw new Error('Missing pairing decision timer');
      if (first === 'timeout') timer[0]();
      const response = desktop.service.respondToPairing({
        pairingId: pending.incomingPairings[0]?.pairingId ?? '',
        approve: false,
      });
      if (first === 'decline') timer[0]();
      await response;
      await waitFor(
        () => laptop.service.getState(),
        (state) => state.outgoingPairing?.status === 'rejected',
      );
      expect(desktop.pairingTelemetry[0]?.outcomes).toEqual([
        first === 'timeout' ? 'timed_out' : 'declined',
      ]);
      expect(laptop.pairingTelemetry[0]?.outcomes).toEqual(['rejected']);
    } finally {
      timers.mockRestore();
    }
  },
);

it('records incoming persistence failure after approval as failed', async () => {
  const hub = new InMemoryRelayHub();
  const laptop = createMachine(hub, 'laptop');
  const desktop = createMachine(hub, 'desktop');
  await laptop.service.initialize();
  await desktop.service.initialize();
  await desktop.service.setAllowIncoming(true);
  const desktopId = (await desktop.store.identity()).deviceId;
  await waitFor(
    () => laptop.service.getState({ discover: true }),
    (state) => state.discoverable.length === 1,
  );
  await laptop.service.startPairing(desktopId);
  const pending = await waitFor(
    () => desktop.service.getState(),
    (state) => state.incomingPairings.length === 1,
  );
  jest
    .spyOn(desktop.store, 'update')
    .mockRejectedValueOnce(new Error('disk failure'));
  await desktop.service.respondToPairing({
    pairingId: pending.incomingPairings[0]?.pairingId ?? '',
    approve: true,
  });
  await waitFor(
    () => laptop.service.getState(),
    (state) => state.outgoingPairing?.status === 'failed',
  );
  expect(desktop.pairingTelemetry[0]?.outcomes).toEqual(['failed']);
  expect(laptop.pairingTelemetry[0]?.outcomes).toEqual(['failed']);
});
